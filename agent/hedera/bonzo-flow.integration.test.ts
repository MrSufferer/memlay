import { describe, expect, it, vi } from 'vitest'
import { scoreOpportunity, type RiskAnalysisDeps } from '../skills/risk-analysis'
import type { TraderTemplate } from '../trader-template'
import type { HederaEnvConfig } from './env'
import { HederaMemoryRuntime, loadHederaMemoryConfig } from './memory/runtime'
import { BonzoPositionReader, type BonzoPositionSource } from './positions/bonzo'
import { createBonzoVaultDiscoverySource } from '../tools/bonzo-vaults/discovery'
import { BonzoVaultExecutor, buildBonzoEnterRequest, buildBonzoExitRequest } from '../tools/bonzo-vaults/execution'
import { evaluateBonzoMonitor } from '../tools/bonzo-vaults/monitoring'
import { mapBonzoVaultOpportunityToRawOpportunity } from '../tools/bonzo-vaults/opportunities'
import { selectBestBonzoVault } from '../tools/bonzo-vaults/ranking'

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
        bonzoExecutionMode: 'simulate',
        bonzoMinApyDeltaBps: 50,
        bonzoExecutorMode: 'dedicated',
        bonzoExecutorAccountId: '0.0.7007',
        bonzoExecutorPrivateKey: 'executor-private-key',
        bonzoExecutorPrivateKeySource: 'env',
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
            owner: 'bonzo-executor',
            accountId: '0.0.7007',
            privateKey: 'executor-private-key',
            privateKeySource: 'env',
        },
        signersShareAccount: false,
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

function makeTemplate(): TraderTemplate {
    return {
        agentId: 'agent-hedera-01',
        name: 'Hedera Bonzo Vault Rotator',
        version: '1.0.0',
        strategy: {
            type: 'custom',
            tools: ['bonzo-vaults'],
            entryThresholds: {
                minOpportunityScore: 70,
                minTrustScore: 70,
                maxRiskLevel: 'MEDIUM',
            },
            exitTriggers: [
                'better_vault_available',
                'apy_drop',
                'reward_change',
                'vault_health',
            ],
        },
        risk: {
            maxPositionPct: 0.1,
            stopLossEnabled: true,
            stopLossDropPct: 0.1,
            profitTarget: 1.25,
            maxConcurrentPositions: 1,
        },
        customInstructions: 'Prefer durable Bonzo vault APY with explicit dry-run execution.',
        createdAt: '2026-03-23T00:00:00.000Z',
        updatedAt: '2026-03-23T00:00:00.000Z',
    }
}

const riskDeps: RiskAnalysisDeps = {
    alphaFetcher: {
        async fetchAlpha() {
            return []
        },
    },
    gemini: {
        async generateJson() {
            return {
                opportunityScore: 88,
                trustScore: 84,
                riskLevel: 'LOW',
                reasoning: 'Mock Bonzo vault remains attractive after APY comparison.',
            }
        },
    },
}

