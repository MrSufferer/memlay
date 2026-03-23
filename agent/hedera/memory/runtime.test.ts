import { describe, expect, it, vi } from 'vitest'
import type { HederaEnvConfig } from '../env'
import {
    buildHederaMemoryCommitmentMessage,
    HederaMemoryRuntime,
    loadHederaMemoryConfig,
} from './runtime'

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

describe('HederaMemoryRuntime', () => {
    it('derives a deterministic entry hash and HCS commitment payload', async () => {
        const blobStore = {
            put: vi.fn().mockResolvedValue({
                uri: 's3://memory-layer/agents/agent-alpha-01/log/decision:1',
            }),
        }
        const topicPublisher = {
            publish: vi.fn().mockResolvedValue({
                topicId: '0.0.8001',
                sequenceNumber: 41,
                transactionId: '0.0.1001@12345.678',
            }),
        }
        const runtime = new HederaMemoryRuntime({
            config: loadHederaMemoryConfig(makeEnv(), makeRawEnv()),
            blobStore,
            topicPublisher,
            now: () => new Date('2026-03-23T00:00:00.000Z'),
        })

        const result = await runtime.commitEntry({
            agentId: 'agent-alpha-01',
            entryKey: 'decision:1',
            entryData: {
                action: 'lp-entry',
                toolId: 'bonzo-vaults',
                reasoning: 'rebalance into the highest APY vault',
            },
        })
        const repeated = await runtime.commitEntry({
            agentId: 'agent-alpha-01',
            entryKey: 'decision:1',
            entryData: {
                action: 'lp-entry',
                toolId: 'bonzo-vaults',
                reasoning: 'rebalance into the highest APY vault',
            },
        })

        expect(result.entryHash).toBe(repeated.entryHash)
        expect(result.commitmentMessage).toBe(
            buildHederaMemoryCommitmentMessage({
                agentId: 'agent-alpha-01',
                entryKey: 'decision:1',
                entryHash: result.entryHash,
                timestamp: '2026-03-23T00:00:00.000Z',
                blobUri: 's3://memory-layer/agents/agent-alpha-01/log/decision:1',
            })
        )
        expect(result.commitmentMessage).toBe(repeated.commitmentMessage)
        expect(blobStore.put).toHaveBeenCalledTimes(2)
        expect(topicPublisher.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                message: result.commitmentMessage,
            })
        )
    })

    it('persists the encrypted blob before publishing the HCS commitment', async () => {
        const callOrder: string[] = []
        const blobStore = {
            put: vi.fn().mockImplementation(async () => {
                callOrder.push('blob')
                return {
                    uri: 's3://memory-layer/agents/agent-alpha-01/log/decision:2',
                }
            }),
        }
        const topicPublisher = {
            publish: vi.fn().mockImplementation(async () => {
                callOrder.push('topic')
                return {
                    topicId: '0.0.8001',
                    sequenceNumber: 42,
                }
            }),
        }
        const runtime = new HederaMemoryRuntime({
            config: loadHederaMemoryConfig(makeEnv(), makeRawEnv()),
            blobStore,
            topicPublisher,
            now: () => new Date('2026-03-23T00:00:01.000Z'),
        })

        await runtime.commitEntry({
            agentId: 'agent-alpha-01',
            entryKey: 'decision:2',
            entryData: {
                action: 'lp-entry',
                toolId: 'bonzo-vaults',
            },
        })

        expect(callOrder).toEqual(['blob', 'topic'])
    })

    it('does not publish an HCS commitment when blob persistence fails', async () => {
        const blobStore = {
            put: vi.fn().mockRejectedValue(new Error('S3 unavailable')),
        }
        const topicPublisher = {
            publish: vi.fn(),
        }
        const runtime = new HederaMemoryRuntime({
            config: loadHederaMemoryConfig(makeEnv(), makeRawEnv()),
            blobStore,
            topicPublisher,
            now: () => new Date('2026-03-23T00:00:02.000Z'),
        })

        await expect(
            runtime.commitEntry({
                agentId: 'agent-alpha-01',
                entryKey: 'decision:3',
                entryData: {
                    action: 'lp-entry',
                    toolId: 'bonzo-vaults',
                },
            })
        ).rejects.toThrow('S3 unavailable')

        expect(topicPublisher.publish).not.toHaveBeenCalled()
    })

    it('uses the control-plane signer for memory commits even when Bonzo execution uses a dedicated signer', () => {
        const env: HederaEnvConfig = {
            ...makeEnv(),
            bonzoExecutionMode: 'simulate',
            bonzoExecutorMode: 'dedicated',
            bonzoExecutorAccountId: '0.0.7007',
            bonzoExecutorPrivateKey: 'executor-private-key',
            bonzoExecutorPrivateKeySource: 'env',
            executionSigner: {
                plane: 'execution',
                owner: 'bonzo-executor',
                accountId: '0.0.7007',
                privateKey: 'executor-private-key',
                privateKeySource: 'env',
            },
            signersShareAccount: false,
        }

        const config = loadHederaMemoryConfig(env, makeRawEnv())

        expect(config.signerAccountId).toBe('0.0.1001')
        expect(config.signerPrivateKey).toBe('operator-private-key')
    })
})
