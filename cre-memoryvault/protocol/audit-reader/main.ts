/**
 * MemoryVault Agent Protocol — Audit Reader (Protocol Workflow)
 *
 * Reads and verifies an agent's complete decision log from MemoryVault.
 * For each S3 entry: decrypt → re-hash → verify against MemoryRegistry on-chain.
 *
 * Flow:
 *   1. Receive HTTP payload: { agentId }
 *   2. Fetch secrets (AES key + AWS credentials) — sequential
 *   3. S3 LIST objects under agents/{agentId}/log/ prefix
 *   4. For each object: S3 GET → decrypt → re-hash plaintext
 *   5. callContract(getCommitment(hash)) on MemoryRegistry
 *   6. Compare computed hash with on-chain commitment
 *   7. Return verified chronological decision log
 *
 * Key invariants:
 *   - Secrets fetched sequentially (CRE SDK requirement)
 *   - Uses runtime.now() for timestamps (NOT Date.now())
 *   - Crypto helpers inlined (CRE builds per-workflow directory)
 *   - callContract pattern from x402-cre-price-alerts example
 *
 * CRE WASM constraints:
 *   - No `crypto` global, no `Bun.*` APIs in WASM
 *   - viem's keccak256 IS available
 *   - No btoa/atob — manual base64
 *
 * Test:
 *   cre workflow simulate protocol/audit-reader \
 *     --target staging-settings --non-interactive --trigger-index 0 \
 *     --http-payload '{"agentId":"agent-alpha-01"}'
 *
 * @module protocol/audit-reader
 */

import {
    cre,
    Runner,
    type Runtime,
    type HTTPPayload,
    type HTTPSendRequester,
    getNetwork,
    encodeCallMsg,
    bytesToHex,
    decodeJson,
    ok,
    consensusIdenticalAggregation,
} from '@chainlink/cre-sdk'
import {
    encodeFunctionData,
    decodeFunctionResult,
    keccak256,
    toHex,
    zeroAddress,
    type Address,
    type Hex,
} from 'viem'
import { z } from 'zod'

// ═══════════════════════════════════════════════════════════════════════════
// Crypto Helpers (inlined — CRE builds per-workflow directory)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Keccak-256 hash of a string, returned as 0x-prefixed hex.
 * Uses viem's keccak256 which is available in the CRE WASM runtime.
 */
