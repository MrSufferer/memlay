import { describe, expect, it, vi } from 'vitest'
import { scoreOpportunity, type AlphaSignal, type RiskAnalysisDeps, type GeminiRiskResponse } from './risk-analysis'
import type { TraderTemplate } from '../trader-template'
import type { RawOpportunity } from '../../cre-memoryvault/protocol/tool-interface'

describe('Risk Analysis Skill — scoreOpportunity', () => {
  it('combines alpha + template and maps Gemini response into ScoredOpportunity', async () => {
    const alphaSignals: AlphaSignal[] = [
      { sourceId: 'test-source', summary: 'Very legit', sentiment: 'bullish' },
    ]

    const recorded: { systemPrompt?: string; input?: any } = {}

    const deps: RiskAnalysisDeps = {
      alphaFetcher: {
        async fetchAlpha(_opp, _tpl) {
          return alphaSignals
        },
      },
      gemini: {
        async generateJson<T>({ systemPrompt, input }: { systemPrompt: string; input: unknown }): Promise<T> {
          recorded.systemPrompt = systemPrompt
          recorded.input = input
          const resp: GeminiRiskResponse = {
            opportunityScore: 91,
            trustScore: 88,
            riskLevel: 'LOW',
            reasoning: 'Looks solid based on mock alpha.',
          }
          return resp as unknown as T
        },
      },
    }

    const opportunity: RawOpportunity = {
      toolId: 'uniswap-v3-lp',
      assetId: 'pool-weth-alpha',
      entryParams: { some: 'data' },
    }

    const template: TraderTemplate = {
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
        profitTarget: 2.0,
        maxConcurrentPositions: 2,
      },
      customInstructions: 'Be extremely conservative.',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const result = await scoreOpportunity(deps, opportunity, template)

    // Output fields mapped correctly
    expect(result.toolId).toBe('uniswap-v3-lp')
    expect(result.assetId).toBe('pool-weth-alpha')
    expect(result.opportunityScore).toBe(91)
    expect(result.trustScore).toBe(88)
    expect(result.riskLevel).toBe('LOW')
    expect(result.reasoning).toContain('mock alpha')

    // System prompt includes strategy type + custom instructions
    expect(recorded.systemPrompt).toBeDefined()
    expect(recorded.systemPrompt!).toContain('Trader strategy type: clmm_lp')
    expect(recorded.systemPrompt!).toContain('Trader custom instructions: Be extremely conservative.')

    // Model input includes alphaSignals and original entryParams
    expect(recorded.input).toBeDefined()
    expect(recorded.input.toolId).toBe('uniswap-v3-lp')
    expect(recorded.input.assetId).toBe('pool-weth-alpha')
    expect(recorded.input.entryParams).toEqual({ some: 'data' })
    expect(recorded.input.alphaSignals).toEqual(alphaSignals)
  })
})

