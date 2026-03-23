import { describe, expect, it, vi } from 'vitest'
import { createCryptoNewsAlphaFetcher } from './alpha-fetcher'
import type { PrivateHttpClient } from './private-http-client'
import type { RawOpportunity } from '../cre-memoryvault/protocol/tool-interface'
import type { TraderTemplate } from './trader-template'

function makeTemplate(): TraderTemplate {
    return {
        agentId: 'agent-test',
        name: 'Test Agent',
        version: '1.0.0',
        strategy: {
            type: 'clmm_lp',
            tools: ['uniswap-v3-lp'],
            entryThresholds: {
                minOpportunityScore: 80,
                minTrustScore: 75,
                maxRiskLevel: 'LOW',
            },
            exitTriggers: ['apy_drop'],
        },
        risk: {
            maxPositionPct: 0.1,
            stopLossEnabled: true,
            stopLossDropPct: 0.2,
            profitTarget: 2,
            maxConcurrentPositions: 2,
        },
        customInstructions: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }
}

const OPPORTUNITY: RawOpportunity = {
    toolId: 'uniswap-v3-lp',
    assetId: 'pool-weth-btc',
    entryParams: {
        pool: {
            token0: { symbol: 'WETH' },
            token1: { symbol: 'BTC' },
        },
    },
}

describe('createCryptoNewsAlphaFetcher', () => {
    it('maps successful PrivateHttpClient responses into AlphaSignal entries', async () => {
        const privateHttpClient: PrivateHttpClient = {
            fetch: vi.fn().mockResolvedValue({
                mode: 'direct',
                status: 'success',
                bodyJson: [
                    {
                        title: 'BTC rebounds',
                        summary: 'Momentum is recovering.',
                        sentiment: { label: 'positive', score: 0.9 },
                    },
                ],
                metadata: {
                    sourceId: 'crypto-news51',
                    reason: 'ok',
                },
            }),
        }

        const fetcher = createCryptoNewsAlphaFetcher(privateHttpClient)
        const signals = await fetcher.fetchAlpha(OPPORTUNITY, makeTemplate())

        expect(signals).toEqual([
            {
                sourceId: 'crypto-news51',
                summary: '[BTC/crypto-news51] BTC rebounds. Momentum is recovering.',
                sentiment: 'bullish',
            },
        ])
    })

    it('returns no signals when PrivateHttpClient is stubbed', async () => {
        const privateHttpClient: PrivateHttpClient = {
            fetch: vi.fn().mockResolvedValue({
                mode: 'stub',
                status: 'stubbed',
                bodyJson: [],
                metadata: {
                    sourceId: 'crypto-news51',
                    reason: 'Private alpha is disabled in stub mode',
                },
            }),
        }

        const fetcher = createCryptoNewsAlphaFetcher(privateHttpClient)
        const signals = await fetcher.fetchAlpha(OPPORTUNITY, makeTemplate())

        expect(signals).toEqual([])
        expect(privateHttpClient.fetch).toHaveBeenCalledOnce()
    })
})
