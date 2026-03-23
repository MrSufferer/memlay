import type { HederaEnvConfig } from '../../hedera/env'
import {
    normalizeBonzoVaultOpportunity,
    type BonzoRewardToken,
    type BonzoStrategyFamily,
    type BonzoVaultOpportunity,
} from './opportunities'

type BonzoDiscoveryMode = HederaEnvConfig['bonzoDataSource']
type BonzoLaunchStatus = 'live' | 'coming-soon'

interface BonzoVaultCatalogRecord {
    vaultId: string
    vaultName: string
    vaultType: string
    assetSymbols: string[]
    shareTokenId: string
    strategyFamily: BonzoStrategyFamily
    launchStatus: BonzoLaunchStatus
    sourceDocs: string[]
    vaultAddress?: string
    strategyAddress?: string
}

interface BonzoVaultSnapshotRecord {
    vaultId: string
    tvl?: number
    apr?: number
    apy?: number
    rewardTokens?: BonzoRewardToken[]
    fetchedAt?: string
}

export interface BonzoVaultDiscoverySource {
    discoverVaults(): Promise<BonzoVaultOpportunity[]>
}

export interface BonzoApiFetcher {
    fetch(input: string): Promise<{
        ok: boolean
        status: number
        statusText: string
        json(): Promise<unknown>
    }>
}

export interface BonzoVaultDiscoveryOptions {
    fetcher?: BonzoApiFetcher
    now?: () => Date
}

const BONZO_SINGLE_ASSET_DOC_URL =
    'https://docs.bonzo.finance/hub/bonzo-vaults-beta/vault-strategies/single-asset-dex/deployed-vaults'
const BONZO_DUAL_ASSET_DOC_URL =
    'https://docs.bonzo.finance/hub/bonzo-vaults-beta/vault-strategies/dual-asset-dex/deployed-vaults'
const BONZO_CONTRACTS_DOC_URL =
    'https://docs.bonzo.finance/hub/developer/bonzo-vaults-beta/vaults-contracts'

