import { mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { HederaEnvConfig } from '../env'
import {
    ensureHederaAgentProfile,
    resolveHederaProfilePublisherSigner,
    type HederaProfileAdapter,
} from './profile'
import { HederaAgentStateStore } from './state-store'

function makeEnv(stateStorePath: string): HederaEnvConfig {
    return {
        network: 'testnet',
        operatorAccountId: '0.0.1001',
        operatorPrivateKey: 'operator-private-key',
        operatorPrivateKeySource: 'env',
        mirrorNodeUrl: 'https://mirror.example.com/api/v1',
        stateStorePath,
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

async function seedExistingAgentState(store: HederaAgentStateStore, env: HederaEnvConfig) {
    await store.save(
        env,
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
}

async function seedGeneratedAgentState(store: HederaAgentStateStore, env: HederaEnvConfig, keyPath: string) {
    await store.save(
        env,
        {
            accountId: '0.0.3003',
            privateKeyRef: 'runtime:generated-agent-key',
            inboundTopicId: '0.0.7101',
            outboundTopicId: '0.0.7102',
            profileTopicId: '0.0.7103',
            network: 'testnet',
            created: true,
            agentPrivateKey: 'generated-agent-private-key',
        },
        {
            generatedKeyPath: keyPath,
        }
    )
}

function makeAdapter(): HederaProfileAdapter {
    return {
        getAgentProfile: vi.fn(),
        publishAgentProfile: vi.fn(),
    }
}

describe('ensureHederaAgentProfile', () => {
    it('chooses the control-plane signer for HCS-11 profile publication', () => {
        const env: HederaEnvConfig = {
            ...makeEnv('.agent/hedera-state.json'),
            agentAccountId: '0.0.2002',
            agentPrivateKey: 'agent-private-key',
            agentPrivateKeySource: 'env',
            controlPlaneSigner: {
                plane: 'control',
                owner: 'operator',
                accountId: '0.0.1001',
                privateKey: 'operator-private-key',
                privateKeySource: 'env',
            },
            executionSigner: {
                plane: 'execution',
                owner: 'bonzo-executor',
                accountId: '0.0.7007',
                privateKey: 'executor-private-key',
                privateKeySource: 'env',
            },
            signersShareAccount: false,
        }

        expect(resolveHederaProfilePublisherSigner(env)).toEqual({
            plane: 'control',
            owner: 'operator',
            accountId: '0.0.1001',
            privateKey: 'operator-private-key',
            privateKeySource: 'env',
        })
    })

    it('skips publishing when the persisted profile already matches the desired metadata', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hedera-profile-'))
        const statePath = join(dir, 'hedera-state.json')
        const store = new HederaAgentStateStore(statePath)
        const env: HederaEnvConfig = {
            ...makeEnv(statePath),
            agentAccountId: '0.0.2002',
            agentPrivateKey: 'agent-private-key',
            agentPrivateKeySource: 'env',
        }
        const adapter = makeAdapter()

        await seedExistingAgentState(store, env)

        vi.mocked(adapter.getAgentProfile).mockResolvedValue({
            displayName: 'MemoryVault Hedera',
            alias: 'memoryvault_hedera',
            bio: 'Autonomous Hedera deployment for Bonzo Vaults.',
            inboundTopicId: '0.0.7001',
            outboundTopicId: '0.0.7002',
            properties: {
                memoryvault: {
                    protocol: 'memoryvault',
                },
            },
            aiAgent: {
                type: 1,
                capabilities: [7, 9, 10],
                model: 'gemini-2.5-flash',
                creator: '0.0.1001',
            },
        })

        const result = await ensureHederaAgentProfile(
            env,
            {
                name: 'MemoryVault Hedera',
                description: 'Autonomous Hedera deployment for Bonzo Vaults.',
                model: 'gemini-2.5-flash',
                capabilities: [7, 9, 10],
                creator: '0.0.1001',
                properties: {
                    memoryvault: {
                        protocol: 'memoryvault',
                    },
                },
            },
            {
                adapter,
                store,
            }
        )

        expect(result).toEqual({
            published: false,
            profileTopicId: '0.0.7003',
            previousProfileTopicId: '0.0.7003',
        })
        expect(adapter.publishAgentProfile).not.toHaveBeenCalled()
    })

    it('publishes a replacement profile and updates the persisted profile topic id when metadata changed', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hedera-profile-'))
        const statePath = join(dir, 'hedera-state.json')
        const store = new HederaAgentStateStore(statePath)
        const env: HederaEnvConfig = {
            ...makeEnv(statePath),
            agentAccountId: '0.0.2002',
            agentPrivateKey: 'agent-private-key',
            agentPrivateKeySource: 'env',
        }
        const adapter = makeAdapter()

        await seedExistingAgentState(store, env)

        vi.mocked(adapter.getAgentProfile).mockResolvedValue({
            displayName: 'Old name',
            alias: 'old_name',
            bio: 'Old bio',
            profileImage: 'hcs://1/0.0.8001',
            inboundTopicId: '0.0.7001',
            outboundTopicId: '0.0.7002',
            properties: {
                memoryvault: {
                    protocol: 'legacy',
                },
            },
            aiAgent: {
                type: 1,
                capabilities: [7],
                model: 'old-model',
                creator: '0.0.9999',
            },
        })
        vi.mocked(adapter.publishAgentProfile).mockResolvedValue({
            profileTopicId: '0.0.9001',
            transactionId: '0.0.1001@123456.789',
        })

        const result = await ensureHederaAgentProfile(
            env,
            {
                name: 'MemoryVault Hedera',
                description: 'Autonomous Hedera deployment for Bonzo Vaults.',
                model: 'gemini-2.5-flash',
                capabilities: [7, 9, 10],
                creator: '0.0.1001',
                properties: {
                    memoryvault: {
                        protocol: 'memoryvault',
                    },
                },
            },
            {
                adapter,
                store,
            }
        )

        const persisted = await store.load()

        expect(result).toEqual({
            published: true,
            profileTopicId: '0.0.9001',
            transactionId: '0.0.1001@123456.789',
            previousProfileTopicId: '0.0.7003',
        })
        expect(adapter.publishAgentProfile).toHaveBeenCalledWith(
            expect.objectContaining({
                existingPfpTopicId: '0.0.8001',
            })
        )
        expect(persisted?.profileTopicId).toBe('0.0.9001')
    })

    it('resolves generated agent keys from the persisted state store when env vars do not provide them', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hedera-profile-'))
        const statePath = join(dir, 'hedera-state.json')
        const keyPath = join(dir, 'hedera-agent.key')
        const store = new HederaAgentStateStore(statePath)
        const env = makeEnv(statePath)
        const adapter = makeAdapter()

        await seedGeneratedAgentState(store, env, keyPath)

        vi.mocked(adapter.getAgentProfile).mockResolvedValue({
            displayName: 'Different profile',
            alias: 'different_profile',
            bio: 'Different profile',
            inboundTopicId: '0.0.7101',
            outboundTopicId: '0.0.7102',
            aiAgent: {
                type: 1,
                capabilities: [7],
                model: 'old-model',
                creator: '0.0.1001',
            },
        })
        vi.mocked(adapter.publishAgentProfile).mockImplementation(async ({ identity }) => {
            expect(identity.accountId).toBe('0.0.3003')
            expect(identity.agentPrivateKey).toBe('generated-agent-private-key')

            return {
                profileTopicId: '0.0.9100',
                transactionId: '0.0.1001@999999.1',
            }
        })

        await ensureHederaAgentProfile(
            env,
            {
                name: 'MemoryVault Hedera',
                description: 'Autonomous Hedera deployment for Bonzo Vaults.',
                model: 'gemini-2.5-flash',
                capabilities: [7, 9, 10],
                creator: '0.0.1001',
                properties: {
                    memoryvault: {
                        protocol: 'memoryvault',
                    },
                },
            },
            {
                adapter,
                store,
            }
        )

        expect(await readFile(keyPath, 'utf8')).toBe('generated-agent-private-key\n')
    })
})
