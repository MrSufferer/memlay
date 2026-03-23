import { describe, expect, it, vi } from 'vitest'
import { ZamaConfidentialTransferClient } from './zama-confidential-client'

const TEST_KEY =
  '0x59c6995e998f97a5a0044966f094538e5f4e8a3f8f8b0f5e8f6f9a66a4d4f4f4'

describe('ZamaConfidentialTransferClient', () => {
  it('runs in simulate mode without on-chain config', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const client = new ZamaConfidentialTransferClient({
      mode: 'simulate',
    })

    await client.privateTransfer({
      recipient: '0x0000000000000000000000000000000000000001',
      token: '0x0000000000000000000000000000000000000002',
      amount: 123n,
    })

    expect(logSpy).toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('fails fast in onchain mode when required config is missing', () => {
    expect(
      () =>
        new ZamaConfidentialTransferClient({
          mode: 'onchain',
        })
    ).toThrow('Missing ZAMA_RPC_URL for onchain transfer mode')
  })

  it('throws when encrypted payload is missing for amount in onchain mode', async () => {
    const client = new ZamaConfidentialTransferClient({
      mode: 'onchain',
      rpcUrl: 'https://example-rpc.local',
      chainId: 11155111,
      privateKey: TEST_KEY,
      tokenAddress: '0x0000000000000000000000000000000000000002',
    })

    await expect(
      client.privateTransfer({
        recipient: '0x0000000000000000000000000000000000000001',
        token: '0x0000000000000000000000000000000000000002',
        amount: 500n,
      })
    ).rejects.toThrow('Missing encrypted payload for amount=500')
  })
})