const OFFICIAL_BONZO_VAULT_CATALOG: BonzoVaultCatalogRecord[] = [
    {
        vaultId: 'jam-hbar-single',
        vaultName: 'JAM (Paired with HBAR)',
        vaultType: 'High Volatility | Wide',
        assetSymbols: ['JAM', 'HBAR'],
        shareTokenId: '0x26C770f89d320Da2c2341cbf410F132f44eF70CD',
        strategyFamily: 'single-asset-dex',
        launchStatus: 'live',
        sourceDocs: [BONZO_SINGLE_ASSET_DOC_URL, BONZO_CONTRACTS_DOC_URL],
    },
    {
        vaultId: 'hbar-jam-single',
        vaultName: 'HBAR (Paired with JAM)',
        vaultType: 'High Volatility | Wide',
        assetSymbols: ['HBAR', 'JAM'],
        shareTokenId: '0x55958da8d5aC662aa8eD45111f170C3D8e4fCB3b',
        strategyFamily: 'single-asset-dex',
        launchStatus: 'live',
        sourceDocs: [BONZO_SINGLE_ASSET_DOC_URL, BONZO_CONTRACTS_DOC_URL],
    },
    {
        vaultId: 'pack-hbar-single',
        vaultName: 'PACK (Paired with HBAR)',
        vaultType: 'High Volatility | Medium',
        assetSymbols: ['PACK', 'HBAR'],
        shareTokenId: '0xACd982eE8b869f11aa928c4760cC3C0D4f30a6d3',
        strategyFamily: 'single-asset-dex',
        launchStatus: 'live',
        sourceDocs: [BONZO_SINGLE_ASSET_DOC_URL, BONZO_CONTRACTS_DOC_URL],
    },
    {
        vaultId: 'hbar-pack-single',
        vaultName: 'HBAR (Paired with PACK)',
        vaultType: 'High Volatility | Medium',
        assetSymbols: ['HBAR', 'PACK'],
        shareTokenId: '0xd1893FcFB1dbEbCCAa6813993074fEfb1569FA5F',
        strategyFamily: 'single-asset-dex',
        launchStatus: 'live',
        sourceDocs: [BONZO_SINGLE_ASSET_DOC_URL, BONZO_CONTRACTS_DOC_URL],
    },
    {
        vaultId: 'bonzo-xbonzo-single',
        vaultName: 'BONZO (Paired with XBONZO)',
        vaultType: 'Medium Volatility | Narrow',
        assetSymbols: ['BONZO', 'XBONZO'],
        shareTokenId: '0x8F6A6441D5Bb2AFD8063181Da52363B9d568F5BE',
        strategyFamily: 'single-asset-dex',
        launchStatus: 'live',
        sourceDocs: [BONZO_SINGLE_ASSET_DOC_URL, BONZO_CONTRACTS_DOC_URL],
    },
    {
        vaultId: 'xbonzo-bonzo-single',
        vaultName: 'XBONZO (Paired with BONZO)',
        vaultType: 'Medium Volatility | Narrow',
        assetSymbols: ['XBONZO', 'BONZO'],
        shareTokenId: '0x938697BaAC6d574f77b848C4B98BfED0ec44a8B2',
        strategyFamily: 'single-asset-dex',
        launchStatus: 'live',
        sourceDocs: [BONZO_SINGLE_ASSET_DOC_URL, BONZO_CONTRACTS_DOC_URL],
    },
    {
        vaultId: 'bonzo-hbar-single',
        vaultName: 'BONZO (Paired with HBAR)',
        vaultType: 'High Volatility | Medium',
        assetSymbols: ['BONZO', 'HBAR'],
        shareTokenId: '0x5D1e9BCAe2c171c0C8aF697Bdd02908f280716bc',
        strategyFamily: 'single-asset-dex',
        launchStatus: 'live',
        sourceDocs: [BONZO_SINGLE_ASSET_DOC_URL, BONZO_CONTRACTS_DOC_URL],
    },
    {
        vaultId: 'usdc-hbar-single',
        vaultName: 'USDC (Paired with HBAR)',
        vaultType: 'High Volatility | Wide',
        assetSymbols: ['USDC', 'HBAR'],
        shareTokenId: '0x1b90B8f8ab3059cf40924338D5292FfbAEd79089',
        strategyFamily: 'single-asset-dex',
        launchStatus: 'live',
        sourceDocs: [BONZO_SINGLE_ASSET_DOC_URL, BONZO_CONTRACTS_DOC_URL],
    },
    {
        vaultId: 'hbar-usdc-single',
        vaultName: 'HBAR (Paired with USDC)',
        vaultType: 'High Volatility | Wide',
        assetSymbols: ['HBAR', 'USDC'],
        shareTokenId: '0xebaFaBBD6610304d7ae89351C5C37b8cf40c76eB',
        strategyFamily: 'single-asset-dex',
        launchStatus: 'live',
        sourceDocs: [BONZO_SINGLE_ASSET_DOC_URL, BONZO_CONTRACTS_DOC_URL],
    },
    {
        vaultId: 'dovu-hbar-single',
        vaultName: 'DOVU (Paired with HBAR)',
        vaultType: 'High Volatility | Medium',
        assetSymbols: ['DOVU', 'HBAR'],
        shareTokenId: '0x072bC950618A4e286683886eBc01C73090BC1C8a',
        strategyFamily: 'single-asset-dex',
        launchStatus: 'live',
        sourceDocs: [BONZO_SINGLE_ASSET_DOC_URL, BONZO_CONTRACTS_DOC_URL],
    },
    {
        vaultId: 'hbar-dovu-single',
        vaultName: 'HBAR (Paired with DOVU)',
        vaultType: 'High Volatility | Medium',
        assetSymbols: ['HBAR', 'DOVU'],
        shareTokenId: '0xEf55ABc71271dceaE4880b9000402a4b3F87D1eA',
        strategyFamily: 'single-asset-dex',
        launchStatus: 'live',
        sourceDocs: [BONZO_SINGLE_ASSET_DOC_URL, BONZO_CONTRACTS_DOC_URL],
    },
    {
        vaultId: 'sauce-hbar-single',
        vaultName: 'SAUCE (Paired with HBAR)',
        vaultType: 'High Volatility | Medium',
        assetSymbols: ['SAUCE', 'HBAR'],
        shareTokenId: '0x8e253F359Ba5DDD62644b1e5DAbD3D7748fb8193',
        strategyFamily: 'single-asset-dex',
        launchStatus: 'live',
        sourceDocs: [BONZO_SINGLE_ASSET_DOC_URL, BONZO_CONTRACTS_DOC_URL],
    },
    {
        vaultId: 'hbar-sauce-single',
        vaultName: 'HBAR (Paired with SAUCE)',
        vaultType: 'High Volatility | Medium',
        assetSymbols: ['HBAR', 'SAUCE'],
        shareTokenId: '0xc883F70804380c1a49E23A6d1DCF8e784D093a3f',
        strategyFamily: 'single-asset-dex',
        launchStatus: 'live',
        sourceDocs: [BONZO_SINGLE_ASSET_DOC_URL, BONZO_CONTRACTS_DOC_URL],
    },
    {
        vaultId: 'hbar-bonzo-single',
        vaultName: 'HBAR (Paired with BONZO)',
        vaultType: 'High Volatility | Medium',
        assetSymbols: ['HBAR', 'BONZO'],
        shareTokenId: '0xd406F0C0211836dbcA3EbF3b84487137be400E57',
        strategyFamily: 'single-asset-dex',
        launchStatus: 'live',
        sourceDocs: [BONZO_SINGLE_ASSET_DOC_URL, BONZO_CONTRACTS_DOC_URL],
    },
    {
        vaultId: 'usdc-weth-single',
        vaultName: 'USDC (Paired with wETH)',
        vaultType: 'High Volatility | Wide',
        assetSymbols: ['USDC', 'wETH'],
        shareTokenId: '0x0Db93Cfe4BA0b2A7C10C83FBEe81Fd2EFB871864',
        strategyFamily: 'single-asset-dex',
        launchStatus: 'live',
        sourceDocs: [BONZO_SINGLE_ASSET_DOC_URL, BONZO_CONTRACTS_DOC_URL],
    },
    {
        vaultId: 'weth-usdc-single',
        vaultName: 'wETH (Paired with USDC)',
        vaultType: 'High Volatility | Wide',
        assetSymbols: ['wETH', 'USDC'],
        shareTokenId: '0x31403d085C601F49b9644a4c9a493403FA14ABfe',
        strategyFamily: 'single-asset-dex',
        launchStatus: 'live',
        sourceDocs: [BONZO_SINGLE_ASSET_DOC_URL, BONZO_CONTRACTS_DOC_URL],
    },
    {
        vaultId: 'usdc-hbar-dual',
        vaultName: 'USDC-HBAR',
        vaultType: 'Volatile / Stable (Major)',
        assetSymbols: ['USDC', 'HBAR'],
        shareTokenId: '0x724F19f52A3E0e9D2881587C997db93f9613B2C7',
        strategyFamily: 'dual-asset-dex',
        launchStatus: 'live',
        sourceDocs: [BONZO_DUAL_ASSET_DOC_URL, BONZO_CONTRACTS_DOC_URL],
    },
    {
        vaultId: 'usdc-sauce-dual',
        vaultName: 'USDC-SAUCE',
        vaultType: 'Volatile / Stable (Alt)',
        assetSymbols: ['USDC', 'SAUCE'],
        shareTokenId: '0x0171baa37fC9f56c98bD56FEB32bC28342944C6e',
        strategyFamily: 'dual-asset-dex',
        launchStatus: 'live',
        sourceDocs: [BONZO_DUAL_ASSET_DOC_URL, BONZO_CONTRACTS_DOC_URL],
    },
    {
        vaultId: 'bonzo-xbonzo-dual',
        vaultName: 'BONZO-XBONZO',
        vaultType: 'LST / Base',
        assetSymbols: ['BONZO', 'XBONZO'],
        shareTokenId: '0xcfba07324bd207C3ED41416a9a36f8184F9a2134',
        strategyFamily: 'dual-asset-dex',
        launchStatus: 'live',
        sourceDocs: [BONZO_DUAL_ASSET_DOC_URL, BONZO_CONTRACTS_DOC_URL],
    },
    {
        vaultId: 'sauce-xsauce-dual',
        vaultName: 'SAUCE-XSAUCE',
        vaultType: 'LST / Base',
        assetSymbols: ['SAUCE', 'XSAUCE'],
        shareTokenId: '0x8AEE31dFF6264074a1a3929432070E1605F6b783',
        strategyFamily: 'dual-asset-dex',
        launchStatus: 'live',
        sourceDocs: [BONZO_DUAL_ASSET_DOC_URL, BONZO_CONTRACTS_DOC_URL],
    },
]

