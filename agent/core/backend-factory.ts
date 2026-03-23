import type { ToolRequest } from '../../cre-memoryvault/protocol/tool-interface'
import { CRETrigger } from '../cre-trigger'
import {
    loadDeploymentTargetConfig,
    type DeploymentTargetConfig,
} from '../deploy-runtime-config'
import { loadHederaEnvConfig, type HederaEnvConfig } from '../hedera/env'
import {
    HederaBonzoLiveTransport,
    validateHederaBonzoLiveConfig,
} from '../hedera/bonzo-live-transport'
import {
    HederaMemoryRuntime,
    loadHederaMemoryConfig,
} from '../hedera/memory/runtime'
import { MemoryClient } from '../memory-client'
import {
    BONZO_TOOL_ID,
} from '../tools/bonzo-vaults/opportunities'
import { BonzoVaultExecutor } from '../tools/bonzo-vaults/execution'
import { HederaBonzoToolRuntime } from '../tools/bonzo-vaults/runtime'
import { ZamaConfidentialTransferClient } from '../zama-confidential-client'
import type {
    AgentBackend,
    AgentExecutionRuntime,
    AgentMemoryRuntime,
    AgentToolRuntime,
} from './backend'

class SepoliaToolRuntime implements AgentToolRuntime {
    constructor(private readonly trigger: CRETrigger) {}

    async scan(toolId: string) {
        return this.trigger.getScanResults(toolId)
    }

    async monitor(toolId: string) {
        return this.trigger.getMonitorResults(toolId)
    }
}

class SepoliaMemoryRuntime implements AgentMemoryRuntime {
    constructor(private readonly memoryClient: MemoryClient) {}

    async commitEntry(args: {
        agentId: string
        entryKey: string
        entryData: any
    }) {
        await this.memoryClient.commitEntry(args)
    }
}

class SepoliaExecutionRuntime implements AgentExecutionRuntime {
    constructor(private readonly zamaTransfer: ZamaConfidentialTransferClient) {}

    async enterPosition(args: {
        toolId: string
        request: ToolRequest
    }) {
        const amount = parseExecutionAmount(args.request)
        await this.zamaTransfer.privateTransfer({
            recipient:
                process.env.LP_POSITION_CONFIDENTIAL_ADDRESS ||
                process.env.LP_POSITION_SHIELDED_ADDRESS ||
                '0x0000000000000000000000000000000000000001',
            token:
                process.env.ZAMA_CONFIDENTIAL_TOKEN_ADDRESS ||
                process.env.TOKEN_ADDRESS ||
                '0x0000000000000000000000000000000000000002',
            amount,
        })
    }

    async exitPosition(args: {
        toolId: string
        request: ToolRequest
    }) {
        const amount = parseExecutionAmount(args.request)
        await this.zamaTransfer.privateTransfer({
            recipient:
                process.env.HOLD_WALLET_CONFIDENTIAL_ADDRESS ||
                process.env.HOLD_WALLET_SHIELDED_ADDRESS ||
                '0x0000000000000000000000000000000000000003',
            token:
                process.env.ZAMA_CONFIDENTIAL_TOKEN_ADDRESS ||
                process.env.TOKEN_ADDRESS ||
                '0x0000000000000000000000000000000000000002',
            amount,
        })
    }
}

class UnsupportedToolRuntime implements AgentToolRuntime {
    constructor(private readonly target: DeploymentTargetConfig) {}

    async scan(toolId: string) {
        throw new Error(
            `[AgentBackend] ${this.target.label} backend cannot scan ${toolId} yet. ` +
            'Implement the target-specific tool runtime first.'
        )
    }

    async monitor(toolId: string) {
        throw new Error(
            `[AgentBackend] ${this.target.label} backend cannot monitor ${toolId} yet. ` +
            'Implement the target-specific tool runtime first.'
        )
    }
}

class UnsupportedMemoryRuntime implements AgentMemoryRuntime {
    constructor(private readonly target: DeploymentTargetConfig) {}

    async commitEntry() {
        throw new Error(
            `[AgentBackend] ${this.target.label} backend cannot commit memory yet. ` +
            'Implement the target-specific memory runtime first.'
        )
    }
}

class UnsupportedExecutionRuntime implements AgentExecutionRuntime {
    constructor(private readonly target: DeploymentTargetConfig) {}

    async enterPosition() {
        throw new Error(
            `[AgentBackend] ${this.target.label} backend cannot execute positions yet. ` +
            'Implement the target-specific execution runtime first.'
        )
    }

    async exitPosition() {
        throw new Error(
            `[AgentBackend] ${this.target.label} backend cannot execute exits yet. ` +
            'Implement the target-specific execution runtime first.'
        )
    }
}

function parseExecutionAmount(request: ToolRequest): bigint {
    const raw = request.params?.amountAtomic

    if (typeof raw === 'bigint') {
        return raw
    }

    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
        return BigInt(raw)
    }

    if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) {
        return BigInt(raw)
    }

    throw new Error(
        '[AgentBackend] request.params.amountAtomic must be a non-negative integer string for the Sepolia execution runtime'
    )
}

