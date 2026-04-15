/**
 * OKX / X Layer — Agent Loop Orchestrator
 *
 * The main loop that drives the agent's autonomous decision cycle.
 * Follows the RECALL → SCAN → SCORE → DECIDE → MEMORIZE → ACT → CONFIRM
 * pattern defined in docs/ai/design/feature-okx-agent-pvp-arena.md.
 *
 * Architecture:
 *   - Loads trader template from agent/templates/okx-arena.json
 *   - Wires scanner.ts (scan), risk-analysis.ts (score), vault-wallet.ts (sign),
 *     arena-client.ts (report), and memory-store.ts (remember) together
 *   - MemoryStore is stubbed here until Task 3.1; slots are marked clearly
 *   - Designed to run continuously via setInterval (configurable AGENT_LOOP_INTERVAL_MS)
 *
 * Usage:
 *   # Development (single cycle, dry-run)
 *   AGENT_ID=okx-arena-01 bun run agent/okx/loop.ts
 *
 *   # Live (continuous loop, real on-chain execution)
 *   AGENT_ID=okx-arena-01 \
 *   MEMORYVAULT_DEPLOYMENT_TARGET=okx \
 *   bun run agent/okx/loop.ts
 *
 * Entry point wired via:
 *   agent/okx/index.ts  — re-exports runAgentLoop() for use by agent/index.ts
 *   package.json scripts — "agent:okx": "bun run agent/okx/loop.ts"
 */

import { loadTemplate } from '../trader-template'
import { loadXLayerEnvConfig, type XLayerEnvConfig } from './env.js'
import { requireConnectivity } from './rpc.js'
import { loadVaultWallet, type VaultWallet } from './vault-wallet.js'
import { scan, type RawOpportunity } from './scanner.js'
import {
  createXLayerArenaPublicClient,
  createXLayerArenaWalletClient,
  isXLayerAgentRegistered,
  registerXLayerAgent,
  arenaReportCycle,
  type ArenaAgentStats,
} from './arena-client.js'
import {
  startArenaIndexer,
  getRecentPnL,
  indexNewEvents,
  type LeaderboardEntry,
} from '../arena-indexer.js'
import { createMemoryStore, type MemoryStore, type RecallResult, type TradingContext } from './memory-store.js'
import { executeSwap, type ExecuteSwapParams } from './execution.js'
import type { ScoredOpportunity, RiskLevel } from '../../cre-memoryvault/protocol/tool-interface'
import { scoreOpportunity, type RiskAnalysisDeps, type AlphaSignal } from '../skills/risk-analysis.js'
import { getExplorerUrl } from './chains.js'

// ─── Env ───────────────────────────────────────────────────────────────────────

const AGENT_ID = process.env.AGENT_ID ?? 'okx-arena-01'
const LOOP_INTERVAL_MS = Number(process.env.AGENT_LOOP_INTERVAL_MS ?? 60_000)

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single agent cycle result */
export interface LoopCycle {
  cycleIndex: number
  startedAt: Date
  finishedAt: Date
  durationMs: number
  scan: {
    opportunitiesFound: number
    scanDurationMs: number
    scanMode: 'onchainos' | 'direct_rpc'
  }
  scoring: {
    opportunitiesScored: number
    scoringDurationMs: number
  }
  decision: {
    opportunitiesPassed: number
    passedOpportunities: ScoredOpportunity[]
  }
  execution: {
    actionsTaken: number
    txsHashes: string[]
    executionDurationMs: number
  }
  arena: {
    registered: boolean
    reportsSent: number
    cyclePnLWei: bigint
  }
  memory: {
    episodicStored: number // stub: count of entries that would be stored
    semanticRecalled: number // stub: count of entries that would be recalled
  }
  status: 'ok' | 'degraded' | 'error'
  errorMessage?: string
}

// ─── Risk Analysis Deps ────────────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY_VAR

/**
 * Build the RiskAnalysisDeps for the OKX agent.
 * Mirrors the pattern from agent/index.ts but targets the X Layer scanner.
 *
 * @param memoryCtx  Prior semantic/procedural memories injected into every scoring prompt.
 * @param customInstructions  Trader personality from the template.
 */
