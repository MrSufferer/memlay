import { createDecipheriv, createHash, createHmac } from 'node:crypto'
import { keccak256, toHex } from 'viem'
import type { MemoryEntryData } from '../../../cre-memoryvault/protocol/tool-interface'
import type { HederaMemoryConfig } from './runtime'

interface MirrorNodeTopicMessage {
    consensusTimestamp: string
    message: string
    sequenceNumber: number
    topicId: string
}

export interface HederaMemoryCommitment {
    agentId: string
    entryKey: string
    entryHash: string
    timestamp: string
    blobUri: string
    topicId: string
    sequenceNumber: number
    consensusTimestamp: string
    committedAt: string
}

export interface HederaVerifiedMemoryEntry extends HederaMemoryCommitment {
    valid: boolean
    observedEntryHash?: string
    data?: MemoryEntryData & { timestamp?: string }
    error?: string
}

export interface HederaMemoryVerificationResult {
    allValid: boolean
    entries: HederaVerifiedMemoryEntry[]
}

export interface HederaMemoryVerifier {
    list(agentId: string): Promise<HederaMemoryCommitment[]>
    verify(agentId: string): Promise<HederaMemoryVerificationResult>
}

export interface HederaTopicMessageReader {
    listMessages(args: {
        mirrorNodeUrl: string
        topicId: string
    }): Promise<MirrorNodeTopicMessage[]>
}

export interface HederaBlobReader {
    get(args: {
        bucket: string
        region: string
        key: string
        accessKeyId: string
        secretAccessKey: string
        now: Date
    }): Promise<{ uri: string; body: string }>
}

export interface HederaMirrorNodeMemoryVerifierOptions {
    config: HederaMemoryConfig
    mirrorNodeUrl: string
    topicMessageReader?: HederaTopicMessageReader
    blobReader?: HederaBlobReader
    now?: () => Date
}

function normalizeOptional(value: string | undefined): string | undefined {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
}

function sha256Hex(data: string): string {
    return createHash('sha256').update(data, 'utf8').digest('hex')
}

