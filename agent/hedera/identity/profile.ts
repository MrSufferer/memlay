import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { HederaEnvConfig } from '../env'
import { HederaAgentStateStore, type ResolvedHederaAgentState } from './state-store'

export interface HederaAgentProfilePublishInput {
    name: string
    description: string
    type?: 'autonomous' | 'manual'
    model?: string
    capabilities: number[]
    social?: Record<string, string>
    creator?: string
    properties?: Record<string, unknown>
    profilePicture?: {
        buffer: Buffer
        fileName: string
    }
}

export interface HederaAgentProfileSnapshot {
    displayName?: string
    alias?: string
    bio?: string
    profileImage?: string
    inboundTopicId?: string
    outboundTopicId?: string
    socials?: Array<{
        platform: string
        handle: string
    }>
    properties?: Record<string, unknown>
    aiAgent?: {
        type?: number
        capabilities?: number[]
        model?: string
        creator?: string
    }
}

export interface HederaPublishedProfileResult {
    published: boolean
    profileTopicId: string
    transactionId?: string
    previousProfileTopicId: string
}

export interface HederaProfileAdapter {
    getAgentProfile(args: {
        env: HederaEnvConfig
        agentAccountId: string
    }): Promise<HederaAgentProfileSnapshot>
    publishAgentProfile(args: {
        env: HederaEnvConfig
        identity: ResolvedHederaAgentState
        profile: HederaAgentProfilePublishInput
        existingPfpTopicId?: string
    }): Promise<{
        profileTopicId: string
        transactionId: string
    }>
}

export interface HederaEnsureProfileOptions {
    adapter?: HederaProfileAdapter
    store?: HederaAgentStateStore
    rawEnv?: Record<string, string | undefined>
}

export function resolveHederaProfilePublisherSigner(
    env: HederaEnvConfig
): HederaEnvConfig['controlPlaneSigner'] {
    return env.controlPlaneSigner
}

function normalizeOptional(value: string | undefined | null): string | undefined {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
}

function slugifyProfileAlias(name: string): string {
    return name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
}

function extractTopicIdFromHcsReference(value: string | undefined): string | undefined {
    const normalized = normalizeOptional(value)
    if (!normalized) {
        return undefined
    }

    const match = normalized.match(/^hcs:\/\/\d+\/(.+)$/)
    return match?.[1]
}

function normalizeSocials(
    socials: Array<{ platform: string; handle: string }> | Record<string, string> | undefined
): Array<{ platform: string; handle: string }> {
    if (!socials) {
        return []
    }

    const entries = Array.isArray(socials)
        ? socials
        : Object.entries(socials).map(([platform, handle]) => ({
            platform,
            handle,
        }))

    return entries
        .map(({ platform, handle }) => ({
            platform: platform.trim(),
            handle: handle.trim(),
        }))
        .filter(({ platform, handle }) => Boolean(platform) && Boolean(handle))
        .sort((left, right) =>
            left.platform.localeCompare(right.platform) ||
            left.handle.localeCompare(right.handle)
        )
}

function sortObjectKeys(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortObjectKeys)
    }

    if (!value || typeof value !== 'object') {
        return value
    }

    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortObjectKeys(entryValue)] as const)

    return Object.fromEntries(entries)
}

function normalizeSnapshotForComparison(
    snapshot: HederaAgentProfileSnapshot
): Record<string, unknown> {
    return {
        displayName: normalizeOptional(snapshot.displayName) ?? '',
        alias: normalizeOptional(snapshot.alias) ?? '',
        bio: normalizeOptional(snapshot.bio) ?? '',
        profileImage: normalizeOptional(snapshot.profileImage) ?? '',
        inboundTopicId: normalizeOptional(snapshot.inboundTopicId) ?? '',
        outboundTopicId: normalizeOptional(snapshot.outboundTopicId) ?? '',
        socials: normalizeSocials(snapshot.socials),
        aiAgent: {
            type: snapshot.aiAgent?.type ?? null,
            model: normalizeOptional(snapshot.aiAgent?.model) ?? '',
            creator: normalizeOptional(snapshot.aiAgent?.creator) ?? '',
            capabilities: [...(snapshot.aiAgent?.capabilities ?? [])].sort((left, right) => left - right),
        },
        properties: sortObjectKeys(snapshot.properties ?? {}),
    }
}

function buildDesiredSnapshot(
    identity: ResolvedHederaAgentState,
    profile: HederaAgentProfilePublishInput,
    existingProfileImage?: string
): HederaAgentProfileSnapshot {
    return {
        displayName: profile.name,
        alias: slugifyProfileAlias(profile.name),
        bio: profile.description,
        profileImage: profile.profilePicture
            ? undefined
            : existingProfileImage,
        inboundTopicId: identity.inboundTopicId,
        outboundTopicId: identity.outboundTopicId,
        socials: normalizeSocials(profile.social),
        properties: profile.properties,
        aiAgent: {
            type: profile.type === 'manual' ? 0 : 1,
            model: profile.model ?? '',
            creator: profile.creator,
            capabilities: profile.capabilities,
        },
    }
}