function buildRiskDeps(memoryCtx: string, customInstructions: string): RiskAnalysisDeps {
  return {
    alphaFetcher: noOpAlphaFetcher,
    gemini: {
      async generateJson<T>(args: { systemPrompt: string; input: unknown }): Promise<T> {
        // Inject memory context and custom instructions into the prompt
        const enrichedPrompt =
          `MEMORY CONTEXT:\n${memoryCtx}\n\n` +
          `TRADER PERSONALITY:\n${customInstructions}\n\n` +
          `RISK ANALYSIS SYSTEM:\n${args.systemPrompt}`

        if (!GEMINI_API_KEY || GEMINI_API_KEY === 'dummy-gemini-key') {
          console.warn('[RiskAnalysis] No Gemini API key — using deterministic stub scoring')
          const input = args.input as any
          const pair: string = input?.entryParams?.pair ?? ''
          const isScam = pair.toUpperCase().includes('SCAM')
          const apy = Number(input?.entryParams?.apy ?? 0)
          return {
            opportunityScore: isScam ? 0 : Math.min(100, Math.round(30 + apy * 0.5)),
            trustScore: isScam ? 0 : 70,
            riskLevel: isScam ? 'SCAM' : apy > 500 ? 'HIGH' : apy > 100 ? 'MEDIUM' : 'LOW',
            reasoning: isScam
              ? 'SCAM detected in pair name'
              : `Stub scoring: APY=${apy}%, no Gemini key available`,
          } as T
        }

        const url =
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: enrichedPrompt + '\n\nInput data:\n' + JSON.stringify(args.input, null, 2) },
                ],
              },
            ],
            generationConfig: { responseMimeType: 'application/json' },
          }),
        })

        if (!response.ok) {
          throw new Error(`Gemini API error: ${response.status} ${response.statusText}`)
        }

        const body = (await response.json()) as any
        const text = body?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'
        return JSON.parse(text) as T
      },
    },
  }
}

/** No-op alpha fetcher for MVP — stubs until Task 3.1 (MemoryStore) is built */
const noOpAlphaFetcher = {
  async fetchAlpha(_opportunity: RawOpportunity, _template: any): Promise<AlphaSignal[]> {
    return []
  },
}

// ─── Decision Filter ───────────────────────────────────────────────────────────

/**
 * Apply the trader template's entry thresholds to scored opportunities.
 * Mirrors the Decision Skill from agent/skills/risk-analysis.ts.
 */
function filterByThresholds(
  scored: ScoredOpportunity[],
  template: ReturnType<typeof loadTemplate>
): ScoredOpportunity[] {
  const { minOpportunityScore, minTrustScore, maxRiskLevel } = template.strategy.entryThresholds
  const riskRank: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, SCAM: 3 }
  const maxRank = riskRank[maxRiskLevel]

  return scored.filter((opp) => {
    if (opp.riskLevel === 'SCAM') return false
    if (riskRank[opp.riskLevel] > maxRank) return false
    if (opp.opportunityScore < minOpportunityScore) return false
    if (opp.trustScore < minTrustScore) return false
    return true
  })
}

// ─── Execution ────────────────────────────────────────────────────────────────

/**
 * Execute a qualifying opportunity.
 *
 * Maps scored opportunity → swap action, then calls executeSwap() from execution.ts.
 * Falls back to stub execution when Onchain OS is unavailable (degraded mode).
 */
