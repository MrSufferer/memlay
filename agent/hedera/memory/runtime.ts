import { createCipheriv, createHash, createHmac } from 'node:crypto'
import { keccak256, toHex } from 'viem'
import type { MemoryEntryData } from '../../../cre-memoryvault/protocol/tool-interface'
import type { HederaEnvConfig, HederaNetwork } from '../env'

export interface HederaMemoryCommitRequest {
    agentId: string
    entryKey: string
    entryData: MemoryEntryData
}

export interface HederaMemoryCommitResult {
    topicId: string
    sequenceNumber: number
    transactionId?: string
    entryHash: string
    timestamp: string
    blobUri: string
    s3Key: string
    commitmentMessage: string
}

export interface HederaMemoryConfig {
    network: HederaNetwork
    topicId: string
    encryptionKeyHex: string
    s3Bucket: string
    s3Region: string
    s3Prefix: string
    awsAccessKeyId: string
    awsSecretAccessKey: string
    signerAccountId: string
    signerPrivateKey: string
}

export interface HederaBlobStore {
    put(args: {
        bucket: string
        region: string
        key: string
        body: string
        accessKeyId: string
        secretAccessKey: string
        now: Date
    }): Promise<{ uri: string }>
}

export interface HederaTopicPublisher {
    publish(args: {
        network: HederaNetwork
        topicId: string
        message: string
        accountId: string
        privateKey: string
    }): Promise<{
        topicId: string
        sequenceNumber: number
        transactionId?: string
    }>
}

export interface HederaMemoryRuntimeOptions {
    config: HederaMemoryConfig
    blobStore?: HederaBlobStore
    topicPublisher?: HederaTopicPublisher
    now?: () => Date
}

function normalizeOptional(value: string | undefined): string | undefined {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
}

function requireEnvValue(
    env: Record<string, string | undefined>,
    names: string[]
): string {
    for (const name of names) {
        const value = normalizeOptional(env[name])
        if (value) {
            return value
        }
    }

    throw new Error(
        `[hedera-memory] Missing required environment variable. Expected one of: ${names.join(', ')}`
    )
}

function normalizePrefix(value: string | undefined): string {
    const normalized = normalizeOptional(value) ?? 'agents'
    return normalized.replace(/^\/+|\/+$/g, '')
}

export function loadHederaMemoryConfig(
    env: HederaEnvConfig,
    rawEnv: Record<string, string | undefined> = process.env
): HederaMemoryConfig {
    if (!env.memoryTopicId) {
        throw new Error('[hedera-memory] HEDERA_MEMORY_TOPIC_ID is required for Hedera memory commits')
    }

    return {
        network: env.network,
        topicId: env.memoryTopicId,
        encryptionKeyHex: requireEnvValue(rawEnv, ['AES_KEY_VAR', 'AES_KEY']),
        s3Bucket: requireEnvValue(rawEnv, ['HEDERA_MEMORY_S3_BUCKET', 'S3_BUCKET']),
        s3Region: requireEnvValue(rawEnv, ['HEDERA_MEMORY_S3_REGION', 'S3_REGION']),
        s3Prefix: normalizePrefix(rawEnv.HEDERA_MEMORY_S3_PREFIX),
        awsAccessKeyId: requireEnvValue(rawEnv, ['AWS_ACCESS_KEY_ID_VAR', 'AWS_ACCESS_KEY_ID']),
        awsSecretAccessKey: requireEnvValue(rawEnv, [
            'AWS_SECRET_ACCESS_KEY_VAR',
            'AWS_SECRET_ACCESS_KEY',
        ]),
        signerAccountId: env.controlPlaneSigner.accountId,
        signerPrivateKey: env.controlPlaneSigner.privateKey,
    }
}

function keccak256Hash(data: string): string {
    return keccak256(toHex(data))
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

function buildS3PutHeaders(args: {
    bucket: string
    region: string
    key: string
    body: string
    accessKeyId: string
    secretAccessKey: string
    now: Date
}): Record<string, string> {
    const host = `${args.bucket}.s3.${args.region}.amazonaws.com`
    const amzDate = formatAmzDate(args.now)
    const dateStamp = amzDate.slice(0, 8)
    const payloadHash = sha256Hex(args.body)
    const canonicalHeaders =
        `content-type:application/octet-stream\nhost:${host}\n` +
        `x-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date'
    const canonicalRequest = [
        'PUT',
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
        'Content-Type': 'application/octet-stream',
        'X-Amz-Content-Sha256': payloadHash,
        'X-Amz-Date': amzDate,
        Authorization:
            `AWS4-HMAC-SHA256 Credential=${args.accessKeyId}/${credentialScope}, ` +
            `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    }
}

