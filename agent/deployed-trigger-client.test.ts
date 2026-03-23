import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeployedTriggerClient } from './deployed-trigger-client'

const TEST_KEY =
  '0x59c6995e998f97a5a0044966f094538e5f4e8a3f8f8b0f5e8f6f9a66a4d4f4f4'

describe('DeployedTriggerClient', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses object payload from JSON-RPC result.output', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            output: { status: 'success', action: 'scan', toolId: 'uniswap-v3-lp', data: {} },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      ) as any
    )

    const client = new DeployedTriggerClient({
      gatewayUrl: 'https://example.org/gateway',
      privateKey: TEST_KEY,
    })

    const result = await client.triggerWorkflow({
      workflowId: '0xabc',
      input: { hello: 'world' },
    })

    expect(result).toEqual({ status: 'success', action: 'scan', toolId: 'uniswap-v3-lp', data: {} })
  })

  it('parses stringified payload from JSON-RPC result.response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            response: JSON.stringify({ status: 'success', action: 'monitor', toolId: 'uniswap-v3-lp', data: {} }),
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      ) as any
    )

    const client = new DeployedTriggerClient({
      gatewayUrl: 'https://example.org/gateway',
      privateKey: TEST_KEY,
    })

    const result = await client.triggerWorkflow({
      workflowId: 'abc',
      input: {},
    })

    expect(result).toEqual({ status: 'success', action: 'monitor', toolId: 'uniswap-v3-lp', data: {} })
  })

  it('throws on JSON-RPC error response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32600, message: 'Invalid request' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      ) as any
    )

    const client = new DeployedTriggerClient({
      gatewayUrl: 'https://example.org/gateway',
      privateKey: TEST_KEY,
    })

    await expect(
      client.triggerWorkflow({ workflowId: 'abc', input: {} })
    ).rejects.toThrow('Gateway returned error (code=-32600): Invalid request')
  })

  it('throws on HTTP error status', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('Gateway unavailable', { status: 503 }) as any
    )

    const client = new DeployedTriggerClient({
      gatewayUrl: 'https://example.org/gateway',
      privateKey: TEST_KEY,
    })

    await expect(
      client.triggerWorkflow({ workflowId: 'abc', input: {} })
    ).rejects.toThrow('HTTP 503')
  })

  it('normalizes workflow ID by stripping 0x prefix', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { output: { ok: true } } }),
        { status: 200 }
      ) as any
    )

    const client = new DeployedTriggerClient({
      gatewayUrl: 'https://example.org/gateway',
      privateKey: TEST_KEY,
    })

    await client.triggerWorkflow({ workflowId: '0xabc123', input: {} })

    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(callBody.params.workflowId).toBe('abc123')
    expect(callBody.params.workflowID).toBe('abc123')
  })
})