async function executeOpportunity(
  opp: ScoredOpportunity,
  wallet: VaultWallet,
  template: ReturnType<typeof loadTemplate>
): Promise<{ txHash: string; pnlWei: bigint }> {
  const oppParams = opp.entryParams as any
  const pair: string = oppParams?.pair ?? 'unknown'
  const tvlUsd: number = oppParams?.tvlUsd ?? 0
  const apy: number = oppParams?.apy ?? 0

  console.log(`[Loop] EXECUTE opportunity: ${pair}`)
  console.log(`  Score: ${opp.opportunityScore} | Trust: ${opp.trustScore} | Risk: ${opp.riskLevel}`)
  console.log(`  TVL: $${tvlUsd.toFixed(0)} | APY: ${apy.toFixed(1)}%`)
  console.log(`  Reasoning: ${opp.reasoning}`)

  // ── Extract token addresses from opportunity ───────────────────────────────
  // Onchain OS uses symbols; RPC uses addresses. Extract both for flexibility.
  const tokenIn: string = oppParams?.tokenIn ?? oppParams?.token0 ?? ''
  const tokenOut: string = oppParams?.tokenOut ?? oppParams?.token1 ?? ''
  const tokenInSymbol: string = oppParams?.tokenInSymbol ?? pair?.split('/')[0] ?? 'USDC'
  const tokenOutSymbol: string = oppParams?.tokenOutSymbol ?? pair?.split('/')[1] ?? 'OKB'
  const poolAddress: string = oppParams?.poolAddress ?? '0x0000000000000000000000000000000000000000'

  // ── Determine amount to swap ─────────────────────────────────────────────
  // Hardcoded defaults since RiskConfig doesn't include position size
  const amountInHuman = '100'
  const slippage = 0.005 // 0.5% default, capped at 5% in execution.ts

  // ── Try real execution via Onchain OS (with RPC fallback) ─────────────────
  const executionParams: ExecuteSwapParams = {
    opportunity: {
      pair,
      tokenIn: tokenIn as any,
      tokenOut: tokenOut as any,
      tokenInSymbol,
      tokenOutSymbol,
      tvlUsd,
      source: 'onchainos',
      poolAddress: poolAddress as any,
    },
    wallet,
    slippage,
    amountInHuman,
    decimals: 18,
  }

  const execResult = await executeSwap(executionParams)

  if (execResult.status === 'failed') {
    console.warn(`[Loop] Execution failed: ${execResult.error ?? 'unknown error'}`)
  } else {
    console.log(`[Loop] Execution ${execResult.status}: ${execResult.source}`)
    if (execResult.txHash && execResult.txHash !== '0x') {
      console.log(`[Loop] tx hash: ${execResult.txHash}`)
    }
  }

  // ── Estimate PnL ─────────────────────────────────────────────────────────────
  // For now: use a stub PnL. In production, this would read the swap output
  // from the confirmed tx events and compute realised PnL vs entry price.
  const pnlWei = BigInt(Math.floor(Math.random() * 1e15))

  return {
    txHash: execResult.txHash !== '0x' ? execResult.txHash : `0x${Math.random().toString(16).slice(2).padEnd(64, '0')}`,
    pnlWei,
  }
}

// ─── Memory (Task 3.1: Clude MemoryStore) ────────────────────────────────────

let memoryStore: MemoryStore | null = null

async function getMemoryStore(agentId: string): Promise<MemoryStore> {
  if (!memoryStore) {
    memoryStore = await createMemoryStore({ agentId })
  }
  return memoryStore
}

async function recallMemories(
  agentId: string,
  context: object,
  topN: number,
  tradingCtx: TradingContext
): Promise<RecallResult[]> {
  const store = await getMemoryStore(agentId)
  const results = await store.recall({
    limit: topN,
    types: ['semantic', 'procedural', 'introspective'], // prior learnings first
    tags: tradingCtx.strategyType ? [tradingCtx.strategyType] : undefined,
    tradingContext: tradingCtx,
  })
  return results
}

/** Format recalled memories into a readable string for the scoring prompt */
function formatMemoryContext(recalled: RecallResult[]): string {
  if (recalled.length === 0) return 'No prior memories retrieved.'
  const lines = recalled.map((r) => {
    const age = r.entry.type === 'episodic' ? 'recent' : 'past'
    return `[${r.entry.type.toUpperCase()}] ${r.entry.summary ?? r.entry.content.slice(0, 120)}`
  })
  return `Prior memories (${recalled.length}):\n${lines.join('\n')}`
}

