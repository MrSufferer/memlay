import {
    createPublicClient,
    createWalletClient,
    http,
    isAddress,
    parseAbi,
    type Address,
    type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { HederaEnvConfig } from './env'
import type {
    BonzoDepositPlan,
    BonzoExecutionTransport,
    BonzoExecutionTransportResult,
    BonzoWithdrawPlan,
} from '../tools/bonzo-vaults/execution'
import type { BonzoStrategyFamily, BonzoVaultOpportunity } from '../tools/bonzo-vaults/opportunities'

const ERC20_ABI = parseAbi([
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function balanceOf(address owner) view returns (uint256)',
    'function symbol() view returns (string)',
])

const ICHI_VAULT_ABI = parseAbi([
    'function deposit(uint256 deposit0, uint256 deposit1, address to) external returns (uint256 shares)',
    'function withdraw(uint256 shares, address to) external returns (uint256 amount0, uint256 amount1)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
])

interface BonzoLivePublicClient {
    readContract(args: {
        address: Address
        abi: readonly unknown[]
        functionName: string
        args?: readonly unknown[]
    }): Promise<unknown>
    waitForTransactionReceipt(args: { hash: Hex }): Promise<unknown>
}

interface BonzoLiveWalletClient {
    writeContract(args: {
        address: Address
        abi: readonly unknown[]
        functionName: string
        args?: readonly unknown[]
    }): Promise<Hex>
}

export interface HederaBonzoLiveTransportOptions {
    rpcUrl?: string
    publicClient?: BonzoLivePublicClient
    walletClient?: BonzoLiveWalletClient
}

function normalizeOptional(value: string | undefined): string | undefined {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
}

function normalizeRpcUrl(env: HederaEnvConfig, override?: string): string {
    const rpcUrl = normalizeOptional(override ?? env.bonzoContractEnv.BONZO_CONTRACT_RPC_URL)
    if (!rpcUrl) {
        throw new Error(
            '[bonzo-live] BONZO_CONTRACT_RPC_URL is required when BONZO_EXECUTION_MODE=live'
        )
    }

    return rpcUrl
}

function normalizeHexPrivateKey(privateKey: string): Hex {
    const normalized = privateKey.trim().startsWith('0x')
        ? privateKey.trim()
        : `0x${privateKey.trim()}`

    if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
        throw new Error(
            '[bonzo-live] Live Bonzo execution requires an ECDSA private key hex string for the execution signer'
        )
    }

    return normalized as Hex
}

function requireAddress(name: string, value: string): Address {
    if (!isAddress(value)) {
        throw new Error(`[bonzo-live] Invalid ${name}: ${value}`)
    }

    return value
}

function parseAtomicAmount(name: string, value: string): bigint {
    if (!/^[0-9]+$/.test(value)) {
        throw new Error(`[bonzo-live] ${name} must be an integer atomic amount string`)
    }

    return BigInt(value)
}

function normalizeSymbol(value: string): string {
    return value.trim().toUpperCase()
}

function symbolsMatch(requested: string, onchain: string): boolean {
    const left = normalizeSymbol(requested)
    const right = normalizeSymbol(onchain)

    if (left === right) {
        return true
    }

    return (
        (left === 'HBAR' && right === 'WHBAR') ||
        (left === 'WHBAR' && right === 'HBAR')
    )
}

function assertSingleAssetStrategy(
    strategyFamily: BonzoStrategyFamily | undefined,
    action: 'deposit' | 'withdraw'
): void {
    if (strategyFamily !== 'single-asset-dex') {
        throw new Error(
            `[bonzo-live] Live Bonzo ${action} currently supports only single-asset-dex vaults`
        )
    }
}

function assertNoMinOutputGuards(plan: BonzoDepositPlan | BonzoWithdrawPlan): void {
    if (plan.action === 'enter') {
        if (plan.minSharesOut !== undefined || plan.slippageBps !== undefined) {
            throw new Error(
                '[bonzo-live] minSharesOut and slippageBps are not yet enforced by live Bonzo deposits'
            )
        }
        return
    }

    const hasFloor = plan.minAssetsOut.some((asset) => asset.minAmount !== '0')
    if (hasFloor) {
        throw new Error(
            '[bonzo-live] minAssetsOut floors are not yet enforced by live Bonzo withdrawals'
        )
    }
}

