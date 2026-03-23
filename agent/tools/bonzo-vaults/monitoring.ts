import type {
    ExitSignal,
    ExitUrgency,
    ToolResponse,
} from '../../../cre-memoryvault/protocol/tool-interface'
import type { BonzoPositionState } from '../../hedera/positions/bonzo'
import { BONZO_TOOL_ID, type BonzoVaultOpportunity } from './opportunities'
import { selectBestBonzoVault } from './ranking'

export type BonzoMonitorTrigger =
    | 'better_vault_available'
    | 'apy_drop'
    | 'reward_change'
    | 'vault_health'

export type BonzoVaultHealthStatus =
    | 'healthy'
    | 'degraded'
    | 'paused'
    | 'unavailable'
    | 'stale'

export interface BonzoVaultHealthSnapshot {
    vaultId: string
    status: BonzoVaultHealthStatus
    reason?: string
    checkedAt?: string
}

export interface BonzoMonitorState {
    vaultId: string
    apy: number
    tvl: number
    rewardTokenSymbols: string[]
    fetchedAt: string
    healthStatus: BonzoVaultHealthStatus
}

export interface BonzoMonitorConfig {
    minRebalanceApyDeltaBps: number
    enabledTriggers?: BonzoMonitorTrigger[]
    maxApyDropBps?: number
    maxSnapshotAgeMs?: number
    minHealthyTvlUsd?: number
    exitOnRewardTokenChange?: boolean
}

export interface BonzoMonitorEvaluation {
    response: ToolResponse
    nextState: BonzoMonitorState | null
}

export interface EvaluateBonzoMonitorArgs {
    currentPosition: BonzoPositionState | null
    opportunities: BonzoVaultOpportunity[]
    config: BonzoMonitorConfig
    previousState?: BonzoMonitorState | null
    vaultHealth?: BonzoVaultHealthSnapshot[]
    now?: () => Date
}

const ALL_BONZO_MONITOR_TRIGGERS: BonzoMonitorTrigger[] = [
    'better_vault_available',
    'apy_drop',
    'reward_change',
    'vault_health',
]

function requireNonNegativeInteger(name: string, value: number | undefined): number | undefined {
    if (value === undefined) {
        return undefined
    }

    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`[bonzo-monitor] ${name} must be a non-negative integer`)
    }

    return value
}

function requireNonNegativeNumber(name: string, value: number | undefined): number | undefined {
    if (value === undefined) {
        return undefined
    }

    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`[bonzo-monitor] ${name} must be a non-negative finite number`)
    }

    return value
}

function validateMonitorConfig(config: BonzoMonitorConfig): Required<Pick<BonzoMonitorConfig, 'minRebalanceApyDeltaBps'>> &
    Omit<BonzoMonitorConfig, 'minRebalanceApyDeltaBps'> {
    const enabledTriggers = config.enabledTriggers ?? ALL_BONZO_MONITOR_TRIGGERS

    for (const trigger of enabledTriggers) {
        if (!ALL_BONZO_MONITOR_TRIGGERS.includes(trigger)) {
            throw new Error(`[bonzo-monitor] Unsupported trigger: ${trigger}`)
        }
    }

    return {
        ...config,
        enabledTriggers,
        minRebalanceApyDeltaBps:
            requireNonNegativeInteger(
                'minRebalanceApyDeltaBps',
                config.minRebalanceApyDeltaBps
            ) ?? 0,
        maxApyDropBps: requireNonNegativeInteger('maxApyDropBps', config.maxApyDropBps),
        maxSnapshotAgeMs: requireNonNegativeInteger(
            'maxSnapshotAgeMs',
            config.maxSnapshotAgeMs
        ),
        minHealthyTvlUsd: requireNonNegativeNumber(
            'minHealthyTvlUsd',
            config.minHealthyTvlUsd
        ),
    }
}

function normalizeRewardSymbols(symbols: string[]): string[] {
    return [...new Set(symbols.map((symbol) => symbol.trim()).filter(Boolean))].sort()
}

function sameStringSet(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
        return false
    }

    return left.every((value, index) => value === right[index])
}

function toBasisPoints(deltaPercent: number): number {
    return Math.round(deltaPercent * 100)
}

function isTriggerEnabled(
    enabledTriggers: BonzoMonitorTrigger[],
    trigger: BonzoMonitorTrigger
): boolean {
    return enabledTriggers.includes(trigger)
}

