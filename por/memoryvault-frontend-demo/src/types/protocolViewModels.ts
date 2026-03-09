import type { RiskLevel } from './tool-interface'
export type { RiskLevel }

export interface CLMMOpportunityView {
  id: string
  poolLabel: string
  tvlUsd: number
  feeApr: number
  riskLevel: RiskLevel
  opportunityScore: number
  trustScore: number
  beforePosition: {
    tvlUsd: number
    exposure: number
  }
  afterPosition: {
    tvlUsd: number
    exposure: number
  }
}

export interface ReasoningInput {
  type: 'public' | 'private'
  source: string
  description: string
}

export interface ReasoningView {
  summary: string
  details: string
  inputs: ReasoningInput[]
}

export type MemoryEntryType = 'scan-result' | 'rebalancing-decision' | 'rebalancing-executed'

export interface MemoryEntryView {
  id: string
  timestamp: string
  type: MemoryEntryType
  toolId: 'uniswap-v3-lp'
  agentId: string
  data: {
    opportunityId: string
    reasoning?: string
    summary?: string
  }
}

export interface AlphaSourceView {
  id: string
  name: string
  /** Full URL template — {TOKEN} will be replaced with the scanned token symbol */
  url: string
  /** Human-readable label for the API key (shown in UI) */
  apiKeyLabel: string
  /** The actual key value — stored in browser only, never sent to Gemini */
  apiKey: string
  /** HTTP header name to send the key under (default: x-api-key) */
  headerName: string
  sampleSignal: string
}

