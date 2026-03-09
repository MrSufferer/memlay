import {
    cre,
    CronCapability,
    handler,
    type Runtime,
    Runner,
    ok,
} from '@chainlink/cre-sdk'
import { z } from 'zod'
import type { ToolResponse, ExitSignal } from '../../protocol/tool-interface'

/**
 * Uniswap V3 LP Tool — Monitor workflow
 *
 * Implements the `monitor` action of the Standard Tool Interface as a
 * CRE cron workflow using only public data (HTTPClient). It inspects a
 * configured set of active LP positions and evaluates the 6 exit
 * triggers defined in the requirements. Any fired triggers are returned
 * as ExitSignal[] for the agent to act on.
 */

const configSchema = z.object({
    /** Cron schedule, e.g. "0 * * * *" */
    schedule: z.string(),
    /** Public data API or subgraph adapter URL (same shape as mock /pools/clmm) */
    apiUrl: z.string(),
    /** List of active Uniswap V3 pool IDs this monitor should track */
    activePositionPoolIds: z.array(z.string()).default([]),
})

type MonitorConfig = z.infer<typeof configSchema>

interface PoolSnapshot {
    id: string
    feeAPY: number
    tvl: number
    /**
     * Optional approximate metrics exposed by the public data API.
     * These allow us to approximate some of the 6 documented exit
     * triggers without requiring premium APIs:
     *
     * - tvlChange4h: % change in TVL over the last 4h (e.g., -25 for -25%)
     * - feeMultipleSinceEntry: multiple of fees earned vs. some baseline
     */
    tvlChange4h?: number
    feeMultipleSinceEntry?: number
    // Additional fields can be added as needed (e.g., holder data, unlock info)
}

interface PoolsResponse {
    pools: PoolSnapshot[]
}

const onCronTrigger = (runtime: Runtime<MonitorConfig>): ToolResponse => {
    const config = runtime.config
    runtime.log('Uniswap V3 LP Monitor tick')

    if (!config.activePositionPoolIds.length) {
        runtime.log('No active positions configured; returning no_action')
        return {
            status: 'no_action',
            action: 'monitor',
            toolId: 'uniswap-v3-lp',
            data: {
                positionsChecked: 0
            },
            exitSignals: []
        }
    }

    const httpClient = new cre.capabilities.HTTPClient()

    // Fetch current pool data for all CLMM pools from the public API
    const resp = httpClient
        .sendRequest(runtime, {
            url: `${config.apiUrl}/pools/clmm`,
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

    for (const poolId of config.activePositionPoolIds) {
        const pool = poolById.get(poolId)
        if (!pool) continue
        checked++

        // --- Exit trigger 1: APY drop below 50% (medium urgency) ---
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

        // --- Exit trigger 2 (approx): TVL crash (>20% drop in 4h) ---
        //
        // If the mock/public API exposes `tvlChange4h`, we treat a drop
        // below -20% as a critical TVL crash. If the field is missing,
        // this trigger is effectively disabled but still logged as such.
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

        // --- Exit trigger 3 (approx): Profit target (2x fees) ---
        //
        // With only aggregate fee data, we approximate the "2x on fee
        // accumulation" requirement using a `feeMultipleSinceEntry`
        // metric if provided by the API or simulator.
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

        // NOTE: The remaining triggers from the requirements —
        // - whale_accumulation
        // - liquidity_unlock
        // - suspicious_contract
        //
        // are not currently derivable from the public pool snapshot
        // alone. They remain TODOs for when richer metrics (holder
        // distribution, lock events, contract call telemetry) are
        // exposed by the scanner/monitor backend.
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

const initWorkflow = (config: MonitorConfig) => {
    return [
        handler(
            new CronCapability().trigger({
                schedule: config.schedule
            }),
            onCronTrigger
        )
    ]
}

export async function main() {
    const runner = await Runner.newRunner<MonitorConfig>({ configSchema })
    await runner.run(initWorkflow)
}

