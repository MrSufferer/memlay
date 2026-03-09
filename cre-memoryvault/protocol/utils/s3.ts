/**
 * MemoryVault Agent Protocol — S3 Storage Utilities
 *
 * Provides SigV4-signed S3 PUT, GET, and LIST operations using CRE's HTTPClient.
 * The CRE SDK has no built-in S3 client, so we use raw HTTP with AWS Signature
 * Version 4 signing.
 *
 * CRE WASM CONSTRAINTS:
 * - No `Bun.*` APIs, no `crypto.*` globals
 * - Uses viem's keccak256 for hashing (only hash available in WASM)
 * - HMAC-SHA256 approximated via keccak256 for simulation
 *
 * For simulation purposes, the SigV4 signing uses keccak256 instead of
 * HMAC-SHA256. Real AWS S3 requires proper HMAC-SHA256, but since CRE
 * simulation doesn't actually write to S3 (the HTTP request will be
 * simulated), this is acceptable.
 *
 * @module protocol/utils/s3
 */

import { keccak256Hash, hexToBytes } from './crypto'

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface AWSCredentials {
    accessKeyId: string
    secretAccessKey: string
}

export interface S3Config {
    s3Bucket: string
    s3Region: string
}

// ═══════════════════════════════════════════════════════════════════════════
// SigV4 Signing (Simulation)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute a hash for SigV4 signing.
 * Returns hex string without 0x prefix.
 *
 * In real AWS SigV4, this would be SHA-256. In CRE simulation,
 * we use keccak256 via viem since it's the only hash available.
 */
function hashHex(data: string): string {
    const h = keccak256Hash(data)
    return h.startsWith('0x') ? h.slice(2) : h
}

/**
 * Simulate HMAC-SHA256 using keccak256.
 *
 * Real AWS SigV4 requires HMAC-SHA256 which needs Web Crypto or
 * native node:crypto. In CRE WASM, we approximate using keccak256
 * of the concatenated key + data. This produces valid-looking
 * signatures for simulation.
 */
function hmacHex(key: string, data: string): string {
    return hashHex(key + data)
}

/**
 * Generate AWS Signature Version 4 authorization header (simulation).
 *
 * The signature computation uses keccak256 instead of HMAC-SHA256.
 * This produces structurally correct SigV4 headers that work for
 * CRE simulation, but would not authenticate against real AWS.
 */
function computeSigV4(
    creds: AWSCredentials,
    service: string,
    region: string,
    dateStamp: string,
    amzDate: string,
    method: string,
    canonicalUri: string,
    host: string,
    payload: string,
    queryString: string = ''
): string {
    const payloadHash = hashHex(payload)

    // 1. Canonical Headers
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'

    // 2. Canonical Request
    const canonicalRequest = [
        method,
        canonicalUri,
        queryString,
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join('\n')

    // 3. String to Sign
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        hashHex(canonicalRequest),
    ].join('\n')

    // 4. Signing Key (simulated HMAC chain)
    const kDate = hmacHex(`AWS4${creds.secretAccessKey}`, dateStamp)
    const kRegion = hmacHex(kDate, region)
    const kService = hmacHex(kRegion, service)
    const kSigning = hmacHex(kService, 'aws4_request')

    // 5. Signature
    const signature = hmacHex(kSigning, stringToSign)

    return `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
}

// ═══════════════════════════════════════════════════════════════════════════
// Date Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the current UTC date components for SigV4 signing.
 * Uses Date constructor (available in CRE WASM — only Date.now()
 * is forbidden for timestamps).
 */
function getDateComponents(): { dateStamp: string; amzDate: string } {
    const now = new Date()
    const dateStamp = now.toISOString().replace(/[-:]/g, '').slice(0, 8)
    const amzDate =
        dateStamp +
        'T' +
        now.toISOString().replace(/[-:]/g, '').slice(9, 15) +
        'Z'
    return { dateStamp, amzDate }
}

// ═══════════════════════════════════════════════════════════════════════════
// S3 Operations
// ═══════════════════════════════════════════════════════════════════════════

/**
 * SigV4-signed S3 PUT. Writes a blob to S3 using raw HTTP via CRE's HTTPClient.
 *
 * @param runtime - CRE Runtime (for logging)
 * @param httpClient - CRE HTTPClient instance
 * @param config - S3 bucket and region
 * @param creds - AWS access key and secret
 * @param key - S3 object key
 * @param body - The data to write
 */
export function s3Put(
    runtime: { log: (msg: string) => void },
    httpClient: any,
    config: S3Config,
    creds: AWSCredentials,
    key: string,
    body: string
): void {
    const host = `${config.s3Bucket}.s3.${config.s3Region}.amazonaws.com`
    const { dateStamp, amzDate } = getDateComponents()
    const payloadHash = hashHex(body)

    const authorization = computeSigV4(
        creds,
        's3',
        config.s3Region,
        dateStamp,
        amzDate,
        'PUT',
        `/${key}`,
        host,
        body
    )

    runtime.log(`[S3] PUT s3://${config.s3Bucket}/${key}`)

    httpClient.sendRequest({
        request: {
            url: `https://${host}/${key}`,
            method: 'PUT',
            body,
            multiHeaders: {
                Host: { values: [host] },
                'X-Amz-Date': { values: [amzDate] },
                'X-Amz-Content-Sha256': { values: [payloadHash] },
                Authorization: { values: [authorization] },
                'Content-Type': { values: ['application/octet-stream'] },
            },
        },
    })
}

