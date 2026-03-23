import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildHederaAuditResponse } from './audit'
import type { HederaMemoryVerifier } from './hedera/memory/verifier'

describe('buildHederaAuditResponse', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('maps verified Hedera entries into the audit response shape', async () => {
    process.env.HEDERA_NETWORK = 'testnet'
    process.env.HEDERA_OPERATOR_ID = '0.0.1001'
    process.env.HEDERA_OPERATOR_KEY = 'operator-private-key'
    process.env.HEDERA_MIRROR_NODE_URL = 'https://mirror.example.com/api/v1'
    process.env.HEDERA_MEMORY_TOPIC_ID = '0.0.8001'
    process.env.BONZO_EXECUTOR_MODE = 'operator'
    process.env.BONZO_DATA_SOURCE = 'mock'
    process.env.AES_KEY_VAR =
      '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
    process.env.AWS_ACCESS_KEY_ID_VAR = 'aws-access-key'
    process.env.AWS_SECRET_ACCESS_KEY_VAR = 'aws-secret-key'
    process.env.HEDERA_MEMORY_S3_BUCKET = 'memory-layer'
    process.env.HEDERA_MEMORY_S3_REGION = 'ap-southeast-2'

    const verifier: HederaMemoryVerifier = {
      list: vi.fn().mockResolvedValue([]),
      verify: vi.fn().mockResolvedValue({
        allValid: false,
        entries: [
          {
            agentId: 'agent-alpha-01',
            entryKey: 'decision:1',
            entryHash: '0x1234',
            timestamp: '2026-03-23T00:00:00.000Z',
            blobUri: 's3://memory-layer/agents/agent-alpha-01/log/decision:1',
            topicId: '0.0.8001',
            sequenceNumber: 4,
            consensusTimestamp: '1711152000.000000000',
            committedAt: '2024-03-23T00:00:00.000Z',
            valid: false,
            error: 'Blob hash mismatch',
            data: {
              action: 'lp-entry',
              toolId: 'bonzo-vaults',
              timestamp: '2026-03-23T00:00:00.000Z',
              reasoning: 'tampered',
            },
          },
        ],
      }),
    }

    const response = await buildHederaAuditResponse('agent-alpha-01', verifier)

    expect(response.status).toBe('success')
    expect(response.agentId).toBe('agent-alpha-01')
    expect(response.totalEntries).toBe(1)
    expect(response.verifiedCount).toBe(0)
    expect(response.unverifiedCount).toBe(1)
    expect(response.onChainCommitments).toContain('0.0.8001')
    expect(response.decisionLog[0]).toEqual({
      key: 'decision:1',
      type: 'lp-entry',
      toolId: 'bonzo-vaults',
      timestamp: '2026-03-23T00:00:00.000Z',
      verified: false,
      committedAt: '2024-03-23T00:00:00.000Z',
      data: {
        action: 'lp-entry',
        toolId: 'bonzo-vaults',
        timestamp: '2026-03-23T00:00:00.000Z',
        reasoning: 'tampered',
      },
    })
  })
})
