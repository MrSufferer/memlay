import type { HederaEnvConfig, HederaNetwork } from '../env'

export interface HederaAgentProfileInput {
    name: string
    description: string
    type?: 'autonomous' | 'manual'
    model?: string
    capabilities?: number[]
    social?: Record<string, string>
    properties?: Record<string, unknown>
    profilePicture: {
        buffer: Buffer
        fileName: string
    }
}

export interface HederaAgentBootstrapResult {
    accountId: string
    privateKeyRef: string
    inboundTopicId: string
    outboundTopicId: string
    profileTopicId: string
    network: HederaNetwork
    created: boolean
    operatorId?: string
    agentPrivateKey?: string
}

export interface HederaAgentProfileSnapshot {
    inboundTopicId?: string
    outboundTopicId?: string
}

export interface HederaCreateAgentResult {
    accountId: string
    privateKey?: string
    inboundTopicId: string
    outboundTopicId: string
    profileTopicId: string
    operatorId?: string
}

export interface HederaIdentityAdapter {
    createAndRegisterAgent(args: {
        env: HederaEnvConfig
        profile: HederaAgentProfileInput
    }): Promise<HederaCreateAgentResult>
    getAgentProfile(args: {
        env: HederaEnvConfig
        agentAccountId: string
    }): Promise<HederaAgentProfileSnapshot>
    getAccountMemo(args: {
        env: HederaEnvConfig
        accountId: string
    }): Promise<string | null>
}

export interface HederaIdentityBootstrapOptions {
    adapter?: HederaIdentityAdapter
}

function assertSupportedHolNetwork(network: HederaNetwork): 'mainnet' | 'testnet' {
    if (network === 'mainnet' || network === 'testnet') {
        return network
    }

    throw new Error(
        `[hedera-bootstrap] HCS bootstrap currently supports mainnet/testnet only; received ${network}`
    )
}

function requireCreateProfile(
    profile: HederaAgentProfileInput | undefined
): HederaAgentProfileInput {
    if (!profile) {
        throw new Error(
            '[hedera-bootstrap] Profile metadata with a profile picture is required when creating a new agent'
        )
    }

    if (!profile.name.trim()) {
        throw new Error('[hedera-bootstrap] Agent profile name is required')
    }

    if (!profile.description.trim()) {
        throw new Error('[hedera-bootstrap] Agent profile description is required')
    }

    if (!profile.profilePicture.buffer.byteLength || !profile.profilePicture.fileName.trim()) {
        throw new Error(
            '[hedera-bootstrap] A non-empty profile picture buffer and filename are required when creating a new agent'
        )
    }

    return profile
}

export function parseProfileTopicIdFromAccountMemo(
    memo: string | null | undefined
): string | null {
    const normalized = memo?.trim()
    if (!normalized) {
        return null
    }

    const match = normalized.match(/^hcs-11:hcs:\/\/\d+\/(.+)$/)
    return match?.[1] ?? null
}

function normalizeRegistrationResultValue(
    result: unknown,
    key: 'accountId' | 'privateKey' | 'inboundTopicId' | 'outboundTopicId' | 'profileTopicId'
): string | undefined {
    if (!result || typeof result !== 'object') {
        return undefined
    }

    const candidate = result as Record<string, unknown>
    const direct = candidate[key]
    if (typeof direct === 'string' && direct.trim()) {
        return direct
    }

    const metadata = candidate.metadata
    if (metadata && typeof metadata === 'object') {
        const metadataValue = (metadata as Record<string, unknown>)[key]
        if (typeof metadataValue === 'string' && metadataValue.trim()) {
            return metadataValue
        }
    }

    const state = candidate.state
    if (state && typeof state === 'object') {
        const stateValue = (state as Record<string, unknown>)[key]
        if (typeof stateValue === 'string' && stateValue.trim()) {
            return stateValue
        }
    }

    return undefined
}

function normalizeRegistrationOperatorId(result: unknown): string | undefined {
    if (!result || typeof result !== 'object') {
        return undefined
    }

    const candidate = result as Record<string, unknown>
    if (typeof candidate.operatorId === 'string' && candidate.operatorId.trim()) {
        return candidate.operatorId
    }

    const metadata = candidate.metadata
    if (metadata && typeof metadata === 'object') {
        const metadataValue = (metadata as Record<string, unknown>).operatorId
        if (typeof metadataValue === 'string' && metadataValue.trim()) {
            return metadataValue
        }
    }

    return undefined
}

