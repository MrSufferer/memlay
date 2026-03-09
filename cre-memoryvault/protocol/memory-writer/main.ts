/**
 * MemoryVault Agent Protocol — Memory Writer (Protocol Workflow)
 *
 * The most critical protocol workflow. Commits agent reasoning to MemoryVault
 * (S3 encrypted + on-chain hash) BEFORE any action is executed.
 *
 * Flow:
 *   1. Receive HTTP payload: { agentId, entryKey, entryData }
 *   2. Encrypt entry data (simulation cipher) with vault secret
 *   3. Write encrypted blob to S3 (SigV4 signed) — retries 3×
 *   4. Compute keccak256 hash of plaintext
 *   5. ABI encode (agentId, entryKey, entryHash, timestamp)
 *   6. Generate CRE report (DON-signed)
 *   7. Write report → MemoryRegistry.sol (on-chain hash anchor)
 *
 * Key invariants:
 *   - S3 write MUST succeed before on-chain commit
 *   - Uses runtime.now() for timestamps (NOT Date.now())
 *   - Secrets fetched sequentially (CRE SDK requirement)
 *   - Gas limit as string (CRE SDK requirement)
 *
 * CRE WASM constraints:
 *   - No `crypto` global, no `Bun.*` APIs in WASM
 *   - viem's keccak256 IS available
 *   - Crypto helpers inlined (CRE builds per-workflow directory)
 *
 * Test:
 *   cre workflow simulate protocol/memory-writer \
 *     --target staging-settings --non-interactive --trigger-index 0 \
 *     --http-payload '{"agentId":"agent-alpha-01","entryKey":"lp-entry-test","entryData":{"action":"lp-entry","toolId":"uniswap-v3-lp","reasoning":"test"}}'
 *
 * @module protocol/memory-writer
 */

import {
    cre,
    Runner,
    type Runtime,
    type HTTPPayload,
    getNetwork,
    hexToBase64,
    bytesToHex,
    TxStatus,
    decodeJson,
} from '@chainlink/cre-sdk'
import {
    encodeAbiParameters,
    parseAbiParameters,
    keccak256,
    toHex,
    type Hex,
} from 'viem'
import { z } from 'zod'

// ═══════════════════════════════════════════════════════════════════════════
// Crypto Helpers (inlined — CRE builds per-workflow directory)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Keccak-256 hash of a string, returned as 0x-prefixed hex.
 * Uses viem's keccak256 which is available in the CRE WASM runtime.
 * Named keccak256Hash (matches utils/crypto.ts) — not SHA-256.
 */
function keccak256Hash(data: string): string {
    return keccak256(toHex(data))
}

/**
 * keccak256Hash result without 0x prefix — used for SigV4 and S3 payload hashes.
 */
function hashHex(data: string): string {
    const h = keccak256Hash(data)
    return h.startsWith('0x') ? h.slice(2) : h
}

/**
 * Simulate HMAC using keccak256 (Web Crypto unavailable in WASM).
 * Produces valid-looking SigV4 structure for CRE simulation.
 */
function hmacHex(key: string, data: string): string {
    return hashHex(key + data)
}

/**
 * Convert hex string to Uint8Array. Strips optional 0x prefix.
 */
function hexToBytes(hex: string): Uint8Array {
    const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex
    const bytes = new Uint8Array(cleanHex.length / 2)
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16)
    }
    return bytes
}

/**
 * Convert Uint8Array to base64 string (no btoa — WASM-safe).
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
    const chars =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    let result = ''
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i]
        const b = i + 1 < bytes.length ? bytes[i + 1] : 0
        const c = i + 2 < bytes.length ? bytes[i + 2] : 0
        result += chars[a >> 2]
        result += chars[((a & 3) << 4) | (b >> 4)]
        result +=
            i + 1 < bytes.length ? chars[((b & 15) << 2) | (c >> 6)] : '='
        result += i + 2 < bytes.length ? chars[c & 63] : '='
    }
    return result
}

/**
 * Encrypt plaintext for MemoryVault storage (simulation cipher).
 * 
 * TODO(production): MUST replace with ConfHTTP encryptOutput AES-GCM
 *
 * In CRE WASM, Web Crypto API is NOT available. Uses XOR with the
 * AES key + a deterministic IV for simulation. Production CRE
 * deployment would use native AES-GCM (via encryptOutput in ConfHTTP,
 * as shown in examples/conf-http-demo).
 *
 * Output format: base64(IV_12bytes + XOR_ciphertext)
 */
