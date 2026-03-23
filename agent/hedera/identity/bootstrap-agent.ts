import { loadHederaEnvConfig } from '../env'
import {
    createOrAttachHederaAgent,
    type HederaAgentProfileInput,
    type HederaIdentityBootstrapOptions,
} from './bootstrap'
import { loadOptionalProfilePicture } from './profile'
import {
    HederaAgentStateStore,
    type PersistedHederaAgentState,
} from './state-store'

const DEFAULT_PROFILE_NAME = 'MemoryVault Hedera'
const DEFAULT_PROFILE_DESCRIPTION =
    'Autonomous Hedera deployment for Bonzo Vaults with MemoryVault audit commitments.'
const DEFAULT_PROFILE_MODEL = 'gemini-2.5-flash'
const DEFAULT_CAPABILITIES = [7, 9, 10, 13, 17, 18]

export interface BootstrapHederaAgentOptions extends HederaIdentityBootstrapOptions {
    rawEnv?: Record<string, string | undefined>
    store?: HederaAgentStateStore
}

export interface BootstrapHederaAgentResult {
    state: PersistedHederaAgentState
    created: boolean
    reusedState: boolean
}

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
            '[hedera-bootstrap] HEDERA_AGENT_PROFILE_CAPABILITIES must be a comma-separated list of non-negative integers'
        )
    }

    return capabilities
}

async function buildBootstrapProfile(
    rawEnv: Record<string, string | undefined>
): Promise<HederaAgentProfileInput | undefined> {
    const profilePicture = await loadOptionalProfilePicture(
        rawEnv.HEDERA_AGENT_PROFILE_PICTURE_PATH
    )

    if (!profilePicture) {
        return undefined
    }

    return {
        name: normalizeOptional(rawEnv.HEDERA_AGENT_PROFILE_NAME) ?? DEFAULT_PROFILE_NAME,
        description:
            normalizeOptional(rawEnv.HEDERA_AGENT_PROFILE_DESCRIPTION) ??
            DEFAULT_PROFILE_DESCRIPTION,
        type: rawEnv.HEDERA_AGENT_PROFILE_TYPE === 'manual' ? 'manual' : 'autonomous',
        model: normalizeOptional(rawEnv.HEDERA_AGENT_PROFILE_MODEL) ?? DEFAULT_PROFILE_MODEL,
        capabilities: parseCapabilityList(rawEnv.HEDERA_AGENT_PROFILE_CAPABILITIES),
        profilePicture,
        properties: {
            memoryvault: {
                protocol: 'memoryvault',
                deploymentTarget: 'hedera',
            },
        },
    }
}

export async function bootstrapHederaAgent(
    options: BootstrapHederaAgentOptions = {}
): Promise<BootstrapHederaAgentResult> {
    const rawEnv = options.rawEnv ?? process.env
    const env = loadHederaEnvConfig(rawEnv)
    const store = options.store ?? new HederaAgentStateStore(env.stateStorePath)

    const existingState = await store.load()
    if (existingState && !env.agentAccountId) {
        return {
            state: existingState,
            created: false,
            reusedState: true,
        }
    }

    const profile = await buildBootstrapProfile(rawEnv)
    const bootstrap = await createOrAttachHederaAgent(env, profile, options)
    const state = await store.save(env, bootstrap)

    return {
        state,
        created: bootstrap.created,
        reusedState: false,
    }
}

async function main(): Promise<void> {
    const result = await bootstrapHederaAgent()

    if (result.reusedState) {
        console.log(
            `[hedera-bootstrap] Reusing persisted agent ${result.state.accountId} ` +
            `with profile topic ${result.state.profileTopicId}`
        )
        return
    }

    console.log(
        `[hedera-bootstrap] ${result.created ? 'Created' : 'Attached'} agent ${result.state.accountId} ` +
        `with inbound ${result.state.inboundTopicId}, outbound ${result.state.outboundTopicId}, ` +
        `profile ${result.state.profileTopicId}`
    )
}

if (import.meta.main) {
    void main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
    })
}
