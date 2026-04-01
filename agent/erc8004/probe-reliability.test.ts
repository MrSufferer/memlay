/**
 * Tests for agent/erc8004/probe-reliability.ts
 *
 * Key behaviors to verify:
 * - All-fail: reachable=false, responseTimeMsMedian=undefined
 * - All-success: reachable=true, responseTimeMsMedian is a number
 * - Partial success: reachable=true (some successes), correct counts
 * - Timeout: AbortController fires, counts as failure
 * - POST + body: method and body forwarded to fetch
 * - Empty endpoints array: returns []
 * - Multiple endpoints: probed sequentially
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { probeEndpoint, probeReliability, type ProbeOptions } from './probe-reliability'
import type { ReliabilityEndpointConfig } from './types'

const SCANNER_ENDPOINT: ReliabilityEndpointConfig = {
  id: 'scanner',
  endpoint: 'https://example.org/scanner',
}

const MONITOR_ENDPOINT: ReliabilityEndpointConfig = {
  id: 'monitor',
  endpoint: 'https://example.org/monitor',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: { key: 'value' },
}

const DEFAULT_OPTIONS: Required<ProbeOptions> = {
  attempts: 5,
  timeoutMs: 10_000,
}

describe('probeReliability', () => {
  it('returns an empty array when given no endpoints', async () => {
    const results = await probeReliability([])
    expect(results).toEqual([])
  })

  it('probes multiple endpoints sequentially', async () => {
    const fetchMock = vi.spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }))

    const results = await probeReliability([SCANNER_ENDPOINT, MONITOR_ENDPOINT])

    expect(results).toHaveLength(2)
    expect(results[0].endpointId).toBe('scanner')
    expect(results[1].endpointId).toBe('monitor')

    // Sequential = 10 total calls (5 per endpoint)
    expect(fetchMock).toHaveBeenCalledTimes(10)
  })
})

describe('probeEndpoint', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // ── All fail ────────────────────────────────────────────────────────────────

  it('sets reachable=false when all attempts fail', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('Server Error', { status: 500 })
    )

    const result = await probeEndpoint(SCANNER_ENDPOINT, { attempts: 3, timeoutMs: 5_000 })

    expect(result.endpointId).toBe('scanner')
    expect(result.endpoint).toBe('https://example.org/scanner')
    expect(result.reachable).toBe(false)
    expect(result.successCount).toBe(0)
    expect(result.attempts).toBe(3)
    expect(result.uptimePct).toBe(0)
    expect(result.successRatePct).toBe(0)
    expect(result.responseTimeMsMedian).toBeUndefined()
  })

  // ── All succeed ─────────────────────────────────────────────────────────────

  it('sets reachable=true when all attempts succeed', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', { status: 200 })
    )

    const result = await probeEndpoint(SCANNER_ENDPOINT, DEFAULT_OPTIONS)

    expect(result.reachable).toBe(true)
    expect(result.successCount).toBe(5)
    expect(result.attempts).toBe(5)
    expect(result.uptimePct).toBe(100)
    expect(result.successRatePct).toBe(100)
    expect(typeof result.responseTimeMsMedian).toBe('number')
    expect(result.responseTimeMsMedian).toBeGreaterThanOrEqual(0)
  })

  // ── Partial success ────────────────────────────────────────────────────────

  it('computes correct counts for partial success', async () => {
    // 3 successes, 2 failures across 5 attempts
    let callCount = 0
    vi.spyOn(global, 'fetch').mockImplementation(() => {
      callCount++
      if (callCount <= 3) {
        return Promise.resolve(new Response('{}', { status: 200 }))
      }
      return Promise.resolve(new Response('Error', { status: 500 }))
    })

    const result = await probeEndpoint(SCANNER_ENDPOINT, DEFAULT_OPTIONS)

    expect(result.reachable).toBe(true) // at least one success
    expect(result.successCount).toBe(3)
    expect(result.attempts).toBe(5)
    expect(result.uptimePct).toBe(60)    // 3/5 * 100
    expect(result.successRatePct).toBe(60)
    expect(typeof result.responseTimeMsMedian).toBe('number')
  })

  // ── Timeout / AbortController ─────────────────────────────────────────────

  it('counts a timed-out request as failure and does not set responseTimeMsMedian', async () => {
    // Mock AbortController so that calling abort() synchronously rejects the fetch promise.
    // This bypasses real-time dependency without requiring vi.useFakeTimers().
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originalAbortController = global.AbortController as any
    let capturedReject: (e: Error) => void = () => {}

    vi.spyOn(global, 'AbortController' as keyof typeof global).mockImplementation(
      () => ({
        signal: { aborted: false, addEventListener: () => {} },
        abort: () => {
          capturedReject(new Error('The operation was aborted'))
        },
      }) as unknown as AbortController
    )

    vi.spyOn(global, 'fetch').mockImplementation(() => {
      return new Promise((_, reject) => {
        capturedReject = reject
      })
    })

    const result = await probeEndpoint(SCANNER_ENDPOINT, { attempts: 2, timeoutMs: 1_000 })

    expect(result.successCount).toBe(0)
    expect(result.reachable).toBe(false)
    expect(result.responseTimeMsMedian).toBeUndefined()
  })

  // ── POST + body forwarding ─────────────────────────────────────────────────

  it('forwards POST method and body to fetch', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 })
    )

    await probeEndpoint(MONITOR_ENDPOINT, { attempts: 1, timeoutMs: 5_000 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]

    expect(url).toBe('https://example.org/monitor')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(init.body).toBe('{"key":"value"}')
  })

  it('defaults to GET when method is not specified', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 })
    )

    await probeEndpoint(SCANNER_ENDPOINT, { attempts: 1, timeoutMs: 5_000 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('GET')
  })

  // ── Default options ────────────────────────────────────────────────────────

  it('uses 5 attempts and 10s timeout when options are empty', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 })
    )

    await probeEndpoint(SCANNER_ENDPOINT, {})

    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  // ── Zero attempts edge case ────────────────────────────────────────────────

  it('handles zero attempts gracefully', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 })
    )

    const result = await probeEndpoint(SCANNER_ENDPOINT, { attempts: 0, timeoutMs: 5_000 })

    expect(result.attempts).toBe(0)
    expect(result.successCount).toBe(0)
    expect(result.reachable).toBe(false)
    expect(result.uptimePct).toBe(0)
    expect(result.successRatePct).toBe(0)
    expect(result.responseTimeMsMedian).toBeUndefined()
  })

  // ── Network error ──────────────────────────────────────────────────────────

  it('counts network errors as failures (no response.ok)', async () => {
    let callCount = 0
    vi.spyOn(global, 'fetch').mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.reject(new Error('ENOTFOUND'))
      return Promise.resolve(new Response('{}', { status: 200 }))
    })

    const result = await probeEndpoint(SCANNER_ENDPOINT, { attempts: 2, timeoutMs: 5_000 })

    expect(result.successCount).toBe(1)
    expect(result.reachable).toBe(true)
    expect(typeof result.responseTimeMsMedian).toBe('number')
  })
})
