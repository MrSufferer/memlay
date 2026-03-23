import type {
    ExitSignal,
    ScoredOpportunity,
    ToolRequest,
    ToolResponse,
} from '../../../cre-memoryvault/protocol/tool-interface'
import type { HederaEnvConfig } from '../../hedera/env'
import {
    BONZO_TOOL_ID,
    type BonzoRawOpportunityEntryParams,
    type BonzoStrategyFamily,
    type BonzoVaultOpportunity,
} from './opportunities'

export type BonzoExecutionMode = 'simulate' | 'live'
export type BonzoDepositMethod = 'deposit-single' | 'deposit-pair'

export interface BonzoDepositAssetInput {
    symbol: string
    tokenId?: string
    amount: string
}

export interface BonzoWithdrawAssetFloor {
    symbol: string
    tokenId?: string
    minAmount: string
}

export interface BonzoDepositPlan {
    action: 'enter'
    method: BonzoDepositMethod
    vaultId: string
    vaultAddress: string
    shareTokenId: string
    strategyAddress: string
    strategyFamily?: BonzoStrategyFamily
    accountId: string
    signerOwner: HederaEnvConfig['executionSigner']['owner']
    depositAssets: BonzoDepositAssetInput[]
    allocationPctBps?: number
    minSharesOut?: string
    slippageBps?: number
}

export interface BonzoWithdrawPlan {
    action: 'exit'
    method: 'withdraw'
    vaultId: string
    vaultAddress: string
    shareTokenId: string
    strategyAddress: string
    strategyFamily?: BonzoStrategyFamily
    accountId: string
    signerOwner: HederaEnvConfig['executionSigner']['owner']
    sharesIn: string
    redeemAll: boolean
    minAssetsOut: BonzoWithdrawAssetFloor[]
}

export interface BonzoExecutionTransportResult {
    status: 'submitted' | 'simulated'
    transactionId?: string
}

export interface BonzoExecutionTransport {
    deposit(plan: BonzoDepositPlan): Promise<BonzoExecutionTransportResult>
    withdraw(plan: BonzoWithdrawPlan): Promise<BonzoExecutionTransportResult>
}

export interface BuildBonzoEnterRequestArgs {
    agentId: string
    strategyType: string
    opportunity: ScoredOpportunity
    amount: bigint | number | string
    allocationPctBps?: number
}

export interface BuildBonzoExitRequestArgs {
    agentId: string
    strategyType: string
    signal: ExitSignal
}

type BonzoExecutionPlan = BonzoDepositPlan | BonzoWithdrawPlan

interface ResolvedVaultMetadata {
    vaultId: string
    vaultAddress: string
    shareTokenId: string
    strategyAddress: string
    strategyFamily?: BonzoStrategyFamily
}

function normalizeOptional(value: string | undefined): string | undefined {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
}

function requireRecord(name: string, value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`[bonzo-execution] ${name} must be an object`)
    }

    return value as Record<string, unknown>
}

function requireString(name: string, value: unknown): string {
    if (typeof value !== 'string') {
        throw new Error(`[bonzo-execution] ${name} must be a non-empty string`)
    }

    const normalized = normalizeOptional(value)
    if (!normalized) {
        throw new Error(`[bonzo-execution] ${name} must be a non-empty string`)
    }

    return normalized
}

function normalizeAmountString(value: bigint | number | string): string {
    if (typeof value === 'bigint') {
        return value.toString()
    }

    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value < 0) {
            throw new Error('[bonzo-execution] amount must be a non-negative finite number')
        }

        return value.toString()
    }

    return requireNonNegativeNumericString('amount', value)
}

function requireNonNegativeNumericString(name: string, value: unknown): string {
    const normalized = requireString(name, value)
    const parsed = Number(normalized)
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`[bonzo-execution] ${name} must be a non-negative numeric string`)
    }

    return normalized
}

function requireNonNegativeInteger(name: string, value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error(`[bonzo-execution] ${name} must be a non-negative integer`)
    }

    return value
}

function normalizeStrategyFamily(value: unknown): BonzoStrategyFamily | undefined {
    if (value === undefined) {
        return undefined
    }

    if (value === 'single-asset-dex' || value === 'dual-asset-dex') {
        return value
    }

    throw new Error(
        '[bonzo-execution] strategyFamily must be one of: single-asset-dex, dual-asset-dex'
    )
}