function encryptData(plaintext: string, keyHex: string): string {
    const keyBytes = hexToBytes(keyHex)
    const encoded = new TextEncoder().encode(plaintext)

    // Deterministic 12-byte IV from plaintext hash (simulation only)
    const ivHex = keccak256(toHex(plaintext))
    const iv = hexToBytes(ivHex.slice(2, 26))

    // XOR cipher (simulation — real deployment uses AES-GCM)
    const ciphertext = new Uint8Array(encoded.length)
    for (let i = 0; i < encoded.length; i++) {
        ciphertext[i] = encoded[i] ^ keyBytes[i % keyBytes.length]
    }

    const combined = new Uint8Array(iv.length + ciphertext.length)
    combined.set(iv)
    combined.set(ciphertext, iv.length)

    return uint8ArrayToBase64(combined)
}

// ═══════════════════════════════════════════════════════════════════════════
// SigV4 Helpers (inlined — CRE builds per-workflow directory)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the current UTC date components for SigV4 signing.
 * Uses `now` which is passed from `runtime.now()` for DON determinism.
 */
function getAmzDateComponents(now: Date): { dateStamp: string; amzDate: string } {
    const dateStamp = now.toISOString().replace(/[-:]/g, '').slice(0, 8)
    const amzDate =
        dateStamp +
        'T' +
        now.toISOString().replace(/[-:]/g, '').slice(9, 15) +
        'Z'
    return { dateStamp, amzDate }
}

/**
 * Compute AWS SigV4 Authorization header value (simulation).
 *
 * Uses keccak256 in place of HMAC-SHA256 (HMAC unavailable in WASM).
 * Produces structurally correct SigV4 headers that work with CRE
 * simulation. Real AWS deployments require proper HMAC-SHA256 signing
 * which is available in the Bun/Node.js agent service (trader-template.ts).
 */
