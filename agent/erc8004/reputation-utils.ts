import type { EndpointProbeResult, ReputationFeedbackInput } from './types'

export const ZERO_HASH =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as const

export function toFixedPointInt(value: number, decimals: number): bigint {
  const scale = 10 ** decimals
  return BigInt(Math.round(value * scale))
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2)
  }
  return sorted[mid]
}

export function buildReliabilityFeedbackInputs(args: {
  agentId: number
  probeResults: EndpointProbeResult[]
}): ReputationFeedbackInput[] {
  const out: ReputationFeedbackInput[] = []

  for (const result of args.probeResults) {
    out.push({
      agentId: args.agentId,
      value: result.reachable ? 1n : 0n,
      valueDecimals: 0,
      tag1: 'reachable',
      tag2: result.endpointId,
      endpoint: result.endpoint,
      feedbackURI: '',
      feedbackHash: ZERO_HASH,
    })

    out.push({
      agentId: args.agentId,
      value: toFixedPointInt(result.uptimePct, 2),
      valueDecimals: 2,
      tag1: 'uptime',
      tag2: result.endpointId,
      endpoint: result.endpoint,
      feedbackURI: '',
      feedbackHash: ZERO_HASH,
    })

    out.push({
      agentId: args.agentId,
      value: toFixedPointInt(result.successRatePct, 2),
      valueDecimals: 2,
      tag1: 'successRate',
      tag2: result.endpointId,
      endpoint: result.endpoint,
      feedbackURI: '',
      feedbackHash: ZERO_HASH,
    })

    if (typeof result.responseTimeMsMedian === 'number') {
      out.push({
        agentId: args.agentId,
        value: BigInt(Math.round(result.responseTimeMsMedian)),
        valueDecimals: 0,
        tag1: 'responseTime',
        tag2: result.endpointId,
        endpoint: result.endpoint,
        feedbackURI: '',
        feedbackHash: ZERO_HASH,
      })
    }
  }

  return out
}
