import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import type { HederaEnvConfig } from '../env'
import type { HederaAgentBootstrapResult } from './bootstrap'

export interface PersistedHederaAgentState {
    version: 1
    accountId: string
    privateKeyRef: string
    inboundTopicId: string
    outboundTopicId: string
    profileTopicId: string
    network: HederaEnvConfig['network']
    createdAt: string
    updatedAt: string
}

export interface HederaAgentStateSaveOptions {
    generatedKeyPath?: string
}

export interface ResolvedHederaAgentState extends PersistedHederaAgentState {
    agentPrivateKey: string
}

function isPersistedState(value: unknown): value is PersistedHederaAgentState {
    if (!value || typeof value !== 'object') {
        return false
    }

    const candidate = value as Record<string, unknown>
    return candidate.version === 1 &&
        typeof candidate.accountId === 'string' &&
        typeof candidate.privateKeyRef === 'string' &&
        typeof candidate.inboundTopicId === 'string' &&
        typeof candidate.outboundTopicId === 'string' &&
        typeof candidate.profileTopicId === 'string' &&
        typeof candidate.network === 'string' &&
        typeof candidate.createdAt === 'string' &&
        typeof candidate.updatedAt === 'string'
}

function deriveGeneratedKeyPath(statePath: string): string {
    const extension = extname(statePath)
    if (!extension) {
        return `${statePath}.agent.key`
    }

    return `${statePath.slice(0, -extension.length)}.agent.key`
}

async function ensureParentDir(path: string): Promise<void> {
    await mkdir(dirname(path), {
        recursive: true,
        mode: 0o700,
    })
}

async function writeRestrictedFile(path: string, content: string): Promise<void> {
    await ensureParentDir(path)
    await writeFile(path, content, {
        encoding: 'utf8',
        mode: 0o600,
    })
    await chmod(path, 0o600)
}

async function writeGeneratedPrivateKey(
    path: string,
    privateKey: string
): Promise<void> {
    const normalized = `${privateKey.trim()}\n`

    try {
        const existing = await readFile(path, 'utf8')
        if (existing === normalized) {
            return
        }

        throw new Error(
            `[hedera-state] Refusing to overwrite existing generated key at ${path}`
        )
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error
        }
    }

    await writeRestrictedFile(path, normalized)
}

function normalizeOptional(value: string | undefined): string | undefined {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
}

async function readSecretFile(path: string): Promise<string> {
    const value = normalizeOptional(await readFile(path, 'utf8'))
    if (!value) {
        throw new Error(`[hedera-state] Secret file was empty: ${path}`)
    }

    return value
}

export class HederaAgentStateStore {
    private readonly statePath: string

    constructor(statePath: string) {
        this.statePath = resolve(statePath)
    }

    async load(): Promise<PersistedHederaAgentState | null> {
        let raw: string

        try {
            raw = await readFile(this.statePath, 'utf8')
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return null
            }
            throw error
        }

        let parsed: unknown
        try {
            parsed = JSON.parse(raw)
        } catch (error) {
            throw new Error(
                `[hedera-state] Failed to parse state file ${this.statePath}: ${String(error)}`
            )
        }

        if (!isPersistedState(parsed)) {
            throw new Error(
                `[hedera-state] State file ${this.statePath} is missing required Hedera agent fields`
            )
        }

        return parsed
    }

    async save(
        env: HederaEnvConfig,
        bootstrap: HederaAgentBootstrapResult,
        options: HederaAgentStateSaveOptions = {}
    ): Promise<PersistedHederaAgentState> {
        const existing = await this.load()
        const timestamp = new Date().toISOString()

        let privateKeyRef = bootstrap.privateKeyRef
        if (bootstrap.created) {
            if (!bootstrap.agentPrivateKey) {
                throw new Error(
                    '[hedera-state] Cannot persist a generated agent without the generated private key'
                )
            }

            const keyPath = resolve(
                options.generatedKeyPath ?? deriveGeneratedKeyPath(this.statePath)
            )
            await writeGeneratedPrivateKey(keyPath, bootstrap.agentPrivateKey)
            privateKeyRef = `file:${keyPath}`
        }

        const state: PersistedHederaAgentState = {
            version: 1,
            accountId: bootstrap.accountId,
            privateKeyRef,
            inboundTopicId: bootstrap.inboundTopicId,
            outboundTopicId: bootstrap.outboundTopicId,
            profileTopicId: bootstrap.profileTopicId,
            network: env.network,
            createdAt: existing?.createdAt ?? timestamp,
            updatedAt: timestamp,
        }

        await writeRestrictedFile(
            this.statePath,
            `${JSON.stringify(state, null, 2)}\n`
        )

        return state
    }

    async getFileMode(): Promise<number> {
        const info = await stat(this.statePath)
        return info.mode & 0o777
    }

    async resolveAgentState(
        env: HederaEnvConfig,
        rawEnv: Record<string, string | undefined> = process.env
    ): Promise<ResolvedHederaAgentState> {
        const state = await this.load()
        if (!state) {
            throw new Error(
                `[hedera-state] No persisted Hedera agent state found at ${this.statePath}`
            )
        }

        if (env.agentAccountId && env.agentAccountId !== state.accountId) {
            throw new Error(
                `[hedera-state] HEDERA_AGENT_ID (${env.agentAccountId}) does not match persisted state account (${state.accountId})`
            )
        }

        if (env.network !== state.network) {
            throw new Error(
                `[hedera-state] Persisted agent network ${state.network} does not match configured network ${env.network}`
            )
        }

        if (env.agentAccountId && env.agentPrivateKey) {
            return {
                ...state,
                agentPrivateKey: env.agentPrivateKey,
                privateKeyRef: env.agentPrivateKeySource === 'file'
                    ? 'file:HEDERA_AGENT_KEY_FILE'
                    : 'env:HEDERA_AGENT_KEY',
            }
        }

        return {
            ...state,
            agentPrivateKey: await this.resolvePrivateKeyRef(state.privateKeyRef, env, rawEnv),
        }
    }

    private async resolvePrivateKeyRef(
        privateKeyRef: string,
        env: HederaEnvConfig,
        rawEnv: Record<string, string | undefined>
    ): Promise<string> {
        const separatorIndex = privateKeyRef.indexOf(':')
        if (separatorIndex === -1) {
            throw new Error(
                `[hedera-state] Unsupported private key reference: ${privateKeyRef}`
            )
        }

        const source = privateKeyRef.slice(0, separatorIndex)
        const reference = privateKeyRef.slice(separatorIndex + 1)

        if (!reference) {
            throw new Error(
                `[hedera-state] Unsupported private key reference: ${privateKeyRef}`
            )
        }

        switch (source) {
            case 'env': {
                const value = normalizeOptional(rawEnv[reference]) ??
                    (reference === 'HEDERA_OPERATOR_KEY' ? env.operatorPrivateKey : undefined) ??
                    (reference === 'HEDERA_AGENT_KEY' ? env.agentPrivateKey : undefined)

                if (!value) {
                    throw new Error(
                        `[hedera-state] Environment variable ${reference} was not set for ${privateKeyRef}`
                    )
                }

                return value
            }
            case 'file': {
                if (reference.startsWith('/')) {
                    return readSecretFile(reference)
                }

                const filePath = normalizeOptional(rawEnv[reference])
                if (!filePath) {
                    throw new Error(
                        `[hedera-state] Environment variable ${reference} was not set for ${privateKeyRef}`
                    )
                }

                return readSecretFile(filePath)
            }
            default:
                throw new Error(
                    `[hedera-state] Unsupported private key reference source: ${privateKeyRef}`
                )
        }
    }
}