function hashData(data: string): string {
    return keccak256(toHex(data))
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
 * Convert base64 string to Uint8Array (no atob — WASM-safe).
 */
function base64ToUint8Array(b64: string): Uint8Array {
    const chars =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const lookup = new Map<string, number>()
    for (let i = 0; i < chars.length; i++) {
        lookup.set(chars[i], i)
    }

    // Remove padding
    const clean = b64.replace(/=/g, '')
    const byteLength = Math.floor((clean.length * 3) / 4)
    const bytes = new Uint8Array(byteLength)

    let j = 0
    for (let i = 0; i < clean.length; i += 4) {
        const a = lookup.get(clean[i]) || 0
        const b = lookup.get(clean[i + 1]) || 0
        const c = lookup.get(clean[i + 2]) || 0
        const d = lookup.get(clean[i + 3]) || 0

        bytes[j++] = (a << 2) | (b >> 4)
        if (j < byteLength) bytes[j++] = ((b & 15) << 4) | (c >> 2)
        if (j < byteLength) bytes[j++] = ((c & 3) << 6) | d
    }

    return bytes
}

/**
 * Decrypt ciphertext from MemoryVault storage (simulation cipher).
 *
 * Reverses the XOR cipher used by memory-writer's encryptData().
 * Input format: base64(IV_12bytes + XOR_ciphertext)
 */
function decryptData(ciphertextB64: string, keyHex: string): string {
    const combined = base64ToUint8Array(ciphertextB64)
    const _iv = combined.slice(0, 12) // IV is prepended (12 bytes)
    const ciphertext = combined.slice(12)

    const keyBytes = hexToBytes(keyHex)

    // Reverse XOR cipher
    const plainBytes = new Uint8Array(ciphertext.length)
    for (let i = 0; i < ciphertext.length; i++) {
        plainBytes[i] = ciphertext[i] ^ keyBytes[i % keyBytes.length]
    }

    return new TextDecoder().decode(plainBytes)
}

// ═══════════════════════════════════════════════════════════════════════════
// S3 Helpers (inlined — CRE builds per-workflow directory)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse S3 ListBucketResult XML to extract object keys.
 * S3 LIST returns XML with <Key> elements for each object.
 */
function parseS3ListResponse(xml: string): string[] {
    const keys: string[] = []
    const regex = /<Key>(.*?)<\/Key>/g
    let match
    while ((match = regex.exec(xml)) !== null) {
        keys.push(match[1])
    }
    return keys
}

/**
 * SigV4 hash helper — uses keccak256 since SHA-256 not available in WASM.
 * Returns hex without 0x prefix (SigV4 convention).
 */
function sigV4Hash(data: string): string {
    const h = hashData(data)
    return h.startsWith('0x') ? h.slice(2) : h
}

/**
 * Simulate HMAC-SHA256 using keccak256 for SigV4 signing.
 * (Real AWS needs HMAC-SHA256, but simulation doesn't hit real S3.)
 */
function hmacHex(key: string, data: string): string {
    return sigV4Hash(key + data)
}

/**
 * Compute AWS SigV4 authorization header (simulation).
 */
function computeSigV4(
    accessKeyId: string,
    secretAccessKey: string,
    region: string,
    dateStamp: string,
    amzDate: string,
    method: string,
    canonicalUri: string,
    host: string,
    payload: string,
    queryString: string = ''
): string {
    const payloadHash = sigV4Hash(payload)

    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'

    const canonicalRequest = [
        method,
        canonicalUri,
        queryString,
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join('\n')

    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        sigV4Hash(canonicalRequest),
    ].join('\n')

    const kDate = hmacHex(`AWS4${secretAccessKey}`, dateStamp)
    const kRegion = hmacHex(kDate, region)
    const kService = hmacHex(kRegion, 's3')
    const kSigning = hmacHex(kService, 'aws4_request')
    const signature = hmacHex(kSigning, stringToSign)

    return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
}

/**
 * Get current UTC date components for SigV4 signing.
 * Uses `now` which is passed from `runtime.now()` for DON determinism.
 */
function getDateComponents(now: Date): { dateStamp: string; amzDate: string } {
    const dateStamp = now.toISOString().replace(/[-:]/g, '').slice(0, 8)
    const amzDate =
        dateStamp +
        'T' +
        now.toISOString().replace(/[-:]/g, '').slice(9, 15) +
        'Z'
    return { dateStamp, amzDate }
}

// ═══════════════════════════════════════════════════════════════════════════
// MemoryRegistry ABI (inlined — subset needed for reads)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Subset of MemoryRegistry ABI — only the view functions needed by audit-reader.
 * Full ABI at contracts/abi/MemoryRegistry.ts
 */
const memoryRegistryAbi = [
    {
        inputs: [{ name: 'hash', type: 'bytes32' }],
        name: 'getCommitment',
        outputs: [
            {
                components: [
                    { name: 'agentId', type: 'string' },
                    { name: 'entryKey', type: 'string' },
                    { name: 'entryHash', type: 'bytes32' },
                    { name: 'committedAt', type: 'uint256' },
                ],
                type: 'tuple',
            },
        ],
        stateMutability: 'view',
        type: 'function',
    },
    {
        inputs: [{ name: 'agentId', type: 'string' }],
        name: 'getAgentHashCount',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
    },
    {
        inputs: [
            { name: 'agentId', type: 'string' },
            { name: 'index', type: 'uint256' },
        ],
        name: 'getAgentHash',
        outputs: [{ name: '', type: 'bytes32' }],
        stateMutability: 'view',
        type: 'function',
    },
] as const

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
    runtime.log('MemoryVault: Audit Reader — HTTP Trigger')
    runtime.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

    // ─── Parse input ────────────────────────────────────────────────
    const inputData = decodeJson(payload.input)
    const agentId = inputData.agentId as string

    if (!agentId) {
        return JSON.stringify({
            status: 'failed',
            error: 'Missing required field: agentId',
        })
    }

    runtime.log(`[Step 1] Audit request for agent: ${agentId}`)

    // ─── Get secrets (SEQUENTIAL — CRE SDK requirement) ─────────────
    runtime.log('[Step 2] Fetching secrets...')
    const aesKey = runtime.getSecret({ id: 'AES_KEY' }).result()
    const awsAccessKeyId = runtime
        .getSecret({ id: 'AWS_ACCESS_KEY_ID' })
        .result()
    const awsSecretAccessKey = runtime
        .getSecret({ id: 'AWS_SECRET_ACCESS_KEY' })
        .result()

    // ─── S3 LIST objects under agent prefix ──────────────────────────
    runtime.log('[Step 3] Listing S3 objects...')
    const httpClient = new cre.capabilities.HTTPClient()
    const prefix = `agents/${agentId}/log/`
    const host = `${runtime.config.s3Bucket}.s3.${runtime.config.s3Region}.amazonaws.com`

    const { dateStamp, amzDate } = getDateComponents(runtime.now())
    const emptyPayloadHash = sigV4Hash('')

    const listAuth = computeSigV4(
        awsAccessKeyId.value,
        awsSecretAccessKey.value,
        runtime.config.s3Region,
        dateStamp,
        amzDate,
        'GET',
        '/',
        host,
        '',
        `prefix=${encodeURIComponent(prefix)}`
    )

    // Define the S3 LIST fetcher — returns raw XML body as string
    const fetchS3List = (
        sendRequester: HTTPSendRequester,
        listUrl: string
    ): string => {
        const resp = sendRequester
            .sendRequest({
                url: listUrl,
                method: 'GET',
                headers: {
                    Host: host,
                    'X-Amz-Date': amzDate,
                    'X-Amz-Content-Sha256': emptyPayloadHash,
                    Authorization: listAuth,
                },
            })
            .result()

        if (!ok(resp)) {
            throw new Error(
                `S3 LIST failed with status: ${resp.statusCode}`
            )
        }

        return new TextDecoder().decode(resp.body)
    }

    let s3Keys: string[] = []
    try {
        const listResponseBody = httpClient
            .sendRequest(
                runtime,
                fetchS3List,
                consensusIdenticalAggregation<string>()
            )(`https://${host}/?prefix=${encodeURIComponent(prefix)}`)
            .result()

        s3Keys = parseS3ListResponse(listResponseBody)
        runtime.log(
            `[Step 3] Found ${s3Keys.length} S3 entries for agent ${agentId}`
        )
    } catch (e) {
        runtime.log(`[Step 3] S3 LIST failed: ${e}`)
        runtime.log(
            '[Step 3] Continuing with empty list (simulation or S3 error)'
        )
    }

    // ─── Set up EVM client for on-chain verification ────────────────
    runtime.log('[Step 4] Setting up EVM client...')
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
        })
    }

    const evmClient = new cre.capabilities.EVMClient(
        network.chainSelector.selector
    )

    // ─── For each S3 entry: GET → decrypt → hash → verify on-chain ─
    runtime.log('[Step 5] Reading, decrypting, and verifying entries...')
    const verifiedEntries: Array<{
        key: string
        type: string
        toolId: string
        timestamp: string
        verified: boolean
        committedAt: string
        data: Record<string, unknown>
    }> = []

    // Define the S3 GET fetcher — returns raw body as string
    const fetchS3Object = (
        sendRequester: HTTPSendRequester,
        objectUrl: string,
        objectAuth: string
    ): string => {
        const resp = sendRequester
            .sendRequest({
                url: objectUrl,
                method: 'GET',
                headers: {
                    Host: host,
                    'X-Amz-Date': amzDate,
                    'X-Amz-Content-Sha256': emptyPayloadHash,
                    Authorization: objectAuth,
                },
            })
            .result()

        if (!ok(resp)) {
            throw new Error(
                `S3 GET failed with status: ${resp.statusCode}`
            )
        }

        return new TextDecoder().decode(resp.body)
    }

    for (const s3Key of s3Keys) {
        try {
            // S3 GET the encrypted blob
            const getAuth = computeSigV4(
                awsAccessKeyId.value,
                awsSecretAccessKey.value,
                runtime.config.s3Region,
                dateStamp,
                amzDate,
                'GET',
                `/${s3Key}`,
                host,
                ''
            )

            const encryptedBlob = httpClient
                .sendRequest(
                    runtime,
                    fetchS3Object,
                    consensusIdenticalAggregation<string>()
                )(
                    `https://${host}/${s3Key}`,
                    getAuth
                )
                .result()

            // Decrypt the blob
            const plaintext = decryptData(encryptedBlob, aesKey.value)
            const entryData = JSON.parse(plaintext) as Record<string, unknown>

            // Re-hash the plaintext to get the expected hash
            const computedHash = hashData(plaintext) as Hex

            // Verify on-chain via callContract(getCommitment(hash))
            const callData = encodeFunctionData({
                abi: memoryRegistryAbi,
                functionName: 'getCommitment',
                args: [computedHash],
            })

            const callResult = evmClient
                .callContract(runtime, {
                    call: encodeCallMsg({
                        from: zeroAddress,
                        to: runtime.config.memoryRegistryAddress as Address,
                        data: callData,
                    }),
                })
                .result()

            const commitmentHex = bytesToHex(callResult.data)

            // Default commitment for zero-data responses (simulation without deployed contract)
            let commitment: {
                agentId: string
                entryKey: string
                entryHash: Hex
                committedAt: bigint
            } = {
                agentId: '',
                entryKey: '',
                entryHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
                committedAt: 0n,
            }

            // Guard against zero-data returns (simulation without deployed contract)
            if (commitmentHex && commitmentHex !== '0x' && commitmentHex.length > 2) {
                commitment = decodeFunctionResult({
                    abi: memoryRegistryAbi,
                    functionName: 'getCommitment',
                    data: commitmentHex,
                }) as typeof commitment
            }

            // Compare: non-zero committedAt means it was committed on-chain
            const isVerified =
                commitment.committedAt > 0n &&
                commitment.entryHash === computedHash

            const entry = {
                key: s3Key,
                type: (entryData.action as string) || 'unknown',
                toolId: (entryData.toolId as string) || 'protocol',
                timestamp: (entryData.timestamp as string) || '',
                verified: isVerified,
                committedAt: commitment.committedAt.toString(),
                data: entryData,
            }

            verifiedEntries.push(entry)
            runtime.log(
                `  [${s3Key}] ${isVerified ? '✅ verified' : '❌ NOT verified'} | toolId: ${entry.toolId}`
            )
        } catch (e) {
            runtime.log(`  [${s3Key}] ⚠️ Error processing entry: ${e}`)
            verifiedEntries.push({
                key: s3Key,
                type: 'error',
                toolId: 'unknown',
                timestamp: '',
                verified: false,
                committedAt: '0',
                data: { error: `Failed to process: ${e}` },
            })
        }
    }

    // ─── Also check on-chain entries (in case S3 was tampered/deleted) ─
    runtime.log('[Step 6] Cross-checking on-chain agent commitments...')
    let onChainCount = 0n
    try {
        const countCallData = encodeFunctionData({
            abi: memoryRegistryAbi,
            functionName: 'getAgentHashCount',
            args: [agentId],
        })

        const countResult = evmClient
            .callContract(runtime, {
                call: encodeCallMsg({
                    from: zeroAddress,
                    to: runtime.config.memoryRegistryAddress as Address,
                    data: countCallData,
                }),
            })
            .result()

        const countHex = bytesToHex(countResult.data)
        // Guard against zero-data returns (simulation without deployed contract)
        if (countHex && countHex !== '0x' && countHex.length > 2) {
            onChainCount = decodeFunctionResult({
                abi: memoryRegistryAbi,
                functionName: 'getAgentHashCount',
                data: countHex,
            }) as bigint
        }

        runtime.log(
            `[Step 6] On-chain commitments: ${onChainCount.toString()} | S3 entries: ${s3Keys.length}`
        )

        if (Number(onChainCount) > s3Keys.length) {
            runtime.log(
                `[Step 6] ⚠️ WARNING: More on-chain commitments than S3 entries — possible S3 deletion`
            )
        }
    } catch (e) {
        runtime.log(`[Step 6] On-chain check failed: ${e}`)
    }

    // ─── Sort by timestamp (chronological order) ────────────────────
    verifiedEntries.sort((a, b) => {
        const tsA = a.timestamp ? new Date(a.timestamp).getTime() : 0
        const tsB = b.timestamp ? new Date(b.timestamp).getTime() : 0
        return tsA - tsB
    })

    // ─── Build response ─────────────────────────────────────────────
    const verifiedCount = verifiedEntries.filter((e) => e.verified).length
    const unverifiedCount = verifiedEntries.length - verifiedCount

    runtime.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    runtime.log(`✅ Audit complete for agent: ${agentId}`)
    runtime.log(`  Total entries:    ${verifiedEntries.length}`)
    runtime.log(`  Verified:         ${verifiedCount}`)
    runtime.log(`  Unverified:       ${unverifiedCount}`)
    runtime.log(`  On-chain count:   ${onChainCount.toString()}`)
    runtime.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

    return JSON.stringify({
        status: 'success',
        agentId,
        decisionLog: verifiedEntries,
        totalEntries: verifiedEntries.length,
        verifiedCount,
        unverifiedCount,
        onChainCommitments: onChainCount.toString(),
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
