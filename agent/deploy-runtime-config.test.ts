import { describe, expect, it } from 'vitest'
import {
  DEPLOYMENT_TARGETS,
  loadDeploymentTargetConfig,
  resolveRuntimeMode,
  resolveDeploymentTarget,
  loadTriggerAuthConfig,
  hasDeployedTriggerConfig,
} from './deploy-runtime-config'

describe('deploy-runtime-config', () => {
  describe('resolveRuntimeMode', () => {
    it('returns auto for undefined or empty string', () => {
      expect(resolveRuntimeMode(undefined)).toBe('auto')
      expect(resolveRuntimeMode('')).toBe('auto')
    })

    it('returns simulate for simulate value', () => {
      expect(resolveRuntimeMode('simulate')).toBe('simulate')
      expect(resolveRuntimeMode('SIMULATE')).toBe('simulate')
    })

    it('returns deployed for deployed value', () => {
      expect(resolveRuntimeMode('deployed')).toBe('deployed')
      expect(resolveRuntimeMode('DEPLOYED')).toBe('deployed')
    })

    it('defaults to auto for unknown values', () => {
      expect(resolveRuntimeMode('invalid')).toBe('auto')
      expect(resolveRuntimeMode('production')).toBe('auto')
    })
  })

  describe('hasDeployedTriggerConfig', () => {
    it('returns true when both gateway and key present', () => {
      expect(
        hasDeployedTriggerConfig({
          gatewayUrl: 'https://example.org',
          privateKey: '0xabc123',
        })
      ).toBe(true)
    })

    it('returns false when gateway missing', () => {
      expect(
        hasDeployedTriggerConfig({
          gatewayUrl: undefined,
          privateKey: '0xabc123',
        })
      ).toBe(false)
    })

    it('returns false when private key missing', () => {
      expect(
        hasDeployedTriggerConfig({
          gatewayUrl: 'https://example.org',
          privateKey: undefined,
        })
      ).toBe(false)
    })

    it('returns false when both missing', () => {
      expect(
        hasDeployedTriggerConfig({
          gatewayUrl: undefined,
          privateKey: undefined,
        })
      ).toBe(false)
    })

    it('returns false for empty strings', () => {
      expect(
        hasDeployedTriggerConfig({
          gatewayUrl: '',
          privateKey: '',
        })
      ).toBe(false)
    })
  })

  describe('resolveDeploymentTarget', () => {
    it('defaults to sepolia for undefined and unknown values', () => {
      expect(resolveDeploymentTarget(undefined)).toBe('sepolia')
      expect(resolveDeploymentTarget('')).toBe('sepolia')
      expect(resolveDeploymentTarget('unknown')).toBe('sepolia')
    })

    it('normalizes Hedera aliases', () => {
      expect(resolveDeploymentTarget('hedera')).toBe('hedera')
      expect(resolveDeploymentTarget('HEDERA-TESTNET')).toBe('hedera')
      expect(resolveDeploymentTarget('hcs')).toBe('hedera')
    })

    it('normalizes Sepolia aliases', () => {
      expect(resolveDeploymentTarget('sepolia')).toBe('sepolia')
      expect(resolveDeploymentTarget('ethereum')).toBe('sepolia')
      expect(resolveDeploymentTarget('erc8004')).toBe('sepolia')
    })
  })

  describe('loadDeploymentTargetConfig', () => {
    it('returns the Sepolia config by default', () => {
      expect(loadDeploymentTargetConfig()).toEqual(DEPLOYMENT_TARGETS.sepolia)
    })

    it('returns the Hedera config when requested explicitly', () => {
      expect(loadDeploymentTargetConfig('hedera')).toEqual(DEPLOYMENT_TARGETS.hedera)
    })
  })
})
