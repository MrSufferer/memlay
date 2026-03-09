import { describe, expect, it } from 'vitest'
import { calculatePositionAmount } from './lp-simulator'
import type { TraderTemplate } from './trader-template'

function makeTemplate(maxPositionPct: number): TraderTemplate {
  const now = new Date().toISOString()
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
      maxPositionPct,
      stopLossEnabled: true,
      stopLossDropPct: 0.2,
      profitTarget: 2.0,
      maxConcurrentPositions: 2,
    },
    customInstructions: '',
    createdAt: now,
    updatedAt: now,
  }
}

describe('LP Simulator — calculatePositionAmount', () => {
  it('returns a proportional amount based on maxPositionPct and wallet balance', () => {
    const tpl = makeTemplate(0.1) // 10%
    const balance = 1_000_000_000n
    const amount = calculatePositionAmount(tpl, balance)
    expect(amount).toBe(100_000_000n)
  })

  it('never returns a negative value and floors to zero for tiny balances', () => {
    const tpl = makeTemplate(0.1)
    const balance = 5n
    const amount = calculatePositionAmount(tpl, balance)
    expect(amount).toBe(0n)
  })

  it('scales linearly with wallet balance', () => {
    const tpl = makeTemplate(0.25) // 25%
    const balance1 = 1_000n
    const balance2 = 2_000n
    const a1 = calculatePositionAmount(tpl, balance1)
    const a2 = calculatePositionAmount(tpl, balance2)

    expect(a1).toBe(250n)
    expect(a2).toBe(500n)
  })
})