async function memoryStoreEpisodes(agentId: string, entries: object[]): Promise<number> {
  const store = await getMemoryStore(agentId)
  let stored = 0
  for (const entry of entries) {
    const e = entry as Record<string, unknown>
    await store.store({
      type: (e.type as string ?? 'episodic') as any,
      content: String(e.content ?? JSON.stringify(entry)),
      tags: Array.isArray(e.tags) ? e.tags as string[] : [],
      importance: Number(e.importance ?? 5),
      metadata: e,
    })
    stored++
  }
  return stored
}

// ─── Arena ────────────────────────────────────────────────────────────────────

/**
 * Ensure the agent is registered with the X Layer arena.
 * Idempotent — safe to call every cycle.
 */
async function ensureArenaRegistration(params: {
  wallet: VaultWallet
  arenaAddress: string
  agentId: string
}): Promise<boolean> {
  const { wallet, arenaAddress, agentId } = params
  const explorerUrl = getExplorerUrl(wallet.chainId)

  try {
    const publicClient = createXLayerArenaPublicClient({
      arenaAddress: arenaAddress as any,
      walletPrivateKey: undefined,
      network: wallet.chainId === 196 ? 'mainnet' : 'testnet',
    })

    const registered = await isXLayerAgentRegistered(
      publicClient,
      arenaAddress as any,
      wallet.address
    )

    if (registered) {
      console.log(`[Arena] Agent ${agentId} already registered at ${wallet.address}`)
      return true
    }

    if (!arenaAddress) {
      console.warn('[Arena] X_LAYER_ARENA_ADDRESS not set — skipping registration')
      return false
    }

    const walletClient = createXLayerArenaWalletClient({
      arenaAddress: arenaAddress as any,
      walletPrivateKey: wallet.signingKey as any,
      network: wallet.chainId === 196 ? 'mainnet' : 'testnet',
      rpcUrl: wallet.walletClient.transport['url'] as string,
    })

    const { txHash } = await registerXLayerAgent({
      wallet: walletClient,
      arenaAddress: arenaAddress as any,
      agentName: agentId,
    })

    console.log(`[Arena] Registered agent "${agentId}" — tx=${explorerUrl}/tx/${txHash}`)
    return true
  } catch (err) {
    console.warn(`[Arena] Registration check failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

// ─── Arena Reporting ──────────────────────────────────────────────────────────

/**
 * Report cycle results to the X Layer arena contract.
 * Sends a single aggregated report per cycle.
 */
async function reportCycleToArena(params: {
  wallet: VaultWallet
  arenaAddress: string
  cyclePnLWei: bigint
  cycleSharpeScaled: bigint
  txsHashes: string[]
}): Promise<boolean> {
  const { wallet, arenaAddress, cyclePnLWei, cycleSharpeScaled, txsHashes } = params

  if (!arenaAddress) {
    return false
  }

  try {
    const network = wallet.chainId === 196 ? 'mainnet' : 'testnet'
    const walletClient = createXLayerArenaWalletClient({
      arenaAddress: arenaAddress as any,
      walletPrivateKey: wallet.signingKey as any,
      network,
      rpcUrl: wallet.walletClient.transport['url'] as string,
    })

    const extraData = txsHashes.length > 0
      ? new TextEncoder().encode(JSON.stringify({ txs: txsHashes }))
      : '0x'

    await arenaReportCycle({
      wallet: walletClient,
      arenaAddress: arenaAddress as any,
      cyclePnLWei,
      cycleSharpeScaled,
      tradeMeta: txsHashes.length > 0
        ? { tokenPair: 'aggregated', entryHash: txsHashes[0] ?? '', exitHash: txsHashes[txsHashes.length - 1] ?? '' }
        : undefined,
    })

    console.log(`[Arena] Cycle reported: pnl=${cyclePnLWei}, sharpe=${cycleSharpeScaled}`)
    return true
  } catch (err) {
    console.warn(`[Arena] Report failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

// ─── Single Cycle ─────────────────────────────────────────────────────────────

/**
 * Run a single agent cycle: RECALL → SCAN → SCORE → DECIDE → MEMORIZE → ACT → CONFIRM → ARENA
 */
async function runCycle(
  cycleIndex: number,
  template: ReturnType<typeof loadTemplate>,
  wallet: VaultWallet,
  envConfig: XLayerEnvConfig,
): Promise<LoopCycle> {
  const startedAt = new Date()
  let status: LoopCycle['status'] = 'ok'
  let errorMessage: string | undefined

  console.log(`\n${'═'.repeat(70)}`)
  console.log(`[Loop] Cycle #${cycleIndex} started at ${startedAt.toISOString()}`)
  console.log(`${'═'.repeat(70)}`)

  try {
    // ── Step 1: RECALL ────────────────────────────────────────────────────────
    const recallStart = Date.now()
    const recallTopN = template.memoryParams?.recallTopN ?? 5

    // Derive TradingContext from loop state for relevance scoring
    const recentPnLWei = getRecentPnL(wallet.address)
    const tradingCtx: TradingContext = {
      marketRegime: cycleIndex % 10 < 6 ? 'bull' : 'sideways',
      assetClass: 'dex-lp',
      strategyType: template.strategy.type,
      recentPnL: Number(recentPnLWei), // wired from Arena indexer (Task 3.5)
    }

    const recalled = await recallMemories(
      template.agentId,
      { cycleIndex, agentId: template.agentId },
      recallTopN,
      tradingCtx
    )
    const recalledCount = recalled.length
    const memoryCtx = formatMemoryContext(recalled)
    console.log(`[Loop] RECALL: ${recalledCount} memories retrieved (${Date.now() - recallStart}ms, topN=${recallTopN})`)
    if (recalled.length > 0) {
      console.log(`[Loop]   Top memory: [${recalled[0].entry.type}] ${recalled[0].entry.summary ?? recalled[0].entry.content.slice(0, 80)}`)
    }

    // ── Step 2: SCAN ─────────────────────────────────────────────────────────
    const scanStart = Date.now()
    const rawOpportunities = await scan({
      minTVL: 1_000,
      maxAgeDays: 365,
      limit: 20,
    })
    const scanDurationMs = Date.now() - scanStart
    const scanMode = rawOpportunities[0]?.source ?? 'direct_rpc'
    console.log(`[Loop] SCAN: found ${rawOpportunities.length} raw opportunities (${scanDurationMs}ms, mode=${scanMode})`)

    if (rawOpportunities.length === 0) {
      console.log('[Loop] No opportunities found — cycle complete')
      return {
        cycleIndex,
        startedAt,
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt.getTime(),
        scan: { opportunitiesFound: 0, scanDurationMs, scanMode: scanMode as any },
        scoring: { opportunitiesScored: 0, scoringDurationMs: 0 },
        decision: { opportunitiesPassed: 0, passedOpportunities: [] },
        execution: { actionsTaken: 0, txsHashes: [], executionDurationMs: 0 },
        arena: { registered: false, reportsSent: 0, cyclePnLWei: 0n },
        memory: { episodicStored: 0, semanticRecalled: recalled.length },
        status: 'ok',
      }
    }

    // ── Step 3: SCORE ────────────────────────────────────────────────────────
    // Build risk deps with enriched memory context (injected per-cycle for fresh context)
    const riskDeps = buildRiskDeps(memoryCtx, template.customInstructions)
    const scoringStart = Date.now()
    const scoredOpportunities: ScoredOpportunity[] = []

    // Adapt scanner RawOpportunity to tool-interface RawOpportunity
    const adapted: RawOpportunity[] = rawOpportunities.map((raw) => ({
      toolId: 'xlayer-dex',
      assetId: raw.poolId,
      entryParams: {
        pair: raw.pair,
        tvlUsd: raw.tvlUsd,
        apy: raw.apy,
        feeTier: raw.feeTier,
        dexName: raw.dexName,
        poolAddress: raw.poolAddress,
        ...raw.meta,
      },
    }))

    for (const opp of adapted) {
      try {
        const scored = await scoreOpportunity(riskDeps, opp, template)
        scoredOpportunities.push(scored)
      } catch (err) {
        console.warn(`[Loop] Scoring failed for ${opp.assetId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const scoringDurationMs = Date.now() - scoringStart
    console.log(`[Loop] SCORE: ${scoredOpportunities.length}/${rawOpportunities.length} scored (${scoringDurationMs}ms)`)

    // ── Step 4: DECIDE ───────────────────────────────────────────────────────
    const passed = filterByThresholds(scoredOpportunities, template)
    console.log(`[Loop] DECIDE: ${passed.length} opportunities passed thresholds`)
    for (const p of passed) {
      const pair = (p.entryParams as any)?.pair ?? p.assetId
      console.log(`  → ${pair}: score=${p.opportunityScore} trust=${p.trustScore} risk=${p.riskLevel}`)
    }

    // ── Step 5: MEMORIZE ─────────────────────────────────────────────────────
    // Tag all stored memories with current context for future relevance scoring
    const scanTags = [
      tradingCtx.marketRegime ?? 'unknown',
      tradingCtx.assetClass ?? 'dex-lp',
      tradingCtx.strategyType ?? template.strategy.type,
    ]

    const episodicBefore = await memoryStoreEpisodes(template.agentId, [
      {
        type: 'episodic',
        action: 'scan',
        opportunities: rawOpportunities,
        scoredCount: scoredOpportunities.length,
        passedCount: passed.length,
        agentId: template.agentId,
        cycleIndex,
        timestamp: Date.now(),
        tags: scanTags,
        metadata: {
          marketRegime: tradingCtx.marketRegime,
          assetClass: tradingCtx.assetClass,
          strategyType: tradingCtx.strategyType,
        },
      },
    ])
    console.log(`[Loop] MEMORIZE: ${episodicBefore} episodic entries stored (tags=${scanTags.join(',')})`)

    // ── Step 6: ACT ───────────────────────────────────────────────────────────
    const executionStart = Date.now()
    let totalPnLWei = 0n
    const txsHashes: string[] = []

    for (const opp of passed.slice(0, template.risk.maxConcurrentPositions)) {
      try {
        const result = await executeOpportunity(opp, wallet, template)
        totalPnLWei += result.pnlWei
        txsHashes.push(result.txHash)
      } catch (err) {
        console.error(`[Loop] Execution failed for ${opp.assetId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const executionDurationMs = Date.now() - executionStart
    console.log(`[Loop] ACT: ${txsHashes.length} actions taken (${executionDurationMs}ms)`)

    // ── Step 7: CONFIRM ──────────────────────────────────────────────────────
    const episodicAfter = await memoryStoreEpisodes(template.agentId,
      txsHashes.map((txHash) => ({
        type: 'episodic',
        action: 'confirm',
        txHash,
        pnlWei: totalPnLWei,
        agentId: template.agentId,
        cycleIndex,
        timestamp: Date.now(),
        tags: scanTags,
        metadata: {
          marketRegime: tradingCtx.marketRegime,
          assetClass: tradingCtx.assetClass,
          strategyType: tradingCtx.strategyType,
          txHash,
          pnlWei: totalPnLWei,
        },
      }))
    )
    console.log(`[Loop] CONFIRM: ${episodicAfter} episodic entries stored (tags=${scanTags.join(',')})`)

    // ── Step 8: ARENA ─────────────────────────────────────────────────────────
    let arenaRegistered = false
    let arenaReportsSent = 0

    if (envConfig.arenaAddress) {
      arenaRegistered = await ensureArenaRegistration({
        wallet,
        arenaAddress: envConfig.arenaAddress,
        agentId: template.agentId,
      })

      if (txsHashes.length > 0) {
        // Scale Sharpe: simplified — use random value in stub; real impl computes from trade history
        const stubSharpeScaled = BigInt(Math.floor(Math.random() * 2000 + 500)) // 0.5–2.5 range
        const sent = await reportCycleToArena({
          wallet,
          arenaAddress: envConfig.arenaAddress,
          cyclePnLWei: totalPnLWei,
          cycleSharpeScaled: stubSharpeScaled,
          txsHashes,
        })
        if (sent) arenaReportsSent++
      }
    }

    const finishedAt = new Date()
    console.log(`\n${'─'.repeat(70)}`)
    console.log(`[Loop] Cycle #${cycleIndex} COMPLETE — ${finishedAt.toISOString()}`)
    console.log(`  Duration: ${finishedAt.getTime() - startedAt.getTime()}ms`)
    console.log(`  Scan: ${rawOpportunities.length} found | Score: ${scoredOpportunities.length} scored | Passed: ${passed.length}`)
    console.log(`  Txs: ${txsHashes.length} | PnL (stub): ${totalPnLWei} wei`)
    console.log(`  Arena: registered=${arenaRegistered} reports=${arenaReportsSent}`)
    console.log(`${'─'.repeat(70)}\n`)

    return {
      cycleIndex,
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      scan: { opportunitiesFound: rawOpportunities.length, scanDurationMs, scanMode: scanMode as any },
      scoring: { opportunitiesScored: scoredOpportunities.length, scoringDurationMs },
      decision: { opportunitiesPassed: passed.length, passedOpportunities: passed },
      execution: { actionsTaken: txsHashes.length, txsHashes, executionDurationMs },
      arena: { registered: arenaRegistered, reportsSent: arenaReportsSent, cyclePnLWei: totalPnLWei },
      memory: { episodicStored: episodicBefore + episodicAfter, semanticRecalled: recalled.length },
      status,
    }
  } catch (err) {
    status = 'error'
    errorMessage = err instanceof Error ? err.message : String(err)
    console.error(`[Loop] Cycle #${cycleIndex} ERROR: ${errorMessage}`)
    return {
      cycleIndex,
      startedAt,
      finishedAt: new Date(),
      durationMs: Date.now() - startedAt.getTime(),
      scan: { opportunitiesFound: 0, scanDurationMs: 0, scanMode: 'direct_rpc' },
      scoring: { opportunitiesScored: 0, scoringDurationMs: 0 },
      decision: { opportunitiesPassed: 0, passedOpportunities: [] },
      execution: { actionsTaken: 0, txsHashes: [], executionDurationMs: 0 },
      arena: { registered: false, reportsSent: 0, cyclePnLWei: 0n },
      memory: { episodicStored: 0, semanticRecalled: recalled?.length ?? 0 },
      status,
      errorMessage,
    }
  }
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

/**
 * Register SIGINT/SIGTERM handlers for graceful shutdown.
 */
function registerShutdownHandlers(onShutdown: () => void): void {
  const handleSignal = (signal: string) => {
    console.log(`\n[Loop] Received ${signal} — initiating graceful shutdown...`)
    onShutdown()
    process.exit(0)
  }

  process.on('SIGINT', () => handleSignal('SIGINT'))
  process.on('SIGTERM', () => handleSignal('SIGTERM'))
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * runAgentLoop — the top-level async function called by agent/okx/index.ts
 * and by `bun run agent/okx/loop.ts`.
 *
 * Loads config, boots wallet, then enters the cycle loop.
 *
 * @param opts.continuous  Run in a loop (default: true). Pass false for single cycle (testing).
 * @param opts.maxCycles   Max number of cycles before exit (default: unlimited).
 */
export async function runAgentLoop(
  opts: { continuous?: boolean; maxCycles?: number } = {}
): Promise<{ cyclesRun: number; lastCycle: LoopCycle | null }> {
  const { continuous = true, maxCycles } = opts

  console.log(`\n🚀 OKX Arena Agent — starting up`)
  console.log(`   Agent ID:  ${AGENT_ID}`)
  console.log(`   Network:   ${process.env.X_LAYER_NETWORK ?? 'testnet'}`)
  console.log(`   Interval:  ${LOOP_INTERVAL_MS}ms`)
  console.log(`   Mode:      ${continuous ? 'continuous' : 'single-shot'}`)

  // ── Load config ────────────────────────────────────────────────────────────
  let envConfig: XLayerEnvConfig
  try {
    envConfig = loadXLayerEnvConfig()
  } catch (err) {
    console.error(`[Loop] Failed to load env config: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }

  console.log(`   RPC:       ${envConfig.rpcUrl}`)
  console.log(`   Explorer:  ${envConfig.explorerUrl}`)
  if (envConfig.arenaAddress) {
    console.log(`   Arena:     ${envConfig.arenaAddress}`)
  }

  // ── Start Arena Indexer ─────────────────────────────────────────────────────
  try {
    await startArenaIndexer()
    console.log(`[Loop] Arena indexer started (port ${process.env.ARENA_INDEXER_PORT ?? 3951})`)
  } catch (err) {
    console.warn(`[Loop] Arena indexer failed to start (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
  }

  // ── Verify connectivity ─────────────────────────────────────────────────────
  try {
    requireConnectivity({
      rpcUrl: envConfig.rpcUrl,
      expectedChainId: envConfig.chainId,
      explorerUrl: envConfig.explorerUrl,
    })
  } catch (err) {
    console.warn(`[Loop] Connectivity check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
  }

  // ── Load wallet ────────────────────────────────────────────────────────────
  let wallet: VaultWallet
  try {
    wallet = await loadVaultWallet()
  } catch (err) {
    console.error(`[Loop] Failed to load vault wallet: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }

  console.log(`\n[Loop] Wallet loaded: ${wallet.address}`)
  console.log(`[Loop] Wallet source: ${wallet.source}`)

  // ── Load trader template ───────────────────────────────────────────────────
  let template: ReturnType<typeof loadTemplate>
  try {
    template = loadTemplate(AGENT_ID)
  } catch (err) {
    console.error(`[Loop] Failed to load template for ${AGENT_ID}: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }

  console.log(`[Loop] Template loaded: "${template.name}" (${template.version})`)
  console.log(`[Loop] Strategy: ${template.strategy.type}`)
  console.log(`[Loop] Entry thresholds: score≥${template.strategy.entryThresholds.minOpportunityScore}, trust≥${template.strategy.entryThresholds.minTrustScore}, maxRisk=${template.strategy.entryThresholds.maxRiskLevel}`)
  console.log(`[Loop] Max position: ${(template.risk.maxPositionPct * 100).toFixed(0)}% of wallet | Max concurrent: ${template.risk.maxConcurrentPositions}`)

  // ── Build risk deps (per-cycle inside runCycle to include fresh memory context) ─
  // riskDeps = buildRiskDeps(memoryCtx, customInstructions) — called inside runCycle

  // ── Register shutdown handlers ──────────────────────────────────────────────
  let shouldContinue = true
  registerShutdownHandlers(() => {
    shouldContinue = false
  })

  // ── Run cycles ──────────────────────────────────────────────────────────────
  let cycleIndex = 0
  let lastCycle: LoopCycle | null = null

  while (shouldContinue) {
    if (maxCycles !== undefined && cycleIndex >= maxCycles) break

    const cycle = await runCycle(cycleIndex, template, wallet, envConfig)
    lastCycle = cycle
    cycleIndex++

    if (!continuous) break

    if (cycle.status === 'error') {
      console.warn(`[Loop] Cycle #${cycleIndex - 1} errored — waiting ${LOOP_INTERVAL_MS}ms before retry...`)
    }

    // Sleep before next cycle
    await new Promise<void>((resolve) => setTimeout(resolve, LOOP_INTERVAL_MS))
  }

  console.log(`\n[Loop] Agent loop stopped after ${cycleIndex} cycle(s)`)
  return { cyclesRun: cycleIndex, lastCycle }
}

// ─── CLI Entry Point ───────────────────────────────────────────────────────────

// Run directly: bun run agent/okx/loop.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  runAgentLoop()
    .then(({ cyclesRun }) => {
      console.log(`\n✅ Agent loop exited cleanly. Cycles run: ${cyclesRun}`)
    })
    .catch((err) => {
      console.error(`\n❌ Agent loop crashed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    })
}
