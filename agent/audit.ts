/**
 * MemoryVault Agent Protocol — Owner Audit Script
 *
 * Reads the verified decision log from audit-reader workflow.
 * Supports deploy-first mode with simulate fallback.
 */

import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import { promisify } from 'util'
import { DeployedTriggerClient } from './deployed-trigger-client'
import {
  hasDeployedTriggerConfig,
  loadDeploymentTargetConfig,
  loadTriggerAuthConfig,
  resolveRuntimeMode,
} from './deploy-runtime-config'
import { loadHederaEnvConfig } from './hedera/env'
import { loadHederaMemoryConfig } from './hedera/memory/runtime'
import {
  HederaMirrorNodeMemoryVerifier,
  type HederaMemoryVerifier,
} from './hedera/memory/verifier'
import { loadWorkflowIdsFromEnv } from './workflow-ids'

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
  const directDate = new Date(committedAt)
  if (!Number.isNaN(directDate.getTime())) {
    return directDate.toISOString()
  }

  const n = Number(committedAt)
  if (!Number.isFinite(n) || n <= 0) return committedAt
  try {
    return new Date(n * 1000).toISOString()
  } catch {
    return committedAt
  }
}

function formatTimestamp(ts: string | undefined): string {
  if (!ts) return 'n/a'
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

function coerceAuditResponse(value: unknown): AuditResponse | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    try {
      return coerceAuditResponse(JSON.parse(trimmed))
    } catch {
      return null
    }
  }

  if (!value || typeof value !== 'object') return null

  const maybe = value as Partial<AuditResponse>
  if (typeof maybe.status !== 'string' || typeof maybe.agentId !== 'string') {
    return null
  }

  return maybe as AuditResponse
}

export async function buildHederaAuditResponse(
  agentId: string,
  verifier?: HederaMemoryVerifier
): Promise<AuditResponse> {
  const env = loadHederaEnvConfig()
  const memoryConfig = loadHederaMemoryConfig(env)
  const activeVerifier =
    verifier ??
    new HederaMirrorNodeMemoryVerifier({
      config: memoryConfig,
      mirrorNodeUrl: env.mirrorNodeUrl,
    })
  const result = await activeVerifier.verify(agentId)
  const decisionLog = result.entries.map((entry) => {
    const data =
      entry.data && typeof entry.data === 'object'
        ? entry.data
        : { error: entry.error ?? 'Unable to decode memory entry' }
    const type = typeof data.action === 'string' ? data.action : 'unknown'
    const toolId = typeof data.toolId === 'string' ? data.toolId : 'protocol'
    const timestamp =
      typeof data.timestamp === 'string' ? data.timestamp : entry.timestamp

    return {
      key: entry.entryKey,
      type,
      toolId,
      timestamp,
      verified: entry.valid,
      committedAt: entry.committedAt,
      data,
    }
  })

  return {
    status: 'success',
    agentId,
    decisionLog,
    totalEntries: decisionLog.length,
    verifiedCount: decisionLog.filter((entry) => entry.verified).length,
    unverifiedCount: decisionLog.filter((entry) => !entry.verified).length,
    onChainCommitments: `${decisionLog.length} HCS commitments on topic ${memoryConfig.topicId}`,
  }
}

export async function runAudit(): Promise<void> {
  const cliAgentId = process.argv[2]
  const agentId = cliAgentId || process.env.AGENT_ID || 'agent-alpha-01'
  const mode = resolveRuntimeMode(process.env.CRE_RUNTIME_MODE)
  const deploymentTarget = loadDeploymentTargetConfig()

  console.log('🔍 MemoryVault Owner Audit')
  console.log(`Agent: ${agentId}`)

  let data: AuditResponse | null = null

  if (!deploymentTarget.supportsLegacyCreStack) {
    console.log('Endpoint: Hedera mirror node + S3 verifier')
    console.log('')
    data = await buildHederaAuditResponse(agentId)
  } else {
    if (mode !== 'simulate') {
      const auth = loadTriggerAuthConfig()
      const workflowIds = loadWorkflowIdsFromEnv()

      if (hasDeployedTriggerConfig(auth) && workflowIds.auditReader) {
        console.log('Endpoint: deployed gateway')
        console.log('')

        try {
          const client = new DeployedTriggerClient({
            gatewayUrl: auth.gatewayUrl!,
            privateKey: auth.privateKey!,
            timeoutMs: 120_000,
          })

          const raw = await client.triggerWorkflow({
            workflowId: workflowIds.auditReader,
            input: { agentId },
          })

          data = coerceAuditResponse(raw)
          if (!data) {
            throw new Error(`Could not parse deployed audit response: ${JSON.stringify(raw).slice(0, 300)}`)
          }
        } catch (error) {
          console.error('[audit] Deployed audit-reader invocation failed:', error)
          if (mode === 'deployed') {
            process.exit(1)
          }
        }
      } else if (mode === 'deployed') {
        console.error('[audit] deploy mode requires CRE gateway auth config and CRE_WORKFLOW_ID_AUDIT_READER')
        process.exit(1)
      }
    }

    if (!data) {
      console.log('Endpoint: (simulate fallback via CRE CLI)')
      console.log('')

      try {
        const creProjectDir = fileURLToPath(new URL('../cre-memoryvault', import.meta.url))
        const payload = JSON.stringify({ agentId })

        console.log('[audit] Running cre workflow simulate protocol/audit-reader...')

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
            timeout: 120_000,
          }
        )

        data = parseSimulationResult(result.stdout)
        if (!data) {
          console.error('[audit] Could not parse CRE simulation output.')
          console.error(result.stdout)
          process.exit(1)
        }
      } catch (err: any) {
        console.error('[audit] Subprocess simulation failed:', err)
        if (err.stdout) console.error('[audit] stdout:', err.stdout)
        if (err.stderr) console.error('[audit] stderr:', err.stderr)
        process.exit(1)
      }
    }
  }

  if (data.status !== 'success') {
    console.error('[audit] Audit-reader reported failure:', data.error || data.status)
    process.exit(1)
  }

  const total = data.totalEntries ?? data.decisionLog?.length ?? 0
  const verified = data.verifiedCount ?? data.decisionLog.filter(e => e.verified).length
  const unverified = data.unverifiedCount ?? total - verified

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
    deploymentTarget.supportsLegacyCreStack
      ? 'Hint: Use this output alongside the MemoryRegistry explorer view to confirm that reasoning entries were committed before actions.'
      : 'Hint: Use this output alongside HCS topic inspection to confirm that reasoning entries were committed before actions.'
  )
}

if (import.meta.main) {
  void runAudit().catch(err => {
    console.error('[audit] Fatal error:', err)
    process.exit(1)
  })
}
