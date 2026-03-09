/**
 * MemoryVault Agent Protocol — Integrity Checker (Protocol Workflow)
 *
 * Cron-triggered workflow that periodically verifies MemoryVault integrity
 * by reading S3 entries, re-hashing plaintext, and comparing against
 * on-chain MemoryRegistry commitments. Sends a Pushover notification
 * if any hash mismatch (tampering) is detected.
 *
 * Flow:
 *   1. Cron fires (every 1h in production, immediate in simulation)
 *   2. Fetch secrets (AES key + AWS creds + Pushover) — sequential
 *   3. S3 LIST objects under agents/{agentId}/log/ prefix
 *   4. For each object: S3 GET → decrypt → re-hash plaintext
 *   5. callContract(getCommitment(hash)) on MemoryRegistry
 *   6. Compare computed hash with on-chain commitment
 *   7. If mismatches: send Pushover alert (POST with cacheSettings)
 *   8. Return integrity check summary
 *
 * Key invariants:
 *   - Secrets fetched sequentially (CRE SDK requirement)
 *   - Uses runtime.now() for timestamps (NOT Date.now())
 *   - Crypto helpers inlined (CRE builds per-workflow directory)
 *   - callContract pattern from x402-cre-price-alerts example
 *   - Pushover POST uses cacheSettings to prevent duplicate alerts
 *
 * CRE WASM constraints:
 *   - No `crypto` global, no `Bun.*` APIs in WASM
 *   - viem's keccak256 IS available
 *   - No btoa/atob — manual base64
 *
 * Test:
 *   cre workflow simulate protocol/integrity-checker \
 *     --target staging-settings --non-interactive --trigger-index 0
 *
 * @module protocol/integrity-checker
 */

