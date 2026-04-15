/**
 * OKX / X Layer — Clude MemoryStore
 *
 * Implements the 5-type Clude memory system for persistent agent memory.
 * Storage backend: local JSON file (~/.agent/memory-{agentId}.json).
 * Supabase (pg_vector) can replace this in production — interface is designed for swap-in.
 *
 * Memory types:
 *   episodic    — raw trade events (scan, act, confirm, arena) — fast decay
 *   semantic    — distilled patterns from episodic (post-dream) — slow decay
 *   procedural  — learned behavioral patterns / strategies — medium decay
 *   self_model  — agent's self-awareness (performance, capabilities) — slowest decay
 *   introspective — reflective thoughts about strategy and existence — medium-slow decay
 *
 * Decay formula (per Clude / inspired by Ebbinghaus):
 *   effectiveImportance = importance * (1 - decay_rate)^days_since_created
 *   Memories with effectiveImportance < 0.01 are "expired" and skipped on recall
 *
 * Clude retrieval scoring formula:
 *   score = 0.5×recency + 3.0×relevance + 2.0×importance + 3.0×vectorSim + 1.5×graphBoost + 2.0×tradingScore
 *
 * Dream Cycle: see agent/okx/dream-cycle.ts
 *
 * Usage:
 *   const store = await createMemoryStore({ agentId: 'okx-arena-01' })
 *   await store.store({ type: 'episodic', content: 'entered BEAON/USDC', tags: ['entry'], importance: 8 })
 *   const memories = await store.recall({ query: 'BEAON entries', limit: 5 })
 *   await store.applyDecay()  // nightly
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// ─── Constants ───────────────────────────────────────────────────────────────

/** Per-type daily decay rates (from Clude.io research) */
export const DECAY_RATES: Record<MemoryType, number> = {
  episodic: 0.07,       // 7%/day — raw events fade fast
  semantic: 0.02,       // 2%/day — distilled knowledge persists
  procedural: 0.03,     // 3%/day — learned behaviors medium persistence
  self_model: 0.01,     // 1%/day — self-knowledge is very sticky
  introspective: 0.02,  // 2%/day — introspective thoughts medium persistence
}

/** Minimum effective importance before a memory is considered expired */
const DECAY_EXPIRATION_THRESHOLD = 0.01

// ─── Types ──────────────────────────────────────────────────────────────────

export type MemoryType = 'episodic' | 'semantic' | 'procedural' | 'self_model' | 'introspective'

export interface MemoryEntry {
  id: string
  type: MemoryType
  content: string
  summary?: string
  tags: string[]
  importance: number          // 0-10; higher = slower decay
  decayFactor: number        // computed: importance * (1 - decay_rate)^days
  createdAt: number          // epoch ms
  updatedAt: number
  agentId: string
  metadata: Record<string, unknown>
  links: MemoryLink[]
  version: number
}

export interface MemoryLink {
  targetId: string
  linkType: 'supports' | 'contradicts' | 'elaborates' | 'causes' | 'resolves' | 'follows' | 'relates'
  strength: number           // 0-1; boosted by +0.05 on co-retrieval
}

export interface RecallOptions {
  query?: string
  types?: MemoryType[]
  tags?: string[]
  importanceThreshold?: number
  limit?: number
  tradingContext?: TradingContext
}

export interface TradingContext {
  marketRegime?: 'bull' | 'bear' | 'sideways' | 'high_vol' | 'low_vol'
  assetClass?: string
  strategyType?: string
  currentDrawdown?: number
  recentPnL?: number
}

export interface RecallResult {
  entry: MemoryEntry
  score: number
  recency: number            // 0-1
  relevance: number           // 0-1 (keyword/tag match)
  importance: number         // 0-1 (importance field)
  vectorSim: number          // 0-1 (placeholder — keyword similarity used for MVP)
  graphBoost: number          // 0-1 (associated with recent recalls)
  tradingScore: number        // 0-1 (regime/strategy match)
}

export interface DreamOptions {
  limitEpisodes?: number
  skipIfRecent?: number   // ms — skip if last dream within this window
}

export interface DreamPhaseResult {
  phase: 'consolidation' | 'compaction' | 'reflection' | 'contradiction_resolution' | 'emergence'
  memoriesProduced: number
  durationMs: number
  errors: string[]
}

// ─── Clude Memory Engine ─────────────────────────────────────────────────────