function requirePercentageBps(name: string, value: unknown): number {
    const normalized = requireNonNegativeInteger(name, value)
    if (normalized > 10000) {
        throw new Error(`[bonzo-execution] ${name} must be between 0 and 10000`)
    }

    return normalized
}

function normalizeDepositAssets(value: unknown): BonzoDepositAssetInput[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error('[bonzo-execution] depositAssets must be a non-empty array')
    }

    return value.map((asset, index) => {
        if (!asset || typeof asset !== 'object') {
            throw new Error(`[bonzo-execution] depositAssets[${index}] must be an object`)
        }

        const record = asset as Record<string, unknown>
        return {
            symbol: requireString(`depositAssets[${index}].symbol`, record.symbol),
            tokenId:
                typeof record.tokenId === 'string'
                    ? normalizeOptional(record.tokenId)
                    : undefined,
            amount: requireNonNegativeNumericString(
                `depositAssets[${index}].amount`,
                record.amount
            ),
        }
    })
}

function normalizeWithdrawAssetFloors(value: unknown): BonzoWithdrawAssetFloor[] {
    if (value === undefined) {
        return []
    }

    if (!Array.isArray(value)) {
        throw new Error('[bonzo-execution] minAssetsOut must be an array when provided')
    }

    return value.map((asset, index) => {
        if (!asset || typeof asset !== 'object') {
            throw new Error(`[bonzo-execution] minAssetsOut[${index}] must be an object`)
        }

        const record = asset as Record<string, unknown>
        return {
            symbol: requireString(`minAssetsOut[${index}].symbol`, record.symbol),
            tokenId:
                typeof record.tokenId === 'string'
                    ? normalizeOptional(record.tokenId)
                    : undefined,
            minAmount: requireNonNegativeNumericString(
                `minAssetsOut[${index}].minAmount`,
                record.minAmount
            ),
        }
    })
}

function resolveVaultMetadata(params: Record<string, unknown>): ResolvedVaultMetadata {
    const maybeVault = params.vault
    const vault =
        maybeVault && typeof maybeVault === 'object'
            ? (maybeVault as Partial<BonzoVaultOpportunity>)
            : undefined

    const vaultId = requireString('vaultId', params.vaultId ?? vault?.vaultId)
    const vaultAddress = requireString(
        'vaultAddress',
        params.vaultAddress ?? vault?.vaultAddress ?? vault?.shareTokenId
    )
    const shareTokenId = requireString(
        'shareTokenId',
        params.shareTokenId ?? vault?.shareTokenId
    )
    const strategyAddress = requireString(
        'strategyAddress',
        params.strategyAddress ?? vault?.strategyAddress
    )

    return {
        vaultId,
        vaultAddress,
        shareTokenId,
        strategyAddress,
        strategyFamily: normalizeStrategyFamily(params.strategyFamily ?? vault?.strategyFamily),
    }
}

