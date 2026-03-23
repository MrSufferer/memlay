import { describe, expect, it, vi } from 'vitest'
import { MemoryClient } from './memory-client'

describe('MemoryClient deploy/simulate fallback', () => {
  it('falls back to simulate in auto mode when deployed path fails', async () => {
    const client = new MemoryClient({ mode: 'auto' })

    ;(client as any).commitViaDeployed = vi.fn().mockRejectedValue(new Error('boom'))
    ;(client as any).commitViaSim = vi.fn().mockResolvedValue(undefined)

    await client.commitEntry({
      agentId: 'agent-alpha-01',
      entryKey: 'decision:1',
      entryData: {
        timestamp: new Date().toISOString(),
        type: 'decision',
        input: {},
        output: {},
        metadata: {},
      },
    })

    expect((client as any).commitViaDeployed).toHaveBeenCalledOnce()
    expect((client as any).commitViaSim).toHaveBeenCalledOnce()
  })

  it('does not fallback in deployed-only mode', async () => {
    const client = new MemoryClient({ mode: 'deployed' })

    ;(client as any).commitViaDeployed = vi.fn().mockRejectedValue(new Error('boom'))
    ;(client as any).commitViaSim = vi.fn().mockResolvedValue(undefined)

    await expect(
      client.commitEntry({
        agentId: 'agent-alpha-01',
        entryKey: 'decision:2',
        entryData: {
          timestamp: new Date().toISOString(),
          type: 'decision',
          input: {},
          output: {},
          metadata: {},
        },
      })
    ).rejects.toThrow('boom')

    expect((client as any).commitViaSim).not.toHaveBeenCalled()
  })

  it('rejects Hedera until a Hedera memory anchor exists', async () => {
    process.env.MEMORYVAULT_DEPLOYMENT_TARGET = 'hedera'

    try {
      const client = new MemoryClient({ mode: 'simulate' })

      await expect(
        client.commitEntry({
          agentId: 'agent-alpha-01',
          entryKey: 'decision:3',
          entryData: {
            timestamp: new Date().toISOString(),
            type: 'decision',
            input: {},
            output: {},
            metadata: {},
          },
        })
      ).rejects.toThrow('Implement the Hedera memory anchor')
    } finally {
      delete process.env.MEMORYVAULT_DEPLOYMENT_TARGET
    }
  })
})