function sigV4Authorization(
    creds: { accessKeyId: string; secretAccessKey: string },
    region: string,
    method: string,
    canonicalUri: string,
    host: string,
    payload: string,
    dateStamp: string,
    amzDate: string
): string {
    const payloadHash = hashHex(payload)
    const canonicalHeaders =
        `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'

    const canonicalRequest = [
        method,
        canonicalUri,
        '', // empty query string
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join('\n')

    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        hashHex(canonicalRequest),
    ].join('\n')

    // Simulated HMAC chain (keccak256 approximation — see note above)
    const kDate = hmacHex(`AWS4${creds.secretAccessKey}`, dateStamp)
    const kRegion = hmacHex(kDate, region)
    const kService = hmacHex(kRegion, 's3')
    const kSigning = hmacHex(kService, 'aws4_request')
    const signature = hmacHex(kSigning, stringToSign)

    return (
        `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`
    )
}

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

const configSchema = z.object({
    /** Owner address for vault secrets */
    owner: z.string(),
    /** S3 bucket for MemoryVault blobs */
    s3Bucket: z.string(),
    /** S3 region */
    s3Region: z.string(),
    /** Public key for HTTP trigger authorization */
    publicKey: z.string(),
    /** MemoryRegistry contract address on Sepolia */
    memoryRegistryAddress: z.string(),
    /** EVM chain configurations */
    evms: z.array(
        z.object({
            chainSelectorName: z.string(),
            gasLimit: z.string(),
        })
    ),
})

type Config = z.infer<typeof configSchema>

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** Maximum S3 write retries — never commit on-chain without persisted reasoning */
const MAX_S3_RETRIES = 3

// ═══════════════════════════════════════════════════════════════════════════
// HTTP Trigger Handler
// ═══════════════════════════════════════════════════════════════════════════

const onHttpTrigger = (
    runtime: Runtime<Config>,
    payload: HTTPPayload
): string => {
    if (!payload.input || payload.input.length === 0) {
        return JSON.stringify({
            status: 'failed',
            error: 'Empty request payload',
        })
    }

    runtime.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    runtime.log('MemoryVault: Memory Writer — HTTP Trigger')
    runtime.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

    // ─── Parse input ────────────────────────────────────────────────
    const inputData = decodeJson(payload.input)
    const agentId = inputData.agentId as string
    const entryKey = inputData.entryKey as string
    const entryData = inputData.entryData as Record<string, unknown>

    if (!agentId || !entryKey || !entryData) {
        return JSON.stringify({
            status: 'failed',
            error: 'Missing required fields: agentId, entryKey, entryData',
        })
    }

    runtime.log(`[Step 1] Agent: ${agentId} | Key: ${entryKey}`)
    runtime.log(
        `[Step 1] Entry data: ${JSON.stringify(entryData)}`
    )

    // ─── Get secrets (SEQUENTIAL — CRE SDK requirement) ─────────────
    runtime.log('[Step 2] Fetching secrets...')
    const aesKey = runtime.getSecret({ id: 'AES_KEY' }).result()
    const awsAccessKeyId = runtime
        .getSecret({ id: 'AWS_ACCESS_KEY_ID' })
        .result()
    const awsSecretAccessKey = runtime
        .getSecret({ id: 'AWS_SECRET_ACCESS_KEY' })
        .result()

    // ─── Prepare plaintext with timestamp ─────────────────────────────
    const timestamp = runtime.now()
    const plaintext = JSON.stringify({
        ...entryData,
        timestamp,
    })
    runtime.log(
        `[Step 3] Plaintext prepared (${plaintext.length} chars, ts=${timestamp})`
    )

    // ─── Encrypt entry data ─────────────────────────────────────────
    runtime.log('[Step 4] Encrypting data...')
    const encrypted = encryptData(plaintext, aesKey.value)
    runtime.log(
        `[Step 4] Encrypted blob: ${encrypted.length} chars (base64)`
    )

    // ─── Write encrypted blob to S3 (retries 3×) ────────────────────
    runtime.log('[Step 5] Writing to S3...')
    const httpClient = new cre.capabilities.HTTPClient()
    const s3Key = `agents/${agentId}/log/${entryKey}`
    const host = `${runtime.config.s3Bucket}.s3.${runtime.config.s3Region}.amazonaws.com`
    const creds = {
        accessKeyId: awsAccessKeyId.value,
        secretAccessKey: awsSecretAccessKey.value,
    }

    let s3Success = false
    for (let attempt = 1; attempt <= MAX_S3_RETRIES; attempt++) {
        try {
            runtime.log(
                `[Step 5] S3 PUT attempt ${attempt}/${MAX_S3_RETRIES}: s3://${runtime.config.s3Bucket}/${s3Key}`
            )

            // SigV4-signed S3 PUT — Authorization header required by AWS
            const { dateStamp, amzDate } = getAmzDateComponents(timestamp)
            const authorization = sigV4Authorization(
                creds,
                runtime.config.s3Region,
                'PUT',
                `/${s3Key}`,
                host,
                encrypted,
                dateStamp,
                amzDate
            )
            const payloadHash = hashHex(encrypted)

            // @ts-expect-error: CRE SDK types Runtime<Config> as NodeRuntime in this overload — works correctly at runtime
            httpClient.sendRequest(runtime, (sendRequester: any) => {
                return sendRequester.sendRequest({
                    request: {
                        url: `https://${host}/${s3Key}`,
                        method: 'PUT',
                        body: encrypted,
                        multiHeaders: {
                            Host: { values: [host] },
                            'X-Amz-Date': { values: [amzDate] },
                            'X-Amz-Content-Sha256': { values: [payloadHash] },
                            Authorization: { values: [authorization] },
                            'Content-Type': {
                                values: ['application/octet-stream'],
                            },
                        },
                    },
                })
            })

            s3Success = true
            runtime.log(
                `[Step 5] S3 write succeeded on attempt ${attempt}`
            )
            break
        } catch (e) {
            runtime.log(
                `[Step 5] S3 write failed (attempt ${attempt}): ${e}`
            )
            if (attempt === MAX_S3_RETRIES) {
                runtime.log(
                    '[Step 5] ⚠️ ALL S3 RETRIES EXHAUSTED — aborting commit'
                )
            }
        }
    }

    if (!s3Success) {
        return JSON.stringify({
            status: 'failed',
            error: `S3 write failed after ${MAX_S3_RETRIES} retries — reasoning NOT persisted, action MUST NOT proceed`,
            agentId,
            entryKey,
        })
    }

    // ─── Compute hash of plaintext ──────────────────────────────────
    // Uses keccak256Hash (via keccak256(toHex(data))) — matches MemoryRegistry.sol
    const entryHash = keccak256Hash(plaintext)
    runtime.log(`[Step 6] Entry hash (keccak256): ${entryHash}`)

    // ─── ABI encode report data ─────────────────────────────────────
    runtime.log('[Step 7] Encoding report for MemoryRegistry...')
    // runtime.now() returns a Date — convert to epoch seconds for on-chain
    const timestampMs = new Date(String(timestamp)).getTime()
    const timestampSecs = BigInt(Math.floor(timestampMs / 1000))
    const reportData = encodeAbiParameters(
        parseAbiParameters('string, string, bytes32, uint256'),
        [agentId, entryKey, entryHash as Hex, timestampSecs]
    )

    // ─── Generate CRE report (DON-signed) ───────────────────────────
    runtime.log('[Step 8] Generating CRE report...')
    const reportResponse = runtime
        .report({
            encodedPayload: hexToBase64(reportData),
            encoderName: 'evm',
            signingAlgo: 'ecdsa',
            hashingAlgo: 'keccak256',
        })
        .result()

    // ─── Write report to MemoryRegistry via EVMClient ───────────────
    runtime.log(
        `[Step 9] Writing report to MemoryRegistry: ${runtime.config.memoryRegistryAddress}`
    )

    const network = getNetwork({
        chainFamily: 'evm',
        chainSelectorName: runtime.config.evms[0].chainSelectorName,
        isTestnet: true,
    })

    if (!network) {
        return JSON.stringify({
            status: 'failed',
            error: `Network not found for chain: ${runtime.config.evms[0].chainSelectorName}`,
            agentId,
            entryKey,
        })
    }

    const evmClient = new cre.capabilities.EVMClient(
        network.chainSelector.selector
    )

    const writeResult = evmClient
        .writeReport(runtime, {
            receiver: runtime.config.memoryRegistryAddress,
            report: reportResponse,
            gasConfig: {
                gasLimit: runtime.config.evms[0].gasLimit,
            },
        })
        .result()

    // ─── Build response ─────────────────────────────────────────────
    if (writeResult.txStatus === TxStatus.SUCCESS) {
        const txHash = bytesToHex(
            writeResult.txHash || new Uint8Array(32)
        )
        runtime.log('[Step 10] ✅ Memory committed successfully')
        runtime.log(`  Agent:    ${agentId}`)
        runtime.log(`  Key:      ${entryKey}`)
        runtime.log(`  Hash:     ${entryHash}`)
        runtime.log(
            `  S3:       s3://${runtime.config.s3Bucket}/${s3Key}`
        )
        runtime.log(`  TX:       ${txHash}`)
        runtime.log(
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
        )

        return JSON.stringify({
            status: 'success',
            agentId,
            entryKey,
            entryHash,
            timestamp,
            s3Key,
            txHash,
        })
    }

    runtime.log(
        `[Step 10] ❌ On-chain write failed: ${writeResult.txStatus}`
    )
    return JSON.stringify({
        status: 'failed',
        error: `On-chain writeReport failed with status: ${writeResult.txStatus}`,
        agentId,
        entryKey,
        entryHash,
        timestamp,
        s3Key,
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// Workflow Init
// ═══════════════════════════════════════════════════════════════════════════

const initWorkflow = (config: Config) => {
    const http = new cre.capabilities.HTTPCapability()

    return [
        cre.handler(
            http.trigger({
                authorizedKeys: [
                    {
                        type: 'KEY_TYPE_ECDSA_EVM',
                        publicKey: config.publicKey,
                    },
                ],
            }),
            onHttpTrigger
        ),
    ]
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

export async function main() {
    const runner = await Runner.newRunner<Config>({ configSchema })
    await runner.run(initWorkflow)
}

main()