function resolveBonzoOpportunityEntryParams(
    opportunity: ScoredOpportunity
): BonzoRawOpportunityEntryParams {
    if (opportunity.toolId !== BONZO_TOOL_ID) {
        throw new Error(
            `[bonzo-execution] buildBonzoEnterRequest requires toolId=${BONZO_TOOL_ID}`
        )
    }

    const params = requireRecord('opportunity.entryParams', opportunity.entryParams)
    const vault = requireRecord('opportunity.entryParams.vault', params.vault)
    const assetSymbols = Array.isArray(params.assetSymbols)
        ? params.assetSymbols.map((symbol, index) =>
            requireString(`opportunity.entryParams.assetSymbols[${index}]`, symbol)
        )
        : Array.isArray(vault.assetSymbols)
            ? vault.assetSymbols.map((symbol, index) =>
                requireString(`opportunity.entryParams.vault.assetSymbols[${index}]`, symbol)
            )
            : []

    return {
        venue: 'bonzo-vaults',
        vaultId: requireString('opportunity.entryParams.vaultId', params.vaultId ?? vault.vaultId),
        vaultName: requireString(
            'opportunity.entryParams.vaultName',
            params.vaultName ?? vault.vaultName
        ),
        vaultType: requireString(
            'opportunity.entryParams.vaultType',
            params.vaultType ?? vault.vaultType
        ),
        assetSymbols,
        primaryAssetSymbol: requireString(
            'opportunity.entryParams.primaryAssetSymbol',
            params.primaryAssetSymbol ?? assetSymbols[0]
        ),
        tvl: typeof params.tvl === 'number' ? params.tvl : Number(params.tvl ?? 0),
        apr: typeof params.apr === 'number' ? params.apr : Number(params.apr ?? 0),
        apy: typeof params.apy === 'number' ? params.apy : Number(params.apy ?? 0),
        rewardTokenSymbols: Array.isArray(params.rewardTokenSymbols)
            ? params.rewardTokenSymbols.map((symbol, index) =>
                requireString(`opportunity.entryParams.rewardTokenSymbols[${index}]`, symbol)
            )
            : [],
        shareTokenId: requireString(
            'opportunity.entryParams.shareTokenId',
            params.shareTokenId ?? vault.shareTokenId
        ),
        strategyAddress: requireString(
            'opportunity.entryParams.strategyAddress',
            params.strategyAddress ?? vault.strategyAddress
        ),
        vaultAddress:
            normalizeOptional(
                typeof params.vaultAddress === 'string'
                    ? params.vaultAddress
                    : typeof vault.vaultAddress === 'string'
                        ? vault.vaultAddress
                        : undefined
            ) ?? requireString('opportunity.entryParams.shareTokenId', params.shareTokenId ?? vault.shareTokenId),
        source:
            (
                typeof params.source === 'string'
                    ? params.source
                    : typeof vault.source === 'string'
                        ? vault.source
                        : 'mock'
            ) as BonzoRawOpportunityEntryParams['source'],
        fetchedAt: requireString(
            'opportunity.entryParams.fetchedAt',
            params.fetchedAt ?? vault.fetchedAt
        ),
        vault: vault as unknown as BonzoVaultOpportunity,
    }
}

export function buildBonzoEnterRequest(
    args: BuildBonzoEnterRequestArgs
): ToolRequest {
    const entryParams = resolveBonzoOpportunityEntryParams(args.opportunity)

    return {
        action: 'enter',
        agentId: args.agentId,
        strategyType: args.strategyType,
        params: {
            vaultId: entryParams.vaultId,
            vaultAddress: entryParams.vaultAddress,
            shareTokenId: entryParams.shareTokenId,
            strategyAddress: entryParams.strategyAddress,
            depositAssets: [
                {
                    symbol: entryParams.primaryAssetSymbol,
                    amount: normalizeAmountString(args.amount),
                },
            ],
            ...(args.allocationPctBps === undefined
                ? {}
                : { allocationPctBps: args.allocationPctBps }),
            vault: entryParams.vault,
        },
    }
}

export function buildBonzoExitRequest(
    args: BuildBonzoExitRequestArgs
): ToolRequest {
    const signalData = requireRecord('signal.data', args.signal.data)

    return {
        action: 'exit',
        agentId: args.agentId,
        strategyType: args.strategyType,
        params: {
            vaultId: requireString('signal.data.vaultId', signalData.vaultId),
            vaultAddress: requireString('signal.data.vaultAddress', signalData.vaultAddress),
            shareTokenId: requireString('signal.data.shareTokenId', signalData.shareTokenId),
            strategyAddress: requireString(
                'signal.data.strategyAddress',
                signalData.strategyAddress
            ),
            redeemAll: signalData.redeemAll === false ? false : true,
            sharesIn:
                signalData.redeemAll === false
                    ? requireNonNegativeNumericString('signal.data.sharesIn', signalData.sharesIn)
                    : undefined,
            ...(signalData.strategyFamily === undefined
                ? {}
                : {
                    strategyFamily: normalizeStrategyFamily(signalData.strategyFamily),
                }),
            trigger: args.signal.trigger,
            urgency: args.signal.urgency,
        },
    }
}

