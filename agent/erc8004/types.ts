export interface ERC8004RegistrationLink {
  agentId: number
  agentRegistry: string
}

export interface ERC8004ServiceEntry {
  name: string
  endpoint: string
  version?: string
  // OASF-specific fields
  skills?: string[]
  domains?: string[]
  // MCP-specific fields
  mcpTools?: string[]
  // A2A-specific fields
  a2aSkills?: string[]
}

export interface ERC8004RegistrationFile {
  type: string
  name: string
  description: string
  image: string
  services: ERC8004ServiceEntry[]
  registrations: ERC8004RegistrationLink[]
  supportedTrust: string[]
  active: boolean
  x402Support: boolean
}

export interface ReliabilityEndpointConfig {
  id: string
  endpoint: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: Record<string, unknown>
}

export interface ERC8004DeploymentConfig {
  name: string
  description: string
  image: string
  type: string
  supportedTrust: string[]
  active: boolean
  x402Support: boolean
  services: ERC8004ServiceEntry[]
  reliabilityEndpoints: ReliabilityEndpointConfig[]
}

export interface EndpointProbeResult {
  endpointId: string
  endpoint: string
  attempts: number
  successCount: number
  reachable: boolean
  uptimePct: number
  successRatePct: number
  responseTimeMsMedian?: number
}

export type ReliabilityTag = 'reachable' | 'uptime' | 'successRate' | 'responseTime'

export interface ReputationFeedbackInput {
  agentId: number
  value: bigint
  valueDecimals: number
  tag1: ReliabilityTag
  tag2: string
  endpoint: string
  feedbackURI: string
  feedbackHash: `0x${string}`
}
