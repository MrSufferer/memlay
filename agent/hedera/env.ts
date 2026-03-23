import { readFileSync } from 'node:fs'

export type HederaNetwork = 'mainnet' | 'testnet' | 'previewnet' | 'localnet'
export type BonzoDataSource = 'contracts' | 'api' | 'mock'
export type BonzoExecutionMode = 'simulate' | 'live'
export type PrivateHttpMode = 'stub'
export type SecretSource = 'env' | 'file'
export type HederaExecutionSignerMode = 'operator' | 'dedicated'

export interface HederaSignerConfig {
    plane: 'control' | 'execution'
    owner: 'operator' | 'bonzo-executor'
    accountId: string
    privateKey: string
    privateKeySource: SecretSource
}

export interface HederaEnvConfig {
    network: HederaNetwork
    operatorAccountId: string
    operatorPrivateKey: string
    operatorPrivateKeySource: SecretSource
    agentAccountId?: string
    agentPrivateKey?: string
    agentPrivateKeySource?: SecretSource
    memoryTopicId?: string
    mirrorNodeUrl: string
    stateStorePath: string
    bonzoDataSource: BonzoDataSource
    bonzoExecutionMode: BonzoExecutionMode
    bonzoMinApyDeltaBps: number
    bonzoExecutorMode: HederaExecutionSignerMode
    bonzoExecutorAccountId?: string
    bonzoExecutorPrivateKey?: string
    bonzoExecutorPrivateKeySource?: SecretSource
    bonzoContractEnv: Record<string, string>
    privateHttpMode: PrivateHttpMode
    oauth3ProxyUrl?: string
    oauth3OwnerApprovalMode?: string
    controlPlaneSigner: HederaSignerConfig
    executionSigner: HederaSignerConfig
    signersShareAccount: boolean
}

interface SecretValue {
    value: string
    source: SecretSource
}

function normalizeOptional(value: string | undefined): string | undefined {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
}

function requireValue(name: string, value: string | undefined): string {
    const normalized = normalizeOptional(value)
    if (!normalized) {
        throw new Error(`[hedera-env] Missing required environment variable: ${name}`)
    }
    return normalized
}

function loadSecretValue(
    env: Record<string, string | undefined>,
    name: string
): SecretValue | undefined {
    const direct = normalizeOptional(env[name])
    const filePath = normalizeOptional(env[`${name}_FILE`])

    if (direct && filePath) {
        throw new Error(`[hedera-env] Set either ${name} or ${name}_FILE, not both`)
    }

    if (filePath) {
        const fromFile = normalizeOptional(readFileSync(filePath, 'utf8'))
        if (!fromFile) {
            throw new Error(`[hedera-env] Secret file for ${name} was empty: ${filePath}`)
        }
        return {
            value: fromFile,
            source: 'file',
        }
    }

    if (direct) {
        return {
            value: direct,
            source: 'env',
        }
    }

    return undefined
}

function parseHederaNetwork(value: string | undefined): HederaNetwork {
    switch (requireValue('HEDERA_NETWORK', value).toLowerCase()) {
        case 'mainnet':
        case 'testnet':
        case 'previewnet':
        case 'localnet':
            return requireValue('HEDERA_NETWORK', value).toLowerCase() as HederaNetwork
        default:
            throw new Error('[hedera-env] HEDERA_NETWORK must be one of: mainnet, testnet, previewnet, localnet')
    }
}

function parseBonzoDataSource(value: string | undefined): BonzoDataSource {
    const normalized = normalizeOptional(value) ?? 'mock'
    switch (normalized.toLowerCase()) {
        case 'contracts':
        case 'api':
        case 'mock':
            return normalized.toLowerCase() as BonzoDataSource
        default:
            throw new Error('[hedera-env] BONZO_DATA_SOURCE must be one of: contracts, api, mock')
    }
}

function parseBonzoExecutionMode(value: string | undefined): BonzoExecutionMode {
    const normalized = normalizeOptional(value) ?? 'simulate'
    switch (normalized.toLowerCase()) {
        case 'simulate':
        case 'live':
            return normalized.toLowerCase() as BonzoExecutionMode
        default:
            throw new Error('[hedera-env] BONZO_EXECUTION_MODE must be one of: simulate, live')
    }
}

function parseExecutionSignerMode(
    value: string | undefined
): HederaExecutionSignerMode {
    switch (requireValue('BONZO_EXECUTOR_MODE', value).toLowerCase()) {
        case 'operator':
        case 'dedicated':
            return requireValue('BONZO_EXECUTOR_MODE', value).toLowerCase() as HederaExecutionSignerMode
        default:
            throw new Error('[hedera-env] BONZO_EXECUTOR_MODE must be one of: operator, dedicated')
    }
}

function parseNonNegativeInt(
    name: string,
    value: string | undefined,
    defaultValue: number
): number {
    const normalized = normalizeOptional(value)
    if (!normalized) {
        return defaultValue
    }

    const parsed = Number(normalized)
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`[hedera-env] ${name} must be a non-negative integer`)
    }

    return parsed
}

function ensurePairedValues(
    leftName: string,
    leftValue: string | undefined,
    rightName: string,
    rightValue: SecretValue | undefined
): void {
    if (leftValue && !rightValue) {
        throw new Error(`[hedera-env] ${rightName} is required when ${leftName} is set`)
    }

    if (!leftValue && rightValue) {
        throw new Error(`[hedera-env] ${leftName} is required when ${rightName} is set`)
    }
}