export function buildBonzoEnterPlan(
    request: ToolRequest,
    env: HederaEnvConfig
): BonzoDepositPlan {
    if (request.action !== 'enter') {
        throw new Error('[bonzo-execution] buildBonzoEnterPlan requires action=enter')
    }

    const params = request.params ?? {}
    const vault = resolveVaultMetadata(params)
    const depositAssets = normalizeDepositAssets(params.depositAssets)

    if (depositAssets.length > 2) {
        throw new Error('[bonzo-execution] Bonzo deposits support at most two assets')
    }

    const plan: BonzoDepositPlan = {
        action: 'enter',
        method: depositAssets.length === 1 ? 'deposit-single' : 'deposit-pair',
        vaultId: vault.vaultId,
        vaultAddress: vault.vaultAddress,
        shareTokenId: vault.shareTokenId,
        strategyAddress: vault.strategyAddress,
        ...(vault.strategyFamily ? { strategyFamily: vault.strategyFamily } : {}),
        accountId: env.executionSigner.accountId,
        signerOwner: env.executionSigner.owner,
        depositAssets,
        ...(params.allocationPctBps === undefined
            ? {}
            : {
                allocationPctBps: requirePercentageBps(
                    'allocationPctBps',
                    params.allocationPctBps
                ),
            }),
        ...(params.minSharesOut === undefined
            ? {}
            : {
                minSharesOut: requireNonNegativeNumericString(
                    'minSharesOut',
                    params.minSharesOut
                ),
            }),
        ...(params.slippageBps === undefined
            ? {}
            : {
                slippageBps: requireNonNegativeInteger(
                    'slippageBps',
                    params.slippageBps
                ),
            }),
    }

    return plan
}

export function buildBonzoExitPlan(
    request: ToolRequest,
    env: HederaEnvConfig
): BonzoWithdrawPlan {
    if (request.action !== 'exit') {
        throw new Error('[bonzo-execution] buildBonzoExitPlan requires action=exit')
    }

    const params = request.params ?? {}
    const vault = resolveVaultMetadata(params)
    const redeemAll = params.redeemAll === true

    const plan: BonzoWithdrawPlan = {
        action: 'exit',
        method: 'withdraw',
        vaultId: vault.vaultId,
        vaultAddress: vault.vaultAddress,
        shareTokenId: vault.shareTokenId,
        strategyAddress: vault.strategyAddress,
        ...(vault.strategyFamily ? { strategyFamily: vault.strategyFamily } : {}),
        accountId: env.executionSigner.accountId,
        signerOwner: env.executionSigner.owner,
        sharesIn: redeemAll
            ? 'all'
            : requireNonNegativeNumericString('sharesIn', params.sharesIn),
        redeemAll,
        minAssetsOut: normalizeWithdrawAssetFloors(params.minAssetsOut),
    }

    return plan
}

class SimulatedBonzoExecutionTransport implements BonzoExecutionTransport {
    async deposit(plan: BonzoDepositPlan): Promise<BonzoExecutionTransportResult> {
        console.log('[bonzo-execution] simulate deposit:', plan)
        return { status: 'simulated' }
    }

    async withdraw(plan: BonzoWithdrawPlan): Promise<BonzoExecutionTransportResult> {
        console.log('[bonzo-execution] simulate withdraw:', plan)
        return { status: 'simulated' }
    }
}

export class BonzoVaultExecutor {
    private readonly transport: BonzoExecutionTransport

    constructor(
        private readonly env: HederaEnvConfig,
        private readonly options: {
            mode?: BonzoExecutionMode
            transport?: BonzoExecutionTransport
        } = {}
    ) {
        const mode = options.mode ?? 'simulate'
        if (mode === 'live' && !options.transport) {
            throw new Error(
                '[bonzo-execution] Live mode requires a BonzoExecutionTransport implementation'
            )
        }

        this.transport = options.transport ?? new SimulatedBonzoExecutionTransport()
    }

    async enter(request: ToolRequest): Promise<ToolResponse> {
        const plan = buildBonzoEnterPlan(request, this.env)
        const result = await this.transport.deposit(plan)
        return this.toToolResponse('enter', plan, result)
    }

    async exit(request: ToolRequest): Promise<ToolResponse> {
        const plan = buildBonzoExitPlan(request, this.env)
        const result = await this.transport.withdraw(plan)
        return this.toToolResponse('exit', plan, result)
    }

    private toToolResponse(
        action: 'enter' | 'exit',
        plan: BonzoExecutionPlan,
        result: BonzoExecutionTransportResult
    ): ToolResponse {
        return {
            status: 'success',
            action,
            toolId: BONZO_TOOL_ID,
            data: {
                mode: result.status === 'simulated' ? 'simulate' : 'live',
                executionPlan: plan,
                transactionId: result.transactionId,
            },
        }
    }
}