function findCurrentVaultOpportunity(
    opportunities: BonzoVaultOpportunity[],
    currentPosition: BonzoPositionState
): BonzoVaultOpportunity | null {
    return opportunities.find(
        (opportunity) => opportunity.vaultId === currentPosition.vaultId
    ) ?? null
}

function findVaultHealth(
    snapshots: BonzoVaultHealthSnapshot[] | undefined,
    vaultId: string
): BonzoVaultHealthSnapshot | null {
    return snapshots?.find((snapshot) => snapshot.vaultId === vaultId) ?? null
}

function determineHealthStatus(args: {
    opportunity: BonzoVaultOpportunity
    explicitHealth: BonzoVaultHealthSnapshot | null
    maxSnapshotAgeMs?: number
    minHealthyTvlUsd?: number
    now: Date
}): { status: BonzoVaultHealthStatus; reason?: string } {
    const { opportunity, explicitHealth, maxSnapshotAgeMs, minHealthyTvlUsd, now } = args

    if (explicitHealth && explicitHealth.status !== 'healthy') {
        return {
            status: explicitHealth.status,
            reason: explicitHealth.reason ?? `Vault health reported as ${explicitHealth.status}`,
        }
    }

    if (
        maxSnapshotAgeMs !== undefined &&
        now.getTime() - new Date(opportunity.fetchedAt).getTime() > maxSnapshotAgeMs
    ) {
        return {
            status: 'stale',
            reason: `Vault snapshot age exceeded ${maxSnapshotAgeMs} ms`,
        }
    }

    if (
        minHealthyTvlUsd !== undefined &&
        opportunity.tvl < minHealthyTvlUsd
    ) {
        return {
            status: 'degraded',
            reason: `Vault TVL ${opportunity.tvl} is below configured floor ${minHealthyTvlUsd}`,
        }
    }

    return {
        status: explicitHealth?.status ?? 'healthy',
        reason: explicitHealth?.reason,
    }
}

function pushSignal(
    signals: ExitSignal[],
    trigger: BonzoMonitorTrigger,
    urgency: ExitUrgency,
    data: Record<string, unknown>
): void {
    signals.push({
        trigger,
        urgency,
        data: {
            ...data,
            fired: true,
        },
    })
}

function buildExecutionMetadata(
    opportunity: BonzoVaultOpportunity,
    currentPosition: BonzoPositionState
): Record<string, unknown> {
    return {
        vaultId: currentPosition.vaultId,
        vaultAddress: opportunity.vaultAddress ?? opportunity.shareTokenId,
        shareTokenId: currentPosition.shareTokenId,
        strategyAddress: opportunity.strategyAddress,
        strategyFamily: opportunity.strategyFamily,
        redeemAll: true,
    }
}