export function normalizeHederaCreateAgentResult(result: unknown): HederaCreateAgentResult {
    return {
        accountId: normalizeRegistrationResultValue(result, 'accountId') ?? '',
        privateKey: normalizeRegistrationResultValue(result, 'privateKey'),
        inboundTopicId: normalizeRegistrationResultValue(result, 'inboundTopicId') ?? '',
        outboundTopicId: normalizeRegistrationResultValue(result, 'outboundTopicId') ?? '',
        profileTopicId: normalizeRegistrationResultValue(result, 'profileTopicId') ?? '',
        operatorId: normalizeRegistrationOperatorId(result),
    }
}

function resolveExistingPrivateKeyRef(env: HederaEnvConfig): string {
    switch (env.agentPrivateKeySource) {
        case 'env':
            return 'env:HEDERA_AGENT_KEY'
        case 'file':
            return 'file:HEDERA_AGENT_KEY_FILE'
        default:
            return 'env:HEDERA_OPERATOR_KEY'
    }
}

async function createDefaultIdentityAdapter(): Promise<HederaIdentityAdapter> {
    const [{ HCS10Client }, sdk] = await Promise.all([
        import('@hashgraphonline/standards-agent-kit'),
        import('@hashgraph/sdk'),
    ])

    return {
        async createAndRegisterAgent({ env, profile }) {
            const network = assertSupportedHolNetwork(env.network)
            const client = new HCS10Client(
                env.operatorAccountId,
                env.operatorPrivateKey,
                network
            )

            const result = await client.createAndRegisterAgent({
                name: profile.name,
                description: profile.description,
                type: profile.type,
                model: profile.model,
                capabilities: profile.capabilities,
                social: profile.social,
                properties: profile.properties,
                pfpBuffer: profile.profilePicture.buffer,
                pfpFileName: profile.profilePicture.fileName,
            })

            return normalizeHederaCreateAgentResult(result)
        },
        async getAgentProfile({ env, agentAccountId }) {
            const network = assertSupportedHolNetwork(env.network)
            const client = new HCS10Client(
                env.operatorAccountId,
                env.operatorPrivateKey,
                network
            )

            const profile = await client.getAgentProfile(agentAccountId)
            return {
                inboundTopicId: profile.inboundTopicId,
                outboundTopicId: profile.outboundTopicId,
            }
        },
        async getAccountMemo({ env, accountId }) {
            const client = sdk.Client.forName(env.network)
            client.setOperator(
                sdk.AccountId.fromString(env.operatorAccountId),
                sdk.PrivateKey.fromString(env.operatorPrivateKey)
            )

            try {
                const info = await new sdk.AccountInfoQuery()
                    .setAccountId(sdk.AccountId.fromString(accountId))
                    .execute(client)
                return info.accountMemo ?? null
            } finally {
                client.close()
            }
        },
    }
}

export async function createOrAttachHederaAgent(
    env: HederaEnvConfig,
    profile?: HederaAgentProfileInput,
    options: HederaIdentityBootstrapOptions = {}
): Promise<HederaAgentBootstrapResult> {
    const adapter = options.adapter ?? await createDefaultIdentityAdapter()

    if (env.agentAccountId && env.agentPrivateKey) {
        const [agentProfile, accountMemo] = await Promise.all([
            adapter.getAgentProfile({
                env,
                agentAccountId: env.agentAccountId,
            }),
            adapter.getAccountMemo({
                env,
                accountId: env.agentAccountId,
            }),
        ])

        if (!agentProfile.inboundTopicId || !agentProfile.outboundTopicId) {
            throw new Error(
                '[hedera-bootstrap] Existing agent profile is incomplete: missing inbound/outbound topic metadata'
            )
        }

        const profileTopicId = parseProfileTopicIdFromAccountMemo(accountMemo)
        if (!profileTopicId) {
            throw new Error(
                '[hedera-bootstrap] Existing agent account memo is missing an HCS-11 profile reference'
            )
        }

        return {
            accountId: env.agentAccountId,
            privateKeyRef: resolveExistingPrivateKeyRef(env),
            inboundTopicId: agentProfile.inboundTopicId,
            outboundTopicId: agentProfile.outboundTopicId,
            profileTopicId,
            network: env.network,
            created: false,
        }
    }

    const createProfile = requireCreateProfile(profile)
    const result = await adapter.createAndRegisterAgent({
        env,
        profile: createProfile,
    })

    return {
        accountId: result.accountId,
        privateKeyRef: 'runtime:generated-agent-key',
        inboundTopicId: result.inboundTopicId,
        outboundTopicId: result.outboundTopicId,
        profileTopicId: result.profileTopicId,
        network: env.network,
        created: true,
        operatorId: result.operatorId,
        agentPrivateKey: result.privateKey,
    }
}