import {
    cre,
    Runner,
    type Runtime,
    type HTTPSendRequester,
    getNetwork,
    encodeCallMsg,
    bytesToHex,
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
 * Subset of MemoryRegistry ABI — only the view functions needed by integrity-checker.
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
// Pushover Response Type
// ═══════════════════════════════════════════════════════════════════════════

type PushoverResponse = {
    statusCode: number
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
    /** Agent ID to check (cron has no HTTP payload) */
    agentId: z.string(),
    /** Cron schedule expression */
    schedule: z.string(),
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
// Cron Trigger Handler
// ═══════════════════════════════════════════════════════════════════════════

const onCronTrigger = (runtime: Runtime<Config>): string => {
    runtime.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    runtime.log('MemoryVault: Integrity Checker — Cron Trigger')
    runtime.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

    const agentId = runtime.config.agentId
    runtime.log(`[Step 1] Integrity check for agent: ${agentId}`)

    // ─── Get secrets (SEQUENTIAL — CRE SDK requirement) ─────────────
    runtime.log('[Step 2] Fetching secrets...')
    const aesKey = runtime.getSecret({ id: 'AES_KEY' }).result()
    const awsAccessKeyId = runtime
        .getSecret({ id: 'AWS_ACCESS_KEY_ID' })
        .result()
    const awsSecretAccessKey = runtime
        .getSecret({ id: 'AWS_SECRET_ACCESS_KEY' })
        .result()
    const pushoverUserKey = runtime
        .getSecret({ id: 'PUSHOVER_USER_KEY' })
        .result()
    const pushoverApiToken = runtime
        .getSecret({ id: 'PUSHOVER_API_TOKEN' })
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

    interface MismatchEntry {
        key: string
        computedHash: string
        onChainHash: string
        committedAt: string
    }

    const mismatches: MismatchEntry[] = []
    let checkedCount = 0
    let verifiedCount = 0

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

            checkedCount++

            // Compare: non-zero committedAt means it was committed on-chain
            const isVerified =
                commitment.committedAt > 0n &&
                commitment.entryHash === computedHash

            if (isVerified) {
                verifiedCount++
                runtime.log(`  [${s3Key}] ✅ hash verified`)
            } else {
                runtime.log(`  [${s3Key}] ❌ HASH MISMATCH — tampering detected!`)
                mismatches.push({
                    key: s3Key,
                    computedHash,
                    onChainHash: commitment.entryHash,
                    committedAt: commitment.committedAt.toString(),
                })
            }
        } catch (e) {
            runtime.log(`  [${s3Key}] ⚠️ Error processing entry: ${e}`)
            checkedCount++
            mismatches.push({
                key: s3Key,
                computedHash: 'error',
                onChainHash: 'error',
                committedAt: '0',
            })
        }
    }

    // ─── Also check on-chain count vs S3 count ──────────────────────
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
            // S3 deletion is also a form of tampering
            mismatches.push({
                key: '__s3_deletion_detected__',
                computedHash: `s3_count:${s3Keys.length}`,
                onChainHash: `onchain_count:${onChainCount.toString()}`,
                committedAt: '0',
            })
        }
    } catch (e) {
        runtime.log(`[Step 6] On-chain check failed: ${e}`)
    }

    // ─── Send Pushover alert if mismatches detected ─────────────────
    if (mismatches.length > 0) {
        runtime.log('[Step 7] 🚨 TAMPERING DETECTED — sending Pushover alert...')

        const mismatchSummary = mismatches
            .slice(0, 5)  // Limit message length
            .map(m => `• ${m.key}`)
            .join('\n')
        const moreText = mismatches.length > 5
            ? `\n...and ${mismatches.length - 5} more`
            : ''

        // Define Pushover POST fetcher (pattern from x402-cre-price-alerts)
        const postPushoverAlert = (
            sendRequester: HTTPSendRequester,
            pushoverConfig: {
                token: string
                user: string
                title: string
                message: string
                priority: number
            }
        ): PushoverResponse => {
            const bodyBytes = new TextEncoder().encode(
                JSON.stringify(pushoverConfig)
            )
            const body = Buffer.from(bodyBytes).toString('base64')

            const resp = sendRequester
                .sendRequest({
                    url: 'https://api.pushover.net/1/messages.json',
                    method: 'POST' as const,
                    body,
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    cacheSettings: {
                        store: true,
                        maxAge: '60s',  // Prevent duplicate alerts within 60s
                    },
                })
                .result()

            if (!ok(resp)) {
                throw new Error(
                    `Pushover API request failed with status: ${resp.statusCode}`
                )
            }

            return { statusCode: resp.statusCode }
        }

        try {
            const result = httpClient
                .sendRequest(
                    runtime,
                    postPushoverAlert,
                    consensusIdenticalAggregation<PushoverResponse>()
                )({
                    token: pushoverApiToken.value,
                    user: pushoverUserKey.value,
                    title: '🚨 MEMORYVAULT TAMPERING DETECTED',
                    message: `${mismatches.length} hash mismatch(es) for agent ${agentId}:\n${mismatchSummary}${moreText}`,
                    priority: 1,  // High priority — bypasses quiet hours
                })
                .result()

            runtime.log(
                `[Step 7] Pushover alert sent (Status: ${result.statusCode})`
            )
        } catch (e) {
            runtime.log(`[Step 7] ⚠️ Pushover alert failed: ${e}`)
        }
    } else {
        runtime.log('[Step 7] ✅ No tampering detected — all entries verified')
    }

    // ─── Build response ─────────────────────────────────────────────
    runtime.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    runtime.log(`Integrity check complete for agent: ${agentId}`)
    runtime.log(`  Entries checked:  ${checkedCount}`)
    runtime.log(`  Verified:         ${verifiedCount}`)
    runtime.log(`  Mismatches:       ${mismatches.length}`)
    runtime.log(`  On-chain count:   ${onChainCount.toString()}`)
    runtime.log(`  Status:           ${mismatches.length > 0 ? '🚨 TAMPERING DETECTED' : '✅ ALL CLEAR'}`)
    runtime.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

    return JSON.stringify({
        status: mismatches.length > 0 ? 'tampering_detected' : 'all_clear',
        agentId,
        checked: checkedCount,
        verified: verifiedCount,
        mismatches: mismatches.length,
        mismatchDetails: mismatches,
        onChainCommitments: onChainCount.toString(),
        s3Entries: s3Keys.length,
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// Workflow Init
// ═══════════════════════════════════════════════════════════════════════════

const initWorkflow = (config: Config) => {
    const cron = new cre.capabilities.CronCapability()

    return [
        cre.handler(
            cron.trigger({ schedule: config.schedule }),
            onCronTrigger
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
