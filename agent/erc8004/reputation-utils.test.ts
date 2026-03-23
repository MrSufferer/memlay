import { describe, expect, it } from 'vitest'
import { buildReliabilityFeedbackInputs, median, toFixedPointInt } from './reputation-utils'

describe('erc8004 reputation-utils', () => {
  it('converts floats to fixed-point integers', () => {
    expect(toFixedPointInt(99.77, 2)).toBe(9977n)
    expect(toFixedPointInt(89, 0)).toBe(89n)
  })

  it('computes median for odd/even lists', () => {
    expect(median([10, 30, 20])).toBe(20)
    expect(median([10, 20, 30, 40])).toBe(25)
    expect(median([])).toBeUndefined()
  })

  it('builds reliability feedback payloads with required tags', () => {
    const entries = buildReliabilityFeedbackInputs({
      agentId: 7,
      probeResults: [
        {
          endpointId: 'scanner',
          endpoint: 'https://example.org/scanner',
          attempts: 5,
          successCount: 4,
          reachable: true,
          uptimePct: 80,
          successRatePct: 80,
          responseTimeMsMedian: 560,
        },
      ],
    })

    expect(entries.length).toBe(4)
    expect(entries.map((entry) => entry.tag1)).toEqual([
      'reachable',
      'uptime',
      'successRate',
      'responseTime',
    ])

    const uptime = entries.find((entry) => entry.tag1 === 'uptime')!
    expect(uptime.value).toBe(8000n)
    expect(uptime.valueDecimals).toBe(2)

    const responseTime = entries.find((entry) => entry.tag1 === 'responseTime')!
    expect(responseTime.value).toBe(560n)
    expect(responseTime.valueDecimals).toBe(0)
  })
})