const DEFAULT_MOCK_SNAPSHOTS: BonzoVaultSnapshotRecord[] = [
    {
        vaultId: 'usdc-hbar-dual',
        tvl: 1750000,
        apr: 11.2,
        apy: 11.9,
        rewardTokens: [{ symbol: 'BONZO' }, { symbol: 'SAUCE' }],
        fetchedAt: '2026-03-23T00:00:00.000Z',
    },
    {
        vaultId: 'sauce-hbar-single',
        tvl: 910000,
        apr: 8.4,
        apy: 8.8,
        rewardTokens: [{ symbol: 'SAUCE' }],
        fetchedAt: '2026-03-23T00:00:00.000Z',
    },
    {
        vaultId: 'bonzo-xbonzo-dual',
        tvl: 640000,
        apr: 13.1,
        apy: 14,
        rewardTokens: [{ symbol: 'BONZO' }],
        fetchedAt: '2026-03-23T00:00:00.000Z',
    },
]

function normalizeOptional(value: string | undefined): string | undefined {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
}

function parseJson<T>(label: string, input: string | undefined): T | null {
    const normalized = normalizeOptional(input)
    if (!normalized) {
        return null
    }

    try {
        return JSON.parse(normalized) as T
    } catch (error) {
        throw new Error(
            `[bonzo-discovery] Failed to parse ${label}: ${error instanceof Error ? error.message : String(error)}`
        )
    }
}

