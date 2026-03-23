import { describe, expect, it } from 'vitest'
import type { BonzoPositionState } from '../../hedera/positions/bonzo'
import type { BonzoVaultOpportunity } from './opportunities'
import {
    evaluateBonzoMonitor,
    type BonzoMonitorState,
    type BonzoVaultHealthSnapshot,
} from './monitoring'

function makeOpportunity(
    overrides: Partial<BonzoVaultOpportunity> = {}
): BonzoVaultOpportunity {
    return {
        vaultId: 'vault-a',
        vaultName: 'Vault A',
        vaultType: 'Volatile / Stable (Major)',
        assetSymbols: ['USDC', 'HBAR'],
        tvl: 1000000,
        apr: 10,
        apy: 10.5,
        rewardTokens: [{ symbol: 'BONZO' }],
        shareTokenId: '0xshare-a',
        strategyAddress: '0xstrategy-a',
        vaultAddress: '0xvault-a',
        source: 'mock',
        fetchedAt: '2026-03-23T06:00:00.000Z',
        ...overrides,
    }
}

function makePosition(
    overrides: Partial<BonzoPositionState> = {}
): BonzoPositionState {
    return {
        accountId: '0.0.1001',
        vaultId: 'vault-a',
        shareTokenId: '0xshare-a',
        shareBalance: '10',
        assetBalances: [{ symbol: 'USDC', amount: '100' }],
        lastObservedApr: 10,
        lastObservedApy: 10.5,
        updatedAt: '2026-03-23T06:05:00.000Z',
        ...overrides,
    }
}

function makeMonitorState(
    overrides: Partial<BonzoMonitorState> = {}
): BonzoMonitorState {
    return {
        vaultId: 'vault-a',
        apy: 10.5,
        tvl: 1000000,
        rewardTokenSymbols: ['BONZO'],
        fetchedAt: '2026-03-23T06:00:00.000Z',
        healthStatus: 'healthy',
        ...overrides,
    }
}

function makeHealth(
    overrides: Partial<BonzoVaultHealthSnapshot> = {}
): BonzoVaultHealthSnapshot {
    return {
        vaultId: 'vault-a',
        status: 'healthy',
        ...overrides,
    }
}

