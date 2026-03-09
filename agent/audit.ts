/**
 * MemoryVault Agent Protocol — Owner Audit Script (T3.3)
 *
 * Reads the verified decision log for an agent from the audit-reader
 * CRE workflow and prints a human-readable summary grouped by toolId.
 *
 * Usage:
 *   AGENT_ID=agent-alpha-01 bun run agent/audit.ts
 *
 *   # or override agent via CLI arg
 *   bun run agent/audit.ts agent-beta-01
 *
 * If AUDIT_READER_URL is set, it posts to that HTTP gateway.
 * Otherwise, it defaults to subprocess simulation of the workflow
 * (mirroring the pattern in CRETrigger and MemoryClient).
 */

import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

interface AuditEntry {
  key: string
  type: string
  toolId: string
  timestamp: string
  verified: boolean
  committedAt: string
  data: Record<string, unknown>
}

interface AuditResponse {
  status: string
  agentId: string
  decisionLog: AuditEntry[]
  totalEntries: number
  verifiedCount?: number
  unverifiedCount?: number
  onChainCommitments?: string
  error?: string
}

function parseCommittedAt(committedAt: string | undefined): string {
  if (!committedAt) return 'n/a'
  const n = Number(committedAt)
  if (!Number.isFinite(n) || n <= 0) return 'n/a'
  try {
    return new Date(n * 1000).toISOString()
  } catch {
    return committedAt
  }
}

function formatTimestamp(ts: string | undefined): string {
  if (!ts) return 'n/a'
  // audit-reader stores ISO strings in entryData.timestamp
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return d.toISOString()
}

function groupByTool(entries: AuditEntry[]): Map<string, AuditEntry[]> {
  const map = new Map<string, AuditEntry[]>()
  for (const entry of entries) {
    const key = entry.toolId || 'protocol'
    const existing = map.get(key)
    if (existing) {
      existing.push(entry)
    } else {
      map.set(key, [entry])
    }
  }
  return map
}

function parseSimulationResult(stdout: string): AuditResponse | null {
  const RESULT_MARKER = 'Simulation Result:'
  const lines = stdout.split('\n')
  const markerIdx = lines.findIndex(l => l.includes(RESULT_MARKER))

  if (markerIdx === -1) return null

  const resultLines: string[] = []
  for (let i = markerIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!trimmed) break
    resultLines.push(trimmed)
  }
  const rawResult = resultLines.join('').trim()
  if (!rawResult) return null

  try {
    const parsed = JSON.parse(rawResult)
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as AuditResponse
    }
    if (typeof parsed === 'string') {
      return JSON.parse(parsed) as AuditResponse
    }
  } catch {
    // fall through
  }
  return null
}

async function run(): Promise<void> {
  const cliAgentId = process.argv[2]
  const agentId = cliAgentId || process.env.AGENT_ID || 'agent-alpha-01'
  const url = process.env.AUDIT_READER_URL

  console.log('🔍 MemoryVault Owner Audit')
  console.log(`Agent: ${agentId}`)

  let data: AuditResponse

  if (url) {
    console.log(`Endpoint: ${url}`)
    console.log('')

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      })
    } catch (e) {
      console.error('[audit] Failed to call audit-reader endpoint:', e)
      process.exit(1)
      return
    }

    if (!res.ok) {
      console.error(
        '[audit] Audit-reader HTTP error:',
        res.status,
        res.statusText
      )
      const text = await res.text().catch(() => '')
      if (text) {
        console.error('[audit] Response body:', text)
      }
      process.exit(1)
    }

    try {
      data = (await res.json()) as AuditResponse
    } catch (e) {
      console.error('[audit] Failed to parse JSON response from audit-reader:', e)
      process.exit(1)
      return
    }

  } else {
    // ── Subprocess fallback ──
    console.log('Endpoint: (None set, using subprocess simulation via CRE CLI)')
    console.log('')

    try {
      const creProjectDir = fileURLToPath(new URL('../cre-memoryvault', import.meta.url))
      const payload = JSON.stringify({ agentId })

      console.log(`[audit] Running cre workflow simulate protocol/audit-reader...`)

      const result = await execFileAsync(
        'cre',
        [
          'workflow', 'simulate', 'protocol/audit-reader',
          '--target', 'staging-settings',
          '--non-interactive',
          '--trigger-index', '0',
          '--http-payload', payload,
        ],
        {
          cwd: creProjectDir,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 120_000
        }
      )

      const parsed = parseSimulationResult(result.stdout)
      if (!parsed) {
        console.error('[audit] Could not parse CRE simulation output.')
        console.error(result.stdout)
        process.exit(1)
      }
      data = parsed

    } catch (err: any) {
      console.error('[audit] Subprocess simulation failed:', err)
      if (err.stdout) console.error('[audit] stdout:', err.stdout)
      if (err.stderr) console.error('[audit] stderr:', err.stderr)
      process.exit(1)
    }
  }

  if (data.status !== 'success') {
    console.error('[audit] Audit-reader reported failure:', data.error || data.status)
    process.exit(1)
  }

  const total = data.totalEntries ?? data.decisionLog?.length ?? 0
  const verified = data.verifiedCount ?? data.decisionLog.filter(e => e.verified).length
  const unverified = data.unverifiedCount ?? (total - verified)

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`✅ Audit complete for agent: ${data.agentId}`)
  console.log(`  Total entries:       ${total}`)
  console.log(`  Verified entries:    ${verified}`)
  console.log(`  Unverified entries:  ${unverified}`)
  if (data.onChainCommitments !== undefined) {
    console.log(`  On-chain commitments: ${data.onChainCommitments}`)
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')

  if (!data.decisionLog || data.decisionLog.length === 0) {
    console.log('[audit] No entries found for this agent.')
    return
  }

  const grouped = groupByTool(data.decisionLog)

  for (const [toolId, entries] of grouped.entries()) {
    console.log(`Tool: ${toolId}`)
    console.log('------------------------------------------------')
    for (const entry of entries) {
      const ts = formatTimestamp(entry.timestamp)
      const committedAt = parseCommittedAt(entry.committedAt)
      const status = entry.verified ? 'VERIFIED' : 'UNVERIFIED'
      console.log(
        `- [${status}] ${entry.type || 'unknown'} ` +
        `(ts=${ts}, committedAt=${committedAt})`
      )
    }
    console.log('')
  }

  console.log(
    'Hint: Use this output alongside the MemoryRegistry explorer view to ' +
    'confirm that reasoning entries were committed before actions.'
  )
}

run().catch(err => {
  console.error('[audit] Fatal error:', err)
  process.exit(1)
})