function loadBonzoContractEnv(
    env: Record<string, string | undefined>
): Record<string, string> {
    const entries = Object.entries(env)
        .filter(([key, value]) => key.startsWith('BONZO_CONTRACT_') && Boolean(normalizeOptional(value)))
        .map(([key, value]) => [key, normalizeOptional(value)!] as const)

    return Object.fromEntries(entries)
}

export function loadHederaEnvConfig(
    env: Record<string, string | undefined> = process.env
): HederaEnvConfig {
    const operatorPrivateKey = loadSecretValue(env, 'HEDERA_OPERATOR_KEY')
    if (!operatorPrivateKey) {
        throw new Error('[hedera-env] HEDERA_OPERATOR_KEY or HEDERA_OPERATOR_KEY_FILE is required')
    }

    const agentAccountId = normalizeOptional(env.HEDERA_AGENT_ID)
    const agentPrivateKey = loadSecretValue(env, 'HEDERA_AGENT_KEY')
    ensurePairedValues('HEDERA_AGENT_ID', agentAccountId, 'HEDERA_AGENT_KEY', agentPrivateKey)

    const bonzoExecutorAccountId = normalizeOptional(env.BONZO_EXECUTOR_ACCOUNT_ID)
    const bonzoExecutorPrivateKey = loadSecretValue(env, 'BONZO_EXECUTOR_PRIVATE_KEY')
    const bonzoExecutorMode = parseExecutionSignerMode(env.BONZO_EXECUTOR_MODE)

    if (bonzoExecutorMode === 'dedicated') {
        ensurePairedValues(
            'BONZO_EXECUTOR_ACCOUNT_ID',
            bonzoExecutorAccountId,
            'BONZO_EXECUTOR_PRIVATE_KEY',
            bonzoExecutorPrivateKey
        )
    } else if (bonzoExecutorAccountId || bonzoExecutorPrivateKey) {
        throw new Error(
            '[hedera-env] BONZO_EXECUTOR_ACCOUNT_ID and BONZO_EXECUTOR_PRIVATE_KEY must be unset when BONZO_EXECUTOR_MODE=operator'
        )
    }

    const privateHttpMode = normalizeOptional(env.PRIVATE_HTTP_MODE) ?? 'stub'
    if (privateHttpMode !== 'stub') {
        throw new Error('[hedera-env] PRIVATE_HTTP_MODE must remain stub for the Hedera target')
    }

    const operatorAccountId = requireValue('HEDERA_OPERATOR_ID', env.HEDERA_OPERATOR_ID)
    const controlPlaneSigner: HederaSignerConfig = {
        plane: 'control',
        owner: 'operator',
        accountId: operatorAccountId,
        privateKey: operatorPrivateKey.value,
        privateKeySource: operatorPrivateKey.source,
    }

    const executionSigner: HederaSignerConfig = bonzoExecutorMode === 'dedicated'
        ? {
            plane: 'execution',
            owner: 'bonzo-executor',
            accountId: requireValue('BONZO_EXECUTOR_ACCOUNT_ID', bonzoExecutorAccountId),
            privateKey: bonzoExecutorPrivateKey!.value,
            privateKeySource: bonzoExecutorPrivateKey!.source,
        }
        : {
            plane: 'execution',
            owner: 'operator',
            accountId: operatorAccountId,
            privateKey: operatorPrivateKey.value,
            privateKeySource: operatorPrivateKey.source,
        }

    return {
        network: parseHederaNetwork(env.HEDERA_NETWORK),
        operatorAccountId,
        operatorPrivateKey: operatorPrivateKey.value,
        operatorPrivateKeySource: operatorPrivateKey.source,
        agentAccountId,
        agentPrivateKey: agentPrivateKey?.value,
        agentPrivateKeySource: agentPrivateKey?.source,
        memoryTopicId: normalizeOptional(env.HEDERA_MEMORY_TOPIC_ID),
        mirrorNodeUrl: requireValue('HEDERA_MIRROR_NODE_URL', env.HEDERA_MIRROR_NODE_URL),
        stateStorePath: normalizeOptional(env.HEDERA_STATE_STORE_PATH) ?? '.agent/hedera-state.json',
        bonzoDataSource: parseBonzoDataSource(env.BONZO_DATA_SOURCE),
        bonzoExecutionMode: parseBonzoExecutionMode(env.BONZO_EXECUTION_MODE),
        bonzoMinApyDeltaBps: parseNonNegativeInt(
            'BONZO_MIN_APY_DELTA_BPS',
            env.BONZO_MIN_APY_DELTA_BPS,
            0
        ),
        bonzoExecutorMode,
        bonzoExecutorAccountId: bonzoExecutorMode === 'dedicated' ? bonzoExecutorAccountId : undefined,
        bonzoExecutorPrivateKey: bonzoExecutorMode === 'dedicated' ? bonzoExecutorPrivateKey?.value : undefined,
        bonzoExecutorPrivateKeySource: bonzoExecutorMode === 'dedicated' ? bonzoExecutorPrivateKey?.source : undefined,
        bonzoContractEnv: loadBonzoContractEnv(env),
        privateHttpMode: 'stub',
        oauth3ProxyUrl: normalizeOptional(env.OAUTH3_PROXY_URL),
        oauth3OwnerApprovalMode: normalizeOptional(env.OAUTH3_OWNER_APPROVAL_MODE),
        controlPlaneSigner,
        executionSigner,
        signersShareAccount: controlPlaneSigner.accountId === executionSigner.accountId,
    }
}
