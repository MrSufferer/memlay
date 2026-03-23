import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolRequest } from '../../../cre-memoryvault/protocol/tool-interface'
import type { HederaEnvConfig } from '../../hedera/env'
import {
    BonzoVaultExecutor,
    buildBonzoEnterRequest,
    buildBonzoEnterPlan,
    buildBonzoExitRequest,
    buildBonzoExitPlan,
} from './execution'

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

describe('Bonzo execution adapter', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('builds an enter ToolRequest from a scored Bonzo opportunity', () => {
        expect(
            buildBonzoEnterRequest({
                agentId: 'agent-hedera-01',
                strategyType: 'custom',
                amount: 250n,
                allocationPctBps: 1000,
                opportunity: {
                    toolId: 'bonzo-vaults',
                    assetId: 'vault-single',
                    opportunityScore: 88,
                    trustScore: 83,
                    riskLevel: 'LOW',
                    reasoning: 'Prefer the HBAR leg.',
                    entryParams: {
                        venue: 'bonzo-vaults',
                        vaultId: 'vault-single',
                        vaultName: 'Vault Single',
                        vaultType: 'Single Asset',
                        assetSymbols: ['HBAR', 'USDC'],
                        primaryAssetSymbol: 'HBAR',
                        tvl: 500000,
                        apr: 9.5,
                        apy: 10.1,
                        rewardTokenSymbols: ['BONZO'],
                        shareTokenId: '0xshare-single',
                        strategyAddress: '0xstrategy-single',
                        vaultAddress: '0xvault-single',
                        source: 'mock',
                        fetchedAt: '2026-03-23T06:00:00.000Z',
                        vault: {
                            vaultId: 'vault-single',
                            vaultName: 'Vault Single',
                            vaultType: 'Single Asset',
                            strategyFamily: 'single-asset-dex',
                            assetSymbols: ['HBAR', 'USDC'],
                            tvl: 500000,
                            apr: 9.5,
                            apy: 10.1,
                            rewardTokens: [{ symbol: 'BONZO' }],
                            shareTokenId: '0xshare-single',
                            strategyAddress: '0xstrategy-single',
                            vaultAddress: '0xvault-single',
                            source: 'mock',
                            fetchedAt: '2026-03-23T06:00:00.000Z',
                        },
                    },
                },
            })
        ).toEqual({
            action: 'enter',
            agentId: 'agent-hedera-01',
            strategyType: 'custom',
            params: {
                vaultId: 'vault-single',
                vaultAddress: '0xvault-single',
                shareTokenId: '0xshare-single',
                strategyAddress: '0xstrategy-single',
                depositAssets: [{ symbol: 'HBAR', amount: '250' }],
                allocationPctBps: 1000,
                vault: expect.objectContaining({
                    vaultId: 'vault-single',
                    shareTokenId: '0xshare-single',
                    strategyFamily: 'single-asset-dex',
                }),
            },
        })
    })

    it('builds an exit ToolRequest from Bonzo monitor signal metadata', () => {
        expect(
            buildBonzoExitRequest({
                agentId: 'agent-hedera-01',
                strategyType: 'custom',
                signal: {
                    trigger: 'vault_health',
                    urgency: 'high',
                    data: {
                        vaultId: 'vault-single',
                        vaultAddress: '0xvault-single',
                        shareTokenId: '0xshare-single',
                        strategyAddress: '0xstrategy-single',
                        redeemAll: true,
                    },
                },
            })
        ).toEqual({
            action: 'exit',
            agentId: 'agent-hedera-01',
            strategyType: 'custom',
            params: {
                vaultId: 'vault-single',
                vaultAddress: '0xvault-single',
                shareTokenId: '0xshare-single',
                strategyAddress: '0xstrategy-single',
                redeemAll: true,
                sharesIn: undefined,
                trigger: 'vault_health',
                urgency: 'high',
            },
        })
    })

    it('maps enter requests into single-asset deposit parameters', () => {
        const request: ToolRequest = {
            action: 'enter',
            agentId: 'agent-alpha-01',
            strategyType: 'clmm_lp',
            params: {
                vault: {
                    vaultId: 'vault-single',
                    vaultAddress: '0xvault-single',
                    shareTokenId: '0xshare-single',
                    strategyAddress: '0xstrategy-single',
                },
                depositAssets: [
                    { symbol: 'HBAR', tokenId: '0.0.3001', amount: '250' },
                ],
                minSharesOut: '245',
                slippageBps: 50,
            },
        }

        expect(buildBonzoEnterPlan(request, makeEnv())).toEqual({
            action: 'enter',
            method: 'deposit-single',
            vaultId: 'vault-single',
            vaultAddress: '0xvault-single',
            shareTokenId: '0xshare-single',
            strategyAddress: '0xstrategy-single',
            accountId: '0.0.1001',
            signerOwner: 'operator',
            depositAssets: [
                { symbol: 'HBAR', tokenId: '0.0.3001', amount: '250' },
            ],
            minSharesOut: '245',
            slippageBps: 50,
        })
    })

    it('maps enter requests into pair-deposit parameters and uses the execution signer', () => {
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
        const request: ToolRequest = {
            action: 'enter',
            agentId: 'agent-alpha-01',
            strategyType: 'clmm_lp',
            params: {
                vaultId: 'vault-dual',
                vaultAddress: '0xvault-dual',
                shareTokenId: '0xshare-dual',
                strategyAddress: '0xstrategy-dual',
                depositAssets: [
                    { symbol: 'USDC', amount: '100' },
                    { symbol: 'HBAR', amount: '200' },
                ],
            },
        }

        expect(buildBonzoEnterPlan(request, env)).toEqual({
            action: 'enter',
            method: 'deposit-pair',
            vaultId: 'vault-dual',
            vaultAddress: '0xvault-dual',
            shareTokenId: '0xshare-dual',
            strategyAddress: '0xstrategy-dual',
            accountId: '0.0.7007',
            signerOwner: 'bonzo-executor',
            depositAssets: [
                { symbol: 'USDC', tokenId: undefined, amount: '100' },
                { symbol: 'HBAR', tokenId: undefined, amount: '200' },
            ],
            minSharesOut: undefined,
            slippageBps: undefined,
        })
    })

    it('maps exit requests into withdraw parameters', () => {
        const request: ToolRequest = {
            action: 'exit',
            agentId: 'agent-alpha-01',
            strategyType: 'clmm_lp',
            params: {
                vaultId: 'vault-dual',
                vaultAddress: '0xvault-dual',
                shareTokenId: '0xshare-dual',
                strategyAddress: '0xstrategy-dual',
                sharesIn: '55',
                minAssetsOut: [
                    { symbol: 'USDC', minAmount: '20' },
                    { symbol: 'HBAR', minAmount: '30' },
                ],
            },
        }

        expect(buildBonzoExitPlan(request, makeEnv())).toEqual({
            action: 'exit',
            method: 'withdraw',
            vaultId: 'vault-dual',
            vaultAddress: '0xvault-dual',
            shareTokenId: '0xshare-dual',
            strategyAddress: '0xstrategy-dual',
            accountId: '0.0.1001',
            signerOwner: 'operator',
            sharesIn: '55',
            redeemAll: false,
            minAssetsOut: [
                { symbol: 'USDC', tokenId: undefined, minAmount: '20' },
                { symbol: 'HBAR', tokenId: undefined, minAmount: '30' },
            ],
        })
    })

    it('returns a simulated ToolResponse for enter and exit flows', async () => {
        const deposit = vi.fn().mockResolvedValue({ status: 'simulated' })
        const withdraw = vi.fn().mockResolvedValue({ status: 'simulated' })
        const executor = new BonzoVaultExecutor(makeEnv(), {
            transport: { deposit, withdraw },
        })

        const enterResponse = await executor.enter({
            action: 'enter',
            agentId: 'agent-alpha-01',
            strategyType: 'clmm_lp',
            params: {
                vaultId: 'vault-single',
                vaultAddress: '0xvault-single',
                shareTokenId: '0xshare-single',
                strategyAddress: '0xstrategy-single',
                depositAssets: [{ symbol: 'HBAR', amount: '25' }],
            },
        })
        const exitResponse = await executor.exit({
            action: 'exit',
            agentId: 'agent-alpha-01',
            strategyType: 'clmm_lp',
            params: {
                vaultId: 'vault-single',
                vaultAddress: '0xvault-single',
                shareTokenId: '0xshare-single',
                strategyAddress: '0xstrategy-single',
                redeemAll: true,
            },
        })

        expect(deposit).toHaveBeenCalledTimes(1)
        expect(withdraw).toHaveBeenCalledTimes(1)
        expect(enterResponse).toMatchObject({
            status: 'success',
            action: 'enter',
            toolId: 'bonzo-vaults',
            data: {
                mode: 'simulate',
                executionPlan: {
                    method: 'deposit-single',
                    vaultId: 'vault-single',
                },
            },
        })
        expect(exitResponse).toMatchObject({
            status: 'success',
            action: 'exit',
            toolId: 'bonzo-vaults',
            data: {
                mode: 'simulate',
                executionPlan: {
                    method: 'withdraw',
                    redeemAll: true,
                    sharesIn: 'all',
                },
            },
        })
    })

    it('rejects live mode without an execution transport', () => {
        expect(
            () => new BonzoVaultExecutor(makeEnv(), { mode: 'live' })
        ).toThrow('Live mode requires a BonzoExecutionTransport implementation')
    })

    it('logs simulated execution plans in simulate mode', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        const executor = new BonzoVaultExecutor(makeEnv(), {
            mode: 'simulate',
        })

        await executor.enter({
            action: 'enter',
            agentId: 'agent-alpha-01',
            strategyType: 'custom',
            params: {
                vaultId: 'vault-single',
                vaultAddress: '0xvault-single',
                shareTokenId: '0xshare-single',
                strategyAddress: '0xstrategy-single',
                depositAssets: [{ symbol: 'HBAR', amount: '25' }],
            },
        })

        expect(logSpy).toHaveBeenCalledWith(
            '[bonzo-execution] simulate deposit:',
            expect.objectContaining({
                vaultId: 'vault-single',
                method: 'deposit-single',
            })
        )
    })
})
