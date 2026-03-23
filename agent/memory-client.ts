/**
 * MemoryVault Client — commits agent reasoning to the memory-writer workflow.
 *
 * Runtime behavior:
 *   - deploy mode: signed CRE gateway trigger to deployed memory-writer
 *   - simulate mode: `cre workflow simulate protocol/memory-writer`
 *   - auto mode: try deployed first, fallback to simulation
 */

import type { MemoryEntryData } from '../cre-memoryvault/protocol/tool-interface'
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
import { loadWorkflowIdsFromEnv } from './workflow-ids'

const execFileAsync = promisify(execFile)

export interface MemoryClientConfig {
    mode?: RuntimeMode
    creProjectDir?: string
    timeoutMs?: number
    memoryWriterWorkflowId?: string
    gatewayUrl?: string
    signerPrivateKey?: string
}

export class MemoryClient {
    private readonly mode: RuntimeMode
    private readonly creProjectDir: string
    private readonly timeoutMs: number
    private readonly memoryWriterWorkflowId?: string
    private readonly deployedClient: DeployedTriggerClient | null
    private readonly deploymentTarget = loadDeploymentTargetConfig()

    constructor(private readonly config: MemoryClientConfig = {}) {
        this.mode = config.mode ?? resolveRuntimeMode(process.env.CRE_RUNTIME_MODE)
        this.creProjectDir = config.creProjectDir
            ?? fileURLToPath(new URL('../cre-memoryvault', import.meta.url))
        this.timeoutMs = config.timeoutMs ?? 60_000
        this.memoryWriterWorkflowId =
            config.memoryWriterWorkflowId ??
            loadWorkflowIdsFromEnv().memoryWriter

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

    async commitEntry(args: {
        agentId: string
        entryKey: string
        entryData: MemoryEntryData
    }): Promise<void> {
        if (!this.deploymentTarget.supportsLegacyCreStack) {
            throw new Error(
                `[MemoryClient] ${this.deploymentTarget.label} does not use the Sepolia CRE memory-writer. ` +
                'Implement the Hedera memory anchor before executing actions on this target.'
            )
        }

        if (this.mode !== 'simulate') {
            try {
                const didCommit = await this.commitViaDeployed(args)
                if (didCommit) return
            } catch (error) {
                if (this.mode === 'deployed') {
                    throw error
                }
                console.warn(`[MemoryClient] Deployed commit failed, falling back to simulate: ${String(error)}`)
            }

            if (this.mode === 'deployed') {
                throw new Error('[MemoryClient] deploy mode active and no deployed commit path succeeded')
            }
        }

        await this.commitViaSim(args)
    }

    private async commitViaDeployed(args: {
        agentId: string
        entryKey: string
        entryData: MemoryEntryData
    }): Promise<boolean> {
        if (!this.deployedClient || !this.memoryWriterWorkflowId) {
            return false
        }

        const raw = await this.deployedClient.triggerWorkflow({
            workflowId: this.memoryWriterWorkflowId,
            input: {
                agentId: args.agentId,
                entryKey: args.entryKey,
                entryData: args.entryData,
            },
        })

        const result = parseMemoryWriterResult(raw)
        if (!result) {
            throw new Error('[MemoryClient] Could not parse deployed memory-writer response')
        }

        if (result.status !== 'success') {
            throw new Error(
                `[MemoryClient] deployed memory-writer returned status=${result.status}: ${result.error ?? '(no error field)'}`
            )
        }

        console.log(
            `[MemoryClient] ✅ Deployed commit: key=${result.entryKey} ` +
            `hash=${result.entryHash?.slice(0, 12)}... s3=${result.s3Key}`
        )

        return true
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

function parseMemoryWriterResult(input: unknown): MemoryWriterResult | null {
    if (typeof input === 'string') {
        const marker = 'Simulation Result:'
        const markerIdx = input.indexOf(marker)
        if (markerIdx !== -1) {
            const after = input.slice(markerIdx + marker.length)
            const line = after
                .split('\n')
                .map(l => l.trim())
                .find(Boolean)
            if (!line) return null
            try {
                return parseMemoryWriterResult(JSON.parse(line))
            } catch {
                return null
            }
        }

        const trimmed = input.trim()
        if (!trimmed) return null
        try {
            return parseMemoryWriterResult(JSON.parse(trimmed))
        } catch {
            return null
        }
    }

    if (input == null || typeof input !== 'object') return null

    const parsed = input as Record<string, unknown>
    if (typeof parsed.status === 'string' && (parsed.status === 'success' || parsed.status === 'failed')) {
        return parsed as MemoryWriterResult
    }

    return null
}