describe('Bonzo monitoring', () => {
    it('returns no_action when no current Bonzo position is active', () => {
        const result = evaluateBonzoMonitor({
            currentPosition: null,
            opportunities: [makeOpportunity()],
            config: {
                minRebalanceApyDeltaBps: 50,
            },
            now: () => new Date('2026-03-23T07:00:00.000Z'),
        })

        expect(result.response).toEqual({
            status: 'no_action',
            action: 'monitor',
            toolId: 'bonzo-vaults',
            data: {
                currentVaultId: null,
                positionsChecked: 0,
                checkedAt: '2026-03-23T07:00:00.000Z',
                reason: 'No active Bonzo position to monitor',
            },
            exitSignals: [],
        })
        expect(result.nextState).toBeNull()
    })

    it('emits a better_vault_available signal when another vault clears the APY delta threshold', () => {
        const result = evaluateBonzoMonitor({
            currentPosition: makePosition({ vaultId: 'vault-a' }),
            opportunities: [
                makeOpportunity({ vaultId: 'vault-a', apy: 8.1 }),
                makeOpportunity({
                    vaultId: 'vault-b',
                    vaultName: 'Vault B',
                    apy: 9.2,
                    shareTokenId: '0xshare-b',
                    strategyAddress: '0xstrategy-b',
                    vaultAddress: '0xvault-b',
                }),
            ],
            config: {
                minRebalanceApyDeltaBps: 50,
            },
            now: () => new Date('2026-03-23T07:00:00.000Z'),
        })

        expect(result.response.status).toBe('success')
        expect(result.response.exitSignals).toEqual([
            expect.objectContaining({
                trigger: 'better_vault_available',
                urgency: 'medium',
                data: expect.objectContaining({
                    vaultId: 'vault-a',
                    vaultAddress: '0xvault-a',
                    shareTokenId: '0xshare-a',
                    strategyAddress: '0xstrategy-a',
                    redeemAll: true,
                    currentVaultId: 'vault-a',
                    bestVaultId: 'vault-b',
                    bestApy: 9.2,
                    apyDeltaBps: 110,
                    threshold: 50,
                    reason: 'Vault vault-b exceeds current vault vault-a by 110 bps',
                    fired: true,
                }),
            }),
        ])
        expect(result.nextState).toMatchObject({
            vaultId: 'vault-a',
            apy: 8.1,
            healthStatus: 'healthy',
        })
    })

    it('emits APY-drop and reward-change signals from prior monitor state', () => {
        const result = evaluateBonzoMonitor({
            currentPosition: makePosition({
                vaultId: 'vault-a',
                lastObservedApy: 12.5,
            }),
            previousState: makeMonitorState({
                vaultId: 'vault-a',
                apy: 12.5,
                rewardTokenSymbols: ['BONZO', 'HBAR'],
            }),
            opportunities: [
                makeOpportunity({
                    vaultId: 'vault-a',
                    apy: 9.8,
                    rewardTokens: [{ symbol: 'BONZO' }],
                }),
            ],
            config: {
                minRebalanceApyDeltaBps: 0,
                maxApyDropBps: 200,
                exitOnRewardTokenChange: true,
            },
            now: () => new Date('2026-03-23T07:00:00.000Z'),
        })

        expect(result.response.exitSignals).toEqual([
            expect.objectContaining({
                trigger: 'apy_drop',
                urgency: 'medium',
                data: expect.objectContaining({
                    vaultId: 'vault-a',
                    vaultAddress: '0xvault-a',
                    shareTokenId: '0xshare-a',
                    strategyAddress: '0xstrategy-a',
                    redeemAll: true,
                    previousApy: 12.5,
                    currentApy: 9.8,
                    apyDropBps: 270,
                    threshold: 200,
                    fired: true,
                }),
            }),
            expect.objectContaining({
                trigger: 'reward_change',
                urgency: 'high',
                data: expect.objectContaining({
                    vaultId: 'vault-a',
                    vaultAddress: '0xvault-a',
                    shareTokenId: '0xshare-a',
                    strategyAddress: '0xstrategy-a',
                    redeemAll: true,
                    previousRewardTokenSymbols: ['BONZO', 'HBAR'],
                    currentRewardTokenSymbols: ['BONZO'],
                    fired: true,
                }),
            }),
        ])
        expect(result.nextState).toEqual({
            vaultId: 'vault-a',
            apy: 9.8,
            tvl: 1000000,
            rewardTokenSymbols: ['BONZO'],
            fetchedAt: '2026-03-23T06:00:00.000Z',
            healthStatus: 'healthy',
        })
    })

    it('emits a vault_health signal when the current vault is degraded', () => {
        const result = evaluateBonzoMonitor({
            currentPosition: makePosition({ vaultId: 'vault-a' }),
            opportunities: [makeOpportunity({ vaultId: 'vault-a', tvl: 90000 })],
            vaultHealth: [
                makeHealth({
                    vaultId: 'vault-a',
                    status: 'degraded',
                    reason: 'Withdrawal queue backing up',
                }),
            ],
            config: {
                minRebalanceApyDeltaBps: 0,
                minHealthyTvlUsd: 100000,
            },
            now: () => new Date('2026-03-23T07:00:00.000Z'),
        })

        expect(result.response.exitSignals).toEqual([
            expect.objectContaining({
                trigger: 'vault_health',
                urgency: 'high',
                data: expect.objectContaining({
                    vaultId: 'vault-a',
                    vaultAddress: '0xvault-a',
                    shareTokenId: '0xshare-a',
                    strategyAddress: '0xstrategy-a',
                    redeemAll: true,
                    status: 'degraded',
                    reason: 'Withdrawal queue backing up',
                    tvl: 90000,
                    fetchedAt: '2026-03-23T06:00:00.000Z',
                    fired: true,
                }),
            }),
        ])
        expect(result.nextState?.healthStatus).toBe('degraded')
    })

    it('only emits explicitly enabled triggers', () => {
        const result = evaluateBonzoMonitor({
            currentPosition: makePosition({
                vaultId: 'vault-a',
                lastObservedApy: 12.5,
            }),
            previousState: makeMonitorState({
                vaultId: 'vault-a',
                apy: 12.5,
                rewardTokenSymbols: ['BONZO', 'HBAR'],
            }),
            opportunities: [
                makeOpportunity({
                    vaultId: 'vault-a',
                    apy: 9.8,
                    rewardTokens: [{ symbol: 'BONZO' }],
                }),
                makeOpportunity({
                    vaultId: 'vault-b',
                    vaultName: 'Vault B',
                    apy: 13.4,
                    shareTokenId: '0xshare-b',
                    strategyAddress: '0xstrategy-b',
                    vaultAddress: '0xvault-b',
                }),
            ],
            config: {
                minRebalanceApyDeltaBps: 50,
                maxApyDropBps: 200,
                exitOnRewardTokenChange: true,
                enabledTriggers: ['vault_health'],
            },
            now: () => new Date('2026-03-23T07:00:00.000Z'),
        })

        expect(result.response.status).toBe('no_action')
        expect(result.response.exitSignals).toEqual([])
    })
})
