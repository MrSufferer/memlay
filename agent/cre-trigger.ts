/**
 * CRE Trigger — runs CRE workflow simulations as subprocesses to get
 * live ToolResponse results from the scanner and monitor workflows.
 *
 * How it works:
 *   1. Spawns `cre workflow simulate <workflowDir> --target <target>` via Bun
 *   2. Captures stdout and extracts the JSON after "Simulation Result:"
 *   3. Returns the parsed ToolResponse to the agent loop
 *
 * This approach requires no running server — it works entirely via the
 * CRE CLI installed locally. For production, replace with an HTTP call
 * to the deployed workflow's HTTP trigger endpoint.
 *
 * Workflow → target mapping:
 *   scan    → tools/uniswap-v3-lp     --target staging-settings
 *   monitor → tools/uniswap-v3-lp     --target monitor-staging-settings
 */

import type { ToolResponse } from '../cre-memoryvault/protocol/tool-interface'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface CRETriggerConfig {
    /** Base URL for deployed CRE workflow HTTP triggers (future use). */
    baseUrl?: string
    /**
     * Absolute path to the cre-memoryvault directory.
     * Defaults to ../cre-memoryvault relative to this file.
     */
    creProjectDir?: string
    /**
     * Timeout in milliseconds for each `cre workflow simulate` call.
     * Defaults to 60 000 ms (1 minute).
     */
    timeoutMs?: number
}

/** Tool-to-workflow directory mapping (relative to creProjectDir). */
const TOOL_WORKFLOW_DIRS: Record<string, string> = {
    'uniswap-v3-lp': 'tools/uniswap-v3-lp',
}

/** CRE project target names for each workflow type. */
const SCAN_TARGET = 'staging-settings'
const MONITOR_TARGET = 'monitor-staging-settings'

export class CRETrigger {
    private readonly creProjectDir: string
    private readonly timeoutMs: number

    constructor(private readonly config: CRETriggerConfig = {}) {
        // Resolve cre-memoryvault dir relative to this file using typed import.meta.url
        this.creProjectDir = config.creProjectDir
            ?? fileURLToPath(new URL('../cre-memoryvault', import.meta.url))
        this.timeoutMs = config.timeoutMs ?? 60_000
    }

    /**
     * Fetch the latest ToolResponse for a given tool's scan action by
     * running `cre workflow simulate <toolDir> --target staging-settings`.
     */
    async getScanResults(toolId: string): Promise<ToolResponse | null> {
        const workflowDir = TOOL_WORKFLOW_DIRS[toolId]
        if (!workflowDir) {
            console.warn(`[CRETrigger] No workflow dir registered for toolId: ${toolId}`)
            return null
        }
        console.log(`[CRETrigger] Running scanner sim for tool: ${toolId}`)
        return this.runSimulate(workflowDir, SCAN_TARGET)
    }

    /**
     * Fetch the latest ToolResponse for a given tool's monitor action by
     * running `cre workflow simulate <toolDir> --target monitor-staging-settings`.
     */
    async getMonitorResults(toolId: string): Promise<ToolResponse | null> {
        const workflowDir = TOOL_WORKFLOW_DIRS[toolId]
        if (!workflowDir) {
            console.warn(`[CRETrigger] No workflow dir registered for toolId: ${toolId}`)
            return null
        }
        console.log(`[CRETrigger] Running monitor sim for tool: ${toolId}`)
        return this.runSimulate(workflowDir, MONITOR_TARGET)
    }

    // ── Private ──────────────────────────────────────────────────────────────