async function createDefaultProfileAdapter(): Promise<HederaProfileAdapter> {
    const [{ HCS10Client }] = await Promise.all([
        import('@hashgraphonline/standards-agent-kit'),
    ])

    return {
        async getAgentProfile({ env, agentAccountId }) {
            const client = new HCS10Client(
                env.operatorAccountId,
                env.operatorPrivateKey,
                env.network
            )

            const response = await client.getAgentProfile(agentAccountId)
            const profile = (response.profile ?? {}) as Record<string, unknown>
            const aiAgent = profile.aiAgent as Record<string, unknown> | undefined
            const socials = Array.isArray(profile.socials)
                ? profile.socials
                    .map((entry) => {
                        if (!entry || typeof entry !== 'object') {
                            return null
                        }

                        const social = entry as Record<string, unknown>
                        if (typeof social.platform !== 'string' || typeof social.handle !== 'string') {
                            return null
                        }

                        return {
                            platform: social.platform,
                            handle: social.handle,
                        }
                    })
                    .filter((entry): entry is { platform: string; handle: string } => Boolean(entry))
                : undefined

            return {
                displayName: typeof profile.display_name === 'string' ? profile.display_name : undefined,
                alias: typeof profile.alias === 'string' ? profile.alias : undefined,
                bio: typeof profile.bio === 'string' ? profile.bio : undefined,
                profileImage: typeof profile.profileImage === 'string' ? profile.profileImage : undefined,
                inboundTopicId: typeof profile.inboundTopicId === 'string' ? profile.inboundTopicId : undefined,
                outboundTopicId: typeof profile.outboundTopicId === 'string' ? profile.outboundTopicId : undefined,
                socials,
                properties: profile.properties && typeof profile.properties === 'object'
                    ? profile.properties as Record<string, unknown>
                    : undefined,
                aiAgent: aiAgent && typeof aiAgent === 'object'
                    ? {
                        type: typeof aiAgent.type === 'number' ? aiAgent.type : undefined,
                        capabilities: Array.isArray(aiAgent.capabilities)
                            ? aiAgent.capabilities.filter((entry): entry is number => typeof entry === 'number')
                            : undefined,
                        model: typeof aiAgent.model === 'string' ? aiAgent.model : undefined,
                        creator: typeof aiAgent.creator === 'string' ? aiAgent.creator : undefined,
                    }
                    : undefined,
            }
        },
        async publishAgentProfile({ env, identity, profile, existingPfpTopicId }) {
            const publisherSigner = resolveHederaProfilePublisherSigner(env)
            const client = new HCS10Client(
                publisherSigner.accountId,
                publisherSigner.privateKey,
                env.network
            )

            const result = await client.standardClient.storeHCS11Profile(
                profile.name,
                profile.description,
                identity.inboundTopicId,
                identity.outboundTopicId,
                profile.capabilities,
                {
                    type: profile.type ?? 'autonomous',
                    model: profile.model,
                    socials: profile.social,
                    creator: profile.creator,
                    properties: profile.properties,
                },
                profile.profilePicture?.buffer,
                profile.profilePicture?.fileName,
                existingPfpTopicId
            )

            if (!result.success || !result.profileTopicId) {
                throw new Error(
                    `[hedera-profile] Failed to publish HCS-11 profile: ${result.error ?? 'unknown error'}`
                )
            }

            return {
                profileTopicId: result.profileTopicId,
                transactionId: result.transactionId,
            }
        },
    }
}

export async function loadOptionalProfilePicture(
    picturePath: string | undefined
): Promise<{ buffer: Buffer; fileName: string } | undefined> {
    const normalized = normalizeOptional(picturePath)
    if (!normalized) {
        return undefined
    }

    return {
        buffer: await readFile(normalized),
        fileName: basename(normalized),
    }
}

export async function ensureHederaAgentProfile(
    env: HederaEnvConfig,
    profile: HederaAgentProfilePublishInput,
    options: HederaEnsureProfileOptions = {}
): Promise<HederaPublishedProfileResult> {
    const store = options.store ?? new HederaAgentStateStore(env.stateStorePath)
    const identity = await store.resolveAgentState(env, options.rawEnv)
    const adapter = options.adapter ?? await createDefaultProfileAdapter()
    const currentProfile = await adapter.getAgentProfile({
        env,
        agentAccountId: identity.accountId,
    })

    const existingPfpTopicId = extractTopicIdFromHcsReference(currentProfile.profileImage)
    const desiredSnapshot = buildDesiredSnapshot(
        identity,
        profile,
        currentProfile.profileImage
    )

    if (
        !profile.profilePicture &&
        JSON.stringify(normalizeSnapshotForComparison(currentProfile)) ===
            JSON.stringify(normalizeSnapshotForComparison(desiredSnapshot))
    ) {
        return {
            published: false,
            profileTopicId: identity.profileTopicId,
            previousProfileTopicId: identity.profileTopicId,
        }
    }

    const published = await adapter.publishAgentProfile({
        env,
        identity,
        profile,
        existingPfpTopicId,
    })

    await store.save(
        env,
        {
            accountId: identity.accountId,
            privateKeyRef: identity.privateKeyRef,
            inboundTopicId: identity.inboundTopicId,
            outboundTopicId: identity.outboundTopicId,
            profileTopicId: published.profileTopicId,
            network: identity.network,
            created: false,
        }
    )

    return {
        published: true,
        profileTopicId: published.profileTopicId,
        transactionId: published.transactionId,
        previousProfileTopicId: identity.profileTopicId,
    }
}