function requireLiveCatalog(records: BonzoVaultCatalogRecord[]): BonzoVaultCatalogRecord[] {
    return records.filter((record) => record.launchStatus === 'live')
}

function nowIso(now: () => Date): string {
    return now().toISOString()
}

function resolveFallbackStrategyAddress(
    record: BonzoVaultCatalogRecord,
    bonzoContractEnv: Record<string, string>
): string {
    const explicitStrategyAddress = normalizeOptional(record.strategyAddress)
    if (explicitStrategyAddress) {
        return explicitStrategyAddress
    }

    const envOverride =
        record.strategyFamily === 'single-asset-dex'
            ? normalizeOptional(
                bonzoContractEnv.BONZO_CONTRACT_SINGLE_ASSET_FACTORY ??
                bonzoContractEnv.BONZO_CONTRACT_ICHI_VAULT_FACTORY
            )
            : normalizeOptional(
                bonzoContractEnv.BONZO_CONTRACT_DUAL_ASSET_DEPLOYER ??
                bonzoContractEnv.BONZO_CONTRACT_DEPLOYER
            )

    // Bonzo's published vault docs expose LP/share-token addresses for each live vault,
    // but not a per-vault strategy contract address. Until that surface exists, the
    // execution path should treat the published share-token/vault address as the stable
    // discovery anchor and override strategy addresses explicitly when available.
    return envOverride ?? record.vaultAddress ?? record.shareTokenId
}

function normalizeSnapshotMap(
    snapshots: BonzoVaultSnapshotRecord[]
): Map<string, BonzoVaultSnapshotRecord> {
    return new Map(
        snapshots.map((snapshot) => [snapshot.vaultId, snapshot])
    )
}

function buildOpportunityFromCatalogRecord(args: {
    record: BonzoVaultCatalogRecord
    snapshot?: BonzoVaultSnapshotRecord
    mode: BonzoDiscoveryMode
    bonzoContractEnv: Record<string, string>
    now: () => Date
}): BonzoVaultOpportunity {
    const rewardTokens = args.snapshot?.rewardTokens ?? []

    return normalizeBonzoVaultOpportunity({
        vaultId: args.record.vaultId,
        vaultName: args.record.vaultName,
        vaultType: args.record.vaultType,
        strategyFamily: args.record.strategyFamily,
        assetSymbols: args.record.assetSymbols,
        tvl: args.snapshot?.tvl ?? 0,
        apr: args.snapshot?.apr ?? 0,
        apy: args.snapshot?.apy ?? 0,
        rewardTokens,
        shareTokenId: args.record.shareTokenId,
        strategyAddress: resolveFallbackStrategyAddress(
            args.record,
            args.bonzoContractEnv
        ),
        vaultAddress: args.record.vaultAddress ?? args.record.shareTokenId,
        source: args.mode,
        fetchedAt: args.snapshot?.fetchedAt ?? nowIso(args.now),
    })
}

function parseVaultCatalogOverride(
    bonzoContractEnv: Record<string, string>
): BonzoVaultCatalogRecord[] | null {
    const parsed = parseJson<BonzoVaultCatalogRecord[]>(
        'BONZO_CONTRACT_VAULTS_JSON',
        bonzoContractEnv.BONZO_CONTRACT_VAULTS_JSON
    )
    return parsed
}

function parseVaultSnapshotOverride(
    bonzoContractEnv: Record<string, string>
): BonzoVaultSnapshotRecord[] {
    return (
        parseJson<BonzoVaultSnapshotRecord[]>(
            'BONZO_CONTRACT_VAULT_SNAPSHOTS_JSON',
            bonzoContractEnv.BONZO_CONTRACT_VAULT_SNAPSHOTS_JSON
        ) ?? []
    )
}