export function evaluateBonzoMonitor(
    args: EvaluateBonzoMonitorArgs
): BonzoMonitorEvaluation {
    const now = (args.now ?? (() => new Date()))()
    const config = validateMonitorConfig(args.config)

    if (!args.currentPosition) {
        return {
            response: {
                status: 'no_action',
                action: 'monitor',
                toolId: BONZO_TOOL_ID,
                data: {
                    currentVaultId: null,
                    positionsChecked: 0,
                    checkedAt: now.toISOString(),
                    reason: 'No active Bonzo position to monitor',
                },
                exitSignals: [],
            },
            nextState: null,
        }
    }

    const currentPosition = args.currentPosition
    const currentOpportunity = findCurrentVaultOpportunity(
        args.opportunities,
        currentPosition
    )
    const signals: ExitSignal[] = []

    if (!currentOpportunity) {
        if (isTriggerEnabled(config.enabledTriggers, 'vault_health')) {
            pushSignal(signals, 'vault_health', 'critical', {
                vaultId: currentPosition.vaultId,
                status: 'unavailable',
                reason: 'Current vault is not present in the latest Bonzo discovery snapshot',
            })
        }

        return {
            response: {
                status: signals.length > 0 ? 'success' : 'no_action',
                action: 'monitor',
                toolId: BONZO_TOOL_ID,
                data: {
                    currentVaultId: currentPosition.vaultId,
                    positionsChecked: 1,
                    checkedAt: now.toISOString(),
                    reason: 'Current Bonzo vault snapshot is unavailable',
                },
                exitSignals: signals,
            },
            nextState: null,
        }
    }

    const ranking = selectBestBonzoVault({
        opportunities: args.opportunities,
        currentPosition,
        minApyDeltaBps: config.minRebalanceApyDeltaBps,
    })
    const explicitHealth = findVaultHealth(args.vaultHealth, currentPosition.vaultId)
    const health = determineHealthStatus({
        opportunity: currentOpportunity,
        explicitHealth,
        maxSnapshotAgeMs: config.maxSnapshotAgeMs,
        minHealthyTvlUsd: config.minHealthyTvlUsd,
        now,
    })

    if (
        isTriggerEnabled(config.enabledTriggers, 'better_vault_available') &&
        ranking.rebalance &&
        ranking.bestVaultId &&
        ranking.bestVaultId !== currentPosition.vaultId
    ) {
        pushSignal(signals, 'better_vault_available', 'medium', {
            ...buildExecutionMetadata(currentOpportunity, currentPosition),
            currentVaultId: currentPosition.vaultId,
            bestVaultId: ranking.bestVaultId,
            bestApy: ranking.bestApy,
            apyDeltaBps: ranking.apyDeltaBps,
            threshold: config.minRebalanceApyDeltaBps,
            reason: ranking.reason,
        })
    }

    const baselineApy =
        args.previousState?.vaultId === currentPosition.vaultId
            ? args.previousState.apy
            : currentPosition.lastObservedApy
    const apyDropBps = toBasisPoints(baselineApy - currentOpportunity.apy)
    if (
        isTriggerEnabled(config.enabledTriggers, 'apy_drop') &&
        config.maxApyDropBps !== undefined &&
        apyDropBps >= config.maxApyDropBps &&
        currentOpportunity.apy < baselineApy
    ) {
        pushSignal(signals, 'apy_drop', 'medium', {
            ...buildExecutionMetadata(currentOpportunity, currentPosition),
            vaultId: currentPosition.vaultId,
            previousApy: baselineApy,
            currentApy: currentOpportunity.apy,
            apyDropBps,
            threshold: config.maxApyDropBps,
        })
    }

    const currentRewardSymbols = normalizeRewardSymbols(
        currentOpportunity.rewardTokens.map((token) => token.symbol)
    )
    const previousRewardSymbols =
        args.previousState?.vaultId === currentPosition.vaultId
            ? normalizeRewardSymbols(args.previousState.rewardTokenSymbols)
            : []

    if (
        isTriggerEnabled(config.enabledTriggers, 'reward_change') &&
        config.exitOnRewardTokenChange === true &&
        previousRewardSymbols.length > 0 &&
        !sameStringSet(previousRewardSymbols, currentRewardSymbols)
    ) {
        pushSignal(signals, 'reward_change', 'high', {
            ...buildExecutionMetadata(currentOpportunity, currentPosition),
            vaultId: currentPosition.vaultId,
            previousRewardTokenSymbols: previousRewardSymbols,
            currentRewardTokenSymbols: currentRewardSymbols,
        })
    }

    if (
        isTriggerEnabled(config.enabledTriggers, 'vault_health') &&
        health.status !== 'healthy'
    ) {
        pushSignal(
            signals,
            'vault_health',
            health.status === 'degraded' || health.status === 'stale' ? 'high' : 'critical',
            {
                ...buildExecutionMetadata(currentOpportunity, currentPosition),
                vaultId: currentPosition.vaultId,
                status: health.status,
                reason: health.reason ?? `Vault health reported as ${health.status}`,
                tvl: currentOpportunity.tvl,
                fetchedAt: currentOpportunity.fetchedAt,
            }
        )
    }

    return {
        response: {
            status: signals.length > 0 ? 'success' : 'no_action',
            action: 'monitor',
            toolId: BONZO_TOOL_ID,
            data: {
                currentVaultId: currentPosition.vaultId,
                bestVaultId: ranking.bestVaultId,
                bestApy: ranking.bestApy,
                apyDeltaBps: ranking.apyDeltaBps,
                currentApy: currentOpportunity.apy,
                healthStatus: health.status,
                positionsChecked: 1,
                firedCount: signals.length,
                checkedAt: now.toISOString(),
            },
            exitSignals: signals,
        },
        nextState: {
            vaultId: currentPosition.vaultId,
            apy: currentOpportunity.apy,
            tvl: currentOpportunity.tvl,
            rewardTokenSymbols: currentRewardSymbols,
            fetchedAt: currentOpportunity.fetchedAt,
            healthStatus: health.status,
        },
    }
}
