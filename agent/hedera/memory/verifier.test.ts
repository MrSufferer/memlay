import { describe, expect, it, vi } from 'vitest'
import { keccak256, toHex } from 'viem'
import type { HederaEnvConfig } from '../env'
import {
    buildHederaMemoryCommitmentMessage,
    encryptMemoryPlaintext,
    loadHederaMemoryConfig,
} from './runtime'
import { HederaMirrorNodeMemoryVerifier } from './verifier'

function makeEnv(): HederaEnvConfig {
    return {
        network: 'testnet',
        operatorAccountId: '0.0.1001',
        operatorPrivateKey: 'operator-private-key',
        operatorPrivateKeySource: 'env',
        mirrorNodeUrl: 'https://mirror.example.com/api/v1',
        stateStorePath: '.agent/hedera-state.json',
        memoryTopicId: '0.0.8001',
        bonzoDataSource: 'mock',
        bonzoMinApyDeltaBps: 0,
        bonzoExecutorMode: 'operator',
        bonzoContractEnv: {},
        privateHttpMode: 'stub',
        controlPlaneSigner: {
            plane: 'control',
            owner: 'operator',
            accountId: '0.0.1001',
            privateKey: 'operator-private-key',
            privateKeySource: 'env',
        },
        executionSigner: {
            plane: 'execution',
            owner: 'operator',
            accountId: '0.0.1001',
            privateKey: 'operator-private-key',
            privateKeySource: 'env',
        },
        signersShareAccount: true,
    }
}

function makeRawEnv(): Record<string, string> {
    return {
        AES_KEY_VAR: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
        AWS_ACCESS_KEY_ID_VAR: 'aws-access-key',
        AWS_SECRET_ACCESS_KEY_VAR: 'aws-secret-key',
        HEDERA_MEMORY_S3_BUCKET: 'memory-layer',
        HEDERA_MEMORY_S3_REGION: 'ap-southeast-2',
        HEDERA_MEMORY_S3_PREFIX: 'agents',
    }
}

function encodeCommitmentMessage(args: {
    agentId: string
    entryKey: string
    plaintext: string
    timestamp: string
    blobUri: string
}): string {
    return Buffer.from(
        buildHederaMemoryCommitmentMessage({
            agentId: args.agentId,
            entryKey: args.entryKey,
            entryHash: keccak256(toHex(args.plaintext)),
            timestamp: args.timestamp,
            blobUri: args.blobUri,
        }),
        'utf8'
    ).toString('base64')
}

