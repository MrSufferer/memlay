import { describe, expect, it, vi } from 'vitest'
import type { HederaEnvConfig } from '../env'
import {
    BonzoPositionReader,
    normalizeBonzoPositionState,
    resolveBonzoExecutionAccountId,
    selectCurrentBonzoPosition,
} from './bonzo'

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

describe('Bonzo position reader', () => {
    it('normalizes share and asset balances into a stable BonzoPositionState', () => {
        const position = normalizeBonzoPositionState({
            accountId: '0.0.2002',
            vaultId: 'vault-hbar',
            shareTokenId: '0.0.6001',
            shareBalance: 1250n,
            assetBalances: [
                { symbol: 'HBAR', amount: '100.5', tokenId: '0.0.3001' },
                { symbol: 'USDC', amount: 25 },
            ],
            lastObservedApr: 9.1,
            lastObservedApy: 9.5,
            updatedAt: '2026-03-23T02:00:00.000Z',
        })

        expect(position).toEqual({
            accountId: '0.0.2002',
            vaultId: 'vault-hbar',
            shareTokenId: '0.0.6001',
            shareBalance: '1250',
            assetBalances: [
                { symbol: 'HBAR', amount: '100.5', tokenId: '0.0.3001' },
                { symbol: 'USDC', amount: '25', tokenId: undefined },
            ],
            lastObservedApr: 9.1,
            lastObservedApy: 9.5,
            updatedAt: '2026-03-23T02:00:00.000Z',
        })
    })

    it('uses the execution signer account as the Bonzo read target', async () => {
        const env = makeEnv({
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
        })
        const source = {
            listPositions: vi.fn().mockResolvedValue([
                {
                    accountId: '0.0.7007',
                    vaultId: 'vault-usdc',
                    shareTokenId: '0.0.7001',
                    shareBalance: '15',
                    assetBalances: [{ symbol: 'USDC', amount: '250' }],
                    lastObservedApr: 7.2,
                    lastObservedApy: 7.4,
                    updatedAt: '2026-03-23T02:05:00.000Z',
                },
            ]),
        }
        const reader = new BonzoPositionReader(source, env)

        expect(resolveBonzoExecutionAccountId(env)).toBe('0.0.7007')
        await expect(reader.getCurrentPosition()).resolves.toEqual({
            accountId: '0.0.7007',
            vaultId: 'vault-usdc',
            shareTokenId: '0.0.7001',
            shareBalance: '15',
            assetBalances: [{ symbol: 'USDC', amount: '250', tokenId: undefined }],
            lastObservedApr: 7.2,
            lastObservedApy: 7.4,
            updatedAt: '2026-03-23T02:05:00.000Z',
        })
        expect(source.listPositions).toHaveBeenCalledWith('0.0.7007')
    })

    it('returns null when the execution account has no active Bonzo position', () => {
        const result = selectCurrentBonzoPosition([
            {
                accountId: '0.0.1001',
                vaultId: 'vault-empty',
                shareTokenId: '0.0.6001',
                shareBalance: '0',
                assetBalances: [{ symbol: 'HBAR', amount: '0' }],
                lastObservedApr: 0,
                lastObservedApy: 0,
                updatedAt: '2026-03-23T02:10:00.000Z',
            },
        ])

        expect(result).toBeNull()
    })

    it('rejects ambiguous multi-vault active state for the same execution account', () => {
        expect(() =>
            selectCurrentBonzoPosition([
                {
                    accountId: '0.0.1001',
                    vaultId: 'vault-a',
                    shareTokenId: '0.0.6001',
                    shareBalance: '1',
                    assetBalances: [{ symbol: 'HBAR', amount: '10' }],
                    lastObservedApr: 5,
                    lastObservedApy: 5.1,
                    updatedAt: '2026-03-23T02:11:00.000Z',
                },
                {
                    accountId: '0.0.1001',
                    vaultId: 'vault-b',
                    shareTokenId: '0.0.6002',
                    shareBalance: '2',
                    assetBalances: [{ symbol: 'USDC', amount: '20' }],
                    lastObservedApr: 6,
                    lastObservedApy: 6.2,
                    updatedAt: '2026-03-23T02:12:00.000Z',
                },
            ])
        ).toThrow('Multiple active Bonzo vault positions found')
    })
})
