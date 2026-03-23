import { describe, expect, it } from 'vitest'
import {
    BONZO_TOOL_ID,
    mapBonzoVaultOpportunitiesToRawOpportunities,
    mapBonzoVaultOpportunityToRawOpportunity,
    normalizeBonzoVaultOpportunity,
    type BonzoVaultOpportunity,
} from './opportunities'

function makeOpportunity(
    overrides: Partial<BonzoVaultOpportunity> = {}
): BonzoVaultOpportunity {
    return {
        vaultId: 'bonzo-hbar-usdc',
        vaultName: 'Bonzo HBAR/USDC Vault',
        vaultType: 'stable-lp',
        assetSymbols: ['HBAR', 'USDC'],
        tvl: 1250000,
        apr: 9.4,
        apy: 10.1,
        rewardTokens: [
            { symbol: 'BONZO', tokenId: '0.0.7001' },
        ],
        shareTokenId: '0.0.6001',
        strategyAddress: '0xstrategy',
        vaultAddress: '0xvault',
        source: 'contracts',
        fetchedAt: '2026-03-23T01:00:00.000Z',
        ...overrides,
    }
}

describe('Bonzo opportunity mapping', () => {
    it('maps a normalized Bonzo vault opportunity into RawOpportunity', () => {
        const raw = mapBonzoVaultOpportunityToRawOpportunity(makeOpportunity())

        expect(raw.toolId).toBe(BONZO_TOOL_ID)
        expect(raw.assetId).toBe('bonzo-hbar-usdc')
        expect(raw.entryParams).toEqual({
            venue: 'bonzo-vaults',
            vaultId: 'bonzo-hbar-usdc',
            vaultName: 'Bonzo HBAR/USDC Vault',
            vaultType: 'stable-lp',
            assetSymbols: ['HBAR', 'USDC'],
            primaryAssetSymbol: 'HBAR',
            tvl: 1250000,
            apr: 9.4,
            apy: 10.1,
            rewardTokenSymbols: ['BONZO'],
            shareTokenId: '0.0.6001',
            strategyAddress: '0xstrategy',
            vaultAddress: '0xvault',
            source: 'contracts',
            fetchedAt: '2026-03-23T01:00:00.000Z',
            vault: makeOpportunity(),
        })
    })

    it('normalizes Bonzo vault inputs and trims optional strings', () => {
        const normalized = normalizeBonzoVaultOpportunity(
            makeOpportunity({
                vaultName: '  Bonzo HBAR Vault  ',
                vaultAddress: '  0xvault  ',
                rewardTokens: [{ symbol: '  BONZO  ', tokenId: ' 0.0.7001 ' }],
            })
        )

        expect(normalized.vaultName).toBe('Bonzo HBAR Vault')
        expect(normalized.vaultAddress).toBe('0xvault')
        expect(normalized.rewardTokens).toEqual([
            { symbol: 'BONZO', tokenId: '0.0.7001' },
        ])
    })

    it('rejects invalid Bonzo opportunities before RawOpportunity mapping', () => {
        expect(() =>
            mapBonzoVaultOpportunityToRawOpportunity(
                makeOpportunity({
                    assetSymbols: [],
                })
            )
        ).toThrow('assetSymbols must contain at least one symbol')

        expect(() =>
            normalizeBonzoVaultOpportunity(
                makeOpportunity({
                    tvl: -1,
                })
            )
        ).toThrow('tvl must be non-negative')

        expect(() =>
            normalizeBonzoVaultOpportunity(
                makeOpportunity({
                    fetchedAt: 'not-a-date',
                })
            )
        ).toThrow('fetchedAt must be an ISO-8601 timestamp')
    })

    it('maps multiple Bonzo opportunities while preserving input order', () => {
        const raw = mapBonzoVaultOpportunitiesToRawOpportunities([
            makeOpportunity({ vaultId: 'vault-a', assetSymbols: ['HBAR'] }),
            makeOpportunity({ vaultId: 'vault-b', assetSymbols: ['USDC'] }),
        ])

        expect(raw.map((entry) => entry.assetId)).toEqual(['vault-a', 'vault-b'])
    })
})
