/**
 * OKX / X Layer — Arena Indexer
 *
 * Background service that polls X Layer Arena events to build a live
 * leaderboard with computed metrics (PnL, Sharpe, win rate, max drawdown).
 *
 * Features:
 *   - Polls `ReportTrade` events every 30s (configurable)
 *   - Maintains in-memory trade history per agent
 *   - Computes rolling Sharpe, win rate, max drawdown from trade history
 *   - Exposes HTTP endpoint for leaderboard + per-agent stats
 *   - Exposes getRecentPnL() for agent loop TradingContext wiring
 *
 * Usage:
 *   # Start as standalone service
 *   bun run agent/arena-indexer.ts
 *
 *   # Import for use in agent loop
 *   import { startArenaIndexer, getRecentPnL } from './okx/arena-indexer.js'
 */

import { createPublicClient, http } from 'viem'
import { xLayerTestnet } from 'viem/chains'
import {
  fetchXLayerArenaEvents,
  getXLayerLeaderboard,
  getXLayerAgentStats,
  type ArenaAgentStats,
  type TradeReportedEvent,
} from './okx/arena-client.js'

// ─── Config ────────────────────────────────────────────────────────────────────

const ARENA_ADDRESS = (process.env.X_LAYER_ARENA_ADDRESS ??
  '0x824af7339b4fFC04D0FD867953eCbfCc75dEAf18') as `0x${string}`
const RPC_URL = process.env.X_LAYER_RPC_URL ?? 'https://testrpc.xlayer.tech'
const RPC_URL_FALLBACK = 'https://xlayertestrpc.okx.com'
const POLL_INTERVAL_MS = Number(process.env.AGENT_INDEXER_POLL_INTERVAL_MS ?? 30_000)
const HTTP_PORT = Number(process.env.ARENA_INDEXER_PORT ?? 3_951)
const FROM_BLOCK = BigInt(process.env.ARENA_INDEXER_FROM_BLOCK ?? '1')
const MAX_RETRIES = 2

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TradeRecord {
  block: bigint
  timestamp: number
  pnlWei: bigint
  sharpeScaled: bigint
  drawdownAtTrade: bigint
}

export interface ComputedStats {
  wallet: `0x${string}`
  agentName: string
  cumulativePnLWei: bigint
  sharpeScaled: bigint         // rolling Sharpe × 1000
  maxDrawdownWei: bigint
  tradeCount: number
  wins: number
  losses: number
  winRate: number              // fraction 0–1
  isActive: boolean
  lastActivityBlock: bigint
  registeredAtBlock: bigint
  recentPnLWei: bigint         // last N trades sum (used in TradingContext)
}

export interface LeaderboardEntry extends ComputedStats {
  rank: number
}

// ─── State ─────────────────────────────────────────────────────────────────────

interface AgentState {
  trades: TradeRecord[]
  cumulativePnLWei: bigint
  sharpeScaled: bigint
  maxDrawdownWei: bigint
  winCount: number
  lossCount: number
  lastBlock: bigint
  onChainStats: ArenaAgentStats
}

const agentStates = new Map<string, AgentState>()
let lastIndexedBlock = FROM_BLOCK

// ─── Core Indexing ────────────────────────────────────────────────────────────

/**
 * Build a public client for the given RPC URL (with optional retry).
 * Returns { client, rpcUrl } so callers know which URL succeeded.
 */
