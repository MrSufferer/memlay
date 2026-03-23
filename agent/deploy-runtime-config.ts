export type RuntimeMode = 'auto' | 'simulate' | 'deployed'
export type DeploymentTarget = 'sepolia' | 'hedera'

export interface TriggerAuthConfig {
    gatewayUrl?: string
    privateKey?: string
}

export interface DeploymentTargetConfig {
    id: DeploymentTarget
    label: string
    identityProtocol: 'erc8004' | 'hcs'
    supportsLegacyCreStack: boolean
}

export const DEPLOYMENT_TARGETS: Record<DeploymentTarget, DeploymentTargetConfig> = {
    sepolia: {
        id: 'sepolia',
        label: 'Sepolia / ERC-8004',
        identityProtocol: 'erc8004',
        supportsLegacyCreStack: true,
    },
    hedera: {
        id: 'hedera',
        label: 'Hedera / HCS-10 + HCS-11',
        identityProtocol: 'hcs',
        supportsLegacyCreStack: false,
    },
}

export function resolveRuntimeMode(value?: string): RuntimeMode {
    switch ((value ?? '').toLowerCase()) {
        case 'simulate':
            return 'simulate'
        case 'deployed':
            return 'deployed'
        default:
            return 'auto'
    }
}

export function resolveDeploymentTarget(value?: string): DeploymentTarget {
    switch ((value ?? '').trim().toLowerCase()) {
        case 'hedera':
        case 'hedera-testnet':
        case 'hedera-mainnet':
        case 'hcs':
            return 'hedera'
        case 'sepolia':
        case 'ethereum':
        case 'erc8004':
        case 'evm':
        default:
            return 'sepolia'
    }
}

export function loadDeploymentTargetConfig(value?: string): DeploymentTargetConfig {
    const target = resolveDeploymentTarget(
        value ??
        process.env.MEMORYVAULT_DEPLOYMENT_TARGET ??
        process.env.AGENT_DEPLOYMENT_TARGET
    )
    return DEPLOYMENT_TARGETS[target]
}

export function loadTriggerAuthConfig(): TriggerAuthConfig {
    return {
        gatewayUrl: process.env.CRE_GATEWAY_URL,
        privateKey:
            process.env.CRE_HTTP_TRIGGER_PRIVATE_KEY ||
            process.env.CRE_ETH_PRIVATE_KEY ||
            process.env.PRIVATE_KEY,
    }
}

export function hasDeployedTriggerConfig(config: TriggerAuthConfig): boolean {
    return Boolean(config.gatewayUrl && config.privateKey)
}
