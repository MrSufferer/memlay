import type { RawOpportunity } from '../../../cre-memoryvault/protocol/tool-interface'

export const BONZO_TOOL_ID = 'bonzo-vaults'

export type BonzoVaultSource = 'contracts' | 'api' | 'mock'
export type BonzoStrategyFamily = 'single-asset-dex' | 'dual-asset-dex'

export interface BonzoRewardToken {
    symbol: string
    tokenId?: string
}

export interface BonzoVaultOpportunity {
    vaultId: string
    vaultName: string
    vaultType: string
    strategyFamily?: BonzoStrategyFamily
    assetSymbols: string[]
    tvl: number
    apr: number
    apy: number
    rewardTokens: BonzoRewardToken[]
    shareTokenId: string
    strategyAddress: string
    vaultAddress?: string
    source: BonzoVaultSource
    fetchedAt: string
}

export interface BonzoRawOpportunityEntryParams {
    venue: 'bonzo-vaults'
    vaultId: string
    vaultName: string
    vaultType: string
    assetSymbols: string[]
    primaryAssetSymbol: string
    tvl: number
    apr: number
    apy: number
    rewardTokenSymbols: string[]
    shareTokenId: string
    strategyAddress: string
    vaultAddress?: string
    source: BonzoVaultSource
    fetchedAt: string
    vault: BonzoVaultOpportunity
}

function normalizeOptional(value: string | undefined): string | undefined {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
}

function requireString(name: string, value: string | undefined): string {
    const normalized = normalizeOptional(value)
    if (!normalized) {
        throw new Error(`[bonzo-opportunity] ${name} is required`)
    }

    return normalized
}

function requireFiniteNumber(name: string, value: number): number {
    if (!Number.isFinite(value)) {
        throw new Error(`[bonzo-opportunity] ${name} must be a finite number`)
    }

    return value
}

function requireNonNegativeNumber(name: string, value: number): number {
    const normalized = requireFiniteNumber(name, value)
    if (normalized < 0) {
        throw new Error(`[bonzo-opportunity] ${name} must be non-negative`)
    }

    return normalized
}

function normalizeStrategyFamily(
    value: string | undefined
): BonzoStrategyFamily | undefined {
    const normalized = normalizeOptional(value)
    if (!normalized) {
        return undefined
    }

    if (normalized === 'single-asset-dex' || normalized === 'dual-asset-dex') {
        return normalized
    }

    throw new Error(
        '[bonzo-opportunity] strategyFamily must be one of: single-asset-dex, dual-asset-dex'
    )
}

function requireIsoDate(name: string, value: string | undefined): string {
    const normalized = requireString(name, value)
    if (Number.isNaN(new Date(normalized).getTime())) {
        throw new Error(`[bonzo-opportunity] ${name} must be an ISO-8601 timestamp`)
    }

    return normalized
}

function normalizeRewardTokens(tokens: BonzoRewardToken[]): BonzoRewardToken[] {
    return tokens.map((token, index) => ({
        symbol: requireString(`rewardTokens[${index}].symbol`, token.symbol),
        tokenId: normalizeOptional(token.tokenId),
    }))
}

function normalizeAssetSymbols(symbols: string[]): string[] {
    const normalized = symbols
        .map((symbol, index) => requireString(`assetSymbols[${index}]`, symbol))

    if (normalized.length === 0) {
        throw new Error('[bonzo-opportunity] assetSymbols must contain at least one symbol')
    }

    return normalized
}

export function normalizeBonzoVaultOpportunity(
    opportunity: BonzoVaultOpportunity
): BonzoVaultOpportunity {
    const source = requireString('source', opportunity.source) as BonzoVaultSource
    if (!['contracts', 'api', 'mock'].includes(source)) {
        throw new Error('[bonzo-opportunity] source must be one of: contracts, api, mock')
    }

    return {
        vaultId: requireString('vaultId', opportunity.vaultId),
        vaultName: requireString('vaultName', opportunity.vaultName),
        vaultType: requireString('vaultType', opportunity.vaultType),
        strategyFamily: normalizeStrategyFamily(opportunity.strategyFamily),
        assetSymbols: normalizeAssetSymbols(opportunity.assetSymbols),
        tvl: requireNonNegativeNumber('tvl', opportunity.tvl),
        apr: requireFiniteNumber('apr', opportunity.apr),
        apy: requireFiniteNumber('apy', opportunity.apy),
        rewardTokens: normalizeRewardTokens(opportunity.rewardTokens),
        shareTokenId: requireString('shareTokenId', opportunity.shareTokenId),
        strategyAddress: requireString('strategyAddress', opportunity.strategyAddress),
        vaultAddress: normalizeOptional(opportunity.vaultAddress),
        source,
        fetchedAt: requireIsoDate('fetchedAt', opportunity.fetchedAt),
    }
}

export function mapBonzoVaultOpportunityToRawOpportunity(
    opportunity: BonzoVaultOpportunity
): RawOpportunity {
    const normalized = normalizeBonzoVaultOpportunity(opportunity)
    const rewardTokenSymbols = normalized.rewardTokens.map((token) => token.symbol)

    const entryParams: BonzoRawOpportunityEntryParams = {
        venue: 'bonzo-vaults',
        vaultId: normalized.vaultId,
        vaultName: normalized.vaultName,
        vaultType: normalized.vaultType,
        assetSymbols: [...normalized.assetSymbols],
        primaryAssetSymbol: normalized.assetSymbols[0],
        tvl: normalized.tvl,
        apr: normalized.apr,
        apy: normalized.apy,
        rewardTokenSymbols,
        shareTokenId: normalized.shareTokenId,
        strategyAddress: normalized.strategyAddress,
        vaultAddress: normalized.vaultAddress,
        source: normalized.source,
        fetchedAt: normalized.fetchedAt,
        vault: normalized,
    }

    return {
        toolId: BONZO_TOOL_ID,
        assetId: normalized.vaultId,
        entryParams,
    }
}

export function mapBonzoVaultOpportunitiesToRawOpportunities(
    opportunities: BonzoVaultOpportunity[]
): RawOpportunity[] {
    return opportunities.map((opportunity) =>
        mapBonzoVaultOpportunityToRawOpportunity(opportunity)
    )
}
