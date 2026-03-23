import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HederaEnvConfig } from './env'
import {
    HederaBonzoLiveTransport,
    validateHederaBonzoLiveConfig,
} from './bonzo-live-transport'
import type {
    BonzoDepositPlan,
    BonzoWithdrawPlan,
} from '../tools/bonzo-vaults/execution'

function makeEnv(
    overrides: Partial<HederaEnvConfig> = {}
): HederaEnvConfig {
    return {
        network: 'testnet',
        operatorAccountId: '0.0.1001',
        operatorPrivateKey: '0x0123456789012345678901234567890123456789012345678901234567890123',
        operatorPrivateKeySource: 'env',
        mirrorNodeUrl: 'https://mirror.example.com/api/v1',
        stateStorePath: '.agent/hedera-state.json',
        memoryTopicId: '0.0.8001',
        bonzoDataSource: 'contracts',
        bonzoExecutionMode: 'live',
        bonzoMinApyDeltaBps: 0,
        bonzoExecutorMode: 'operator',
        bonzoContractEnv: {
            BONZO_CONTRACT_RPC_URL: 'https://rpc.example.com',
            BONZO_CONTRACT_VAULTS_JSON: '[]',
        },
        privateHttpMode: 'stub',
        controlPlaneSigner: {
            plane: 'control',
            owner: 'operator',
            accountId: '0.0.1001',
            privateKey: '0x0123456789012345678901234567890123456789012345678901234567890123',
            privateKeySource: 'env',
        },
        executionSigner: {
            plane: 'execution',
            owner: 'operator',
            accountId: '0.0.1001',
            privateKey: '0x0123456789012345678901234567890123456789012345678901234567890123',
            privateKeySource: 'env',
        },
        signersShareAccount: true,
        ...overrides,
    }
}

describe('HederaBonzoLiveTransport', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('validates live config before startup', () => {
        expect(() =>
            validateHederaBonzoLiveConfig(
                makeEnv({
                    bonzoDataSource: 'mock',
                })
            )
        ).toThrow('BONZO_DATA_SOURCE=mock is not supported')

        expect(() =>
            validateHederaBonzoLiveConfig(
                makeEnv({
                    bonzoContractEnv: {
                        BONZO_CONTRACT_RPC_URL: 'https://rpc.example.com',
                    },
                })
            )
        ).toThrow('BONZO_CONTRACT_VAULTS_JSON is required')
    })

    it('sizes single-asset deposits from the live token balance and submits approve + deposit', async () => {
        const publicClient = {
            readContract: vi.fn().mockImplementation(async ({ functionName, address }) => {
                switch (functionName) {
                    case 'token0':
                        return '0x00000000000000000000000000000000000000a1'
                    case 'token1':
                        return '0x00000000000000000000000000000000000000b2'
                    case 'symbol':
                        return address === '0x00000000000000000000000000000000000000a1'
                            ? 'WHBAR'
                            : 'SAUCE'
                    case 'balanceOf':
                        return 5000n
                    default:
                        throw new Error(`Unexpected function ${functionName}`)
                }
            }),
            waitForTransactionReceipt: vi.fn().mockResolvedValue({}),
        }
        const walletClient = {
            writeContract: vi
                .fn()
                .mockResolvedValueOnce(`0x${'1'.repeat(64)}`)
                .mockResolvedValueOnce(`0x${'2'.repeat(64)}`),
        }
        const transport = new HederaBonzoLiveTransport(makeEnv(), {
            publicClient,
            walletClient,
        })
        const plan: BonzoDepositPlan = {
            action: 'enter',
            method: 'deposit-single',
            vaultId: 'hbar-sauce-single',
            vaultAddress: '0x0000000000000000000000000000000000001000',
            shareTokenId: '0x0000000000000000000000000000000000001000',
            strategyAddress: '0x0000000000000000000000000000000000002000',
            strategyFamily: 'single-asset-dex',
            accountId: '0.0.1001',
            signerOwner: 'operator',
            depositAssets: [{ symbol: 'HBAR', amount: '250' }],
            allocationPctBps: 1000,
        }

        const result = await transport.deposit(plan)

        expect(result).toEqual({
            status: 'submitted',
            transactionId: `0x${'2'.repeat(64)}`,
        })
        expect(plan.depositAssets[0]?.amount).toBe('500')
        expect(walletClient.writeContract).toHaveBeenNthCalledWith(1, {
            address: '0x00000000000000000000000000000000000000a1',
            abi: expect.any(Array),
            functionName: 'approve',
            args: ['0x0000000000000000000000000000000000001000', 500n],
        })
        expect(walletClient.writeContract).toHaveBeenNthCalledWith(2, {
            address: '0x0000000000000000000000000000000000001000',
            abi: expect.any(Array),
            functionName: 'deposit',
            args: [500n, 0n, expect.any(String)],
        })
    })

    it('resolves redeem-all withdrawals from the live share balance before submitting withdraw', async () => {
        const publicClient = {
            readContract: vi.fn().mockImplementation(async ({ functionName }) => {
                if (functionName === 'balanceOf') {
                    return 42n
                }

                throw new Error(`Unexpected function ${functionName}`)
            }),
            waitForTransactionReceipt: vi.fn().mockResolvedValue({}),
        }
        const walletClient = {
            writeContract: vi.fn().mockResolvedValue(`0x${'3'.repeat(64)}`),
        }
        const transport = new HederaBonzoLiveTransport(makeEnv(), {
            publicClient,
            walletClient,
        })
        const plan: BonzoWithdrawPlan = {
            action: 'exit',
            method: 'withdraw',
            vaultId: 'sauce-hbar-single',
            vaultAddress: '0x0000000000000000000000000000000000001000',
            shareTokenId: '0x0000000000000000000000000000000000001000',
            strategyAddress: '0x0000000000000000000000000000000000002000',
            strategyFamily: 'single-asset-dex',
            accountId: '0.0.1001',
            signerOwner: 'operator',
            sharesIn: 'all',
            redeemAll: true,
            minAssetsOut: [],
        }

        const result = await transport.withdraw(plan)

        expect(result).toEqual({
            status: 'submitted',
            transactionId: `0x${'3'.repeat(64)}`,
        })
        expect(plan.sharesIn).toBe('42')
        expect(walletClient.writeContract).toHaveBeenCalledWith({
            address: '0x0000000000000000000000000000000000001000',
            abi: expect.any(Array),
            functionName: 'withdraw',
            args: [42n, expect.any(String)],
        })
    })

    it('rejects unsupported live vault families', async () => {
        const transport = new HederaBonzoLiveTransport(makeEnv(), {
            publicClient: {
                readContract: vi.fn(),
                waitForTransactionReceipt: vi.fn(),
            },
            walletClient: {
                writeContract: vi.fn(),
            },
        })

        await expect(
            transport.deposit({
                action: 'enter',
                method: 'deposit-single',
                vaultId: 'usdc-hbar-dual',
                vaultAddress: '0x0000000000000000000000000000000000001000',
                shareTokenId: '0x0000000000000000000000000000000000001000',
                strategyAddress: '0x0000000000000000000000000000000000002000',
                strategyFamily: 'dual-asset-dex',
                accountId: '0.0.1001',
                signerOwner: 'operator',
                depositAssets: [{ symbol: 'USDC', amount: '100' }],
            })
        ).rejects.toThrow('supports only single-asset-dex vaults')
    })
})