export interface MemoryStore {
  /** Store a new memory entry */
  store(entry: StoreEntry): Promise<MemoryEntry>

  /** Retrieve relevant memories */
  recall(options: RecallOptions): Promise<RecallResult[]>

  /** Apply decay to all memories (run nightly) */
  applyDecay(): Promise<{ updated: number; expired: number }>

  /** Run the full 5-phase dream cycle */
  dream(options?: DreamOptions): Promise<DreamPhaseResult[]>

  /** Get all memories of a specific type */
  getByType(type: MemoryType): Promise<MemoryEntry[]>

  /** Get memories approaching expiration (decayFactor < threshold) */
  getFadingMemories(threshold?: number): Promise<MemoryEntry[]>

  /** Add a link between two memory entries */
  addLink(sourceId: string, targetId: string, linkType: MemoryLink['linkType'], strength?: number): Promise<void>

  /** Delete a memory by ID */
  delete(id: string): Promise<boolean>

  /** Get aggregate stats */
  stats(): Promise<MemoryStats>

  /** Close/release resources */
  close(): void
}

export interface StoreEntry {
  type: MemoryType
  content: string
  summary?: string
  tags?: string[]
  importance?: number
  metadata?: Record<string, unknown>
}

export interface MemoryStats {
  total: number
  byType: Record<MemoryType, number>
  avgDecayFactor: Record<MemoryType, number>
  lastDreamAt: number | null
}

// ─── Storage Backend ─────────────────────────────────────────────────────────

interface StorageBackend {
  read(): MemoryEntry[]
  write(entries: MemoryEntry[]): void
  path: string
}

/** Local JSON file storage — SQLite/Supabase can replace this */
class LocalFileStorage implements StorageBackend {
  readonly path: string

  constructor(agentId: string) {
    const dir = join(homedir(), '.agent')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.path = join(dir, `memory-${sanitizeFilename(agentId)}.json`)
  }

  read(): MemoryEntry[] {
    if (!existsSync(this.path)) return []
    try {
      const raw = readFileSync(this.path, 'utf8')
      return JSON.parse(raw) as MemoryEntry[]
    } catch {
      return []
    }
  }

  write(entries: MemoryEntry[]): void {
    writeFileSync(this.path, JSON.stringify(entries, null, 2), 'utf8')
  }
}

// ─── Store Factory ──────────────────────────────────────────────────────────

export async function createMemoryStore(
  config: { agentId: string; storagePath?: string }
): Promise<MemoryStore> {
  const storage = config.storagePath
    ? { read: () => { try { return JSON.parse(readFileSync(config.storagePath!, 'utf8')) as MemoryEntry[] } catch { return [] } }, write: (e: MemoryEntry[]) => writeFileSync(config.storagePath!, JSON.stringify(e, null, 2)), path: config.storagePath }
    : new LocalFileStorage(config.agentId)

  const engine = new CludeMemoryEngine(config.agentId, storage)
  return engine
}

// ─── Core Engine ─────────────────────────────────────────────────────────────

class CludeMemoryEngine implements MemoryStore {
  private entries: MemoryEntry[]
  private recentRecallIds: Set<string> = new Set()

  constructor(
    private readonly agentId: string,
    private readonly storage: StorageBackend
  ) {
    this.entries = this.storage.read()
  }

  // ── Store ──────────────────────────────────────────────────────────────────

  async store(entry: StoreEntry): Promise<MemoryEntry> {
    const now = Date.now()
    const daysSinceEpoch = now / 86400_000
    const decayRate = DECAY_RATES[entry.type]

    const fullEntry: MemoryEntry = {
      id: randomUUID(),
      type: entry.type,
      content: entry.content,
      summary: entry.summary,
      tags: entry.tags ?? [],
      importance: entry.importance ?? 5,
      decayFactor: (entry.importance ?? 5) * Math.pow(1 - decayRate, 0), // start at full
      createdAt: now,
      updatedAt: now,
      agentId: this.agentId,
      metadata: entry.metadata ?? {},
      links: [],
      version: 1,
    }

    // Recompute decayFactor
    fullEntry.decayFactor = computeDecayFactor(fullEntry)

    this.entries.push(fullEntry)
    this.save()
    console.log(`[MemoryStore] Stored ${entry.type} memory: id=${fullEntry.id.slice(0, 8)}... importance=${fullEntry.importance} decayFactor=${fullEntry.decayFactor.toFixed(3)}`)
    return fullEntry
  }