describe('Hedera Bonzo flow integration', () => {
    it('reads current position, ranks opportunities, commits memory, and dry-runs a Bonzo entry', async () => {
        const env = makeEnv()
        const callOrder: string[] = []
        const memoryRuntime = new HederaMemoryRuntime({
            config: loadHederaMemoryConfig(env, makeRawEnv()),
            blobStore: {
                put: vi.fn().mockImplementation(async () => {
                    callOrder.push('blob')
                    return { uri: 's3://memory-layer/agents/agent-hedera-01/log/entry-1' }
                }),
            },
            topicPublisher: {
                publish: vi.fn().mockImplementation(async () => {
                    callOrder.push('topic')
                    return { topicId: '0.0.8001', sequenceNumber: 1 }
                }),
            },
            now: () => new Date('2026-03-23T00:00:00.000Z'),
        })
        const transport = {
            deposit: vi.fn().mockImplementation(async (plan) => {
                callOrder.push('execute')
                return { status: 'simulated', transactionId: `sim:${plan.vaultId}` } as const
            }),
            withdraw: vi.fn(),
        }
        const executor = new BonzoVaultExecutor(env, {
            mode: 'simulate',
            transport,
        })
        const positionSource: BonzoPositionSource = {
            listPositions: vi.fn().mockResolvedValue([
                {
                    accountId: '0.0.7007',
                    vaultId: 'sauce-hbar-single',
                    shareTokenId: '0x8e253F359Ba5DDD62644b1e5DAbD3D7748fb8193',
                    shareBalance: '10',
                    assetBalances: [{ symbol: 'SAUCE', amount: '100' }],
                    lastObservedApr: 8.4,
                    lastObservedApy: 8.8,
                    updatedAt: '2026-03-23T00:01:00.000Z',
                },
            ]),
        }
        const reader = new BonzoPositionReader(positionSource, env)
        const discovery = createBonzoVaultDiscoverySource(env, {
            now: () => new Date('2026-03-23T00:00:00.000Z'),
        })

        const currentPosition = await reader.getCurrentPosition()
        const opportunities = await discovery.discoverVaults()
        const ranking = selectBestBonzoVault({
            opportunities,
            currentPosition,
            minApyDeltaBps: env.bonzoMinApyDeltaBps,
        })
        const bestVault = opportunities.find(
            (opportunity) => opportunity.vaultId === ranking.bestVaultId
        )

        expect(positionSource.listPositions).toHaveBeenCalledWith('0.0.7007')
        expect(currentPosition?.vaultId).toBe('sauce-hbar-single')
        expect(ranking.bestVaultId).toBe('bonzo-xbonzo-dual')
        expect(bestVault).toBeTruthy()

        const scored = await scoreOpportunity(
            riskDeps,
            mapBonzoVaultOpportunityToRawOpportunity(bestVault!),
            makeTemplate()
        )

        await memoryRuntime.commitEntry({
            agentId: 'agent-hedera-01',
            entryKey: 'entry-1',
            entryData: {
                action: 'lp-entry',
                toolId: 'bonzo-vaults',
                vaultId: scored.assetId,
            },
        })

        const response = await executor.enter(
            buildBonzoEnterRequest({
                agentId: 'agent-hedera-01',
                strategyType: 'custom',
                opportunity: scored,
                amount: '250',
            })
        )

        expect(callOrder).toEqual(['blob', 'topic', 'execute'])
        expect(response).toMatchObject({
            status: 'success',
            action: 'enter',
            toolId: 'bonzo-vaults',
            data: {
                mode: 'simulate',
                executionPlan: {
                    vaultId: 'bonzo-xbonzo-dual',
                    accountId: '0.0.7007',
                    signerOwner: 'bonzo-executor',
                },
            },
        })
    })

    it('builds monitor-driven exit requests, commits memory, and dry-runs a Bonzo exit', async () => {
        const env = makeEnv()
        const callOrder: string[] = []
        const memoryRuntime = new HederaMemoryRuntime({
            config: loadHederaMemoryConfig(env, makeRawEnv()),
            blobStore: {
                put: vi.fn().mockImplementation(async () => {
                    callOrder.push('blob')
                    return { uri: 's3://memory-layer/agents/agent-hedera-01/log/exit-1' }
                }),
            },
            topicPublisher: {
                publish: vi.fn().mockImplementation(async () => {
                    callOrder.push('topic')
                    return { topicId: '0.0.8001', sequenceNumber: 2 }
                }),
            },
            now: () => new Date('2026-03-23T00:05:00.000Z'),
        })
        const transport = {
            deposit: vi.fn(),
            withdraw: vi.fn().mockImplementation(async (plan) => {
                callOrder.push('execute')
                return { status: 'simulated', transactionId: `sim:${plan.vaultId}` } as const
            }),
        }
        const executor = new BonzoVaultExecutor(env, {
            mode: 'simulate',
            transport,
        })
        const discovery = createBonzoVaultDiscoverySource(env, {
            now: () => new Date('2026-03-23T00:00:00.000Z'),
        })
        const opportunities = await discovery.discoverVaults()

        const currentPosition = {
            accountId: '0.0.7007',
            vaultId: 'sauce-hbar-single',
            shareTokenId: '0x8e253F359Ba5DDD62644b1e5DAbD3D7748fb8193',
            shareBalance: '10',
            assetBalances: [{ symbol: 'SAUCE', amount: '100' }],
            lastObservedApr: 12.4,
            lastObservedApy: 12.6,
            updatedAt: '2026-03-23T00:04:00.000Z',
        }
        const monitor = evaluateBonzoMonitor({
            currentPosition,
            opportunities,
            previousState: {
                vaultId: 'sauce-hbar-single',
                apy: 12.6,
                tvl: 910000,
                rewardTokenSymbols: ['SAUCE'],
                fetchedAt: '2026-03-23T00:00:00.000Z',
                healthStatus: 'healthy',
            },
            config: {
                minRebalanceApyDeltaBps: 50,
                maxApyDropBps: 200,
            },
            now: () => new Date('2026-03-23T00:05:00.000Z'),
        })
        const signal = monitor.response.exitSignals?.find(
            (entry) => entry.trigger === 'apy_drop'
        )

        expect(signal).toBeTruthy()

        await memoryRuntime.commitEntry({
            agentId: 'agent-hedera-01',
            entryKey: 'exit-1',
            entryData: {
                action: 'lp-exit',
                toolId: 'bonzo-vaults',
                trigger: signal!.trigger,
            },
        })

        const response = await executor.exit(
            buildBonzoExitRequest({
                agentId: 'agent-hedera-01',
                strategyType: 'custom',
                signal: signal!,
            })
        )

        expect(callOrder).toEqual(['blob', 'topic', 'execute'])
        expect(response).toMatchObject({
            status: 'success',
            action: 'exit',
            toolId: 'bonzo-vaults',
            data: {
                mode: 'simulate',
                executionPlan: {
                    vaultId: 'sauce-hbar-single',
                    accountId: '0.0.7007',
                    signerOwner: 'bonzo-executor',
                    redeemAll: true,
                },
            },
        })
    })
})