export function isLiveExecutableBonzoOpportunity(
    opportunity: BonzoVaultOpportunity
): boolean {
    return opportunity.strategyFamily === 'single-asset-dex'
}

export function validateHederaBonzoLiveConfig(env: HederaEnvConfig): void {
    if (env.bonzoExecutionMode !== 'live') {
        return
    }

    if (env.bonzoDataSource === 'mock') {
        throw new Error(
            '[bonzo-live] BONZO_DATA_SOURCE=mock is not supported when BONZO_EXECUTION_MODE=live'
        )
    }

    normalizeRpcUrl(env)

    if (
        env.network !== 'mainnet' &&
        !normalizeOptional(env.bonzoContractEnv.BONZO_CONTRACT_VAULTS_JSON)
    ) {
        throw new Error(
            '[bonzo-live] BONZO_CONTRACT_VAULTS_JSON is required for live Bonzo execution outside mainnet'
        )
    }
}

export class HederaBonzoLiveTransport implements BonzoExecutionTransport {
    private readonly publicClient: BonzoLivePublicClient
    private readonly walletClient: BonzoLiveWalletClient
    private readonly accountAddress: Address

    constructor(
        private readonly env: HederaEnvConfig,
        options: HederaBonzoLiveTransportOptions = {}
    ) {
        validateHederaBonzoLiveConfig(env)

        const account = privateKeyToAccount(
            normalizeHexPrivateKey(env.executionSigner.privateKey)
        )
        const rpcUrl = normalizeRpcUrl(env, options.rpcUrl)
        const transport = http(rpcUrl)

        this.accountAddress = account.address
        this.publicClient = options.publicClient ?? createPublicClient({ transport })
        this.walletClient = options.walletClient ?? createWalletClient({
            account,
            transport,
        })
    }

    async deposit(plan: BonzoDepositPlan): Promise<BonzoExecutionTransportResult> {
        assertSingleAssetStrategy(plan.strategyFamily, 'deposit')
        assertNoMinOutputGuards(plan)

        if (plan.method !== 'deposit-single' || plan.depositAssets.length !== 1) {
            throw new Error(
                '[bonzo-live] Live Bonzo deposits currently support exactly one deposit asset'
            )
        }

        const vaultAddress = requireAddress('vaultAddress', plan.vaultAddress)
        const token0 = await this.readAddress(vaultAddress, 'token0')
        const token1 = await this.readAddress(vaultAddress, 'token1')
        const token0Symbol = await this.readSymbol(token0)
        const token1Symbol = await this.readSymbol(token1)
        const asset = plan.depositAssets[0]

        const resolvedAmount =
            plan.allocationPctBps !== undefined
                ? await this.resolveAllocationSizedAmount({
                    tokenAddress:
                        symbolsMatch(asset.symbol, token0Symbol)
                            ? token0
                            : symbolsMatch(asset.symbol, token1Symbol)
                                ? token1
                                : undefined,
                    symbol: asset.symbol,
                    allocationPctBps: plan.allocationPctBps,
                })
                : parseAtomicAmount('depositAssets[0].amount', asset.amount)

        let deposit0 = 0n
        let deposit1 = 0n

        if (symbolsMatch(asset.symbol, token0Symbol)) {
            deposit0 = resolvedAmount
        } else if (symbolsMatch(asset.symbol, token1Symbol)) {
            deposit1 = resolvedAmount
        } else {
            throw new Error(
                `[bonzo-live] Deposit asset ${asset.symbol} does not match vault tokens ${token0Symbol}/${token1Symbol}`
            )
        }

        plan.depositAssets[0] = {
            ...asset,
            amount: resolvedAmount.toString(),
        }

        const nonZeroDeposit = deposit0 > 0n ? { tokenAddress: token0, amount: deposit0 } : { tokenAddress: token1, amount: deposit1 }
        if (nonZeroDeposit.amount <= 0n) {
            throw new Error('[bonzo-live] Deposit amount must be greater than zero')
        }

        await this.approve(nonZeroDeposit.tokenAddress, vaultAddress, nonZeroDeposit.amount)

        const txHash = await this.walletClient.writeContract({
            address: vaultAddress,
            abi: ICHI_VAULT_ABI,
            functionName: 'deposit',
            args: [deposit0, deposit1, this.accountAddress],
        })

        await this.publicClient.waitForTransactionReceipt({ hash: txHash })

        return {
            status: 'submitted',
            transactionId: txHash,
        }
    }

