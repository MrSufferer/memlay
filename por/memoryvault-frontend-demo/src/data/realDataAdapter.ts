/**
 * Real Data Adapter for MemoryVault Frontend Demo
 *
 * This module provides functions to load data from real agent/audit endpoints.
 * All functions are behind a config flag so the demo can work with pure fixtures.
 *
 * API Contracts:
 * - loadOpportunities(): Expects agent service endpoint that returns ScoredOpportunity[]
 * - loadMemoryLog(): Expects audit-reader HTTP trigger that returns verified decision log
 */

import type { CLMMOpportunityView, MemoryEntryView } from '../types/protocolViewModels'

// ─── Configuration ──────────────────────────────────────────────────────────

export interface RealDataConfig {
  /** Enable real data loading (default: false, uses fixtures) */
  enabled: boolean
  /** Agent service endpoint for loading opportunities */
  agentServiceUrl?: string
  /** Audit-reader HTTP trigger endpoint for loading memory log */
  auditReaderUrl?: string
  /** Optional API key for authenticated requests */
  apiKey?: string
}

const defaultConfig: RealDataConfig = {
  enabled: false,
}

let currentConfig: RealDataConfig = defaultConfig

export const configureRealData = (config: Partial<RealDataConfig>) => {
  currentConfig = { ...defaultConfig, ...config }
}

export const isRealDataEnabled = (): boolean => {
  return currentConfig.enabled === true
}

// ─── Type Definitions for Real API Responses ────────────────────────────────

/**
 * Expected response from agent service for opportunities
 * Maps to ScoredOpportunity from the protocol
 */
interface AgentOpportunityResponse {
  opportunities: Array<{
    id: string
    poolLabel: string
    tvlUsd: number
    feeApr: number
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'SCAM'
    opportunityScore: number
    trustScore: number
    // Additional fields that may be present
    beforePosition?: { tvlUsd: number; exposure: number }
    afterPosition?: { tvlUsd: number; exposure: number }
  }>
}

/**
 * Expected response from audit-reader HTTP trigger
 * Maps to the verified decision log structure
 */
interface AuditReaderResponse {
  status: 'success' | 'error'
  agentId: string
  decisionLog: Array<{
    id: string
    timestamp: string
    type: 'scan-result' | 'rebalancing-decision' | 'rebalancing-executed'
    toolId: string
    agentId: string
    data: {
      opportunityId: string
      reasoning?: string
      summary?: string
    }
    verified?: boolean
  }>
  totalEntries?: number
  verifiedCount?: number
  unverifiedCount?: number
}

// ─── Data Loading Functions ────────────────────────────────────────────────

/**
 * Load CLMM opportunities from the agent service
 *
 * @param agentId Optional agent ID to filter opportunities
 * @returns Array of CLMM opportunities, or empty array if disabled/error
 */
export async function loadOpportunities(agentId?: string): Promise<CLMMOpportunityView[]> {
  if (!isRealDataEnabled() || !currentConfig.agentServiceUrl) {
    return []
  }

  try {
    const url = new URL(currentConfig.agentServiceUrl)
    if (agentId) {
      url.searchParams.set('agentId', agentId)
    }

    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    }
    if (currentConfig.apiKey) {
      headers['Authorization'] = `Bearer ${currentConfig.apiKey}`
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers,
    })

    if (!response.ok) {
      console.warn(`[RealDataAdapter] Failed to load opportunities: ${response.statusText}`)
      return []
    }

    const data: AgentOpportunityResponse = await response.json()

    // Map to view model format
    return data.opportunities.map((opp) => ({
      id: opp.id,
      poolLabel: opp.poolLabel,
      tvlUsd: opp.tvlUsd,
      feeApr: opp.feeApr,
      riskLevel: opp.riskLevel,
      opportunityScore: opp.opportunityScore,
      trustScore: opp.trustScore,
      beforePosition: opp.beforePosition ?? { tvlUsd: 0, exposure: 0 },
      afterPosition: opp.afterPosition ?? { tvlUsd: 0, exposure: 0 },
    }))
  } catch (error) {
    console.error('[RealDataAdapter] Error loading opportunities:', error)
    return []
  }
}

/**
 * Load MemoryVault decision log from the audit-reader HTTP trigger
 *
 * @param agentId Required agent ID to fetch decision log for
 * @returns Array of memory entries, or empty array if disabled/error
 */
export async function loadMemoryLog(agentId: string): Promise<MemoryEntryView[]> {
  if (!isRealDataEnabled() || !currentConfig.auditReaderUrl) {
    return []
  }

  if (!agentId) {
    console.warn('[RealDataAdapter] agentId required for loadMemoryLog')
    return []
  }

  try {
    const url = new URL(currentConfig.auditReaderUrl)

    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    }
    if (currentConfig.apiKey) {
      headers['Authorization'] = `Bearer ${currentConfig.apiKey}`
    }

    // Audit-reader expects HTTP POST with { agentId } payload
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ agentId }),
    })

    if (!response.ok) {
      console.warn(`[RealDataAdapter] Failed to load memory log: ${response.statusText}`)
      return []
    }

    const data: AuditReaderResponse = await response.json()

    if (data.status !== 'success' || !data.decisionLog) {
      console.warn('[RealDataAdapter] Invalid response from audit-reader')
      return []
    }

    // Map to view model format
    return data.decisionLog.map((entry) => ({
      id: entry.id,
      timestamp: entry.timestamp,
      type: entry.type,
      toolId: entry.toolId as 'uniswap-v3-lp',
      agentId: entry.agentId,
      data: {
        opportunityId: entry.data.opportunityId,
        reasoning: entry.data.reasoning,
        summary: entry.data.summary,
      },
    }))
  } catch (error) {
    console.error('[RealDataAdapter] Error loading memory log:', error)
    return []
  }
}

// ─── Helper: Check if endpoints are reachable ───────────────────────────────

/**
 * Test connectivity to configured endpoints
 * Useful for showing connection status in the UI
 */
export async function testEndpoints(): Promise<{
  agentService: boolean
  auditReader: boolean
}> {
  const result = {
    agentService: false,
    auditReader: false,
  }

  if (!isRealDataEnabled()) {
    return result
  }

  // Test agent service
  if (currentConfig.agentServiceUrl) {
    try {
      const response = await fetch(currentConfig.agentServiceUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(3000),
      })
      result.agentService = response.ok
    } catch {
      // Endpoint not reachable
    }
  }

  // Test audit-reader (can't use HEAD, but we can try a minimal POST)
  if (currentConfig.auditReaderUrl) {
    try {
      const response = await fetch(currentConfig.auditReaderUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'test' }),
        signal: AbortSignal.timeout(3000),
      })
      // Even if it fails with 400/404, if we get a response, the endpoint exists
      result.auditReader = response.status !== 0
    } catch {
      // Endpoint not reachable
    }
  }

  return result
}
