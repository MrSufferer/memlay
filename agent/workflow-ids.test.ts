import { describe, expect, it } from 'vitest'
import { normalizeWorkflowId } from './workflow-ids'

describe('workflow-ids', () => {
  describe('normalizeWorkflowId', () => {
    it('strips 0x prefix from hex workflow IDs', () => {
      expect(normalizeWorkflowId('0xabc123def456')).toBe('abc123def456')
      expect(normalizeWorkflowId('0x1234567890abcdef')).toBe('1234567890abcdef')
    })

    it('returns ID unchanged when no 0x prefix', () => {
      expect(normalizeWorkflowId('abc123def456')).toBe('abc123def456')
      expect(normalizeWorkflowId('workflow-id-123')).toBe('workflow-id-123')
    })

    it('handles empty string', () => {
      expect(normalizeWorkflowId('')).toBe('')
    })

    it('handles 0x alone', () => {
      expect(normalizeWorkflowId('0x')).toBe('')
    })
  })
})
