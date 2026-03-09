import { describe, expect, it, vi } from 'vitest'
import type { Runtime } from '@chainlink/cre-sdk'
import type { ToolResponse } from '../../protocol/tool-interface'
import { onCronTrigger } from './scanner'

// Lightweight smoke test to ensure scanner onCronTrigger builds a valid ToolResponse
// given a mocked Runtime + HTTPClient. We don't exercise the real CRE runtime here.

vi.mock('@chainlink/cre-sdk', async () => {
  const actual = await vi.importActual<any>('@chainlink/cre-sdk')
  return {
    ...actual,
    cre: {
      capabilities: {
        HTTPClient: vi.fn().mockImplementation(() => ({
          sendRequest: (_runtime: any, req: any) => ({
            result: () => ({
              statusCode: 200,
              body: new TextEncoder().encode(JSON.stringify({
                pools: [
                  {
                    id: 'pool-weth-alpha',
                    pair: 'WETH/ALPHA',
                    protocol: 'uniswap-v3',
                    token: '0xAlpha...',
                    age: '3d',
                    tvl: 820000,
                    feeAPY: 240,
                    feeTier: 3000,
                    tickSpacing: 60,
                    currentTick: 202100,
                  },
                ],
              })),
            }),
          }),
        })),
      },
    },
  }
})

describe('uniswap-v3-lp scanner', () => {
  // NOTE: This test is marked as skipped because the compiled CRE workflow
  // bundle for scanner validates host bindings (CRE WASM globals) on import,
  // which is not available in the Vitest/Node environment. The functional
  // behavior of the scanner is covered via `cre workflow simulate` as per
  // docs/ai/testing/feature-memoryvault-agent-protocol.md.
  it.skip('returns a successful ToolResponse with RawOpportunity[]', async () => {
    const runtime: Partial<Runtime<any>> = {
      log: () => {},
      config: {
        schedule: '0 * * * *',
        apiUrl: 'http://localhost:3001',
        minTVL: 500000,
        maxAgeDays: 7,
      },
      getSecret: vi.fn().mockReturnValue({
        result: () => ({ value: 'demo-secret-key-12345' }),
      }),
    }

    const result = onCronTrigger(runtime as Runtime<any>)

    expect(result.status).toBe('success')
    expect(result.action).toBe('scan')
    expect(result.toolId).toBe('uniswap-v3-lp')
    expect(result.opportunities).toBeDefined()
    expect(result.opportunities!.length).toBe(1)
    const opp = result.opportunities![0]
    expect(opp.toolId).toBe('uniswap-v3-lp')
    expect(opp.assetId).toBe('pool-weth-alpha')
    expect(opp.entryParams.pool.pair).toBe('WETH/ALPHA')
  })
})

