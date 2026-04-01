import { loadErc8004Config } from './config'
import type { EndpointProbeResult, ReliabilityEndpointConfig } from './types'
import { median } from './reputation-utils'

export interface ProbeOptions {
  attempts?: number
  timeoutMs?: number
}

export async function probeEndpoint(
  endpoint: ReliabilityEndpointConfig,
  options: Required<ProbeOptions>
): Promise<EndpointProbeResult> {
  const durations: number[] = []
  let successCount = 0
  const attempts = options.attempts ?? 5
  const timeoutMs = options.timeoutMs ?? 10_000

  for (let i = 0; i < attempts; i++) {
    const method = endpoint.method ?? 'GET'
    const startedAt = Date.now()

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(endpoint.endpoint, {
        method,
        headers: endpoint.headers,
        body: endpoint.body ? JSON.stringify(endpoint.body) : undefined,
        signal: controller.signal,
      })

      if (response.ok) {
        successCount += 1
        durations.push(Date.now() - startedAt)
      }
    } catch {
      // network errors count as failure
    } finally {
      clearTimeout(timer)
    }
  }

  const successRate = attempts > 0 ? (successCount / attempts) * 100 : 0

  return {
    endpointId: endpoint.id,
    endpoint: endpoint.endpoint,
    attempts,
    successCount,
    reachable: successCount > 0,
    uptimePct: successRate,
    successRatePct: successRate,
    responseTimeMsMedian: median(durations),
  }
}

export async function probeReliability(
  endpoints: ReliabilityEndpointConfig[],
  options: ProbeOptions = {}
): Promise<EndpointProbeResult[]> {
  const resolved: Required<ProbeOptions> = {
    attempts: options.attempts ?? 5,
    timeoutMs: options.timeoutMs ?? 10_000,
  }

  const results: EndpointProbeResult[] = []
  for (const endpoint of endpoints) {
    results.push(await probeEndpoint(endpoint, resolved))
  }
  return results
}

if (import.meta.main) {
  const config = loadErc8004Config()
  const attempts = process.env.ERC8004_PROBE_ATTEMPTS ? Number(process.env.ERC8004_PROBE_ATTEMPTS) : undefined
  const timeoutMs = process.env.ERC8004_PROBE_TIMEOUT_MS ? Number(process.env.ERC8004_PROBE_TIMEOUT_MS) : undefined

  probeReliability(config.reliabilityEndpoints, { attempts, timeoutMs })
    .then((results) => {
      console.log('[erc8004] Probe results:')
      for (const result of results) {
        console.log(
          `  ${result.endpointId}: reachable=${result.reachable} ` +
            `uptime=${result.uptimePct.toFixed(2)}% ` +
            `successRate=${result.successRatePct.toFixed(2)}% ` +
            `responseTimeMsMedian=${result.responseTimeMsMedian ?? 'n/a'}`
        )
      }
    })
    .catch((error) => {
      console.error('[erc8004] probe-reliability failed:', error)
      process.exit(1)
    })
}
