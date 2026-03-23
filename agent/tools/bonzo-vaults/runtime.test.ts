import { describe, expect, it, vi } from 'vitest'
import type { HederaEnvConfig } from '../../hedera/env'
import type { BonzoPositionSource } from '../../hedera/positions/bonzo'
import { HederaBonzoToolRuntime } from './runtime'

function makeEnv(): HederaEnvConfig {
    return {
        network: 'testnet',
        operatorAccountId: '0.0.1001',
        operatorPrivateKey: 'operator-private-key',
        operatorPrivateKeySource: 'env',
        mirrorNodeUrl: 'https://mirror.example.com/api/v1',
        stateStorePath: '.agent/hedera-state.json',
        bonzoDataSource: 'mock',
        bonzoExecutionMode: 'simulate',
        bonzoMinApyDeltaBps: 50,
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

describe('HederaBonzoToolRuntime', () => {
    it('returns the best Bonzo candidate when no current position exists', async () => {
        const runtime = new HederaBonzoToolRuntime(makeEnv(), {
            positionSource: {
                listPositions: vi.fn().mockResolvedValue([]),
            },
        })

        const response = await runtime.scan('bonzo-vaults')

        expect(response).toMatchObject({
            status: 'success',
            action: 'scan',
            toolId: 'bonzo-vaults',
            data: {
                bestVaultId: 'bonzo-xbonzo-dual',
            },
        })
        expect(response.opportunities).toHaveLength(1)
        expect(response.opportunities?.[0]?.assetId).toBe('bonzo-xbonzo-dual')
    })

    it('returns no_action when the current vault remains best', async () => {
        const positionSource: BonzoPositionSource = {
            listPositions: vi.fn().mockResolvedValue([
                {
                    accountId: '0.0.1001',
                    vaultId: 'bonzo-xbonzo-dual',
                    shareTokenId: '0xcfba07324bd207C3ED41416a9a36f8184F9a2134',
                    shareBalance: '25',
                    assetBalances: [{ symbol: 'BONZO', amount: '100' }],
                    lastObservedApr: 13.1,
                    lastObservedApy: 14,
                    updatedAt: '2026-03-23T00:00:00.000Z',
                },
            ]),
        }
        const runtime = new HederaBonzoToolRuntime(makeEnv(), { positionSource })

        const response = await runtime.scan('bonzo-vaults')

        expect(response.status).toBe('no_action')
        expect(response.opportunities).toEqual([])
        expect(response.data.reason).toContain('remains the highest APY candidate')
    })

    it('filters live scan candidates down to single-asset vaults', async () => {
        const runtime = new HederaBonzoToolRuntime({
            ...makeEnv(),
            bonzoExecutionMode: 'live',
        }, {
            positionSource: {
                listPositions: vi.fn().mockResolvedValue([]),
            },
        })

        const response = await runtime.scan('bonzo-vaults')

        expect(response).toMatchObject({
            status: 'success',
            action: 'scan',
            toolId: 'bonzo-vaults',
            data: {
                bestVaultId: 'sauce-hbar-single',
                availableVaults: expect.any(Number),
            },
        })
        expect(response.opportunities?.[0]?.assetId).toBe('sauce-hbar-single')
    })

    it('refuses live scan re-entry when the current position is a non-executable dual-asset vault', async () => {
        const runtime = new HederaBonzoToolRuntime({
            ...makeEnv(),
            bonzoExecutionMode: 'live',
        }, {
            positionSource: {
                listPositions: vi.fn().mockResolvedValue([
                    {
                        accountId: '0.0.1001',
                        vaultId: 'bonzo-xbonzo-dual',
                        shareTokenId: '0xcfba07324bd207C3ED41416a9a36f8184F9a2134',
                        shareBalance: '10',
                        assetBalances: [{ symbol: 'BONZO', amount: '100' }],
                        lastObservedApr: 13.1,
                        lastObservedApy: 14,
                        updatedAt: '2026-03-23T00:00:00.000Z',
                    },
                ]),
            },
        })

        const response = await runtime.scan('bonzo-vaults')

        expect(response).toMatchObject({
            status: 'no_action',
            action: 'scan',
            toolId: 'bonzo-vaults',
            data: {
                currentVaultId: 'bonzo-xbonzo-dual',
            },
            opportunities: [],
        })
        expect(response.data.reason).toContain('only single-asset-dex vaults are currently enabled')
    })
})