class HederaAgentMemoryRuntime implements AgentMemoryRuntime {
    private runtime: HederaMemoryRuntime | null = null

    constructor(private readonly env: HederaEnvConfig) {}

    async commitEntry(args: {
        agentId: string
        entryKey: string
        entryData: any
    }) {
        if (!this.runtime) {
            this.runtime = new HederaMemoryRuntime({
                config: loadHederaMemoryConfig(this.env),
            })
        }

        await this.runtime.commitEntry(args)
    }
}

class HederaToolRuntime implements AgentToolRuntime {
    private runtime: HederaBonzoToolRuntime | null = null

    constructor(private readonly env: HederaEnvConfig) {}

    private getRuntime(): HederaBonzoToolRuntime {
        if (!this.runtime) {
            this.runtime = new HederaBonzoToolRuntime(this.env)
        }

        return this.runtime
    }

    async scan(toolId: string) {
        return this.getRuntime().scan(toolId)
    }

    async monitor(toolId: string) {
        return this.getRuntime().monitor(toolId)
    }
}

class HederaExecutionRuntime implements AgentExecutionRuntime {
    private executor: BonzoVaultExecutor | null = null

    constructor(private readonly env: HederaEnvConfig) {
        if (env.bonzoExecutionMode === 'live') {
            this.executor = new BonzoVaultExecutor(env, {
                mode: env.bonzoExecutionMode,
                transport: new HederaBonzoLiveTransport(env),
            })
        }
    }

    private getExecutor(): BonzoVaultExecutor {
        if (!this.executor) {
            this.executor = new BonzoVaultExecutor(this.env, {
                mode: this.env.bonzoExecutionMode,
                transport:
                    this.env.bonzoExecutionMode === 'live'
                        ? new HederaBonzoLiveTransport(this.env)
                        : undefined,
            })
        }

        return this.executor
    }

    async enterPosition(args: { toolId: string; request: ToolRequest }) {
        if (args.toolId !== BONZO_TOOL_ID) {
            throw new Error(
                `[AgentBackend] Hedera execution runtime cannot enter positions for ${args.toolId} yet.`
            )
        }

        await this.getExecutor().enter(args.request)
    }

    async exitPosition(args: { toolId: string; request: ToolRequest }) {
        if (args.toolId !== BONZO_TOOL_ID) {
            throw new Error(
                `[AgentBackend] Hedera execution runtime cannot exit positions for ${args.toolId} yet.`
            )
        }

        await this.getExecutor().exit(args.request)
    }
}

function createSepoliaBackend(target: DeploymentTargetConfig): AgentBackend {
    const trigger = new CRETrigger()
    const memoryClient = new MemoryClient()
    const zamaTransfer = new ZamaConfidentialTransferClient({
        mode:
            process.env.ZAMA_TRANSFER_MODE === 'onchain'
                ? 'onchain'
                : 'simulate',
        rpcUrl: process.env.ZAMA_RPC_URL || process.env.RPC_URL,
        chainId: Number(process.env.ZAMA_CHAIN_ID || process.env.ERC8004_CHAIN_ID || 11155111),
        privateKey: process.env.ZAMA_PRIVATE_KEY || process.env.CRE_ETH_PRIVATE_KEY,
        tokenAddress: process.env.ZAMA_CONFIDENTIAL_TOKEN_ADDRESS || process.env.TOKEN_ADDRESS,
        encryptedInputsJson: process.env.ZAMA_ENCRYPTED_INPUTS_JSON,
        defaultHandle: process.env.ZAMA_DEFAULT_HANDLE,
        defaultInputProof: process.env.ZAMA_DEFAULT_INPUT_PROOF,
        waitForReceipt: process.env.ZAMA_WAIT_FOR_RECEIPT !== 'false',
    })

    return {
        target: target.id,
        label: target.label,
        tools: new SepoliaToolRuntime(trigger),
        memory: new SepoliaMemoryRuntime(memoryClient),
        execution: new SepoliaExecutionRuntime(zamaTransfer),
    }
}

function createUnsupportedBackend(target: DeploymentTargetConfig): AgentBackend {
    return {
        target: target.id,
        label: target.label,
        tools: new UnsupportedToolRuntime(target),
        memory: new UnsupportedMemoryRuntime(target),
        execution: new UnsupportedExecutionRuntime(target),
    }
}

function createHederaBackend(target: DeploymentTargetConfig): AgentBackend {
    const env = loadHederaEnvConfig()
    validateHederaBonzoLiveConfig(env)

    return {
        target: target.id,
        label: target.label,
        tools: new HederaToolRuntime(env),
        memory: new HederaAgentMemoryRuntime(env),
        execution: new HederaExecutionRuntime(env),
    }
}

export function createAgentBackend(): AgentBackend {
    const target = loadDeploymentTargetConfig()

    switch (target.id) {
        case 'sepolia':
            return createSepoliaBackend(target)
        case 'hedera':
            return createHederaBackend(target)
        default:
            return createUnsupportedBackend(target)
    }
}
