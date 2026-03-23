import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { bootstrapHederaAgent } from './bootstrap-agent'
import { HederaAgentStateStore } from './state-store'

function makeRawEnv(stateStorePath: string): Record<string, string> {
    return {
        HEDERA_NETWORK: 'testnet',
        HEDERA_OPERATOR_ID: '0.0.1001',
        HEDERA_OPERATOR_KEY: 'operator-private-key',
        HEDERA_MIRROR_NODE_URL: 'https://mirror.example.com/api/v1',
        HEDERA_STATE_STORE_PATH: stateStorePath,
        HEDERA_AGENT_PROFILE_NAME: 'MemoryVault Hedera',
        HEDERA_AGENT_PROFILE_DESCRIPTION: 'Autonomous yield agent',
        BONZO_EXECUTOR_MODE: 'operator',
    }
}

describe('bootstrapHederaAgent', () => {
    it('creates and persists Hedera agent state through the bootstrap entrypoint', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hedera-bootstrap-'))

        try {
            const stateStorePath = join(dir, 'hedera-state.json')
            const store = new HederaAgentStateStore(stateStorePath)
            const adapter = {
                createAndRegisterAgent: vi.fn().mockResolvedValue({
                    accountId: '0.0.3003',
                    privateKey: 'generated-agent-key',
                    inboundTopicId: '0.0.7101',
                    outboundTopicId: '0.0.7102',
                    profileTopicId: '0.0.7103',
                    operatorId: '0.0.1001@0.0.3003',
                }),
                getAgentProfile: vi.fn(),
                getAccountMemo: vi.fn(),
            }

            const result = await bootstrapHederaAgent({
                rawEnv: {
                    ...makeRawEnv(stateStorePath),
                    HEDERA_AGENT_PROFILE_PICTURE_PATH: fileURLToPath(
                        new URL('../../../CV.html', import.meta.url)
                    ),
                },
                store,
                adapter,
            })

            expect(result.created).toBe(true)
            expect(result.reusedState).toBe(false)
            expect(result.state.accountId).toBe('0.0.3003')
            expect(await store.load()).toMatchObject({
                accountId: '0.0.3003',
                profileTopicId: '0.0.7103',
            })
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('reuses persisted state when no explicit agent credentials are supplied', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hedera-bootstrap-'))

        try {
            const stateStorePath = join(dir, 'hedera-state.json')
            const store = new HederaAgentStateStore(stateStorePath)
            await store.save(
                {
                    network: 'testnet',
                    operatorAccountId: '0.0.1001',
                    operatorPrivateKey: 'operator-private-key',
                    operatorPrivateKeySource: 'env',
                    mirrorNodeUrl: 'https://mirror.example.com/api/v1',
                    stateStorePath,
                    bonzoDataSource: 'mock',
                    bonzoExecutionMode: 'simulate',
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
                },
                {
                    accountId: '0.0.2002',
                    privateKeyRef: 'env:HEDERA_AGENT_KEY',
                    inboundTopicId: '0.0.7001',
                    outboundTopicId: '0.0.7002',
                    profileTopicId: '0.0.7003',
                    network: 'testnet',
                    created: false,
                }
            )

            const adapter = {
                createAndRegisterAgent: vi.fn(),
                getAgentProfile: vi.fn(),
                getAccountMemo: vi.fn(),
            }
            const result = await bootstrapHederaAgent({
                rawEnv: makeRawEnv(stateStorePath),
                store,
                adapter,
            })

            expect(result.reusedState).toBe(true)
            expect(result.state.accountId).toBe('0.0.2002')
            expect(adapter.createAndRegisterAgent).not.toHaveBeenCalled()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
