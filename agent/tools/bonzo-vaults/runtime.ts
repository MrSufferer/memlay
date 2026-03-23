import type { ToolResponse } from '../../../cre-memoryvault/protocol/tool-interface'
import {
    BonzoPositionReader,
    createBonzoPositionSource,
    type BonzoPositionApiFetcher,
    type BonzoPositionState,
    type BonzoPositionSource,
} from '../../hedera/positions/bonzo'
import type { HederaEnvConfig } from '../../hedera/env'
import { isLiveExecutableBonzoOpportunity } from '../../hedera/bonzo-live-transport'
import {
    evaluateBonzoMonitor,
    type BonzoMonitorConfig,
    type BonzoMonitorState,
} from './monitoring'
import {
    BONZO_TOOL_ID,
    mapBonzoVaultOpportunityToRawOpportunity,
    type BonzoVaultOpportunity,
} from './opportunities'
import {
    createBonzoVaultDiscoverySource,
    type BonzoApiFetcher,
    type BonzoVaultDiscoverySource,
} from './discovery'
import { selectBestBonzoVault } from './ranking'

export interface HederaBonzoToolRuntimeOptions {
    discoverySource?: BonzoVaultDiscoverySource
    positionSource?: BonzoPositionSource
    discoveryFetcher?: BonzoApiFetcher
    positionFetcher?: BonzoPositionApiFetcher
    rawEnv?: Record<string, string | undefined>
}

function normalizeOptional(value: string | undefined): string | undefined {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
}

function parseOptionalInteger(
    name: string,
    value: string | undefined
): number | undefined {
    const normalized = normalizeOptional(value)
    if (!normalized) {
        return undefined
    }

    const parsed = Number(normalized)
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`[bonzo-runtime] ${name} must be a non-negative integer`)
    }

    return parsed
}

function parseOptionalNumber(
    name: string,
    value: string | undefined
): number | undefined {
    const normalized = normalizeOptional(value)
    if (!normalized) {
        return undefined
    }

    const parsed = Number(normalized)
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`[bonzo-runtime] ${name} must be a non-negative number`)
    }

    return parsed
}

function createMonitorConfig(
    env: HederaEnvConfig,
    rawEnv: Record<string, string | undefined>
): BonzoMonitorConfig {
    return {
        minRebalanceApyDeltaBps: env.bonzoMinApyDeltaBps,
        maxApyDropBps:
            parseOptionalInteger(
                'BONZO_MONITOR_MAX_APY_DROP_BPS',
                rawEnv.BONZO_MONITOR_MAX_APY_DROP_BPS
            ) ?? 200,
        maxSnapshotAgeMs: parseOptionalInteger(
            'BONZO_MONITOR_MAX_SNAPSHOT_AGE_MS',
            rawEnv.BONZO_MONITOR_MAX_SNAPSHOT_AGE_MS
        ),
        minHealthyTvlUsd: parseOptionalNumber(
            'BONZO_MONITOR_MIN_HEALTHY_TVL_USD',
            rawEnv.BONZO_MONITOR_MIN_HEALTHY_TVL_USD
        ),
        exitOnRewardTokenChange: rawEnv.BONZO_MONITOR_EXIT_ON_REWARD_CHANGE === 'true',
    }
}

function isLiveMode(env: HederaEnvConfig): boolean {
    return env.bonzoExecutionMode === 'live'
}

function findCurrentOpportunity(
    opportunities: BonzoVaultOpportunity[],
    currentPosition: BonzoPositionState | null
): BonzoVaultOpportunity | null {
    if (!currentPosition) {
        return null
    }

    return opportunities.find(
        (opportunity) => opportunity.vaultId === currentPosition.vaultId
    ) ?? null
}

function buildUnsupportedCurrentPositionResponse(args: {
    action: 'scan' | 'monitor'
    currentPosition: BonzoPositionState
    opportunities: BonzoVaultOpportunity[]
    checkedAt: string
    reason: string
}): ToolResponse {
    return {
        status: 'no_action',
        action: args.action,
        toolId: BONZO_TOOL_ID,
        data: {
            currentVaultId: args.currentPosition.vaultId,
            bestVaultId: null,
            bestApy: 0,
            apyDeltaBps: 0,
            availableVaults: args.opportunities.length,
            positionsChecked: 1,
            checkedAt: args.checkedAt,
            reason: args.reason,
        },
        opportunities: args.action === 'scan' ? [] : undefined,
        exitSignals: args.action === 'monitor' ? [] : undefined,
    }
}

function filterExecutableOpportunities(
    env: HederaEnvConfig,
    opportunities: BonzoVaultOpportunity[]
): BonzoVaultOpportunity[] {
    if (!isLiveMode(env)) {
        return opportunities
    }

    return opportunities.filter(isLiveExecutableBonzoOpportunity)
}

export class HederaBonzoToolRuntime {
    private readonly discoverySource: BonzoVaultDiscoverySource
    private readonly positionReader: BonzoPositionReader
    private readonly monitorConfig: BonzoMonitorConfig
    private previousMonitorState: BonzoMonitorState | null = null

