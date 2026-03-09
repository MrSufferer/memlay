/**
 * Crypto News Alpha Fetcher
 *
 * Uses the crypto-news51 RapidAPI provider to pull 24h news articles
 * for the token symbol of each scanned pool opportunity. Sentiment
 * labels from the API are surfaced directly to the Risk Analysis Skill,
 * which passes them to Gemini for scoring.
 *
 * API: https://rapidapi.com/apiwizard/api/crypto-news51
 * Endpoint used: GET /api/v1/crypto/articles/search
 *   ?title_keywords=<token_symbol>
 *   &page=1
 *   &limit=5
 *   &time_frame=24h
 *   &format=json
 *
 * Each article includes:
 *   { title, summary, link, media[], sentiment: { label, score } }
 *
 * Alpha sources are configured in the trader template via `alpha.sources`.
 * If no sources are configured, the fetcher falls back to the default
 * provider using RAPIDAPI_KEY_VAR from the environment.
 *
 * In the CRE workflow context, API keys would be fetched via
 * `runtime.getSecret({ id: 'RAPIDAPI_KEY' })`. In the agent service
 * (Node.js/Bun) they are loaded from `process.env[secretEnvVar]`.
 */

import type { AlphaFetcher, AlphaSignal } from './skills/risk-analysis'
import type { RawOpportunity } from '../cre-memoryvault/protocol/tool-interface'
import type { TraderTemplate, AlphaSource } from './trader-template'

const RAPIDAPI_HOST = 'crypto-news51.p.rapidapi.com'
const BASE_URL = `https://${RAPIDAPI_HOST}/api/v1/crypto/articles/search`

const DEFAULT_SOURCE: AlphaSource = {
    id: 'crypto-news51',
    description: '24h crypto news via RapidAPI (default)',
    secretEnvVar: 'RAPIDAPI_KEY_VAR',
}

interface NewsArticle {
    title: string
    summary: string
    link: string
    media?: string[]
    sentiment?: {
        label: 'positive' | 'negative' | 'neutral'
        score: number
    }
}

/**
 * Extract a short token symbol from pool data.
 * Uniswap V3 scanner returns pools with:
 *   token0.symbol / token1.symbol  (from subgraph)  OR
 *   pair: "WETH/ALPHA"             (from mock API)
 *
 * We pick the non-WETH/USDC/USDT side as the "interesting" token.
 */
function extractTokenSymbol(opportunity: RawOpportunity): string {
    const p: any = opportunity.entryParams?.pool ?? opportunity.entryParams

    // Subgraph shape: token0 / token1 objects with .symbol
    if (p?.token0?.symbol && p?.token1?.symbol) {
        const base = ['WETH', 'USDC', 'USDT', 'DAI', 'WBTC']
        const t0 = String(p.token0.symbol)
        const t1 = String(p.token1.symbol)
        // Pick the non-base token; default to token1
        return base.includes(t0.toUpperCase()) ? t1 : t0
    }

    // Mock API shape: pair = "WETH/ALPHA"
    if (p?.pair) {
        const parts: string[] = String(p.pair).split('/')
        const bases = ['WETH', 'USDC', 'USDT', 'DAI']
        const interesting = parts.find(s => !bases.includes(s.toUpperCase()))
        if (interesting) return interesting
    }

    // Fallback to assetId (pool address)
    return opportunity.assetId.slice(0, 10)
}

/**
 * Map a RapidAPI sentiment label to our AlphaSignal sentiment type.
 */
function mapSentiment(label?: string): 'bullish' | 'bearish' | 'neutral' {
    if (label === 'positive') return 'bullish'
    if (label === 'negative') return 'bearish'
    return 'neutral'
}

/**
 * Fetch news articles for a token symbol using a single AlphaSource config.
 * Returns an empty array (never throws) if the key is missing or the API fails.
 */
async function fetchFromSource(
    source: AlphaSource,
    symbol: string,
): Promise<AlphaSignal[]> {
    const apiKey = process.env[source.secretEnvVar]
    if (!apiKey) {
        console.warn(
            `[AlphaFetcher] ${source.id}: env var "${source.secretEnvVar}" not set — skipping`
        )
        return []
    }

    const baseUrl = source.baseUrl ?? BASE_URL
    const url =
        `${baseUrl}` +
        `?title_keywords=${encodeURIComponent(symbol)}` +
        `&page=1&limit=5&time_frame=24h&format=json`

    console.log(`[AlphaFetcher] ${source.id}: fetching 24h news for token: ${symbol}`)

    let articles: NewsArticle[] = []
    try {
        const resp = await fetch(url, {
            headers: {
                'x-rapidapi-host': RAPIDAPI_HOST,
                'x-rapidapi-key': apiKey,
            },
        })

        if (!resp.ok) {
            console.warn(`[AlphaFetcher] ${source.id}: API returned ${resp.status} for ${symbol}`)
            return []
        }

        articles = (await resp.json()) as NewsArticle[]
    } catch (err) {
        console.warn(`[AlphaFetcher] ${source.id}: fetch error:`, err)
        return []
    }

    if (!Array.isArray(articles) || articles.length === 0) {
        console.log(`[AlphaFetcher] ${source.id}: no news articles found for ${symbol}`)
        return []
    }

    const signals: AlphaSignal[] = articles.slice(0, 5).map(a => ({
        sourceId: source.id,
        summary: `[${symbol}/${source.id}] ${a.title}. ${a.summary?.slice(0, 200) ?? ''}`.trim(),
        sentiment: mapSentiment(a.sentiment?.label),
    }))

    const counts = signals.reduce(
        (acc, s) => { acc[s.sentiment ?? 'neutral']++; return acc },
        { bullish: 0, bearish: 0, neutral: 0 }
    )
    console.log(
        `[AlphaFetcher] ${source.id} / ${symbol}: ${signals.length} articles — ` +
        `bullish:${counts.bullish} bearish:${counts.bearish} neutral:${counts.neutral}`
    )

    return signals
}

/**
 * Live implementation of AlphaFetcher.
 *
 * Alpha sources are resolved in priority order from the trader template:
 *   1. template.alpha.sources  — trader-configured sources (from template JSON)
 *   2. DEFAULT_SOURCE          — fallback to crypto-news51 via RAPIDAPI_KEY_VAR
 *
 * Results from all configured sources are combined into a single AlphaSignal[].
 */
export const cryptoNewsAlphaFetcher: AlphaFetcher = {
    async fetchAlpha(
        opportunity: RawOpportunity,
        template: TraderTemplate,
    ): Promise<AlphaSignal[]> {
        const symbol = extractTokenSymbol(opportunity)

        // Resolve alpha sources from template; fall back to default if none configured
        const hasTemplateSources = template.alpha?.sources && template.alpha.sources.length > 0
        const sources: AlphaSource[] = hasTemplateSources
            ? template.alpha!.sources
            : [DEFAULT_SOURCE]

        if (!hasTemplateSources) {
            console.log(`[AlphaFetcher] No alpha.sources in template — using default (${DEFAULT_SOURCE.id})`)
        }

        // Fetch from all configured sources and merge results
        const allSignals = await Promise.all(
            sources.map(source => fetchFromSource(source, symbol))
        )

        return allSignals.flat()
    },
}
