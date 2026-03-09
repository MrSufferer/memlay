/**
 * Configuration for MemoryVault Frontend Demo
 *
 * By default, the demo uses fixtures. To enable real data from agent/audit endpoints,
 * set USE_REAL_DATA=true and configure the endpoint URLs.
 */

import { configureRealData } from './data/realDataAdapter'

// ─── Real Data Configuration ───────────────────────────────────────────────

// Check for environment variable or localStorage flag
const useRealData =
  import.meta.env.VITE_USE_REAL_DATA === 'true' ||
  (typeof window !== 'undefined' && localStorage.getItem('useRealData') === 'true')

if (useRealData) {
  // Configure real data adapter
  // These URLs should point to your deployed agent service and audit-reader endpoints
  configureRealData({
    enabled: true,
    agentServiceUrl: import.meta.env.VITE_AGENT_SERVICE_URL || 'https://api.example.com/agent/opportunities',
    auditReaderUrl: import.meta.env.VITE_AUDIT_READER_URL || 'https://api.example.com/audit-reader',
    apiKey: import.meta.env.VITE_API_KEY, // Optional API key for authenticated requests
  })

  console.log('[Config] Real data mode enabled')
} else {
  console.log('[Config] Using fixture data (default)')
}

// ─── Export configuration helpers ────────────────────────────────────────────

/**
 * Enable/disable real data mode at runtime
 * Useful for toggling in development or via UI controls
 */
export const setRealDataMode = (enabled: boolean, config?: {
  agentServiceUrl?: string
  auditReaderUrl?: string
  apiKey?: string
}) => {
  if (typeof window !== 'undefined') {
    localStorage.setItem('useRealData', enabled ? 'true' : 'false')
  }

  configureRealData({
    enabled,
    ...config,
  })
}
