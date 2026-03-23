import { describe, expect, it, vi } from 'vitest'
import { runOnce } from './index'
import type { AgentBackend } from './core/backend'
import type { TraderTemplate } from './trader-template'
import type { RiskAnalysisDeps } from './skills/risk-analysis'

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
            exitTriggers: ['apy_drop', 'vault_health', 'better_vault_available'],
        },
        risk: {
            maxPositionPct: 0.1,
            stopLossEnabled: true,
            stopLossDropPct: 0.1,
            profitTarget: 1.25,
            maxConcurrentPositions: 1,
        },
        customInstructions: 'Prefer Hedera Bonzo vaults.',
        createdAt: '2026-03-23T00:00:00.000Z',
        updatedAt: '2026-03-23T00:00:00.000Z',
    }
}

function makeRiskDeps(): RiskAnalysisDeps {
    return {
        alphaFetcher: {
            async fetchAlpha() {
                return []
            },
        },
        gemini: {
            async generateJson() {
                return {
                    opportunityScore: 90,
                    trustScore: 82,
                    riskLevel: 'LOW',
                    reasoning: 'Bonzo vault is acceptable.',
                }
            },
        },
    }
}

describe('agent orchestration', () => {
    it('commits failure memory when entry execution throws', async () => {
        const memory = {
            commitEntry: vi.fn().mockResolvedValue(undefined),
        }
        const backend: AgentBackend = {
            target: 'hedera',
            label: 'Hedera / HCS-10 + HCS-11',
            tools: {
                scan: vi.fn().mockResolvedValue({
                    status: 'success',
                    action: 'scan',
                    toolId: 'bonzo-vaults',
                    data: {},
                    opportunities: [
                        {
                            toolId: 'bonzo-vaults',
                            assetId: 'bonzo-xbonzo-dual',
                            entryParams: {
                                venue: 'bonzo-vaults',
                                vaultId: 'bonzo-xbonzo-dual',
                                vaultName: 'BONZO-XBONZO',
                                vaultType: 'LST / Base',
                                assetSymbols: ['BONZO', 'XBONZO'],
                                primaryAssetSymbol: 'BONZO',
                                tvl: 640000,
                                apr: 13.1,
                                apy: 14,
                                rewardTokenSymbols: ['BONZO'],
                                shareTokenId: '0xcfba07324bd207C3ED41416a9a36f8184F9a2134',
                                strategyAddress: '0xcfba07324bd207C3ED41416a9a36f8184F9a2134',
                                vaultAddress: '0xcfba07324bd207C3ED41416a9a36f8184F9a2134',
                                source: 'mock',
                                fetchedAt: '2026-03-23T00:00:00.000Z',
                                vault: {
                                    vaultId: 'bonzo-xbonzo-dual',
                                    vaultName: 'BONZO-XBONZO',
                                    vaultType: 'LST / Base',
                                    assetSymbols: ['BONZO', 'XBONZO'],
                                    tvl: 640000,
                                    apr: 13.1,
                                    apy: 14,
                                    rewardTokens: [{ symbol: 'BONZO' }],
                                    shareTokenId: '0xcfba07324bd207C3ED41416a9a36f8184F9a2134',
                                    strategyAddress: '0xcfba07324bd207C3ED41416a9a36f8184F9a2134',
                                    vaultAddress: '0xcfba07324bd207C3ED41416a9a36f8184F9a2134',
                                    source: 'mock',
                                    fetchedAt: '2026-03-23T00:00:00.000Z',
                                },
                            },
                        },
                    ],
                }),
                monitor: vi.fn().mockResolvedValue({
                    status: 'no_action',
                    action: 'monitor',
                    toolId: 'bonzo-vaults',
                    data: {},
                    exitSignals: [],
                }),
            },
            memory,
            execution: {
                enterPosition: vi.fn().mockRejectedValue(new Error('executor down')),
                exitPosition: vi.fn().mockResolvedValue(undefined),
            },
        }

        await expect(
            runOnce('agent-hedera-01', backend, {
                template: makeTemplate(),
                riskDeps: makeRiskDeps(),
            })
        ).rejects.toThrow('executor down')

        const actions = memory.commitEntry.mock.calls.map(
            ([arg]) => arg.entryData.action
        )
        expect(actions).toEqual(['lp-entry', 'lp-entry-failed'])
    })

    it('still processes monitor exits when scan returns no opportunities', async () => {
        const memory = {
            commitEntry: vi.fn().mockResolvedValue(undefined),
        }
        const execution = {
            enterPosition: vi.fn().mockResolvedValue(undefined),
            exitPosition: vi.fn().mockResolvedValue(undefined),
        }
        const backend: AgentBackend = {
            target: 'hedera',
            label: 'Hedera / HCS-10 + HCS-11',
            tools: {
                scan: vi.fn().mockResolvedValue({
                    status: 'no_action',
                    action: 'scan',
                    toolId: 'bonzo-vaults',
                    data: {},
                    opportunities: [],
                }),
                monitor: vi.fn().mockResolvedValue({
                    status: 'success',
                    action: 'monitor',
                    toolId: 'bonzo-vaults',
                    data: {},
                    exitSignals: [
                        {
                            trigger: 'apy_drop',
                            urgency: 'high',
                            data: {
                                vaultId: 'bonzo-xbonzo-dual',
                                vaultAddress: '0xcfba07324bd207C3ED41416a9a36f8184F9a2134',
                                shareTokenId: '0xcfba07324bd207C3ED41416a9a36f8184F9a2134',
                                strategyAddress: '0xcfba07324bd207C3ED41416a9a36f8184F9a2134',
                                redeemAll: true,
                            },
                        },
                    ],
                }),
            },
            memory,
            execution,
        }

        await runOnce('agent-hedera-01', backend, {
            template: makeTemplate(),
            riskDeps: makeRiskDeps(),
        })

        expect(execution.exitPosition).toHaveBeenCalledOnce()
        const actions = memory.commitEntry.mock.calls.map(
            ([arg]) => arg.entryData.action
        )
        expect(actions).toEqual(['lp-exit', 'lp-exit-confirmed'])
    })

    it('passes Bonzo allocation sizing into the enter request', async () => {
        const memory = {
            commitEntry: vi.fn().mockResolvedValue(undefined),
        }
        const execution = {
            enterPosition: vi.fn().mockResolvedValue(undefined),
            exitPosition: vi.fn().mockResolvedValue(undefined),
        }
        const backend: AgentBackend = {
            target: 'hedera',
            label: 'Hedera / HCS-10 + HCS-11',
            tools: {
                scan: vi.fn().mockResolvedValue({
                    status: 'success',
                    action: 'scan',
                    toolId: 'bonzo-vaults',
                    data: {},
                    opportunities: [
                        {
                            toolId: 'bonzo-vaults',
                            assetId: 'sauce-hbar-single',
                            entryParams: {
                                venue: 'bonzo-vaults',
                                vaultId: 'sauce-hbar-single',
                                vaultName: 'SAUCE (Paired with HBAR)',
                                vaultType: 'High Volatility | Medium',
                                assetSymbols: ['SAUCE', 'HBAR'],
                                primaryAssetSymbol: 'SAUCE',
                                tvl: 910000,
                                apr: 8.4,
                                apy: 8.8,
                                rewardTokenSymbols: ['SAUCE'],
                                shareTokenId: '0x8e253F359Ba5DDD62644b1e5DAbD3D7748fb8193',
                                strategyAddress: '0x8e253F359Ba5DDD62644b1e5DAbD3D7748fb8193',
                                vaultAddress: '0x8e253F359Ba5DDD62644b1e5DAbD3D7748fb8193',
                                source: 'mock',
                                fetchedAt: '2026-03-23T00:00:00.000Z',
                                vault: {
                                    vaultId: 'sauce-hbar-single',
                                    vaultName: 'SAUCE (Paired with HBAR)',
                                    vaultType: 'High Volatility | Medium',
                                    strategyFamily: 'single-asset-dex',
                                    assetSymbols: ['SAUCE', 'HBAR'],
                                    tvl: 910000,
                                    apr: 8.4,
                                    apy: 8.8,
                                    rewardTokens: [{ symbol: 'SAUCE' }],
                                    shareTokenId: '0x8e253F359Ba5DDD62644b1e5DAbD3D7748fb8193',
                                    strategyAddress: '0x8e253F359Ba5DDD62644b1e5DAbD3D7748fb8193',
                                    vaultAddress: '0x8e253F359Ba5DDD62644b1e5DAbD3D7748fb8193',
                                    source: 'mock',
                                    fetchedAt: '2026-03-23T00:00:00.000Z',
                                },
                            },
                        },
                    ],
                }),
                monitor: vi.fn().mockResolvedValue({
                    status: 'no_action',
                    action: 'monitor',
                    toolId: 'bonzo-vaults',
                    data: {},
                    exitSignals: [],
                }),
            },
            memory,
            execution,
        }

        await runOnce('agent-hedera-01', backend, {
            template: makeTemplate(),
            riskDeps: makeRiskDeps(),
        })

        expect(execution.enterPosition).toHaveBeenCalledOnce()
        expect(execution.enterPosition).toHaveBeenCalledWith({
            toolId: 'bonzo-vaults',
            request: expect.objectContaining({
                params: expect.objectContaining({
                    allocationPctBps: 1000,
                }),
            }),
        })
    })

    it('executes monitor exits before scanning for a Bonzo replacement entry', async () => {
        const memory = {
            commitEntry: vi.fn().mockResolvedValue(undefined),
        }
        const execution = {
            enterPosition: vi.fn().mockResolvedValue(undefined),
            exitPosition: vi.fn().mockResolvedValue(undefined),
        }
        const backend: AgentBackend = {
            target: 'hedera',
            label: 'Hedera / HCS-10 + HCS-11',
            tools: {
                scan: vi.fn().mockResolvedValue({
                    status: 'success',
                    action: 'scan',
                    toolId: 'bonzo-vaults',
                    data: {
                        currentVaultId: 'sauce-hbar-single',
                        bestVaultId: 'bonzo-xbonzo-dual',
                    },
                    opportunities: [
                        {
                            toolId: 'bonzo-vaults',
                            assetId: 'bonzo-xbonzo-dual',
                            entryParams: {
                                venue: 'bonzo-vaults',
                            },
                        },
                    ],
                }),
                monitor: vi.fn().mockResolvedValue({
                    status: 'success',
                    action: 'monitor',
                    toolId: 'bonzo-vaults',
                    data: {},
                    exitSignals: [
                        {
                            trigger: 'better_vault_available',
                            urgency: 'medium',
                            data: {
                                vaultId: 'sauce-hbar-single',
                                vaultAddress: '0xvault-single',
                                shareTokenId: '0xshare-single',
                                strategyAddress: '0xstrategy-single',
                                redeemAll: true,
                            },
                        },
                    ],
                }),
            },
            memory,
            execution,
        }

        await runOnce('agent-hedera-01', backend, {
            template: makeTemplate(),
            riskDeps: makeRiskDeps(),
        })

        expect(execution.exitPosition).toHaveBeenCalledOnce()
        expect(execution.enterPosition).not.toHaveBeenCalled()
        expect(backend.tools.scan).not.toHaveBeenCalled()
        const actions = memory.commitEntry.mock.calls.map(
            ([arg]) => arg.entryData.action
        )
        expect(actions).toEqual(['lp-exit', 'lp-exit-confirmed'])
    })
})