    constructor(
        private readonly env: HederaEnvConfig,
        options: HederaBonzoToolRuntimeOptions = {}
    ) {
        this.discoverySource = options.discoverySource ?? createBonzoVaultDiscoverySource(env, {
            fetcher: options.discoveryFetcher,
        })
        this.positionReader = new BonzoPositionReader(
            options.positionSource ?? createBonzoPositionSource(env, {
                fetcher: options.positionFetcher,
            }),
            env
        )
        this.monitorConfig = createMonitorConfig(env, options.rawEnv ?? process.env)
    }

    async scan(toolId: string): Promise<ToolResponse> {
        if (toolId !== BONZO_TOOL_ID) {
            throw new Error(
                `[bonzo-runtime] Hedera tool runtime does not support ${toolId}`
            )
        }

        const checkedAt = new Date().toISOString()
        const [opportunities, currentPosition] = await Promise.all([
            this.discoverySource.discoverVaults(),
            this.positionReader.getCurrentPosition(),
        ])

        if (isLiveMode(this.env) && currentPosition) {
            const currentOpportunity = findCurrentOpportunity(opportunities, currentPosition)
            if (!currentOpportunity) {
                return buildUnsupportedCurrentPositionResponse({
                    action: 'scan',
                    currentPosition,
                    opportunities,
                    checkedAt,
                    reason:
                        `Current vault ${currentPosition.vaultId} is not present in the live Bonzo catalog; ` +
                        'refusing to open a replacement position until the catalog is corrected',
                })
            }

            if (!isLiveExecutableBonzoOpportunity(currentOpportunity)) {
                return buildUnsupportedCurrentPositionResponse({
                    action: 'scan',
                    currentPosition,
                    opportunities,
                    checkedAt,
                    reason:
                        `Current vault ${currentPosition.vaultId} is not supported for live Bonzo execution; ` +
                        'only single-asset-dex vaults are currently enabled',
                })
            }
        }

        const executableOpportunities = filterExecutableOpportunities(this.env, opportunities)
        const ranking = selectBestBonzoVault({
            opportunities: executableOpportunities,
            currentPosition,
            minApyDeltaBps: this.env.bonzoMinApyDeltaBps,
        })
        const bestOpportunity = executableOpportunities.find(
            (opportunity) => opportunity.vaultId === ranking.bestVaultId
        )

        if (!bestOpportunity || !ranking.rebalance) {
            return {
                status: 'no_action',
                action: 'scan',
                toolId: BONZO_TOOL_ID,
                data: {
                    currentVaultId: ranking.currentVaultId,
                    bestVaultId: ranking.bestVaultId,
                    bestApy: ranking.bestApy,
                    apyDeltaBps: ranking.apyDeltaBps,
                    availableVaults: executableOpportunities.length,
                    discoveredVaults: opportunities.length,
                    reason: ranking.reason,
                },
                opportunities: [],
            }
        }

        return {
            status: 'success',
            action: 'scan',
            toolId: BONZO_TOOL_ID,
            data: {
                currentVaultId: ranking.currentVaultId,
                bestVaultId: ranking.bestVaultId,
                bestApy: ranking.bestApy,
                apyDeltaBps: ranking.apyDeltaBps,
                availableVaults: executableOpportunities.length,
                discoveredVaults: opportunities.length,
                reason: ranking.reason,
            },
            opportunities: [mapBonzoVaultOpportunityToRawOpportunity(bestOpportunity)],
        }
    }

    async monitor(toolId: string): Promise<ToolResponse> {
        if (toolId !== BONZO_TOOL_ID) {
            throw new Error(
                `[bonzo-runtime] Hedera tool runtime does not support ${toolId}`
            )
        }

        const [opportunities, currentPosition] = await Promise.all([
            this.discoverySource.discoverVaults(),
            this.positionReader.getCurrentPosition(),
        ])

        if (isLiveMode(this.env) && currentPosition) {
            const currentOpportunity = findCurrentOpportunity(opportunities, currentPosition)
            if (!currentOpportunity) {
                return buildUnsupportedCurrentPositionResponse({
                    action: 'monitor',
                    currentPosition,
                    opportunities,
                    checkedAt: new Date().toISOString(),
                    reason:
                        `Current vault ${currentPosition.vaultId} is not present in the live Bonzo catalog; ` +
                        'monitor is refusing to emit executable exits until the catalog is corrected',
                })
            }

            if (!isLiveExecutableBonzoOpportunity(currentOpportunity)) {
                return buildUnsupportedCurrentPositionResponse({
                    action: 'monitor',
                    currentPosition,
                    opportunities,
                    checkedAt: new Date().toISOString(),
                    reason:
                        `Current vault ${currentPosition.vaultId} is not supported for live Bonzo execution; ` +
                        'only single-asset-dex vaults are currently enabled',
                })
            }
        }

        const evaluation = evaluateBonzoMonitor({
            currentPosition,
            opportunities: filterExecutableOpportunities(this.env, opportunities),
            config: this.monitorConfig,
            previousState: this.previousMonitorState,
        })

        this.previousMonitorState = evaluation.nextState
        return evaluation.response
    }
}
