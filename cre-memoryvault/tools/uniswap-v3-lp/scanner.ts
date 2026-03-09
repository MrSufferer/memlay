import {
    cre,
    CronCapability,
    handler,
    ok,
    type Runtime,
    Runner,
} from '@chainlink/cre-sdk'
import { z } from 'zod'
import type { ToolResponse, RawOpportunity } from '../../protocol/tool-interface'

const configSchema = z.object({
    schedule: z.string(),
    /** Full The Graph subgraph URL (no API key in path) */
    uniswapSubgraphUrl: z.string(),
    minTVL: z.number().default(500000),
    maxAgeDays: z.number().default(7)
})

type ScannerConfig = z.infer<typeof configSchema>

/**
 * Encode a UTF-8 string into base64 (WASM-safe, no btoa).
 */
function stringToBase64(value: string): string {
    const bytes = new TextEncoder().encode(value)
    const chars =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    let result = ''
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i]
        const b = i + 1 < bytes.length ? bytes[i + 1] : 0
        const c = i + 2 < bytes.length ? bytes[i + 2] : 0

        result += chars[a >> 2]
        result += chars[((a & 3) << 4) | (b >> 4)]
        result +=
            i + 1 < bytes.length ? chars[((b & 15) << 2) | (c >> 6)] : '='
        result += i + 2 < bytes.length ? chars[c & 63] : '='
    }
    return result
}

export const onCronTrigger = (runtime: Runtime<ScannerConfig>): ToolResponse => {
    runtime.log('Starting Uniswap V3 LP Scanner tool')

    // ── Fetch API key secret (sequential getSecret — CRE requirement) ─────────
    // We reuse the existing `dataApiKey` secret: for The Graph, it is sent as a
    // Bearer token instead of x-api-key header.
    const dataApiKey = runtime.getSecret({ id: 'dataApiKey' }).result()

    const httpClient = new cre.capabilities.HTTPClient()
    const config = runtime.config

    // ── Fetch public CLMM pool data from Uniswap V3 subgraph via The Graph ────
    //
    // NOTE: The full gateway URL (including API key and subgraph ID) is provided
    //       via the `uniswapSubgraphUrl` config field. This is public pool data
    //       only — no trader secrets or Confidential HTTP.
    const query = `
      {
        pools(first: 50, orderBy: totalValueLockedUSD, orderDirection: desc) {
          id
          token0 { id symbol }
          token1 { id symbol }
          feeTier
          liquidity
          tick
          createdAtTimestamp
          totalValueLockedUSD
        }
      }
    `

    const resp = httpClient
        .sendRequest(runtime, {
            url: config.uniswapSubgraphUrl,
            method: 'POST',
            headers: {
                Authorization: `Bearer ${dataApiKey.value}`,
                'Content-Type': 'application/json',
            },
            // CRE HTTPClient expects base64-encoded body
            body: stringToBase64(JSON.stringify({ query })),
        })
        .result()

    if (!ok(resp)) {
        throw new Error(
            `Failed to fetch pools from subgraph: ${resp.statusCode}`
        )
    }

    const decoded = JSON.parse(new TextDecoder().decode(resp.body)) as {
        data?: { pools?: any[] }
    }
    const allPools = decoded.data?.pools ?? []

    // Optional filtering by TVL and age (days), using runtime.now() for
    // consensus-safe timestamps (no Date.now()).
    const nowDate = new Date(String(runtime.now()))
    const nowSecs = Math.floor(nowDate.getTime() / 1000)
    const maxAgeSecs = config.maxAgeDays * 24 * 60 * 60

    const pools = allPools.filter((p: any) => {
        const tvl = Number(p.totalValueLockedUSD ?? 0)
        const createdAt = Number(p.createdAtTimestamp ?? 0)
        const ageSecs = nowSecs - createdAt
        const tvlOk = tvl >= config.minTVL
        const ageOk = ageSecs >= 0 && ageSecs <= maxAgeSecs
        return tvlOk && ageOk
    })

    // Build RawOpportunity[] from public pool data only.
    // Trust/alpha scoring is handled by the Risk Analysis Skill.
    const opportunities: RawOpportunity[] = []

    for (const pool of pools) {
        opportunities.push({
            toolId: 'uniswap-v3-lp',
            assetId: pool.id,
            entryParams: {
                pool
            }
        })
    }

    const result: ToolResponse = {
        status: 'success',
        action: 'scan',
        toolId: 'uniswap-v3-lp',
        data: {
            fetchedCount: opportunities.length
        },
        opportunities
    }

    runtime.log(`Scanner completed successfully. Found ${result.opportunities?.length || 0} opportunities.`)
    return result
}

const initWorkflow = (config: ScannerConfig) => {
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
    const runner = await Runner.newRunner<ScannerConfig>({ configSchema })
    await runner.run(initWorkflow)
}