    /**
     * Spawn `cre workflow simulate <workflowDir> --target <target>` and
     * parse the ToolResponse from stdout.
     *
     * The CRE CLI prints the workflow return value as a JSON string on the
     * line immediately after "✓ Workflow Simulation Result:". We extract
     * that line and JSON.parse it (twice — once to unwrap the outer string
     * literal, once to parse the inner ToolResponse object).
     */
    private async runSimulate(
        workflowDir: string,
        target: string,
    ): Promise<ToolResponse | null> {
        let stdoutText: string

        try {
            const result = await execFileAsync(
                'cre',
                [
                    'workflow', 'simulate', workflowDir,
                    '--target', target,
                    '--non-interactive',
                    '--trigger-index', '0',
                ],
                {
                    cwd: this.creProjectDir,
                    timeout: this.timeoutMs,
                    maxBuffer: 10 * 1024 * 1024, // 10 MB — scan results can be large
                }
            )
            stdoutText = result.stdout
        } catch (err: any) {
            // execFile rejects on non-zero exit or timeout
            if (err.killed || err.code === 'ETIMEDOUT') {
                console.error(`[CRETrigger] cre workflow simulate timed out after ${this.timeoutMs}ms`)
            } else {
                console.error(
                    `[CRETrigger] cre workflow simulate failed (exit ${err.code ?? '?'}):\n` +
                    `stderr: ${String(err.stderr ?? '').slice(0, 500)}`
                )
            }
            return null
        }

        return parseSimulationResult(stdoutText, workflowDir)
    }
}

// ── Result Parsing ────────────────────────────────────────────────────────────

/**
 * Extract and parse the ToolResponse from `cre workflow simulate` stdout.
 *
 * CRE CLI ≥1.3 outputs the workflow return value as a plain JSON object:
 *   ✓ Workflow Simulation Result:
 *   {"status":"success","action":"scan", ...}
 *
 * CRE CLI ≤1.2 wraps it in a JSON string literal (double-encoded):
 *   ✓ Workflow Simulation Result:
 *   "{\"status\":\"success\",\"action\":\"scan\", ...}"
 *
 * We handle both: try plain parse first, then unwrap-and-parse.
 */
function parseSimulationResult(
    stdout: string,
    workflowDir: string,
): ToolResponse | null {
    const RESULT_MARKER = 'Simulation Result:'
    const lines = stdout.split('\n')
    const markerIdx = lines.findIndex(l => l.includes(RESULT_MARKER))

    if (markerIdx === -1) {
        console.error(
            `[CRETrigger] Could not find "${RESULT_MARKER}" in simulate output for ${workflowDir}.\n` +
            `stdout snippet: ${stdout.slice(0, 400)}`
        )
        return null
    }

    // Collect lines after the marker until a blank line
    const resultLines: string[] = []
    for (let i = markerIdx + 1; i < lines.length; i++) {
        const trimmed = lines[i].trim()
        if (!trimmed) break
        resultLines.push(trimmed)
    }
    const rawResult = resultLines.join('').trim()

    if (!rawResult) {
        console.error(`[CRETrigger] Empty result after marker for ${workflowDir}`)
        return null
    }

    try {
        const parsed = JSON.parse(rawResult)

        // CLI ≥1.3: result is already a plain object
        if (typeof parsed === 'object' && parsed !== null) {
            const toolResponse = parsed as ToolResponse
            console.log(
                `[CRETrigger] Parsed result: status=${toolResponse.status} ` +
                `action=${toolResponse.action} toolId=${toolResponse.toolId} ` +
                `opportunities=${toolResponse.opportunities?.length ?? 0}`
            )
            return toolResponse
        }

        // CLI ≤1.2: result is a JSON-encoded string — parse again
        if (typeof parsed === 'string') {
            const toolResponse = JSON.parse(parsed) as ToolResponse
            console.log(
                `[CRETrigger] Parsed result (unwrapped): status=${toolResponse.status} ` +
                `action=${toolResponse.action} toolId=${toolResponse.toolId} ` +
                `opportunities=${toolResponse.opportunities?.length ?? 0}`
            )
            return toolResponse
        }

        console.error(`[CRETrigger] Unexpected result type (${typeof parsed}) for ${workflowDir}`)
        return null
    } catch (err) {
        console.error(
            `[CRETrigger] Failed to parse simulation result for ${workflowDir}: ${err}\n` +
            `raw: ${rawResult.slice(0, 300)}`
        )
        return null
    }
}

