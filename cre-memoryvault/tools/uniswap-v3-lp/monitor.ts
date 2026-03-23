import {
    cre,
    CronCapability,
    handler,
    type Runtime,
    Runner,
    decodeJson,
    type HTTPPayload,
} from '@chainlink/cre-sdk'
import { z } from 'zod'
import type { ToolResponse, ExitSignal } from '../../protocol/tool-interface'

/**
 * Uniswap V3 LP Tool — Monitor workflow
 *
 * Implements the `monitor` action of the Standard Tool Interface as a
 * CRE workflow using public data (HTTPClient). Supports both cron and
 * HTTP triggers so deployed environments can invoke on-demand checks.
 */

const configSchema = z.object({
    /** Cron schedule, e.g. "0 * * * *" */
    schedule: z.string(),
    /** Public data API or subgraph adapter URL (same shape as mock /pools/clmm) */
    apiUrl: z.string(),
    /** List of active Uniswap V3 pool IDs this monitor should track */
    activePositionPoolIds: z.array(z.string()).default([]),
    /** Authorized ECDSA key used by deployed HTTP trigger */
    publicKey: z.string(),
})

type MonitorConfig = z.infer<typeof configSchema>

interface MonitorOverrides {
    apiUrl?: string
    activePositionPoolIds?: string[]
}

interface PoolSnapshot {
    id: string
    feeAPY: number
    tvl: number
    tvlChange4h?: number
    feeMultipleSinceEntry?: number
}

interface PoolsResponse {
    pools: PoolSnapshot[]
}

function parseHttpOverrides(payload: HTTPPayload): MonitorOverrides {
    if (!payload.input || payload.input.length === 0) {
        return {}
    }

    const parsed = decodeJson(payload.input) as Record<string, unknown>
    const params = (parsed.params ?? parsed) as Record<string, unknown>

    const out: MonitorOverrides = {}
    if (typeof params.apiUrl === 'string' && params.apiUrl.length > 0) {
        out.apiUrl = params.apiUrl
    }

    if (Array.isArray(params.activePositionPoolIds)) {
        const ids = params.activePositionPoolIds.filter((v): v is string => typeof v === 'string' && v.length > 0)
        out.activePositionPoolIds = ids
    }

    return out
}

function executeMonitor(runtime: Runtime<MonitorConfig>, overrides: MonitorOverrides = {}): ToolResponse {
    const config = runtime.config
    runtime.log('Uniswap V3 LP Monitor tick')

    const apiUrl = overrides.apiUrl ?? config.apiUrl
    const activePositionPoolIds = overrides.activePositionPoolIds ?? config.activePositionPoolIds

    if (!activePositionPoolIds.length) {
        runtime.log('No active positions configured; returning no_action')
        return {
            status: 'no_action',
            action: 'monitor',
            toolId: 'uniswap-v3-lp',
            data: {
                positionsChecked: 0,
            },
            exitSignals: [],
        }
    }

    const httpClient = new cre.capabilities.HTTPClient()

    const resp = httpClient
        .sendRequest(runtime, {
            url: `${apiUrl}/pools/clmm`,
            method: 'GET',
        })
        .result()
    const poolsResp = JSON.parse(new TextDecoder().decode(resp.body)) as PoolsResponse

    const poolById = new Map<string, PoolSnapshot>()
    for (const p of poolsResp.pools || []) {
        poolById.set(p.id, p)
    }

    const exitSignals: ExitSignal[] = []
    let checked = 0

    for (const poolId of activePositionPoolIds) {
        const pool = poolById.get(poolId)
        if (!pool) continue
        checked++

        // Exit trigger 1: APY drop below 50%
        if (pool.feeAPY < 50) {
            exitSignals.push({
                trigger: 'apy_drop',
                urgency: 'medium',
                data: {
                    poolId,
                    currentAPY: pool.feeAPY,
                    threshold: 50,
                },
            })
        }

        // Exit trigger 2 (approx): TVL crash (>20% drop in 4h)
        if (typeof pool.tvlChange4h === 'number') {
            if (pool.tvlChange4h < -20) {
                exitSignals.push({
                    trigger: 'tvl_crash',
                    urgency: 'critical',
                    data: {
                        poolId,
                        change4h: pool.tvlChange4h,
                        threshold: -20,
                        approximated: false,
                    },
                })
            }
        } else {
            runtime.log(
                `TVL crash trigger approximated/disabled for pool ${poolId}: ` +
                'tvlChange4h not provided by API.'
            )
        }

        // Exit trigger 3 (approx): Profit target (2x fees)
        if (typeof pool.feeMultipleSinceEntry === 'number') {
            if (pool.feeMultipleSinceEntry >= 2.0) {
                exitSignals.push({
                    trigger: 'profit_target',
                    urgency: 'low',
                    data: {
                        poolId,
                        multiple: pool.feeMultipleSinceEntry,
                        target: 2.0,
                        approximated: true,
                    },
                })
            }
        } else {
            runtime.log(
                `Profit target trigger approximated/disabled for pool ${poolId}: ` +
                'feeMultipleSinceEntry not provided by API.'
            )
        }
    }

    const status: ToolResponse['status'] = exitSignals.length > 0 ? 'success' : 'no_action'

    const response: ToolResponse = {
        status,
        action: 'monitor',
        toolId: 'uniswap-v3-lp',
        data: {
            positionsChecked: checked,
            firedCount: exitSignals.length,
        },
        exitSignals: exitSignals.length ? exitSignals : [],
    }

    runtime.log(
        `Monitor completed. Checked ${checked} positions, ` +
        `fired ${exitSignals.length} exit signals.`
    )

    return response
}

const onCronTrigger = (runtime: Runtime<MonitorConfig>): ToolResponse => {
    return executeMonitor(runtime)
}

const onHttpTrigger = (
    runtime: Runtime<MonitorConfig>,
    payload: HTTPPayload
): string => {
    const overrides = parseHttpOverrides(payload)
    const response = executeMonitor(runtime, overrides)
    return JSON.stringify(response)
}

const initWorkflow = (config: MonitorConfig) => {
    const http = new cre.capabilities.HTTPCapability()

    return [
        // Keep cron trigger first so existing --trigger-index 0 monitor commands remain valid.
        handler(
            new CronCapability().trigger({
                schedule: config.schedule,
            }),
            onCronTrigger
        ),
        handler(
            http.trigger({
                authorizedKeys: [
                    {
                        type: 'KEY_TYPE_ECDSA_EVM',
                        publicKey: config.publicKey,
                    },
                ],
            }),
            onHttpTrigger
        ),
    ]
}

export async function main() {
    const runner = await Runner.newRunner<MonitorConfig>({ configSchema })
    await runner.run(initWorkflow)
}

main()