    async withdraw(plan: BonzoWithdrawPlan): Promise<BonzoExecutionTransportResult> {
        assertSingleAssetStrategy(plan.strategyFamily, 'withdraw')
        assertNoMinOutputGuards(plan)

        const vaultAddress = requireAddress('vaultAddress', plan.vaultAddress)
        const shareTokenAddress = requireAddress('shareTokenId', plan.shareTokenId)
        const sharesIn =
            plan.sharesIn === 'all'
                ? await this.readUint256(shareTokenAddress, 'balanceOf', [this.accountAddress])
                : parseAtomicAmount('sharesIn', plan.sharesIn)

        if (sharesIn <= 0n) {
            throw new Error('[bonzo-live] Withdraw amount must be greater than zero')
        }

        plan.sharesIn = sharesIn.toString()

        const txHash = await this.walletClient.writeContract({
            address: vaultAddress,
            abi: ICHI_VAULT_ABI,
            functionName: 'withdraw',
            args: [sharesIn, this.accountAddress],
        })

        await this.publicClient.waitForTransactionReceipt({ hash: txHash })

        return {
            status: 'submitted',
            transactionId: txHash,
        }
    }

    private async approve(
        tokenAddress: Address,
        spender: Address,
        amount: bigint
    ): Promise<void> {
        const approvalHash = await this.walletClient.writeContract({
            address: tokenAddress,
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [spender, amount],
        })

        await this.publicClient.waitForTransactionReceipt({ hash: approvalHash })
    }

    private async readAddress(
        address: Address,
        functionName: 'token0' | 'token1'
    ): Promise<Address> {
        const value = await this.publicClient.readContract({
            address,
            abi: ICHI_VAULT_ABI,
            functionName,
        })

        if (typeof value !== 'string' || !isAddress(value)) {
            throw new Error(`[bonzo-live] ${functionName} returned an invalid address`)
        }

        return value
    }

    private async readSymbol(address: Address): Promise<string> {
        const value = await this.publicClient.readContract({
            address,
            abi: ERC20_ABI,
            functionName: 'symbol',
        })

        if (typeof value !== 'string' || !value.trim()) {
            throw new Error(`[bonzo-live] symbol() returned an invalid value for ${address}`)
        }

        return value
    }

    private async readUint256(
        address: Address,
        functionName: 'balanceOf',
        args: readonly unknown[]
    ): Promise<bigint> {
        const value = await this.publicClient.readContract({
            address,
            abi: ERC20_ABI,
            functionName,
            args,
        })

        if (typeof value !== 'bigint') {
            throw new Error(`[bonzo-live] ${functionName} returned a non-bigint value`)
        }

        return value
    }

    private async resolveAllocationSizedAmount(args: {
        tokenAddress: Address | undefined
        symbol: string
        allocationPctBps: number
    }): Promise<bigint> {
        if (!args.tokenAddress) {
            throw new Error(
                `[bonzo-live] Could not resolve a live token address for ${args.symbol}`
            )
        }

        const balance = await this.readUint256(
            args.tokenAddress,
            'balanceOf',
            [this.accountAddress]
        )
        const amount = (balance * BigInt(args.allocationPctBps)) / 10000n

        if (amount <= 0n) {
            throw new Error(
                `[bonzo-live] Execution signer has insufficient ${args.symbol} balance for allocation-based deposit sizing`
            )
        }

        return amount
    }
}
