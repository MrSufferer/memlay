import { describe, expect, it } from 'vitest'
import type { BonzoPositionState } from '../../hedera/positions/bonzo'
import type { BonzoVaultOpportunity } from './opportunities'
import { selectBestBonzoVault } from './ranking'

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

describe('Bonzo APY ranking', () => {
    it('keeps the current vault on exact APY ties', () => {
        const result = selectBestBonzoVault({
            opportunities: [
                makeOpportunity({ vaultId: 'vault-a', apy: 12 }),
                makeOpportunity({ vaultId: 'vault-b', apy: 12, shareTokenId: '0xshare-b' }),
            ],
            currentPosition: makePosition({ vaultId: 'vault-b', shareTokenId: '0xshare-b' }),
            minApyDeltaBps: 10,
        })

        expect(result).toEqual({
            currentVaultId: 'vault-b',
            bestVaultId: 'vault-b',
            bestApy: 12,
            apyDeltaBps: 0,
            rebalance: false,
            reason: 'Current vault vault-b remains the highest APY candidate',
        })
    })

    it('does not rebalance when the APY delta is below the configured threshold', () => {
        const result = selectBestBonzoVault({
            opportunities: [
                makeOpportunity({ vaultId: 'vault-a', apy: 10.5 }),
                makeOpportunity({ vaultId: 'vault-b', apy: 10.8, shareTokenId: '0xshare-b' }),
            ],
            currentPosition: makePosition({ vaultId: 'vault-a' }),
            minApyDeltaBps: 40,
        })

        expect(result.rebalance).toBe(false)
        expect(result.bestVaultId).toBe('vault-b')
        expect(result.apyDeltaBps).toBe(30)
        expect(result.reason).toContain('below the configured rebalance threshold')
    })

    it('rebalances when the best vault clears the minimum APY delta threshold', () => {
        const result = selectBestBonzoVault({
            opportunities: [
                makeOpportunity({ vaultId: 'vault-a', apy: 8.1 }),
                makeOpportunity({ vaultId: 'vault-b', apy: 9.2, shareTokenId: '0xshare-b' }),
            ],
            currentPosition: makePosition({ vaultId: 'vault-a' }),
            minApyDeltaBps: 50,
        })

        expect(result).toEqual({
            currentVaultId: 'vault-a',
            bestVaultId: 'vault-b',
            bestApy: 9.2,
            apyDeltaBps: 110,
            rebalance: true,
            reason: 'Vault vault-b exceeds current vault vault-a by 110 bps',
        })
    })

    it('selects the highest APY vault when there is no current position', () => {
        const result = selectBestBonzoVault({
            opportunities: [
                makeOpportunity({ vaultId: 'vault-a', apy: 8.1 }),
                makeOpportunity({ vaultId: 'vault-b', apy: 11.4, shareTokenId: '0xshare-b' }),
            ],
            currentPosition: null,
            minApyDeltaBps: 100,
        })

        expect(result).toEqual({
            currentVaultId: null,
            bestVaultId: 'vault-b',
            bestApy: 11.4,
            apyDeltaBps: 0,
            rebalance: true,
            reason: 'No current Bonzo position is active; select vault-b as the highest APY vault',
        })
    })
})