describe('HederaMirrorNodeMemoryVerifier', () => {
    it('reconstructs ordered entries from mirror-node sequence numbers', async () => {
        const config = loadHederaMemoryConfig(makeEnv(), makeRawEnv())
        const firstTimestamp = '2026-03-23T00:00:00.000Z'
        const secondTimestamp = '2026-03-23T00:05:00.000Z'
        const firstPlaintext = JSON.stringify({
            action: 'lp-entry',
            toolId: 'bonzo-vaults',
            reasoning: 'enter the highest APY vault',
            timestamp: firstTimestamp,
        })
        const secondPlaintext = JSON.stringify({
            action: 'lp-entry-confirmed',
            toolId: 'bonzo-vaults',
            timestamp: secondTimestamp,
        })
        const blobBodies = new Map<string, string>([
            [
                'agents/agent-alpha-01/log/decision:1',
                encryptMemoryPlaintext(firstPlaintext, config.encryptionKeyHex),
            ],
            [
                'agents/agent-alpha-01/log/decision:2',
                encryptMemoryPlaintext(secondPlaintext, config.encryptionKeyHex),
            ],
        ])
        const topicMessageReader = {
            listMessages: vi.fn().mockResolvedValue([
                {
                    topicId: config.topicId,
                    sequenceNumber: 8,
                    consensusTimestamp: '1711152300.200000000',
                    message: encodeCommitmentMessage({
                        agentId: 'agent-alpha-01',
                        entryKey: 'decision:2',
                        plaintext: secondPlaintext,
                        timestamp: secondTimestamp,
                        blobUri: 's3://memory-layer/agents/agent-alpha-01/log/decision:2',
                    }),
                },
                {
                    topicId: config.topicId,
                    sequenceNumber: 7,
                    consensusTimestamp: '1711152000.100000000',
                    message: encodeCommitmentMessage({
                        agentId: 'agent-alpha-01',
                        entryKey: 'decision:1',
                        plaintext: firstPlaintext,
                        timestamp: firstTimestamp,
                        blobUri: 's3://memory-layer/agents/agent-alpha-01/log/decision:1',
                    }),
                },
                {
                    topicId: config.topicId,
                    sequenceNumber: 9,
                    consensusTimestamp: '1711152600.300000000',
                    message: encodeCommitmentMessage({
                        agentId: 'other-agent',
                        entryKey: 'decision:3',
                        plaintext: secondPlaintext,
                        timestamp: secondTimestamp,
                        blobUri: 's3://memory-layer/agents/other-agent/log/decision:3',
                    }),
                },
            ]),
        }
        const blobReader = {
            get: vi.fn().mockImplementation(async ({ key }: { key: string }) => ({
                uri: `s3://memory-layer/${key}`,
                body: blobBodies.get(key) ?? '',
            })),
        }
        const verifier = new HederaMirrorNodeMemoryVerifier({
            config,
            mirrorNodeUrl: makeEnv().mirrorNodeUrl,
            topicMessageReader,
            blobReader,
            now: () => new Date('2026-03-23T00:10:00.000Z'),
        })

        const result = await verifier.verify('agent-alpha-01')

        expect(result.allValid).toBe(true)
        expect(result.entries.map((entry) => entry.sequenceNumber)).toEqual([7, 8])
        expect(result.entries.map((entry) => entry.entryKey)).toEqual([
            'decision:1',
            'decision:2',
        ])
        expect(result.entries[0]?.data?.action).toBe('lp-entry')
        expect(result.entries[1]?.data?.action).toBe('lp-entry-confirmed')
        expect(blobReader.get).toHaveBeenCalledTimes(2)
    })

    it('marks entries unverified when the decrypted blob hash does not match the HCS commitment', async () => {
        const config = loadHederaMemoryConfig(makeEnv(), makeRawEnv())
        const timestamp = '2026-03-23T00:00:00.000Z'
        const committedPlaintext = JSON.stringify({
            action: 'lp-entry',
            toolId: 'bonzo-vaults',
            reasoning: 'committed version',
            timestamp,
        })
        const tamperedPlaintext = JSON.stringify({
            action: 'lp-entry',
            toolId: 'bonzo-vaults',
            reasoning: 'tampered version',
            timestamp,
        })
        const topicMessageReader = {
            listMessages: vi.fn().mockResolvedValue([
                {
                    topicId: config.topicId,
                    sequenceNumber: 12,
                    consensusTimestamp: '1711152000.000000000',
                    message: encodeCommitmentMessage({
                        agentId: 'agent-alpha-01',
                        entryKey: 'decision:12',
                        plaintext: committedPlaintext,
                        timestamp,
                        blobUri: 's3://memory-layer/agents/agent-alpha-01/log/decision:12',
                    }),
                },
            ]),
        }
        const blobReader = {
            get: vi.fn().mockResolvedValue({
                uri: 's3://memory-layer/agents/agent-alpha-01/log/decision:12',
                body: encryptMemoryPlaintext(tamperedPlaintext, config.encryptionKeyHex),
            }),
        }
        const verifier = new HederaMirrorNodeMemoryVerifier({
            config,
            mirrorNodeUrl: makeEnv().mirrorNodeUrl,
            topicMessageReader,
            blobReader,
        })

        const result = await verifier.verify('agent-alpha-01')

        expect(result.allValid).toBe(false)
        expect(result.entries).toHaveLength(1)
        expect(result.entries[0]?.valid).toBe(false)
        expect(result.entries[0]?.error).toBe('Blob hash mismatch')
        expect(result.entries[0]?.data?.reasoning).toBe('tampered version')
    })
})
