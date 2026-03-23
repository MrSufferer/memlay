import { describe, expect, it } from 'vitest'
import { createRegistrationArtifacts } from './build-registration'

describe('erc8004 build-registration', () => {
  it('creates registration + well-known artifacts with env-independent options', () => {
    const { registration, wellKnown } = createRegistrationArtifacts({
      baseUrl: 'https://example.org/cre-demo',
      chainId: 11155111,
      identityRegistryAddress: '0x1234567890abcdef1234567890abcdef12345678',
      agentId: 42,
    })

    expect(registration.type).toBe('https://eips.ethereum.org/EIPS/eip-8004#registration-v1')
    expect(registration.services.length).toBeGreaterThan(0)

    // First service is OASF (static metadata)
    expect(registration.services[0].name).toBe('OASF')
    expect(registration.services[0].skills).toBeDefined()
    expect(registration.services[0].domains).toBeDefined()

    // Web services follow OASF
    const webServices = registration.services.filter(s => s.name === 'web')
    expect(webServices.length).toBeGreaterThan(0)
    expect(webServices[0].endpoint.startsWith('https://example.org/cre-demo')).toBe(true)

    expect(registration.registrations[0]).toEqual({
      agentId: 42,
      agentRegistry: 'eip155:11155111:0x1234567890abcdef1234567890abcdef12345678',
    })

    expect(wellKnown.registrations).toEqual(registration.registrations)
  })
})