export function encryptMemoryPlaintext(
    plaintext: string,
    keyHex: string
): string {
    const normalizedKey = keyHex.startsWith('0x') ? keyHex.slice(2) : keyHex
    const key = Buffer.from(normalizedKey, 'hex')
    if (key.length !== 32) {
        throw new Error('[hedera-memory] AES_KEY_VAR must be a 32-byte hex string')
    }

    const iv = Buffer.from(keccak256Hash(plaintext).slice(2, 26), 'hex')
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
    ])
    const authTag = cipher.getAuthTag()

    return JSON.stringify({
        version: 1,
        algorithm: 'aes-256-gcm',
        iv: iv.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        authTag: authTag.toString('base64'),
    })
}

export function buildHederaMemoryCommitmentMessage(args: {
    agentId: string
    entryKey: string
    entryHash: string
    timestamp: string
    blobUri: string
}): string {
    return JSON.stringify({
        version: 'memoryvault-hedera/v1',
        agentId: args.agentId,
        entryKey: args.entryKey,
        entryHash: args.entryHash,
        timestamp: args.timestamp,
        blobUri: args.blobUri,
    })
}

class S3HederaBlobStore implements HederaBlobStore {
    async put(args: {
        bucket: string
        region: string
        key: string
        body: string
        accessKeyId: string
        secretAccessKey: string
        now: Date
    }): Promise<{ uri: string }> {
        const host = `${args.bucket}.s3.${args.region}.amazonaws.com`
        const response = await fetch(
            `https://${host}/${args.key}`,
            {
                method: 'PUT',
                headers: buildS3PutHeaders(args),
                body: args.body,
            }
        )

        if (!response.ok) {
            throw new Error(
                `[hedera-memory] S3 PUT failed for s3://${args.bucket}/${args.key}: ` +
                `${response.status} ${response.statusText}`
            )
        }

        return {
            uri: `s3://${args.bucket}/${args.key}`,
        }
    }
}

class HederaSdkTopicPublisher implements HederaTopicPublisher {
    async publish(args: {
        network: HederaNetwork
        topicId: string
        message: string
        accountId: string
        privateKey: string
    }): Promise<{
        topicId: string
        sequenceNumber: number
        transactionId?: string
    }> {
        const sdk = await import('@hashgraph/sdk')
        const client = sdk.Client.forName(args.network)
        client.setOperator(
            sdk.AccountId.fromString(args.accountId),
            sdk.PrivateKey.fromString(args.privateKey)
        )

        try {
            const response = await new sdk.TopicMessageSubmitTransaction()
                .setTopicId(sdk.TopicId.fromString(args.topicId))
                .setMessage(args.message)
                .execute(client)
            const receipt = await response.getReceipt(client)
            const rawSequence = (receipt as { topicSequenceNumber?: number | { toNumber: () => number } }).topicSequenceNumber
            const sequenceNumber =
                typeof rawSequence === 'number'
                    ? rawSequence
                    : rawSequence?.toNumber() ?? 0

            return {
                topicId: args.topicId,
                sequenceNumber,
                transactionId: response.transactionId?.toString(),
            }
        } finally {
            client.close()
        }
    }
}

export class HederaMemoryRuntime {
    private readonly blobStore: HederaBlobStore
    private readonly topicPublisher: HederaTopicPublisher
    private readonly now: () => Date

    constructor(private readonly options: HederaMemoryRuntimeOptions) {
        this.blobStore = options.blobStore ?? new S3HederaBlobStore()
        this.topicPublisher = options.topicPublisher ?? new HederaSdkTopicPublisher()
        this.now = options.now ?? (() => new Date())
    }

    async commitEntry(
        args: HederaMemoryCommitRequest
    ): Promise<HederaMemoryCommitResult> {
        const timestamp = this.now().toISOString()
        const plaintext = JSON.stringify({
            ...args.entryData,
            timestamp,
        })
        const entryHash = keccak256Hash(plaintext)
        const encryptedBlob = encryptMemoryPlaintext(
            plaintext,
            this.options.config.encryptionKeyHex
        )
        const s3Key = `${this.options.config.s3Prefix}/${args.agentId}/log/${args.entryKey}`

        const blob = await this.blobStore.put({
            bucket: this.options.config.s3Bucket,
            region: this.options.config.s3Region,
            key: s3Key,
            body: encryptedBlob,
            accessKeyId: this.options.config.awsAccessKeyId,
            secretAccessKey: this.options.config.awsSecretAccessKey,
            now: new Date(timestamp),
        })

        const commitmentMessage = buildHederaMemoryCommitmentMessage({
            agentId: args.agentId,
            entryKey: args.entryKey,
            entryHash,
            timestamp,
            blobUri: blob.uri,
        })

        const commit = await this.topicPublisher.publish({
            network: this.options.config.network,
            topicId: this.options.config.topicId,
            message: commitmentMessage,
            accountId: this.options.config.signerAccountId,
            privateKey: this.options.config.signerPrivateKey,
        })

        return {
            topicId: commit.topicId,
            sequenceNumber: commit.sequenceNumber,
            transactionId: commit.transactionId,
            entryHash,
            timestamp,
            blobUri: blob.uri,
            s3Key,
            commitmentMessage,
        }
    }
}
