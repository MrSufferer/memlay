import {
    cre,
    CronCapability,
    handler,
    ok,
    type Runtime,
    Runner,
    decodeJson,
    type HTTPPayload,
} from '@chainlink/cre-sdk'
import { z } from 'zod'
import type { ToolResponse, RawOpportunity } from '../../protocol/tool-interface'

const configSchema = z.object({
    schedule: z.string(),
    /** Full The Graph subgraph URL (no API key in path) */
    uniswapSubgraphUrl: z.string(),
    minTVL: z.number().default(500000),
    maxAgeDays: z.number().default(7),
    /** Authorized ECDSA key used by deployed HTTP trigger */
    publicKey: z.string(),
})

type ScannerConfig = z.infer<typeof configSchema>

interface ScannerOverrides {
    minTVL?: number
    maxAgeDays?: number
    uniswapSubgraphUrl?: string
}

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

function parseHttpOverrides(payload: HTTPPayload): ScannerOverrides {
    if (!payload.input || payload.input.length === 0) {
        return {}
    }

    const parsed = decodeJson(payload.input) as Record<string, unknown>
    const params = (parsed.params ?? parsed) as Record<string, unknown>

    const out: ScannerOverrides = {}
    if (typeof params.minTVL === 'number' && Number.isFinite(params.minTVL)) {
        out.minTVL = params.minTVL
    }
    if (typeof params.maxAgeDays === 'number' && Number.isFinite(params.maxAgeDays)) {
        out.maxAgeDays = params.maxAgeDays
    }
    if (typeof params.uniswapSubgraphUrl === 'string' && params.uniswapSubgraphUrl.length > 0) {
        out.uniswapSubgraphUrl = params.uniswapSubgraphUrl
    }

    return out
}

function executeScan(runtime: Runtime<ScannerConfig>, overrides: ScannerOverrides = {}): ToolResponse {
    runtime.log('Starting Uniswap V3 LP Scanner tool')

    // ── Fetch API key secret (sequential getSecret — CRE requirement) ─────────
    const dataApiKey = runtime.getSecret({ id: 'dataApiKey' }).result()

    const httpClient = new cre.capabilities.HTTPClient()
    const config = runtime.config

    const minTVL = overrides.minTVL ?? config.minTVL
    const maxAgeDays = overrides.maxAgeDays ?? config.maxAgeDays
    const uniswapSubgraphUrl = overrides.uniswapSubgraphUrl ?? config.uniswapSubgraphUrl

    // ── Fetch public CLMM pool data from Uniswap V3 subgraph via The Graph ────
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
            url: uniswapSubgraphUrl,
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
    const maxAgeSecs = maxAgeDays * 24 * 60 * 60

    const pools = allPools.filter((p: any) => {
        const tvl = Number(p.totalValueLockedUSD ?? 0)
        const createdAt = Number(p.createdAtTimestamp ?? 0)
        const ageSecs = nowSecs - createdAt
        const tvlOk = tvl >= minTVL
        const ageOk = ageSecs >= 0 && ageSecs <= maxAgeSecs
        return tvlOk && ageOk
    })

    // Build RawOpportunity[] from public pool data only.
    const opportunities: RawOpportunity[] = []

    for (const pool of pools) {
        opportunities.push({
            toolId: 'uniswap-v3-lp',
            assetId: pool.id,
            entryParams: {
                pool,
            },
        })
    }

    const result: ToolResponse = {
        status: 'success',
        action: 'scan',
        toolId: 'uniswap-v3-lp',
        data: {
            fetchedCount: opportunities.length,
            minTVL,
            maxAgeDays,
        },
        opportunities,
    }

    runtime.log(`Scanner completed successfully. Found ${result.opportunities?.length || 0} opportunities.`)
    return result
}

export const onCronTrigger = (runtime: Runtime<ScannerConfig>): ToolResponse => {
    return executeScan(runtime)
}

export const onHttpTrigger = (
    runtime: Runtime<ScannerConfig>,
    payload: HTTPPayload
): string => {
    const overrides = parseHttpOverrides(payload)
    const result = executeScan(runtime, overrides)
    return JSON.stringify(result)
}

const initWorkflow = (config: ScannerConfig) => {
    const http = new cre.capabilities.HTTPCapability()

    return [
        // Keep cron trigger first so existing simulate commands using --trigger-index 0 remain valid.
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
    const runner = await Runner.newRunner<ScannerConfig>({ configSchema })
    await runner.run(initWorkflow)
}
main()
