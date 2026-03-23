import { loadHederaEnvConfig } from '../env'
import { ensureHederaAgentProfile, loadOptionalProfilePicture } from './profile'

const DEFAULT_PROFILE_NAME = 'MemoryVault Hedera'
const DEFAULT_PROFILE_DESCRIPTION =
    'Autonomous Hedera deployment for Bonzo Vaults with MemoryVault audit commitments.'
const DEFAULT_PROFILE_MODEL = 'gemini-2.5-flash'
const DEFAULT_CAPABILITIES = [7, 9, 10, 13, 17, 18]

function normalizeOptional(value: string | undefined): string | undefined {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
}

function parseCapabilityList(rawValue: string | undefined): number[] {
    const normalized = normalizeOptional(rawValue)
    if (!normalized) {
        return DEFAULT_CAPABILITIES
    }

    const capabilities = normalized
        .split(',')
        .map((entry) => Number(entry.trim()))

    if (
        capabilities.length === 0 ||
        capabilities.some((entry) => !Number.isInteger(entry) || entry < 0)
    ) {
        throw new Error(
            '[hedera-profile] HEDERA_AGENT_PROFILE_CAPABILITIES must be a comma-separated list of non-negative integers'
        )
    }

    return capabilities
}

function buildWorkflowEndpointMap(
    gatewayUrl: string | undefined,
    workflowIds: Record<string, string | undefined>
): Record<string, unknown> | undefined {
    const endpoints = Object.entries(workflowIds)
        .filter(([, workflowId]) => Boolean(workflowId))
        .map(([workflowName, workflowId]) => {
            const endpoint = gatewayUrl
                ? `${gatewayUrl.replace(/\/+$/, '')}/workflows/${workflowId}`
                : undefined

            return [
                workflowName,
                {
                    workflowId,
                    endpoint,
                },
            ] as const
        })

    return endpoints.length > 0 ? Object.fromEntries(endpoints) : undefined
}

async function main(): Promise<void> {
    const env = loadHederaEnvConfig()
    const gatewayUrl = normalizeOptional(process.env.CRE_GATEWAY_URL)
    const workflowEndpoints = buildWorkflowEndpointMap(gatewayUrl, {
        scanner: normalizeOptional(process.env.CRE_WORKFLOW_ID_SCANNER),
        monitor: normalizeOptional(process.env.CRE_WORKFLOW_ID_MONITOR),
        memoryWriter: normalizeOptional(process.env.CRE_WORKFLOW_ID_MEMORY_WRITER),
        auditReader: normalizeOptional(process.env.CRE_WORKFLOW_ID_AUDIT_READER),
    })

    const result = await ensureHederaAgentProfile(env, {
        name: normalizeOptional(process.env.HEDERA_AGENT_PROFILE_NAME) ?? DEFAULT_PROFILE_NAME,
        description:
            normalizeOptional(process.env.HEDERA_AGENT_PROFILE_DESCRIPTION) ??
            DEFAULT_PROFILE_DESCRIPTION,
        type: process.env.HEDERA_AGENT_PROFILE_TYPE === 'manual' ? 'manual' : 'autonomous',
        model: normalizeOptional(process.env.HEDERA_AGENT_PROFILE_MODEL) ?? DEFAULT_PROFILE_MODEL,
        capabilities: parseCapabilityList(process.env.HEDERA_AGENT_PROFILE_CAPABILITIES),
        creator: normalizeOptional(process.env.HEDERA_AGENT_PROFILE_CREATOR) ?? env.operatorAccountId,
        properties: {
            memoryvault: {
                protocol: 'memoryvault',
                deploymentTarget: 'hedera',
                privateHttpMode: env.privateHttpMode,
                mirrorNodeUrl: env.mirrorNodeUrl,
                memoryTopicId: env.memoryTopicId,
                bonzo: {
                    dataSource: env.bonzoDataSource,
                    minApyDeltaBps: env.bonzoMinApyDeltaBps,
                    executorMode: env.bonzoExecutorMode,
                },
                tools: {
                    bonzoVaults: {
                        venue: 'bonzo-vaults',
                        supportedOperations: {
                            scan: true,
                            enter: true,
                            exit: true,
                            monitor: true,
                        },
                    },
                },
                workflows: workflowEndpoints,
            },
        },
        profilePicture: await loadOptionalProfilePicture(
            process.env.HEDERA_AGENT_PROFILE_PICTURE_PATH
        ),
    })

    if (!result.published) {
        console.log(
            `[hedera-profile] HCS-11 profile already current at topic ${result.profileTopicId}`
        )
        return
    }

    console.log(
        `[hedera-profile] Published HCS-11 profile topic ${result.profileTopicId} ` +
        `(previous ${result.previousProfileTopicId}, tx ${result.transactionId ?? 'unknown'})`
    )
}

void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
})
