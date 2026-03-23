import { describe, expect, it, vi } from 'vitest'
import type { HederaEnvConfig } from '../../hedera/env'
import { createBonzoVaultDiscoverySource } from './discovery'

function makeEnv(
    overrides: Partial<HederaEnvConfig> = {}
): HederaEnvConfig {
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
        ...overrides,
    }
}

describe('Bonzo vault discovery', () => {
    it('returns the official live vault catalog in mock mode with mock snapshots', async () => {
        const source = createBonzoVaultDiscoverySource(makeEnv())

        const vaults = await source.discoverVaults()

        expect(vaults.length).toBeGreaterThan(10)
        expect(vaults.some((vault) => vault.vaultId === 'usdc-hbar-dual')).toBe(true)
        expect(vaults.find((vault) => vault.vaultId === 'usdc-hbar-dual')).toMatchObject({
            source: 'mock',
            apy: 11.9,
            rewardTokens: [{ symbol: 'BONZO' }, { symbol: 'SAUCE' }],
        })
    })

    it('combines official catalog metadata with contract snapshot overrides', async () => {
        const source = createBonzoVaultDiscoverySource(
            makeEnv({
                bonzoDataSource: 'contracts',
                bonzoContractEnv: {
                    BONZO_CONTRACT_SINGLE_ASSET_FACTORY:
                        '0x822b0bE4958ab5b4A48DA3c5f68Fc54846093618',
                    BONZO_CONTRACT_VAULT_SNAPSHOTS_JSON: JSON.stringify([
                        {
                            vaultId: 'sauce-hbar-single',
                            tvl: 123456,
                            apr: 7.2,
                            apy: 7.5,
                            rewardTokens: [{ symbol: 'SAUCE' }],
                            fetchedAt: '2026-03-23T03:00:00.000Z',
                        },
                    ]),
                },
            }),
            {
                now: () => new Date('2026-03-23T03:30:00.000Z'),
            }
        )

        const vaults = await source.discoverVaults()
        const target = vaults.find((vault) => vault.vaultId === 'sauce-hbar-single')

        expect(target).toMatchObject({
            source: 'contracts',
            tvl: 123456,
            apr: 7.2,
            apy: 7.5,
            strategyAddress: '0x822b0bE4958ab5b4A48DA3c5f68Fc54846093618',
            fetchedAt: '2026-03-23T03:00:00.000Z',
        })
    })

    it('uses the api payload directly when the feed returns full vault records', async () => {
        const fetcher = {
            fetch: vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                statusText: 'OK',
                json: async () => ({
                    vaults: [
                        {
                            vaultId: 'custom-dual',
                            vaultName: 'Custom Dual',
                            vaultType: 'Volatile / Stable (Major)',
                            assetSymbols: ['USDC', 'HBAR'],
                            tvl: 555000,
                            apr: 12.2,
                            apy: 12.9,
                            rewardTokens: [{ symbol: 'BONZO' }],
                            shareTokenId: '0xshare',
                            strategyAddress: '0xstrategy',
                            vaultAddress: '0xvault',
                            source: 'api',
                            fetchedAt: '2026-03-23T04:00:00.000Z',
                        },
                    ],
                }),
            }),
        }
        const source = createBonzoVaultDiscoverySource(
            makeEnv({
                bonzoDataSource: 'api',
                bonzoContractEnv: {
                    BONZO_CONTRACT_VAULTS_API_URL: 'https://bonzo.example.com/vaults',
                },
            }),
            { fetcher }
        )

        const vaults = await source.discoverVaults()

        expect(fetcher.fetch).toHaveBeenCalledWith('https://bonzo.example.com/vaults')
        expect(vaults).toEqual([
            expect.objectContaining({
                vaultId: 'custom-dual',
                source: 'api',
                apy: 12.9,
            }),
        ])
    })

    it('uses official catalog metadata when the api only returns snapshots', async () => {
        const fetcher = {
            fetch: vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                statusText: 'OK',
                json: async () => ({
                    snapshots: [
                        {
                            vaultId: 'bonzo-xbonzo-dual',
                            tvl: 888000,
                            apr: 15.2,
                            apy: 16.1,
                            rewardTokens: [{ symbol: 'BONZO' }],
                            fetchedAt: '2026-03-23T05:00:00.000Z',
                        },
                    ],
                }),
            }),
        }
        const source = createBonzoVaultDiscoverySource(
            makeEnv({
                bonzoDataSource: 'api',
                bonzoContractEnv: {
                    BONZO_CONTRACT_VAULTS_API_URL: 'https://bonzo.example.com/snapshots',
                },
            }),
            { fetcher }
        )

        const vaults = await source.discoverVaults()
        const target = vaults.find((vault) => vault.vaultId === 'bonzo-xbonzo-dual')

        expect(target).toMatchObject({
            source: 'api',
            vaultName: 'BONZO-XBONZO',
            apy: 16.1,
            rewardTokens: [{ symbol: 'BONZO' }],
        })
    })
})
