import { describe, expect, it } from 'vitest'
import { loadTemplate } from './trader-template'

describe('loadTemplate', () => {
    it('falls back to the Hedera Bonzo template for Hedera deployments', () => {
        process.env.MEMORYVAULT_DEPLOYMENT_TARGET = 'hedera'

        try {
            const template = loadTemplate('agent-hedera-01')

            expect(template.agentId).toBe('agent-hedera-01')
            expect(template.strategy.tools).toEqual(['bonzo-vaults'])
        } finally {
            delete process.env.MEMORYVAULT_DEPLOYMENT_TARGET
        }
    })
})
