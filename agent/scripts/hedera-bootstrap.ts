/**
 * Hedera Agent Bootstrap — Operator Setup Script
 *
 * Sequentially:
 *   1. Load env and resolve the Hedera network
 *   2. Bootstrap (create or attach) the HCS-10/HCS-11 agent identity
 *   3. Persist the agent state to the local state store
 *   4. Publish the HCS-11 profile with MemoryVault + Bonzo metadata
 *
 * Usage (from repo root):
 *   bun --env-file=.env run agent/scripts/hedera-bootstrap.ts
 *
 * Environment variables required:
 *   HEDERA_NETWORK=mainnet|testnet
 *   HEDERA_OPERATOR_ID       — operator account (pays for HCS topic creation)
 *   HEDERA_OPERATOR_KEY      — operator private key
 *   HEDERA_STATE_STORE_PATH  — path for persisted agent state (default: .agent/hedera-state.json)
 *
 * Environment variables optional:
 *   HEDERA_AGENT_ID          — attach to an existing agent (skip bootstrap)
 *   HEDERA_AGENT_KEY         — required when HEDERA_AGENT_ID is set
 *   HEDERA_MEMORY_TOPIC_ID   — HCS topic for memory anchoring
 *   HEDERA_AGENT_PROFILE_PICTURE_PATH  — PNG/JPEG for HCS-11 profile image
 *   HEDERA_AGENT_PROFILE_NAME         — display name (default: MemoryVault Hedera)
 *   HEDERA_AGENT_PROFILE_DESCRIPTION   — bio text
 *
 * For mainnet live Bonzo execution also set:
 *   BONZO_DATA_SOURCE=contracts
 *   BONZO_EXECUTION_MODE=simulate|live
 *   BONZO_CONTRACT_RPC_URL=<hedera-json-rpc-url>
 *   BONZO_EXECUTOR_MODE=operator|dedicated
 *   BONZO_EXECUTOR_ACCOUNT_ID         — required when mode=dedicated
 *   BONZO_EXECUTOR_PRIVATE_KEY        — required when mode=dedicated
 *
 * This script is idempotent: running against an existing agent will re-publish
 * the HCS-11 profile if the profile content has changed.
 */

import { bootstrapHederaAgent } from '../hedera/identity/bootstrap-agent'
import {
    ensureHederaAgentProfile,
    loadOptionalProfilePicture,
} from '../hedera/identity/profile'
import { loadHederaEnvConfig } from '../hedera/env'

const DEFAULT_PROFILE_NAME = 'MemoryVault Hedera'
const DEFAULT_PROFILE_DESCRIPTION =
    'Autonomous Hedera deployment for Bonzo Vaults yield rotation with MemoryVault audit trail.'
const DEFAULT_PROFILE_MODEL = 'gemini-2.5-flash'
const DEFAULT_CAPABILITIES = [7, 9, 10, 13, 17, 18]

// ── Env parsing helpers ───────────────────────────────────────────────────────

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
            '[hedera-bootstrap] HEDERA_AGENT_PROFILE_CAPABILITIES must be ' +
            'a comma-separated list of non-negative integers'
        )
    }

    return capabilities
}

// ── Step 1: Bootstrap ─────────────────────────────────────────────────────────

async function stepBootstrap(rawEnv: Record<string, string | undefined>) {
    console.log('\n── Step 1: HCS-10 Agent Bootstrap ──')

    const result = await bootstrapHederaAgent({ rawEnv })

    if (result.reusedState) {
        console.log(
            `[hedera-bootstrap] Reusing existing agent state:\n` +
            `  accountId    = ${result.state.accountId}\n` +
            `  inboundTopic = ${result.state.inboundTopicId}\n` +
            `  outboundTopic= ${result.state.outboundTopicId}\n` +
            `  profileTopic = ${result.state.profileTopicId}`
        )
    } else {
        console.log(
            `[hedera-bootstrap] ${result.created ? 'Created new' : 'Attached existing'} agent:\n` +
            `  accountId    = ${result.state.accountId}\n` +
            `  inboundTopic = ${result.state.inboundTopicId}\n` +
            `  outboundTopic= ${result.state.outboundTopicId}\n` +
            `  profileTopic = ${result.state.profileTopicId}\n` +
            `  state file   = ${result.state.updatedAt}`
        )
    }

    return result.state
}