  // ── Recall ─────────────────────────────────────────────────────────────────

  async recall(options: RecallOptions): Promise<RecallResult[]> {
    const limit = options.limit ?? 10
    const types = options.types ?? ['episodic', 'semantic', 'procedural', 'self_model', 'introspective']
    const now = Date.now()

    // 1. Filter candidates by type, expiration, tags, importance
    const candidates = this.entries.filter(entry => {
      if (!types.includes(entry.type)) return false
      if (computeDecayFactor(entry) < DECAY_EXPIRATION_THRESHOLD) return false
      if (options.importanceThreshold !== undefined && entry.importance < options.importanceThreshold) return false
      if (options.tags && options.tags.length > 0) {
        const hasTag = options.tags.some(t => entry.tags.includes(t))
        if (!hasTag) return false
      }
      return true
    })

    // 2. Score each candidate
    const scored: RecallResult[] = candidates.map(entry => {
      const recency = computeRecency(entry.createdAt, now)
      const relevance = computeRelevance(entry, options.query ?? '', options.tags ?? [])
      const importance = entry.importance / 10
      const vectorSim = computeVectorSim(entry, options.query ?? '')  // keyword-based for MVP
      const graphBoost = computeGraphBoost(entry, this.recentRecallIds)
      const tradingScore = computeTradingScore(entry, options.tradingContext)

      // Clude scoring formula
      const score =
        0.5 * recency +
        3.0 * relevance +
        2.0 * importance +
        3.0 * vectorSim +
        1.5 * graphBoost +
        2.0 * tradingScore

      return { entry, score, recency, relevance, importance, vectorSim, graphBoost, tradingScore }
    })

    // 3. Sort and limit
    const results = scored
      .filter(r => r.score > 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    // 4. Update recent recall IDs for graph boost
    for (const r of results) {
      this.recentRecallIds.add(r.entry.id)
    }
    // Keep only last 20
    if (this.recentRecallIds.size > 20) {
      const entries = Array.from(this.recentRecallIds)
      this.recentRecallIds = new Set(entries.slice(-20))
    }

    console.log(`[MemoryStore] recall: query="${options.query ?? ''}" types=${types.join(',')} → ${results.length} results (max ${limit})`)
    return results
  }

  // ── Decay ───────────────────────────────────────────────────────────────────

  async applyDecay(): Promise<{ updated: number; expired: number }> {
    const now = Date.now()
    let updated = 0
    let expired = 0

    for (const entry of this.entries) {
      const newDecayFactor = computeDecayFactor(entry)
      entry.decayFactor = newDecayFactor
      entry.updatedAt = now
      updated++

      if (newDecayFactor < DECAY_EXPIRATION_THRESHOLD) {
        expired++
      }
    }

    // Remove expired episodic memories (semantic/procedural/self_model/introspective are preserved)
    const before = this.entries.length
    this.entries = this.entries.filter(entry =>
      entry.type === 'episodic'
        ? entry.decayFactor >= DECAY_EXPIRATION_THRESHOLD
        : true
    )
    expired += before - this.entries.length

    this.save()
    console.log(`[MemoryStore] applyDecay: updated=${updated} expired=${expired} remaining=${this.entries.length}`)
    return { updated, expired }
  }

  // ── Dream Cycle ─────────────────────────────────────────────────────────────

  async dream(options: DreamOptions = {}): Promise<DreamPhaseResult[]> {
    const limitEpisodes = options.limitEpisodes ?? 50
    const results: DreamPhaseResult[] = []
    const now = Date.now()

    console.log('[MemoryStore] Starting dream cycle...')

    // Phase 1: Consolidation — distill recent episodic → semantic insights
    {
      const start = Date.now()
      const episodic = await this.recall({ types: ['episodic'], limit: limitEpisodes })
      if (episodic.length > 0) {
        const insight = distillEpisodic(episodic, this.agentId)
        if (insight) {
          await this.store({
            type: 'semantic',
            content: insight.content,
            summary: insight.summary,
            tags: [...(insight.tags ?? []), 'dream', 'consolidation'],
            importance: insight.importance ?? 5,
          })
        }
      }
      results.push({ phase: 'consolidation', memoriesProduced: 1, durationMs: Date.now() - start, errors: [] })
    }

    // Phase 2: Compaction — summarize fading episodic memories → semantic
    {
      const start = Date.now()
      const fading = await this.getFadingMemories(0.3)
      if (fading.length > 0) {
        for (const entry of fading.slice(0, 5)) {
          const summary = summarizeEntry(entry)
          await this.store({
            type: 'semantic',
            content: summary,
            tags: ['dream', 'compaction'],
            importance: 6,
            metadata: { sourceId: entry.id, originalType: entry.type },
          })
          await this.delete(entry.id)
        }
      }
      results.push({ phase: 'compaction', memoriesProduced: Math.min(fading.length, 5), durationMs: Date.now() - start, errors: [] })
    }

    // Phase 3: Reflection — introspective assessment of recent performance
    {
      const start = Date.now()
      const selfMemories = await this.recall({ types: ['self_model', 'procedural'], limit: 10 })
      const recentPnL = this._getRecentPnLSummary()
      const reflection = generateReflection(selfMemories, recentPnL, this.agentId)
      await this.store({
        type: 'introspective',
        content: reflection.content,
        summary: reflection.summary,
        tags: ['dream', 'reflection'],
        importance: 7,
      })
      results.push({ phase: 'reflection', memoriesProduced: 1, durationMs: Date.now() - start, errors: [] })
    }

    // Phase 4: Contradiction Resolution — find conflicting semantic memories
    {
      const start = Date.now()
      const semantic = await this.getByType('semantic')
      const conflicts = findContradictions(semantic)
      for (const conflict of conflicts.slice(0, 3)) {
        const resolution = resolveConflict(conflict, this.agentId)
        await this.store({
          type: 'semantic',
          content: resolution.content,
          summary: `Resolved conflict between ${conflict.id1} and ${conflict.id2}`,
          tags: ['dream', 'contradiction', 'resolution'],
          importance: 8,
        })
        await this.addLink(conflict.id1, resolution.id ?? '', 'resolves')
        await this.addLink(conflict.id2, resolution.id ?? '', 'resolves')
      }
      results.push({ phase: 'contradiction_resolution', memoriesProduced: conflicts.slice(0, 3).length, durationMs: Date.now() - start, errors: [] })
    }

    // Phase 5: Emergence — what does this mean for strategy?
    {
      const start = Date.now()
      const all = await this.recall({ limit: 20 })
      const emergence = generateEmergence(all, this.agentId)
      await this.store({
        type: 'introspective',
        content: emergence.content,
        summary: emergence.summary,
        tags: ['dream', 'emergence'],
        importance: 9,
      })
      results.push({ phase: 'emergence', memoriesProduced: 1, durationMs: Date.now() - start, errors: [] })
    }

    const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0)
    console.log(`[MemoryStore] Dream cycle complete: ${results.map(r => `${r.phase}:${r.memoriesProduced}`).join(', ')} (${totalMs}ms total)`)
    return results
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private _getRecentPnLSummary(): { total: number; trades: number; wins: number } {
    const cutoff = Date.now() - 7 * 86_400_000
    const episodic = this.entries.filter(e =>
      e.type === 'episodic' &&
      e.tags.includes('confirm') &&
      e.createdAt >= cutoff
    )
    let total = 0
    let wins = 0
    for (const e of episodic) {
      const pnl = Number(e.metadata?.pnlWei ?? 0)
      total += pnl
      if (pnl > 0) wins++
    }
    return { total, trades: episodic.length, wins }
  }

  async getByType(type: MemoryType): Promise<MemoryEntry[]> {
    return this.entries.filter(e => e.type === type)
  }

  async getFadingMemories(threshold = 0.3): Promise<MemoryEntry[]> {
    return this.entries.filter(e => computeDecayFactor(e) < threshold)
  }

  async addLink(sourceId: string, targetId: string, linkType: MemoryLink['linkType'], strength = 0.5): Promise<void> {
    const source = this.entries.find(e => e.id === sourceId)
    if (!source) return
    const existing = source.links.find(l => l.targetId === targetId)
    if (existing) {
      existing.strength = Math.min(1, existing.strength + 0.05) // Hebbian reinforcement
    } else {
      source.links.push({ targetId, linkType, strength })
    }
    this.save()
  }

  async delete(id: string): Promise<boolean> {
    const before = this.entries.length
    this.entries = this.entries.filter(e => e.id !== id)
    if (this.entries.length < before) {
      this.save()
      return true
    }
    return false
  }

  async stats(): Promise<MemoryStats> {
    const now = Date.now()
    const byType: Record<MemoryType, number> = { episodic: 0, semantic: 0, procedural: 0, self_model: 0, introspective: 0 }
    const avgDecayFactor: Record<MemoryType, number> = { episodic: 0, semantic: 0, procedural: 0, self_model: 0, introspective: 0 }
    const counts: Record<MemoryType, number> = { episodic: 0, semantic: 0, procedural: 0, self_model: 0, introspective: 0 }

    for (const entry of this.entries) {
      byType[entry.type]++
      avgDecayFactor[entry.type] += computeDecayFactor(entry)
      counts[entry.type]++
    }

    for (const type of Object.keys(counts) as MemoryType[]) {
      if (counts[type] > 0) avgDecayFactor[type] /= counts[type]
    }

    const dreamEntries = this.entries.filter(e => e.tags.includes('dream'))
    const lastDream = dreamEntries.length > 0
      ? Math.max(...dreamEntries.map(e => e.createdAt))
      : null

    return {
      total: this.entries.length,
      byType,
      avgDecayFactor,
      lastDreamAt: lastDream,
    }
  }

  close(): void {
    this.save()
  }

  private save(): void {
    try {
      this.storage.write(this.entries)
    } catch (err) {
      console.error(`[MemoryStore] Failed to save: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

// ─── Scoring Functions ───────────────────────────────────────────────────────

/**
 * Compute effective importance after decay.
 * effectiveImportance = importance * (1 - decay_rate)^days_since_created
 */
function computeDecayFactor(entry: MemoryEntry): number {
  const daysSinceCreated = (Date.now() - entry.createdAt) / 86_400_000
  const decayRate = DECAY_RATES[entry.type]
  return entry.importance * Math.pow(1 - decayRate, daysSinceCreated)
}

/**
 * Recency score: linear from 1 (just created) to 0 (7+ days old).
 */
function computeRecency(createdAt: number, now: number): number {
  const ageMs = now - createdAt
  const ageDays = ageMs / 86_400_000
  return Math.max(0, 1 - ageDays / 7)
}

/**
 * Relevance: fraction of query keywords present in content + tags.
 * Keyword-based MVP — Supabase pg_vector replaces this in production.
 */
function computeRelevance(entry: MemoryEntry, query: string, filterTags: string[]): number {
  if (!query) return 0.5 // neutral if no query
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (keywords.length === 0) return 0.5

  const content = entry.content.toLowerCase()
  const summary = (entry.summary ?? '').toLowerCase()
  const tags = entry.tags.map(t => t.toLowerCase())

  let matches = 0
  for (const kw of keywords) {
    if (content.includes(kw) || summary.includes(kw) || tags.some(t => t.includes(kw))) {
      matches++
    }
  }

  const base = matches / keywords.length

  // Boost if filter tags match entry tags
  const tagBoost = filterTags.length > 0 && filterTags.some(t => tags.includes(t.toLowerCase())) ? 0.2 : 0

  return Math.min(1, base + tagBoost)
}

/**
 * Vector similarity — keyword-based approximation for MVP.
 * Production: replace with Supabase pg_vector cosine similarity.
 */
function computeVectorSim(entry: MemoryEntry, query: string): number {
  if (!query) return 0
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  const content = entry.content.toLowerCase()
  const matches = tokens.filter(t => content.includes(t)).length
  return tokens.length > 0 ? matches / tokens.length : 0
}

/**
 * Graph boost: entries linked to recently recalled entries get a score boost.
 */
function computeGraphBoost(entry: MemoryEntry, recentIds: Set<string>): number {
  const links = entry.links.filter(l => recentIds.has(l.targetId))
  if (links.length === 0) return 0
  return links.reduce((sum, l) => sum + l.strength, 0) / links.length
}

/**
 * Trading score: regime/strategy match bonus.
 */
function computeTradingScore(entry: MemoryEntry, ctx?: TradingContext): number {
  if (!ctx) return 0.3 // neutral
  let score = 0

  if (ctx.marketRegime && entry.tags.includes(ctx.marketRegime)) score += 0.5
  if (ctx.strategyType && entry.tags.includes(ctx.strategyType)) score += 0.5
  if (ctx.assetClass && entry.tags.includes(ctx.assetClass)) score += 0.3

  return Math.min(1, score)
}

// ─── Dream Helpers ───────────────────────────────────────────────────────────

function distillEpisodic(episodic: RecallResult[], agentId: string): { content: string; summary: string; tags: string[]; importance: number } | null {
  if (episodic.length === 0) return null

  const entries = episodic.map(e => e.entry)
  const tags = aggregateTags(entries)
  const highImportance = entries.filter(e => e.importance >= 7)
  const outcomes = entries
    .map(e => (e.metadata?.outcome as string | undefined))
    .filter(Boolean) as string[]

  const summary = `${episodic.length} episodic memories from ${agentId}`
  const content = `From ${episodic.length} recent trade events: ${highImportance.length} high-importance events detected. ` +
    `Common themes: ${tags.slice(0, 3).join(', ') || 'none'}. ` +
    `Outcomes observed: ${outcomes.slice(0, 3).join(', ') || 'pending'}.`

  return { content, summary, tags: ['pattern', 'distilled'], importance: 6 }
}

function summarizeEntry(entry: MemoryEntry): string {
  return `[Compacted from ${entry.type} memory] ${entry.content.slice(0, 200)}${entry.content.length > 200 ? '...' : ''}`
}

function generateReflection(selfMemories: RecallResult[], pnl: { total: number; trades: number; wins: number }, agentId: string): { content: string; summary: string } {
  const winRate = pnl.trades > 0 ? (pnl.wins / pnl.trades * 100).toFixed(1) : 'N/A'
  const pnlStr = pnl.total >= 0 ? `+${pnl.total}` : `${pnl.total}`

  const content =
    `Self-assessment for ${agentId} over the past week: ` +
    `${pnl.trades} trades executed, ${winRate}% win rate, cumulative PnL ${pnlStr} wei. ` +
    (pnl.total > 0
      ? 'Strategy is generating positive returns. Consider maintaining current position sizing.'
      : 'Strategy is underperforming. Review risk thresholds and market regime detection.')

  return { content, summary: `Weekly reflection: ${winRate}% win rate, ${pnlStr} PnL` }
}

interface Conflict {
  id1: string
  id2: string
  type: 'contradiction'
}

function findContradictions(semantic: MemoryEntry[]): Conflict[] {
  const conflicts: Conflict[] = []
  // Simple heuristic: entries with conflicting tags
  const bullish = semantic.filter(e => e.tags.includes('bull') || e.content.includes('bullish'))
  const bearish = semantic.filter(e => e.tags.includes('bear') || e.content.includes('bearish'))

  for (const b of bullish.slice(0, 3)) {
    for (const br of bearish.slice(0, 3)) {
      if (Math.abs(b.createdAt - br.createdAt) < 3 * 86_400_000) {
        conflicts.push({ id1: b.id, id2: br.id, type: 'contradiction' })
      }
    }
  }
  return conflicts
}

function resolveConflict(conflict: Conflict, agentId: string): { content: string; id?: string } {
  return {
    content:
      `Conflict resolution for ${agentId}: detected conflicting market directional signals. ` +
      `Resolution: defer to most recent semantic memory and current market regime indicator. ` +
      `Use conservative position sizing when directional signals conflict.`,
    id: randomUUID(),
  }
}

function generateEmergence(all: RecallResult[], agentId: string): { content: string; summary: string } {
  const types = {} as Record<string, number>
  for (const r of all) types[r.entry.type] = (types[r.entry.type] ?? 0) + 1

  const avgScore = all.length > 0 ? (all.reduce((s, r) => s + r.score, 0) / all).toFixed(2) : 'N/A'

  const content =
    `Emergent insight for ${agentId}: memory analysis reveals ${Object.entries(types).map(([t, n]) => `${n} ${t}`).join(', ')}. ` +
    `Average retrieval relevance: ${avgScore}. ` +
    `Key insight: the agent's memory system is functioning — ` +
    `${all.length} relevant memories retrieved with average score ${avgScore}. ` +
    `Continue current strategy while monitoring decay rates of episodic memories.`

  return { content, summary: `Emergence: ${all.length} memories, avg score ${avgScore}` }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function aggregateTags(entries: MemoryEntry[]): string[] {
  const counts: Record<string, number> = {}
  for (const e of entries) {
    for (const t of e.tags) counts[t] = (counts[t] ?? 0) + 1
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag)
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()
}