function formatAmzDate(date: Date): string {
    return date.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

function deriveSigningKey(
    secretKey: string,
    dateStamp: string,
    region: string,
    service: string
): Buffer {
    const kDate = createHmac('sha256', `AWS4${secretKey}`).update(dateStamp).digest()
    const kRegion = createHmac('sha256', kDate).update(region).digest()
    const kService = createHmac('sha256', kRegion).update(service).digest()
    return createHmac('sha256', kService).update('aws4_request').digest()
}

function buildS3GetHeaders(args: {
    bucket: string
    region: string
    key: string
    accessKeyId: string
    secretAccessKey: string
    now: Date
}): Record<string, string> {
    const host = `${args.bucket}.s3.${args.region}.amazonaws.com`
    const amzDate = formatAmzDate(args.now)
    const dateStamp = amzDate.slice(0, 8)
    const payloadHash = sha256Hex('')
    const canonicalHeaders =
        `host:${host}\n` +
        `x-amz-content-sha256:${payloadHash}\n` +
        `x-amz-date:${amzDate}\n`
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
    const canonicalRequest = [
        'GET',
        `/${args.key}`,
        '',
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join('\n')
    const credentialScope = `${dateStamp}/${args.region}/s3/aws4_request`
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        sha256Hex(canonicalRequest),
    ].join('\n')
    const signingKey = deriveSigningKey(
        args.secretAccessKey,
        dateStamp,
        args.region,
        's3'
    )
    const signature = createHmac('sha256', signingKey)
        .update(stringToSign)
        .digest('hex')

    return {
        Host: host,
        'X-Amz-Content-Sha256': payloadHash,
        'X-Amz-Date': amzDate,
        Authorization:
            `AWS4-HMAC-SHA256 Credential=${args.accessKeyId}/${credentialScope}, ` +
            `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    }
}

function parseS3Uri(uri: string): { bucket: string; key: string } {
    if (!uri.startsWith('s3://')) {
        throw new Error(`[hedera-memory] Unsupported blob URI: ${uri}`)
    }

    const withoutScheme = uri.slice('s3://'.length)
    const slashIndex = withoutScheme.indexOf('/')
    if (slashIndex === -1) {
        throw new Error(`[hedera-memory] Blob URI is missing an object key: ${uri}`)
    }

    return {
        bucket: withoutScheme.slice(0, slashIndex),
        key: withoutScheme.slice(slashIndex + 1),
    }
}

function decodeMirrorMessage(encodedMessage: string): string {
    return Buffer.from(encodedMessage, 'base64').toString('utf8')
}

function decryptMemoryEnvelope(
    ciphertextEnvelope: string,
    keyHex: string
): string {
    const normalizedKey = keyHex.startsWith('0x') ? keyHex.slice(2) : keyHex
    const key = Buffer.from(normalizedKey, 'hex')
    if (key.length !== 32) {
        throw new Error('[hedera-memory] AES_KEY_VAR must be a 32-byte hex string')
    }

    const envelope = JSON.parse(ciphertextEnvelope) as {
        iv?: string
        ciphertext?: string
        authTag?: string
    }
    if (!envelope.iv || !envelope.ciphertext || !envelope.authTag) {
        throw new Error('[hedera-memory] Blob payload is not a valid encrypted memory envelope')
    }

    const iv = Buffer.from(envelope.iv, 'base64')
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64')
    const authTag = Buffer.from(envelope.authTag, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)

    return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ]).toString('utf8')
}

function toIsoTimestamp(consensusTimestamp: string): string {
    const [secondsPart, fractionalPart = ''] = consensusTimestamp.split('.')
    const seconds = Number(secondsPart)
    const milliseconds = Number((fractionalPart + '000').slice(0, 3))

    if (!Number.isFinite(seconds)) {
        return consensusTimestamp
    }

    return new Date(seconds * 1000 + milliseconds).toISOString()
}

function isMemoryEntryData(value: unknown): value is MemoryEntryData & { timestamp?: string } {
    return Boolean(value) && typeof value === 'object'
}

function parseCommitmentMessage(
    rawMessage: string,
    sequenceNumber: number,
    topicId: string,
    consensusTimestamp: string
): HederaMemoryCommitment | null {
    let decoded: unknown
    try {
        decoded = JSON.parse(rawMessage)
    } catch {
        return null
    }

    if (!decoded || typeof decoded !== 'object') {
        return null
    }

    const candidate = decoded as Record<string, unknown>
    if (
        candidate.version !== 'memoryvault-hedera/v1' ||
        typeof candidate.agentId !== 'string' ||
        typeof candidate.entryKey !== 'string' ||
        typeof candidate.entryHash !== 'string' ||
        typeof candidate.timestamp !== 'string' ||
        typeof candidate.blobUri !== 'string'
    ) {
        return null
    }

    return {
        agentId: candidate.agentId,
        entryKey: candidate.entryKey,
        entryHash: candidate.entryHash,
        timestamp: candidate.timestamp,
        blobUri: candidate.blobUri,
        topicId,
        sequenceNumber,
        consensusTimestamp,
        committedAt: toIsoTimestamp(consensusTimestamp),
    }
}

class MirrorNodeTopicReader implements HederaTopicMessageReader {
    async listMessages(args: {
        mirrorNodeUrl: string
        topicId: string
    }): Promise<MirrorNodeTopicMessage[]> {
        const rootUrl = args.mirrorNodeUrl.replace(/\/+$/, '')
        const visited = new Set<string>()
        const messages: MirrorNodeTopicMessage[] = []
        let nextUrl = `${rootUrl}/topics/${args.topicId}/messages?order=asc&limit=100`

        while (nextUrl) {
            if (visited.has(nextUrl)) {
                break
            }
            visited.add(nextUrl)

            const response = await fetch(nextUrl)
            if (!response.ok) {
                throw new Error(
                    `[hedera-memory] Mirror-node request failed for ${nextUrl}: ` +
                    `${response.status} ${response.statusText}`
                )
            }

            const payload = await response.json() as {
                messages?: Array<Record<string, unknown>>
                links?: { next?: string | null }
            }

            for (const message of payload.messages ?? []) {
                const sequenceNumber = Number(message.sequence_number)
                const encoded = normalizeOptional(String(message.message ?? ''))
                const consensusTimestamp = String(message.consensus_timestamp ?? '')
                if (!encoded || !Number.isFinite(sequenceNumber) || !consensusTimestamp) {
                    continue
                }

                messages.push({
                    topicId: String(message.topic_id ?? args.topicId),
                    sequenceNumber,
                    consensusTimestamp,
                    message: encoded,
                })
            }

            const next = normalizeOptional(payload.links?.next ?? undefined)
            nextUrl = next ? new URL(next, `${rootUrl}/`).toString() : ''
        }

        return messages
    }
}

class S3HederaBlobReader implements HederaBlobReader {
    async get(args: {
        bucket: string
        region: string
        key: string
        accessKeyId: string
        secretAccessKey: string
        now: Date
    }): Promise<{ uri: string; body: string }> {
        const host = `${args.bucket}.s3.${args.region}.amazonaws.com`
        const response = await fetch(`https://${host}/${args.key}`, {
            method: 'GET',
            headers: buildS3GetHeaders(args),
        })

        if (!response.ok) {
            throw new Error(
                `[hedera-memory] S3 GET failed for s3://${args.bucket}/${args.key}: ` +
                `${response.status} ${response.statusText}`
            )
        }

        return {
            uri: `s3://${args.bucket}/${args.key}`,
            body: await response.text(),
        }
    }
}