async function getPublicClientWithFallback(
  primaryRpc: string,
  fallbackRpc: string,
  retries: number
): Promise<{ client: ReturnType<typeof createPublicClient>; rpcUrl: string }> {
  const urls = [primaryRpc, fallbackRpc]
  let lastError: unknown

  for (let attempt = 0; attempt < urls.length && attempt <= retries; attempt++) {
    const rpc = urls[Math.min(attempt, urls.length - 1)]
    const client = createPublicClient({
      chain: xLayerTestnet,
      transport: http(rpc),
    })
    try {
      // Probe with a lightweight call to verify the RPC is responsive
      await client.getBlockNumber()
      return { client, rpcUrl: rpc }
    } catch (err) {
      lastError = err
      console.warn(`[ArenaIndexer] RPC probe failed for ${rpc}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // All retries exhausted — return primary client anyway (indexNewEvents will report the error)
  return {
    client: createPublicClient({ chain: xLayerTestnet, transport: http(primaryRpc) }),
    rpcUrl: primaryRpc,
  }
}

/**
 * Poll new events from the Arena contract and update in-memory state.
 * Safe to call repeatedly — idempotent on event indexing.
 */
export async function indexNewEvents(): Promise<{
  newTrades: number
  newAgents: number
  errors: string[]
}> {
  const errors: string[] = []

  // Probe + select the best available RPC
  const { client: publicClient, rpcUrl } = await getPublicClientWithFallback(
    RPC_URL,
    RPC_URL_FALLBACK,
    MAX_RETRIES
  )

  let latestBlock: bigint
  try {
    latestBlock = await publicClient.getBlockNumber()
  } catch (err) {
    errors.push(`getBlockNumber failed (${rpcUrl}): ${err instanceof Error ? err.message : String(err)}`)
    return { newTrades: 0, newAgents: 0, errors }
  }

  if (latestBlock <= lastIndexedBlock) {
    return { newTrades: 0, newAgents: 0, errors }
  }

  let events
  try {
    events = await fetchXLayerArenaEvents(publicClient, ARENA_ADDRESS, lastIndexedBlock + 1n, latestBlock)
  } catch (err) {
    errors.push(`fetchXLayerArenaEvents failed (${rpcUrl}): ${err instanceof Error ? err.message : String(err)}`)
    return { newTrades: 0, newAgents: 0, errors }
  }

  let newTrades = 0
  let newAgents = 0

  // Process agent registrations
  for (const reg of events.agentRegistered) {
    const key = reg.wallet.toLowerCase()
    if (!agentStates.has(key)) {
      agentStates.set(key, {
        trades: [],
        cumulativePnLWei: 0n,
        sharpeScaled: 0n,
        maxDrawdownWei: 0n,
        winCount: 0,
        lossCount: 0,
        lastBlock: reg.block,
        onChainStats: {
          wallet: reg.wallet,
          agentName: reg.agentName,
          cumulativePnL: 0n,
          sharpeRatioScaled: 0n,
          maxDrawdown: 0n,
          tradeCount: 0n,
          wins: 0n,
          losses: 0n,
          lastActivityBlock: reg.block,
          registeredAt: reg.block,
          isActive: true,
          extraData: '0x' as any,
        },
      })
      newAgents++
    }
  }

  // Process trade reports
  for (const trade of events.tradeReported) {
    const key = trade.wallet.toLowerCase()
    if (!agentStates.has(key)) {
      // Agent not registered in memory yet — create placeholder
      agentStates.set(key, {
        trades: [],
        cumulativePnLWei: 0n,
        sharpeScaled: 0n,
        maxDrawdownWei: 0n,
        winCount: 0,
        lossCount: 0,
        lastBlock: trade.block,
        onChainStats: {
          wallet: trade.wallet,
          agentName: 'unknown',
          cumulativePnL: 0n,
          sharpeRatioScaled: 0n,
          maxDrawdown: 0n,
          tradeCount: 0n,
          wins: 0n,
          losses: 0n,
          lastActivityBlock: trade.block,
          registeredAt: 0n,
          isActive: true,
          extraData: '0x' as any,
        },
      })
      newAgents++
    }

    const state = agentStates.get(key)!
    const record: TradeRecord = {
      block: trade.block,
      timestamp: Date.now(),
      pnlWei: trade.pnl,
      sharpeScaled: trade.sharpeScaled,
      drawdownAtTrade: trade.drawdownAtTrade,
    }
    state.trades.push(record)
    state.cumulativePnLWei += trade.pnl

    // Update max drawdown
    if (trade.drawdownAtTrade < state.maxDrawdownWei) {
      state.maxDrawdownWei = trade.drawdownAtTrade
    }

    // Update win/loss count (vs. other agents in challenges — deferred to on-chain stats for now)
    state.lastBlock = trade.block

    // Rolling Sharpe: weighted average of sharpeScaled from individual reports
    const n = state.trades.length
    // Arena contract already computes rolling avg in reportTrade, use that as authoritative
    // But we can also compute our own from history
    const newAvg = computeRollingAvg(state.sharpeScaled, n - 1, trade.sharpeScaled)
    state.sharpeScaled = newAvg

    newTrades++
  }

  // Update on-chain leaderboard stats for all tracked agents (using same client as events)
  try {
    const onChainLeaderboard = await getXLayerLeaderboard(publicClient, ARENA_ADDRESS)
    for (const agent of onChainLeaderboard) {
      const key = agent.wallet.toLowerCase()
      if (agentStates.has(key)) {
        agentStates.get(key)!.onChainStats = agent
        // Use on-chain PnL as authoritative (the contract is the source of truth)
        // For recentPnL computation, use last 5 trades from our local history
      }
    }
  } catch (err) {
    errors.push(`getXLayerLeaderboard failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  lastIndexedBlock = latestBlock
  return { newTrades, newAgents, errors }
}

/** Rolling average: (oldAvg × (n-1) + newVal) / n */
function computeRollingAvg(currentAvg: bigint, n: number, newVal: bigint): bigint {
  if (n <= 0) return newVal
  return (currentAvg * BigInt(n) + newVal) / BigInt(n + 1)
}

// ─── Computed Stats ───────────────────────────────────────────────────────────

/**
 * Compute full stats for a tracked agent.
 * Uses on-chain cumulative PnL as authoritative; local history for Sharpe/recentPnL.
 */
export function computeStats(wallet: `0x${string}`): ComputedStats | null {
  const state = agentStates.get(wallet.toLowerCase())
  if (!state) return null

  const recentCount = 5
  const recentTrades = state.trades.slice(-recentCount)
  const recentPnLWei = recentTrades.reduce((sum, t) => sum + t.pnlWei, 0n)

  // Win/loss from on-chain stats (includes challenge outcomes)
  const wins = Number(state.onChainStats.wins)
  const losses = Number(state.onChainStats.losses)
  const tradeCount = state.trades.length
  const winRate = tradeCount > 0 ? wins / tradeCount : 0

  return {
    wallet,
    agentName: state.onChainStats.agentName,
    cumulativePnLWei: state.onChainStats.cumulativePnL,  // on-chain authoritative
    sharpeScaled: state.sharpeScaled,
    maxDrawdownWei: state.maxDrawdownWei,
    tradeCount,
    wins,
    losses,
    winRate: Math.round(winRate * 100) / 100,
    isActive: state.onChainStats.isActive,
    lastActivityBlock: state.onChainStats.lastActivityBlock,
    registeredAtBlock: state.onChainStats.registeredAt,
    recentPnLWei,
  }
}

/**
 * Get the recent PnL sum (last N trades) for an agent.
 * Used to wire `recentPnL` into TradingContext in the agent loop.
 */
export function getRecentPnL(wallet: `0x${string}`, lookbackTrades = 5): bigint {
  const state = agentStates.get(wallet.toLowerCase())
  if (!state) return 0n
  return state.trades
    .slice(-lookbackTrades)
    .reduce((sum, t) => sum + t.pnlWei, 0n)
}

/** Get all tracked agents sorted by cumulative PnL descending */
export function getLeaderboard(): LeaderboardEntry[] {
  const entries: LeaderboardEntry[] = []

  for (const [wallet, state] of agentStates) {
    const stats = computeStats(wallet as `0x${string}`)
    if (!stats) continue
    entries.push({
      ...stats,
      rank: 0, // assigned below after sort
    })
  }

  // Sort by cumulative PnL descending
  entries.sort((a, b) => {
    const aPnL = a.cumulativePnLWei < 0 ? a.cumulativePnLWei : a.cumulativePnLWei
    const bPnL = b.cumulativePnLWei < 0 ? b.cumulativePnLWei : b.cumulativePnLWei
    return aPnL > bPnL ? -1 : aPnL < bPnL ? 1 : 0
  })

  // Assign ranks
  entries.forEach((entry, i) => {
    entry.rank = i + 1
  })

  return entries
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

function startHttpServer(): void {
  NodeHttpServer()
  console.log(`[ArenaIndexer] HTTP server listening on port ${HTTP_PORT}`)
}

/** Bun-native HTTP server */
function BunServe(): any {
  // Dynamic import for Bun-specific API
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { serve } = require('bun')
  return serve({
    port: HTTP_PORT,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)

      if (url.pathname === '/leaderboard') {
        const entries = getLeaderboard()
        return Response.json({
          updatedAt: new Date().toISOString(),
          indexedBlock: lastIndexedBlock.toString(),
          agents: entries.map((e) => ({
            rank: e.rank,
            wallet: e.wallet,
            agentName: e.agentName,
            cumulativePnLWei: e.cumulativePnLWei.toString(),
            sharpeScaled: Number(e.sharpeScaled),
            maxDrawdownWei: e.maxDrawdownWei.toString(),
            tradeCount: e.tradeCount,
            wins: e.wins,
            losses: e.losses,
            winRate: e.winRate,
            isActive: e.isActive,
            recentPnLWei: e.recentPnLWei.toString(),
          })),
        })
      }

      if (url.pathname.startsWith('/stats/')) {
        const wallet = url.pathname.slice('/stats/'.length) as `0x${string}`
        const stats = computeStats(wallet)
        if (!stats) {
          return Response.json({ error: 'Agent not found' }, { status: 404 })
        }
        return Response.json({
          wallet: stats.wallet,
          agentName: stats.agentName,
          cumulativePnLWei: stats.cumulativePnLWei.toString(),
          sharpeScaled: Number(stats.sharpeScaled),
          maxDrawdownWei: stats.maxDrawdownWei.toString(),
          tradeCount: stats.tradeCount,
          wins: stats.wins,
          losses: stats.losses,
          winRate: stats.winRate,
          isActive: stats.isActive,
          lastActivityBlock: stats.lastActivityBlock.toString(),
          registeredAtBlock: stats.registeredAtBlock.toString(),
          recentPnLWei: stats.recentPnLWei.toString(),
        })
      }

      if (url.pathname === '/health') {
        return Response.json({
          status: 'ok',
          trackedAgents: agentStates.size,
          lastIndexedBlock: lastIndexedBlock.toString(),
        })
      }

      return Response.json(
        {
          service: 'ArenaIndexer',
          endpoints: ['/leaderboard', '/stats/:wallet', '/health'],
          arenaAddress: ARENA_ADDRESS,
          pollIntervalMs: POLL_INTERVAL_MS,
        },
        { status: 200 }
      )
    },
  })
}

/** Node.js fallback HTTP server */
function NodeHttpServer(): any {
  // Use Bun serve if available, otherwise import node:http
  const http = require('node:http')
  const server = http.createServer((req: any, res: any) => {
    const url = new URL(req.url, 'http://localhost')

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Content-Type', 'application/json')

    try {
      if (url.pathname === '/leaderboard') {
        const entries = getLeaderboard()
        res.end(
          JSON.stringify({
            updatedAt: new Date().toISOString(),
            indexedBlock: lastIndexedBlock.toString(),
            agents: entries.map((e) => ({
              rank: e.rank,
              wallet: e.wallet,
              agentName: e.agentName,
              cumulativePnLWei: e.cumulativePnLWei.toString(),
              sharpeScaled: Number(e.sharpeScaled),
              maxDrawdownWei: e.maxDrawdownWei.toString(),
              tradeCount: e.tradeCount,
              wins: e.wins,
              losses: e.losses,
              winRate: e.winRate,
              isActive: e.isActive,
              recentPnLWei: e.recentPnLWei.toString(),
            })),
          })
        )
        return
      }

      if (url.pathname.startsWith('/stats/')) {
        const wallet = url.pathname.slice('/stats/'.length) as `0x${string}`
        const stats = computeStats(wallet)
        if (!stats) {
          res.statusCode = 404
          res.end(JSON.stringify({ error: 'Agent not found' }))
          return
        }
        res.end(
          JSON.stringify({
            wallet: stats.wallet,
            agentName: stats.agentName,
            cumulativePnLWei: stats.cumulativePnLWei.toString(),
            sharpeScaled: Number(stats.sharpeScaled),
            maxDrawdownWei: stats.maxDrawdownWei.toString(),
            tradeCount: stats.tradeCount,
            wins: stats.wins,
            losses: stats.losses,
            winRate: stats.winRate,
            isActive: stats.isActive,
            recentPnLWei: stats.recentPnLWei.toString(),
          })
        )
        return
      }

      if (url.pathname === '/health') {
        res.end(
          JSON.stringify({
            status: 'ok',
            trackedAgents: agentStates.size,
            lastIndexedBlock: lastIndexedBlock.toString(),
          })
        )
        return
      }

      res.statusCode = 200
      res.end(
        JSON.stringify({
          service: 'ArenaIndexer',
          endpoints: ['/leaderboard', '/stats/:wallet', '/health'],
          arenaAddress: ARENA_ADDRESS,
          pollIntervalMs: POLL_INTERVAL_MS,
        })
      )
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(err) }))
    }
  })

  server.listen(HTTP_PORT, () => {
    console.log(`[ArenaIndexer] HTTP server listening on port ${HTTP_PORT}`)
  })
  return server
}