// ── Step 2: Publish HCS-11 Profile ───────────────────────────────────────────

async function stepPublishProfile(
    rawEnv: Record<string, string | undefined>,
    stateStorePath: string
) {
    console.log('\n── Step 2: HCS-11 Profile Publication ──')

    const profilePicture = await loadOptionalProfilePicture(
        normalizeOptional(rawEnv.HEDERA_AGENT_PROFILE_PICTURE_PATH)
    )

    const result = await ensureHederaAgentProfile(
        loadHederaEnvConfig(rawEnv),
        {
            name:
                normalizeOptional(rawEnv.HEDERA_AGENT_PROFILE_NAME) ??
                DEFAULT_PROFILE_NAME,
            description:
                normalizeOptional(rawEnv.HEDERA_AGENT_PROFILE_DESCRIPTION) ??
                DEFAULT_PROFILE_DESCRIPTION,
            type: rawEnv.HEDERA_AGENT_PROFILE_TYPE === 'manual' ? 'manual' : 'autonomous',
            model:
                normalizeOptional(rawEnv.HEDERA_AGENT_PROFILE_MODEL) ??
                DEFAULT_PROFILE_MODEL,
            capabilities: parseCapabilityList(
                rawEnv.HEDERA_AGENT_PROFILE_CAPABILITIES
            ),
            // creator defaults to operatorAccountId inside ensureHederaAgentProfile
            properties: {
                memoryvault: {
                    protocol: 'memoryvault',
                    deploymentTarget: 'hedera',
                    privateHttpMode: 'stub', // TEE deferred
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
                },
            },
            profilePicture,
        },
        { rawEnv }
    )

    if (!result.published) {
        console.log(
            `[hedera-profile] No update needed — HCS-11 profile at topic ${result.profileTopicId} is current.`
        )
    } else {
        console.log(
            `[hedera-profile] Published HCS-11 profile:\n` +
            `  profileTopic = ${result.profileTopicId}\n` +
            `  transaction  = ${result.transactionId ?? 'unknown'}`
        )
    }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log('=== Hedera Agent Bootstrap ===')
    console.log(`Started at ${new Date().toISOString()}`)

    // Load env once; used by all steps
    const rawEnv = process.env

    // Validate network early so we fail fast before any on-chain calls
    const network = normalizeOptional(rawEnv.HEDERA_NETWORK) ?? 'testnet'
    console.log(`Network: ${network}`)

    // Step 1: Bootstrap (idempotent — safe to re-run)
    const state = await stepBootstrap(rawEnv)

    // Step 2: Profile publication (depends on state being persisted)
    await stepPublishProfile(rawEnv, state.accountId)

    console.log('\n=== Bootstrap Complete ===')
    console.log(
        `\nNext steps:\n` +
        `  1. Add HEDERA_MEMORY_TOPIC_ID to .env and re-run to anchor memory on Hedera\n` +
        `  2. For live Bonzo execution on mainnet:\n` +
        `       bun --env-file=.env run agent/scripts/bonzo-live-trade.ts\n` +
        `     (or run the agent loop with MEMORYVAULT_DEPLOYMENT_TARGET=hedera)\n` +
        `  3. Verify HCS-10 registration:\n` +
        `       https://app.hol.live/agents/${state.accountId}`
    )
}

void main().catch((error) => {
    console.error('\n[error]', error instanceof Error ? error.message : String(error))
    process.exitCode = 1
})