export class HederaMirrorNodeMemoryVerifier implements HederaMemoryVerifier {
    private readonly topicMessageReader: HederaTopicMessageReader
    private readonly blobReader: HederaBlobReader
    private readonly now: () => Date

    constructor(private readonly options: HederaMirrorNodeMemoryVerifierOptions) {
        this.topicMessageReader = options.topicMessageReader ?? new MirrorNodeTopicReader()
        this.blobReader = options.blobReader ?? new S3HederaBlobReader()
        this.now = options.now ?? (() => new Date())
    }

    async list(agentId: string): Promise<HederaMemoryCommitment[]> {
        const messages = await this.topicMessageReader.listMessages({
            mirrorNodeUrl: this.options.mirrorNodeUrl,
            topicId: this.options.config.topicId,
        })

        return messages
            .map((message) =>
                parseCommitmentMessage(
                    decodeMirrorMessage(message.message),
                    message.sequenceNumber,
                    message.topicId,
                    message.consensusTimestamp
                )
            )
            .filter((entry): entry is HederaMemoryCommitment => Boolean(entry))
            .filter((entry) => entry.agentId === agentId)
            .sort((left, right) => left.sequenceNumber - right.sequenceNumber)
    }

    async verify(agentId: string): Promise<HederaMemoryVerificationResult> {
        const commitments = await this.list(agentId)
        const entries = await Promise.all(
            commitments.map(async (commitment) => {
                try {
                    const location = parseS3Uri(commitment.blobUri)
                    const blob = await this.blobReader.get({
                        bucket: location.bucket,
                        region: this.options.config.s3Region,
                        key: location.key,
                        accessKeyId: this.options.config.awsAccessKeyId,
                        secretAccessKey: this.options.config.awsSecretAccessKey,
                        now: this.now(),
                    })
                    const plaintext = decryptMemoryEnvelope(
                        blob.body,
                        this.options.config.encryptionKeyHex
                    )
                    const observedEntryHash = keccak256(toHex(plaintext))
                    const decodedEntry = JSON.parse(plaintext) as unknown
                    const data = isMemoryEntryData(decodedEntry)
                        ? decodedEntry
                        : undefined
                    const timestampMatches =
                        typeof data?.timestamp === 'string' &&
                        data.timestamp === commitment.timestamp
                    const hashMatches = observedEntryHash === commitment.entryHash

                    return {
                        ...commitment,
                        valid: hashMatches && timestampMatches,
                        observedEntryHash,
                        data,
                        error:
                            !hashMatches
                                ? 'Blob hash mismatch'
                                : !timestampMatches
                                    ? 'Blob timestamp mismatch'
                                    : undefined,
                    } satisfies HederaVerifiedMemoryEntry
                } catch (error) {
                    return {
                        ...commitment,
                        valid: false,
                        error: error instanceof Error ? error.message : String(error),
                    } satisfies HederaVerifiedMemoryEntry
                }
            })
        )

        return {
            allValid: entries.every((entry) => entry.valid),
            entries,
        }
    }
}
