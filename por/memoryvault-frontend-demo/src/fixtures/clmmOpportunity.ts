import type { CLMMOpportunityView, ReasoningView, MemoryEntryView, AlphaSourceView } from '../types/protocolViewModels'

export const clmmOpportunity: CLMMOpportunityView = {
  id: 'alpha-weth-0.3',
  poolLabel: 'ALPHA / WETH 0.3% CLMM',
  tvlUsd: 750_000,
  feeApr: 145,
  riskLevel: 'LOW',
  opportunityScore: 88,
  trustScore: 90,
  beforePosition: {
    tvlUsd: 0,
    exposure: 0,
  },
  afterPosition: {
    tvlUsd: 100_000,
    exposure: 0.12,
  },
}

export const reasoning: ReasoningView = {
  summary: 'Pool has deep, growing liquidity and strong fee APR; alpha feeds confirm no major red flags.',
  details:
    'Uniswap V3 subgraph shows >$700k TVL, healthy daily volume, and stable tick range. Holder distribution is diversified and contract verified. Custom HTTP alpha sources report neutral-to-positive sentiment and no rug-pull indicators. Given the trader template thresholds, this opportunity meets the criteria for a conservative CLMM LP rebalance.',
  inputs: [
    {
      type: 'public',
      source: 'Uniswap V3 Subgraph',
      description: 'TVL, fee APR, pool age, liquidity, current tick.',
    },
    {
      type: 'public',
      source: 'On-chain holders',
      description: 'Top 10 holders &lt; 35% of supply; no suspicious concentration.',
    },
    {
      type: 'private',
      source: 'https://alpha.example.com/clmm-signals',
      description: 'Custom HTTP alpha feed with neutral/positive signals; no scam alerts.',
    },
  ],
}

export const memoryEntries: MemoryEntryView[] = [
  {
    id: 'scan-1',
    timestamp: '2026-03-04T10:00:00Z',
    type: 'scan-result',
    toolId: 'uniswap-v3-lp',
    agentId: 'agent-alpha-01',
    data: {
      opportunityId: clmmOpportunity.id,
      summary: 'Scanned CLMM pools; ALPHA/WETH 0.3% surfaced as candidate.',
    },
  },
  {
    id: 'decision-1',
    timestamp: '2026-03-04T10:00:15Z',
    type: 'rebalancing-decision',
    toolId: 'uniswap-v3-lp',
    agentId: 'agent-alpha-01',
    data: {
      opportunityId: clmmOpportunity.id,
      reasoning: reasoning.summary,
      summary: 'Committed reasoning + scores to MemoryVault (hash anchored on-chain).',
    },
  },
  {
    id: 'exec-1',
    timestamp: '2026-03-04T10:00:30Z',
    type: 'rebalancing-executed',
    toolId: 'uniswap-v3-lp',
    agentId: 'agent-alpha-01',
    data: {
      opportunityId: clmmOpportunity.id,
      summary: 'Executed CLMM rebalance (simulated ACE private transfer).',
    },
  },
]

export const alphaSources: AlphaSourceView[] = [
  {
    id: 'alpha-cryptonews51',
    name: 'Crypto News 51 (24h news • sentiment)',
    url: 'https://crypto-news51.p.rapidapi.com/api/v1/crypto/articles/search?title_keywords={TOKEN}&page=1&limit=5&time_frame=24h&format=json',
    apiKeyLabel: 'x-rapidapi-key',
    apiKey: '',   // user fills this in — never sent to Gemini
    headerName: 'x-rapidapi-key',
    sampleSignal: 'Returns 24h news articles with sentiment (positive/negative/neutral) for the scanned token.',
  },
]