/**
 * SigV4-signed S3 GET. Reads a single object from S3.
 */
export function s3Get(
    httpClient: any,
    config: S3Config,
    creds: AWSCredentials,
    key: string
): string {
    const host = `${config.s3Bucket}.s3.${config.s3Region}.amazonaws.com`
    const { dateStamp, amzDate } = getDateComponents()

    const authorization = computeSigV4(
        creds,
        's3',
        config.s3Region,
        dateStamp,
        amzDate,
        'GET',
        `/${key}`,
        host,
        ''
    )

    const resp = httpClient.sendRequest({
        request: {
            url: `https://${host}/${key}`,
            method: 'GET',
            multiHeaders: {
                Host: { values: [host] },
                'X-Amz-Date': { values: [amzDate] },
                'X-Amz-Content-Sha256': { values: [hashHex('')] },
                Authorization: { values: [authorization] },
            },
        },
    })

    return new TextDecoder().decode(resp.result().body)
}

/**
 * Parse S3 ListBucketResult XML to extract object keys.
 */
export function parseS3ListResponse(xml: string): string[] {
    const keys: string[] = []
    const regex = /<Key>(.*?)<\/Key>/g
    let match
    while ((match = regex.exec(xml)) !== null) {
        keys.push(match[1])
    }
    return keys
}

/**
 * SigV4-signed S3 list + read. Lists all objects under a prefix,
 * then reads each one. Returns array of { key, data } entries.
 */
export function s3ListAndRead(
    httpClient: any,
    config: S3Config,
    creds: AWSCredentials,
    prefix: string
): Array<{ key: string; data: any }> {
    const host = `${config.s3Bucket}.s3.${config.s3Region}.amazonaws.com`
    const { dateStamp, amzDate } = getDateComponents()

    const listAuth = computeSigV4(
        creds,
        's3',
        config.s3Region,
        dateStamp,
        amzDate,
        'GET',
        '/',
        host,
        '',
        `prefix=${encodeURIComponent(prefix)}`
    )

    const listResp = httpClient.sendRequest({
        request: {
            url: `https://${host}/?prefix=${encodeURIComponent(prefix)}`,
            method: 'GET',
            multiHeaders: {
                Host: { values: [host] },
                'X-Amz-Date': { values: [amzDate] },
                'X-Amz-Content-Sha256': { values: [hashHex('')] },
                Authorization: { values: [listAuth] },
            },
        },
    })

    const keys = parseS3ListResponse(
        new TextDecoder().decode(listResp.result().body)
    )

    return keys.map((objKey) => {
        const data = s3Get(httpClient, config, creds, objKey)
        return { key: objKey, data: JSON.parse(data) }
    })
}
