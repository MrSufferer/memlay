import { describe, expect, it, vi } from 'vitest'
import { CRETrigger } from './cre-trigger'
import type { ToolResponse } from '../cre-memoryvault/protocol/tool-interface'

const SAMPLE_SCAN_RESULT: ToolResponse = {
  status: 'success',
  action: 'scan',
  toolId: 'uniswap-v3-lp',
  data: {},
  opportunities: [],
}

describe('CRETrigger deploy/simulate fallback', () => {
  it('falls back to simulate in auto mode when deployed call fails', async () => {
    const trigger = new CRETrigger({ mode: 'auto' })

    ;(trigger as any).deployedClient = {
      triggerWorkflow: vi.fn().mockRejectedValue(new Error('boom')),
    }
    ;(trigger as any).workflowIds = { scanner: 'abc123' }

    const simulateSpy = vi
      .spyOn(trigger as any, 'runSimulate')
      .mockResolvedValue(SAMPLE_SCAN_RESULT)

    const result = await trigger.getScanResults('uniswap-v3-lp')

    expect(result).toEqual(SAMPLE_SCAN_RESULT)
    expect(simulateSpy).toHaveBeenCalledOnce()
  })

  it('does not fallback in deployed-only mode', async () => {
    const trigger = new CRETrigger({ mode: 'deployed' })

    ;(trigger as any).deployedClient = {
      triggerWorkflow: vi.fn().mockRejectedValue(new Error('boom')),
    }
    ;(trigger as any).workflowIds = { scanner: 'abc123' }

    const simulateSpy = vi
      .spyOn(trigger as any, 'runSimulate')
      .mockResolvedValue(SAMPLE_SCAN_RESULT)

    const result = await trigger.getScanResults('uniswap-v3-lp')

    expect(result).toBeNull()
    expect(simulateSpy).not.toHaveBeenCalled()
  })

  it('returns null for Hedera until a Hedera tool adapter exists', async () => {
    process.env.MEMORYVAULT_DEPLOYMENT_TARGET = 'hedera'

    try {
      const trigger = new CRETrigger({ mode: 'simulate' })
      const simulateSpy = vi.spyOn(trigger as any, 'runSimulate')

      const result = await trigger.getScanResults('uniswap-v3-lp')

      expect(result).toBeNull()
      expect(simulateSpy).not.toHaveBeenCalled()
    } finally {
      delete process.env.MEMORYVAULT_DEPLOYMENT_TARGET
    }
  })
})
