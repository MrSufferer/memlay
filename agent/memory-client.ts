/**
 * MemoryVault Client — commits agent reasoning to the memory-writer workflow.
 *
 * Runs `cre workflow simulate protocol/memory-writer --http-payload '...'`
 * as a subprocess so the agent can commit entries without a deployed
 * HTTP trigger. Mirrors the CRETrigger pattern.
 *
 * The critical invariant: commitEntry() MUST succeed before any action
 * is executed. On failure the caller should abort the action.
 */

import type { MemoryEntryData } from '../cre-memoryvault/protocol/tool-interface'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface MemoryClientConfig {
    /**
     * Gateway URL that forwards to the memory-writer workflow HTTP trigger.
     * If set, the client uses HTTP instead of subprocess simulation.
     */
    memoryWriterUrl?: string
    /**
     * Absolute path to the cre-memoryvault directory.
     * Defaults to ../cre-memoryvault relative to this file.
     */
    creProjectDir?: string
    /** Timeout for each simulate call. Defaults to 60 000 ms. */
    timeoutMs?: number
}

export class MemoryClient {
    private readonly creProjectDir: string
    private readonly timeoutMs: number

    constructor(private readonly config: MemoryClientConfig = {}) {
        this.creProjectDir = config.creProjectDir
            ?? fileURLToPath(new URL('../cre-memoryvault', import.meta.url))
        this.timeoutMs = config.timeoutMs ?? 60_000
    }

    /**
     * Commit an entry to MemoryVault (S3 + on-chain hash).
     *
     * Uses the memory-writer CRE workflow via subprocess simulation.
     * Throws on failure so the caller can enforce the pre-action invariant.
     */
    async commitEntry(args: {
        agentId: string
        entryKey: string
        entryData: MemoryEntryData
    }): Promise<void> {
        // ── HTTP path (for deployed workflows) ────────────────────────────────
        if (this.config.memoryWriterUrl) {
            await this.commitViaHttp(args)
            return
        }

        // ── Subprocess simulation path ─────────────────────────────────────────
        await this.commitViaSim(args)
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private async commitViaHttp(args: {
        agentId: string
        entryKey: string
        entryData: MemoryEntryData
    }): Promise<void> {
        const res = await fetch(this.config.memoryWriterUrl!, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(args),
        })
        if (!res.ok) {
            throw new Error(`[MemoryClient] HTTP commit failed: ${res.status} ${res.statusText}`)
        }
    }

    private async commitViaSim(args: {
        agentId: string
        entryKey: string
        entryData: MemoryEntryData
    }): Promise<void> {
        const payload = JSON.stringify({
            agentId: args.agentId,
            entryKey: args.entryKey,
            entryData: args.entryData,
        })

        console.log(`[MemoryClient] Committing entry via sim: ${args.agentId}/${args.entryKey}`)

        let stdout: string
        try {
            const result = await execFileAsync(
                'cre',
                [
                    'workflow', 'simulate', 'protocol/memory-writer',
                    '--target', 'staging-settings',
                    '--non-interactive',
                    '--trigger-index', '0',
                    '--http-payload', payload,
                ],
                {
                    cwd: this.creProjectDir,
                    timeout: this.timeoutMs,
                    maxBuffer: 2 * 1024 * 1024,
                }
            )
            stdout = result.stdout
        } catch (err: any) {
            const stderr = String(err.stderr ?? '')
            throw new Error(
                `[MemoryClient] memory-writer sim failed (exit ${err.code ?? '?'}):\n` +
                stderr.slice(0, 500)
            )
        }

        // Parse and log the result (status=success means S3+chain commit worked)
        const result = parseMemoryWriterResult(stdout)
        if (!result) {
            throw new Error('[MemoryClient] Could not parse memory-writer sim output')
        }
        if (result.status !== 'success') {
            throw new Error(
                `[MemoryClient] memory-writer returned status=${result.status}: ${result.error ?? '(no error field)'}`
            )
        }

        console.log(
            `[MemoryClient] ✅ Committed: key=${result.entryKey} ` +
            `hash=${result.entryHash?.slice(0, 12)}... s3=${result.s3Key}`
        )
    }
}

// ── Result Parsing ────────────────────────────────────────────────────────────

interface MemoryWriterResult {
    status: 'success' | 'failed'
    agentId?: string
    entryKey?: string
    entryHash?: string
    timestamp?: string
    s3Key?: string
    txHash?: string
    error?: string
}

function parseMemoryWriterResult(stdout: string): MemoryWriterResult | null {
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
        // CLI ≥1.3: plain object
        if (typeof parsed === 'object' && parsed !== null) {
            return parsed as MemoryWriterResult
        }
        // CLI ≤1.2: double-encoded string
        if (typeof parsed === 'string') {
            return JSON.parse(parsed) as MemoryWriterResult
        }
    } catch {
        // fall through
    }
    return null
}