// ─── Polling Loop ─────────────────────────────────────────────────────────────

let pollingActive = false

async function pollOnce(): Promise<void> {
  const result = await indexNewEvents()
  if (result.newTrades > 0 || result.newAgents > 0) {
    console.log(
      `[ArenaIndexer] Indexed ${result.newTrades} new trades, ${result.newAgents} new agents ` +
        `(block ${lastIndexedBlock.toString()})`
    )
  }
  if (result.errors.length > 0) {
    for (const err of result.errors) {
      console.warn(`[ArenaIndexer] Warning: ${err}`)
    }
  }
}

async function startPolling(): Promise<void> {
  if (pollingActive) return
  pollingActive = true

  // Do a first immediate poll to catch up
  await pollOnce()

  setInterval(async () => {
    if (!pollingActive) return
    await pollOnce()
  }, POLL_INTERVAL_MS)
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the arena indexer: begins polling and starts HTTP server.
 * Call once at application startup.
 */
export async function startArenaIndexer(): Promise<void> {
  console.log(`[ArenaIndexer] Starting — Arena: ${ARENA_ADDRESS}`)
  console.log(`[ArenaIndexer] RPC: ${RPC_URL} | Poll interval: ${POLL_INTERVAL_MS}ms`)
  console.log(`[ArenaIndexer] HTTP port: ${HTTP_PORT} | From block: ${FROM_BLOCK.toString()}`)

  // Start HTTP server
  startHttpServer()

  // Start polling
  await startPolling()
}

/**
 * Stop the indexer polling loop.
 */
export function stopArenaIndexer(): void {
  pollingActive = false
  console.log('[ArenaIndexer] Stopped')
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  startArenaIndexer()
    .then(() => {
      console.log('[ArenaIndexer] Running. Press Ctrl+C to stop.')
    })
    .catch((err) => {
      console.error(`[ArenaIndexer] Fatal: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    })

  // Graceful shutdown
  process.on('SIGINT', () => {
    stopArenaIndexer()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    stopArenaIndexer()
    process.exit(0)
  })
}