function parseApiPayload(
    payload: unknown
): {
    vaults?: BonzoVaultOpportunity[]
    snapshots?: BonzoVaultSnapshotRecord[]
} {
    if (Array.isArray(payload)) {
        return {
            vaults: payload as BonzoVaultOpportunity[],
        }
    }

    if (!payload || typeof payload !== 'object') {
        throw new Error('[bonzo-discovery] API payload must be an array or object')
    }

    const record = payload as Record<string, unknown>

    if (Array.isArray(record.vaults)) {
        return {
            vaults: record.vaults as BonzoVaultOpportunity[],
        }
    }

    if (Array.isArray(record.snapshots)) {
        return {
            snapshots: record.snapshots as BonzoVaultSnapshotRecord[],
        }
    }

    throw new Error(
        '[bonzo-discovery] API payload must contain either a vaults array or snapshots array'
    )
}

class MockBonzoVaultDiscoverySource implements BonzoVaultDiscoverySource {
    constructor(
        private readonly env: HederaEnvConfig,
        private readonly now: () => Date
    ) {}

    async discoverVaults(): Promise<BonzoVaultOpportunity[]> {
        const snapshots = normalizeSnapshotMap(DEFAULT_MOCK_SNAPSHOTS)

        return requireLiveCatalog(OFFICIAL_BONZO_VAULT_CATALOG).map((record) =>
            buildOpportunityFromCatalogRecord({
                record,
                snapshot: snapshots.get(record.vaultId),
                mode: 'mock',
                bonzoContractEnv: this.env.bonzoContractEnv,
                now: this.now,
            })
        )
    }
}

class ContractsBonzoVaultDiscoverySource implements BonzoVaultDiscoverySource {
    constructor(
        private readonly env: HederaEnvConfig,
        private readonly now: () => Date
    ) {}

    async discoverVaults(): Promise<BonzoVaultOpportunity[]> {
        const catalog =
            parseVaultCatalogOverride(this.env.bonzoContractEnv) ??
            OFFICIAL_BONZO_VAULT_CATALOG
        const snapshots = normalizeSnapshotMap(
            parseVaultSnapshotOverride(this.env.bonzoContractEnv)
        )

        return requireLiveCatalog(catalog).map((record) =>
            buildOpportunityFromCatalogRecord({
                record,
                snapshot: snapshots.get(record.vaultId),
                mode: 'contracts',
                bonzoContractEnv: this.env.bonzoContractEnv,
                now: this.now,
            })
        )
    }
}

class ApiBonzoVaultDiscoverySource implements BonzoVaultDiscoverySource {
    private readonly fetcher: BonzoApiFetcher

    constructor(
        private readonly env: HederaEnvConfig,
        fetcher: BonzoApiFetcher | undefined,
        private readonly now: () => Date
    ) {
        this.fetcher = fetcher ?? { fetch }
    }

    async discoverVaults(): Promise<BonzoVaultOpportunity[]> {
        const url = normalizeOptional(
            this.env.bonzoContractEnv.BONZO_CONTRACT_VAULTS_API_URL
        )
        if (!url) {
            throw new Error(
                '[bonzo-discovery] BONZO_CONTRACT_VAULTS_API_URL is required when BONZO_DATA_SOURCE=api'
            )
        }

        const response = await this.fetcher.fetch(url)
        if (!response.ok) {
            throw new Error(
                `[bonzo-discovery] Vault discovery API failed: ${response.status} ${response.statusText}`
            )
        }

        const payload = parseApiPayload(await response.json())
        if (payload.vaults) {
            return payload.vaults.map((vault) =>
                normalizeBonzoVaultOpportunity({
                    ...vault,
                    source: 'api',
                })
            )
        }

        const snapshots = normalizeSnapshotMap(payload.snapshots ?? [])
        return requireLiveCatalog(OFFICIAL_BONZO_VAULT_CATALOG).map((record) =>
            buildOpportunityFromCatalogRecord({
                record,
                snapshot: snapshots.get(record.vaultId),
                mode: 'api',
                bonzoContractEnv: this.env.bonzoContractEnv,
                now: this.now,
            })
        )
    }
}

export function createBonzoVaultDiscoverySource(
    env: HederaEnvConfig,
    options: BonzoVaultDiscoveryOptions = {}
): BonzoVaultDiscoverySource {
    const now = options.now ?? (() => new Date())

    switch (env.bonzoDataSource) {
        case 'contracts':
            return new ContractsBonzoVaultDiscoverySource(env, now)
        case 'api':
            return new ApiBonzoVaultDiscoverySource(env, options.fetcher, now)
        case 'mock':
        default:
            return new MockBonzoVaultDiscoverySource(env, now)
    }
}
