/**
 * CRE Trigger — fetches ToolResponse results for scanner/monitor actions.
 *
 * Runtime behavior:
 *   - deploy mode: trigger deployed workflow via signed JSON-RPC/JWT request
 *   - simulate mode: run `cre workflow simulate` subprocess only
 *   - auto mode: try deployed first, then fallback to subprocess simulation
 */

import type { ToolResponse } from '../cre-memoryvault/protocol/tool-interface'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import { promisify } from 'util'
import { DeployedTriggerClient } from './deployed-trigger-client'
import {
    hasDeployedTriggerConfig,
    loadDeploymentTargetConfig,
    loadTriggerAuthConfig,
    resolveRuntimeMode,
    type RuntimeMode,
} from './deploy-runtime-config'
import { loadWorkflowIdsFromEnv, type WorkflowIdMap } from './workflow-ids'

const execFileAsync = promisify(execFile)

export interface CRETriggerConfig {
    /** Execution mode for workflow invocation behavior. */
    mode?: RuntimeMode
    /** Absolute path to cre-memoryvault directory. */
    creProjectDir?: string
    /** Timeout per invocation in milliseconds. */
    timeoutMs?: number
    /** Optional explicit workflow IDs override. */
    workflowIds?: WorkflowIdMap
    /** Optional explicit gateway URL/private key override. */
    gatewayUrl?: string
    signerPrivateKey?: string
}

/** Tool-to-workflow directory mapping (relative to creProjectDir). */
const TOOL_WORKFLOW_DIRS: Record<string, string> = {
    'uniswap-v3-lp': 'tools/uniswap-v3-lp',
}

/** CRE project target names for the legacy Sepolia workflow stack. */
const LEGACY_SCAN_TARGET = 'staging-settings'
const LEGACY_MONITOR_TARGET = 'monitor-staging-settings'

export class CRETrigger {
    private readonly mode: RuntimeMode
    private readonly creProjectDir: string
    private readonly timeoutMs: number
    private readonly workflowIds: WorkflowIdMap
    private readonly deployedClient: DeployedTriggerClient | null
    private readonly deploymentTarget = loadDeploymentTargetConfig()

    constructor(private readonly config: CRETriggerConfig = {}) {
        this.mode = config.mode ?? resolveRuntimeMode(process.env.CRE_RUNTIME_MODE)
        this.creProjectDir = config.creProjectDir
            ?? fileURLToPath(new URL('../cre-memoryvault', import.meta.url))
        this.timeoutMs = config.timeoutMs ?? 60_000
        this.workflowIds = config.workflowIds ?? loadWorkflowIdsFromEnv()

        const auth = loadTriggerAuthConfig()
        const gatewayUrl = config.gatewayUrl ?? auth.gatewayUrl
        const privateKey = config.signerPrivateKey ?? auth.privateKey

        if (hasDeployedTriggerConfig({ gatewayUrl, privateKey })) {
            this.deployedClient = new DeployedTriggerClient({
                gatewayUrl: gatewayUrl!,
                privateKey: privateKey!,
                timeoutMs: this.timeoutMs,
            })
        } else {
            this.deployedClient = null
        }
    }

    async getScanResults(toolId: string): Promise<ToolResponse | null> {
        const workflowDir = TOOL_WORKFLOW_DIRS[toolId]
        if (!workflowDir) {
            console.warn(`[CRETrigger] No workflow dir registered for toolId: ${toolId}`)
            return null
        }

        if (!this.deploymentTarget.supportsLegacyCreStack) {
            console.warn(
                `[CRETrigger] ${this.deploymentTarget.label} does not use CRE scan workflows. ` +
                'Implement the Hedera tool adapter before invoking scan.'
            )
            return null
        }

        if (this.mode !== 'simulate') {
            const deployed = await this.runDeployed(toolId, 'scan')
            if (deployed) return deployed
            if (this.mode === 'deployed') return null
        }

        console.log(`[CRETrigger] Running scanner sim for tool: ${toolId}`)
        return this.runSimulate(workflowDir, LEGACY_SCAN_TARGET)
    }

    async getMonitorResults(toolId: string): Promise<ToolResponse | null> {
        const workflowDir = TOOL_WORKFLOW_DIRS[toolId]
        if (!workflowDir) {
            console.warn(`[CRETrigger] No workflow dir registered for toolId: ${toolId}`)
            return null
        }

        if (!this.deploymentTarget.supportsLegacyCreStack) {
            console.warn(
                `[CRETrigger] ${this.deploymentTarget.label} does not use CRE monitor workflows. ` +
                'Implement the Hedera tool adapter before invoking monitor.'
            )
            return null
        }

        if (this.mode !== 'simulate') {
            const deployed = await this.runDeployed(toolId, 'monitor')
            if (deployed) return deployed
            if (this.mode === 'deployed') return null
        }

        console.log(`[CRETrigger] Running monitor sim for tool: ${toolId}`)
        return this.runSimulate(workflowDir, LEGACY_MONITOR_TARGET)
    }

    private resolveWorkflowId(toolId: string, action: 'scan' | 'monitor'): string | null {
        if (toolId !== 'uniswap-v3-lp') return null
        return action === 'scan' ? (this.workflowIds.scanner ?? null) : (this.workflowIds.monitor ?? null)
    }

    private async runDeployed(
        toolId: string,
        action: 'scan' | 'monitor'
    ): Promise<ToolResponse | null> {
        if (!this.deployedClient) {
            if (this.mode === 'deployed') {
                console.error('[CRETrigger] deploy mode selected but gateway/private key config is missing')
            }
            return null
        }

        const workflowId = this.resolveWorkflowId(toolId, action)
        if (!workflowId) {
            console.warn(`[CRETrigger] No deployed workflow ID configured for ${toolId}:${action}`)
            return null
        }

        try {
            const raw = await this.deployedClient.triggerWorkflow({
                workflowId,
                input: {
                    action,
                    toolId,
                },
            })
            const response = coerceToolResponse(raw)
            if (!response) {
                throw new Error(`Unable to coerce deployed response into ToolResponse: ${JSON.stringify(raw).slice(0, 300)}`)
            }

            console.log(
                `[CRETrigger] Deployed ${action} success: status=${response.status} ` +
                `toolId=${response.toolId} opportunities=${response.opportunities?.length ?? 0}`
            )
            return response
        } catch (error) {
            console.error(
                `[CRETrigger] Deployed ${action} trigger failed for ${toolId}: ${String(error)}`
            )
            return null
        }
    }

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
                    maxBuffer: 10 * 1024 * 1024,
                }
            )
            stdoutText = result.stdout
        } catch (err: any) {
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

function coerceToolResponse(value: unknown): ToolResponse | null {
    if (typeof value === 'string') {
        const trimmed = value.trim()
        if (!trimmed) return null
        try {
            return coerceToolResponse(JSON.parse(trimmed))
        } catch {
            return null
        }
    }

    if (value == null || typeof value !== 'object') {
        return null
    }

    const maybe = value as Partial<ToolResponse>
    if (!maybe.status || !maybe.action || !maybe.toolId) {
        return null
    }

    return maybe as ToolResponse
}

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

        if (typeof parsed === 'object' && parsed !== null) {
            const toolResponse = parsed as ToolResponse
            console.log(
                `[CRETrigger] Parsed result: status=${toolResponse.status} ` +
                `action=${toolResponse.action} toolId=${toolResponse.toolId} ` +
                `opportunities=${toolResponse.opportunities?.length ?? 0}`
            )
            return toolResponse
        }

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
