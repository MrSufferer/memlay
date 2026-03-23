import type { HederaEnvConfig } from '../env'

export interface BonzoAssetBalance {
    symbol: string
    tokenId?: string
    amount: string
}

export interface BonzoPositionState {
    accountId: string
    vaultId: string
    shareTokenId: string
    shareBalance: string
    assetBalances: BonzoAssetBalance[]
    lastObservedApr: number
    lastObservedApy: number
    updatedAt: string
}

export interface BonzoPositionSnapshot {
    accountId: string
    vaultId: string
    shareTokenId: string
    shareBalance: string | number | bigint
    assetBalances: Array<{
        symbol: string
        tokenId?: string
        amount: string | number | bigint
    }>
    lastObservedApr: number
    lastObservedApy: number
    updatedAt: string
}

export interface BonzoPositionSource {
    listPositions(accountId: string): Promise<BonzoPositionSnapshot[]>
}

export interface BonzoPositionApiFetcher {
    fetch(input: string): Promise<{
        ok: boolean
        status: number
        statusText: string
        json(): Promise<unknown>
    }>
}

export interface BonzoPositionSourceOptions {
    fetcher?: BonzoPositionApiFetcher
}

function normalizeOptional(value: string | undefined): string | undefined {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
}

function parseJson<T>(label: string, input: string | undefined): T | null {
    const normalized = normalizeOptional(input)
    if (!normalized) {
        return null
    }

    try {
        return JSON.parse(normalized) as T
    } catch (error) {
        throw new Error(
            `[bonzo-position] Failed to parse ${label}: ${error instanceof Error ? error.message : String(error)}`
        )
    }
}

function requireString(name: string, value: string | undefined): string {
    const normalized = normalizeOptional(value)
    if (!normalized) {
        throw new Error(`[bonzo-position] ${name} is required`)
    }

    return normalized
}

function requireIsoDate(name: string, value: string): string {
    const normalized = requireString(name, value)
    if (Number.isNaN(new Date(normalized).getTime())) {
        throw new Error(`[bonzo-position] ${name} must be an ISO-8601 timestamp`)
    }

    return normalized
}

function normalizeAmount(
    name: string,
    value: string | number | bigint
): string {
    if (typeof value === 'bigint') {
        return value.toString()
    }

    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value < 0) {
            throw new Error(`[bonzo-position] ${name} must be a non-negative finite number`)
        }
        return Number.isInteger(value) ? value.toString() : value.toString()
    }

    const normalized = requireString(name, value)
    const parsed = Number(normalized)
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`[bonzo-position] ${name} must be a non-negative numeric string`)
    }

    return normalized
}

function requireFiniteNumber(name: string, value: number): number {
    if (!Number.isFinite(value)) {
        throw new Error(`[bonzo-position] ${name} must be a finite number`)
    }

    return value
}

function normalizeAssetBalances(
    balances: BonzoPositionSnapshot['assetBalances']
): BonzoAssetBalance[] {
    return balances.map((balance, index) => ({
        symbol: requireString(`assetBalances[${index}].symbol`, balance.symbol),
        tokenId: normalizeOptional(balance.tokenId),
        amount: normalizeAmount(`assetBalances[${index}].amount`, balance.amount),
    }))
}

function isZeroAmount(value: string): boolean {
    return Number(value) === 0
}

export function normalizeBonzoPositionState(
    snapshot: BonzoPositionSnapshot
): BonzoPositionState {
    return {
        accountId: requireString('accountId', snapshot.accountId),
        vaultId: requireString('vaultId', snapshot.vaultId),
        shareTokenId: requireString('shareTokenId', snapshot.shareTokenId),
        shareBalance: normalizeAmount('shareBalance', snapshot.shareBalance),
        assetBalances: normalizeAssetBalances(snapshot.assetBalances),
        lastObservedApr: requireFiniteNumber('lastObservedApr', snapshot.lastObservedApr),
        lastObservedApy: requireFiniteNumber('lastObservedApy', snapshot.lastObservedApy),
        updatedAt: requireIsoDate('updatedAt', snapshot.updatedAt),
    }
}

export function normalizeBonzoPositionStates(
    snapshots: BonzoPositionSnapshot[]
): BonzoPositionState[] {
    return snapshots.map((snapshot) => normalizeBonzoPositionState(snapshot))
}

export function resolveBonzoExecutionAccountId(env: HederaEnvConfig): string {
    return env.executionSigner.accountId
}

export function selectCurrentBonzoPosition(
    positions: BonzoPositionState[]
): BonzoPositionState | null {
    const activePositions = positions.filter((position) => !isZeroAmount(position.shareBalance))

    if (activePositions.length === 0) {
        return null
    }

    if (activePositions.length > 1) {
        throw new Error(
            '[bonzo-position] Multiple active Bonzo vault positions found; current-position state is ambiguous'
        )
    }

    return activePositions[0]
}

export class BonzoPositionReader {
    constructor(
        private readonly source: BonzoPositionSource,
        private readonly env: HederaEnvConfig
    ) {}

    async listExecutionAccountPositions(): Promise<BonzoPositionState[]> {
        const accountId = resolveBonzoExecutionAccountId(this.env)
        const snapshots = await this.source.listPositions(accountId)
        const positions = normalizeBonzoPositionStates(snapshots)

        return positions.filter((position) => position.accountId === accountId)
    }

    async getCurrentPosition(): Promise<BonzoPositionState | null> {
        const positions = await this.listExecutionAccountPositions()
        return selectCurrentBonzoPosition(positions)
    }
}

class StaticBonzoPositionSource implements BonzoPositionSource {
    constructor(private readonly snapshots: BonzoPositionSnapshot[]) {}

    async listPositions(accountId: string): Promise<BonzoPositionSnapshot[]> {
        return this.snapshots.filter((snapshot) => snapshot.accountId === accountId)
    }
}

class ApiBonzoPositionSource implements BonzoPositionSource {
    private readonly fetcher: BonzoPositionApiFetcher

    constructor(
        private readonly url: string,
        fetcher: BonzoPositionApiFetcher | undefined
    ) {
        this.fetcher = fetcher ?? { fetch }
    }

    async listPositions(accountId: string): Promise<BonzoPositionSnapshot[]> {
        const response = await this.fetcher.fetch(this.url)
        if (!response.ok) {
            throw new Error(
                `[bonzo-position] Position API failed: ${response.status} ${response.statusText}`
            )
        }

        const payload = await response.json()
        if (!Array.isArray(payload)) {
            throw new Error('[bonzo-position] Position API payload must be an array')
        }

        return (payload as BonzoPositionSnapshot[]).filter(
            (snapshot) => snapshot.accountId === accountId
        )
    }
}

export function createBonzoPositionSource(
    env: HederaEnvConfig,
    options: BonzoPositionSourceOptions = {}
): BonzoPositionSource {
    const staticSnapshots = parseJson<BonzoPositionSnapshot[]>(
        'BONZO_CONTRACT_POSITIONS_JSON',
        env.bonzoContractEnv.BONZO_CONTRACT_POSITIONS_JSON
    )
    if (staticSnapshots) {
        return new StaticBonzoPositionSource(staticSnapshots)
    }

    const apiUrl = normalizeOptional(env.bonzoContractEnv.BONZO_CONTRACT_POSITIONS_API_URL)
    if (apiUrl) {
        return new ApiBonzoPositionSource(apiUrl, options.fetcher)
    }

    return new StaticBonzoPositionSource([])
}
