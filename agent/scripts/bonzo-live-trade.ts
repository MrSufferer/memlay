/**
 * Bonzo Live Trade — Standalone Script
 *
 * Discovers vaults from the official Bonzo catalog (or BONZO_CONTRACT_VAULTS_JSON),
 * optionally fetches live APY snapshots, ranks by APY, and submits a live
 * single-asset deposit WITHOUT going through the full agent loop or memory commits.
 *
 * Usage (from repo root, mainnet):
 *   HEDERA_NETWORK=mainnet \
 *   HEDERA_OPERATOR_ID=<account> \
 *   HEDERA_OPERATOR_KEY=<key> \
 *   HEDERA_MIRROR_NODE_URL=https://mainnet.mirrornode.hedera.com/api/v1 \
 *   BONZO_EXECUTION_MODE=live \
 *   BONZO_DATA_SOURCE=contracts \
 *   BONZO_CONTRACT_RPC_URL=<hedera-json-rpc-url> \
 *   BONZO_EXECUTOR_MODE=operator \
 *   bun --env-file=.env run agent/scripts/bonzo-live-trade.ts
 *
 * Usage (from repo root, testnet):
 *   HEDERA_NETWORK=testnet \
 *   HEDERA_OPERATOR_ID=<account> \
 *   HEDERA_OPERATOR_KEY=<key> \
 *   BONZO_EXECUTION_MODE=live \
 *   BONZO_DATA_SOURCE=contracts \
 *   BONZO_CONTRACT_RPC_URL=<hedera-json-rpc-url> \
 *   BONZO_CONTRACT_VAULTS_JSON='[{"vaultId":"sauce-hbar-single","shareTokenId":"...","..."}]' \
 *   BONZO_CONTRACT_VAULT_SNAPSHOTS_JSON='[{"vaultId":"sauce-hbar-single","apy":8.8,"tvl":910000}]' \
 *   bun --env-file=.env run agent/scripts/bonzo-live-trade.ts
 *
 * Prerequisites:
 *   - Hedera vars set in .env (or passed as env vars)
 *   - BONZO_CONTRACT_RPC_URL set for live execution
 *   - For testnet: BONZO_CONTRACT_VAULTS_JSON + BONZO_CONTRACT_VAULT_SNAPSHOTS_JSON
 *     (or the script will fall back to the mock catalog with zero APY/TVL)
 *
 * This script does NOT commit memory. It executes the raw Bonzo deposit tx only.
 * For full agent loop with memory anchoring use:
 *   MEMORYVAULT_DEPLOYMENT_TARGET=hedera AGENT_ID=agent-hedera-01 bun run agent/index.ts
 */

import { loadHederaEnvConfig } from '../hedera/env'
import { validateHederaBonzoLiveConfig } from '../hedera/bonzo-live-transport'
import {
    createBonzoVaultDiscoverySource,
    type BonzoVaultDiscoverySource,
} from '../tools/bonzo-vaults/discovery'
import {
    BonzoVaultExecutor,
    buildBonzoEnterRequest,
} from '../tools/bonzo-vaults/execution'
import { selectBestBonzoVault } from '../tools/bonzo-vaults/ranking'
import type { BonzoVaultOpportunity } from '../tools/bonzo-vaults/opportunities'

const DEFAULT_DEPOSIT_UNITS = '1'

function normalizeOptional(value: string | undefined): string | undefined {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
}

// ── APY snapshot fetching ─────────────────────────────────────────────────────

interface BonzoVaultSnapshot {
    vaultId: string
    tvl?: number
    apr?: number
    apy?: number
    rewardTokens?: Array<{ symbol: string }>
    fetchedAt?: string
}

async function fetchLiveApySnapshots(env: ReturnType<typeof loadHederaEnvConfig>): Promise<BonzoVaultSnapshot[]> {
    const apiUrl = normalizeOptional(env.bonzoContractEnv.BONZO_API_URL)
    if (!apiUrl) {
        return []
    }

    try {
        const response = await fetch(`${apiUrl.replace(/\/+$/, '')}/vaults/snapshots`)
        if (!response.ok) {
            console.warn(`[bonzo-api] APY fetch failed: HTTP ${response.status} — using snapshot defaults`)
            return []
        }

        const json = (await response.json()) as BonzoVaultSnapshot[]
        console.log(`[bonzo-api] Fetched live APY snapshots for ${json.length} vaults`)
        return json
    } catch (err) {
        console.warn(`[bonzo-api] APY fetch error: ${(err as Error).message} — using snapshot defaults`)
        return []
    }
}

function applySnapshots(
    opportunities: BonzoVaultOpportunity[],
    snapshots: BonzoVaultSnapshot[]
): void {
    if (snapshots.length === 0) return

    const byId = new Map(snapshots.map((s) => [s.vaultId, s]))
    for (const opp of opportunities) {
        const snap = byId.get(opp.vaultId)
        if (snap) {
            if (snap.apy !== undefined) opp.apy = snap.apy
            if (snap.tvl !== undefined) opp.tvl = snap.tvl
            if (snap.apr !== undefined) opp.apr = snap.apr
            if (snap.rewardTokens) opp.rewardTokens = snap.rewardTokens
            if (snap.fetchedAt) opp.fetchedAt = snap.fetchedAt
        }
    }
}

// ── Execution ─────────────────────────────────────────────────────────────────

async function main() {
    console.log('=== Bonzo Live Trade Script ===\n')

    // 1. Load and validate env
    let env: ReturnType<typeof loadHederaEnvConfig>
    try {
        env = loadHederaEnvConfig()
        console.log(`[env] network          = ${env.network}`)
        console.log(`[env] operator         = ${env.operatorAccountId}`)
        console.log(`[env] bonzoExecution   = ${env.bonzoExecutionMode}`)
        console.log(`[env] bonzoDataSource  = ${env.bonzoDataSource}`)
    } catch (err) {
        console.error('[env] Failed to load environment:', (err as Error).message)
        console.error('Required vars: HEDERA_NETWORK, HEDERA_OPERATOR_ID, HEDERA_OPERATOR_KEY')
        process.exit(1)
    }

    // 2. Validate live config (RPC URL, non-mock data source)
    try {
        validateHederaBonzoLiveConfig(env)
        console.log('[config] Live mode validation passed')
    } catch (err) {
        console.error('[config] Live mode validation failed:', (err as Error).message)
        process.exit(1)
    }

    // 3. Set up vault discovery via the standard factory
    //    On mainnet: uses OFFICIAL_BONZO_VAULT_CATALOG from discovery.ts
    //    On testnet: requires BONZO_CONTRACT_VAULTS_JSON in env
    //    For APY/TVL: tries BONZO_API_URL first, falls back to BONZO_CONTRACT_VAULT_SNAPSHOTS_JSON
    let discovery: BonzoVaultDiscoverySource
    try {
        discovery = createBonzoVaultDiscoverySource(env)
        console.log('[discovery] Vault discovery source initialised')
    } catch (err) {
        console.error('[discovery] Failed to create discovery source:', (err as Error).message)
        process.exit(1)
    }

    // 4. Discover vaults from the official catalog
    console.log('[discovery] Fetching vault catalog...')
    let opportunities = await discovery.discoverVaults()
    console.log(`[discovery] Found ${opportunities.length} vaults in catalog`)

    // 5. Overlay live APY snapshots if available
    const snapshots = await fetchLiveApySnapshots(env)
    if (snapshots.length > 0) {
        applySnapshots(opportunities, snapshots)
    } else {
        console.warn('[bonzo-api] No live APY feed — using catalog/default snapshot values')
        console.warn('             Set BONZO_API_URL for live APY, or BONZO_CONTRACT_VAULT_SNAPSHOTS_JSON for static snapshots')
    }

    console.log('\nVault summary:')
    for (const opp of opportunities) {
        const status = opp.launchStatus === 'live' ? 'LIVE' : 'COMING'
        console.log(
            `  [${status}] ${opp.vaultId} (${opp.vaultName}): ` +
            `APY=${opp.apy.toFixed(2)}%  TVL=$${opp.tvl.toLocaleString()}  ` +
            `rewards=[${opp.rewardTokens.map((t) => t.symbol).join(', ')}]`
        )
    }
    console.log()

    // 6. Rank by APY — no current position means best vault is always selected
    const ranking = selectBestBonzoVault({
        opportunities,
        currentPosition: null,
        minApyDeltaBps: 0,
    })

    console.log('[ranking] Best vault :', ranking.bestVaultId ?? 'none')
    console.log('[ranking] APY        :', ranking.bestApy > 0 ? `${ranking.bestApy.toFixed(2)}%` : 'unknown (no snapshot)')
    console.log('[ranking] Rebalance  :', ranking.rebalance)
    console.log('[ranking] Reason     :', ranking.reason)
    console.log()

    if (!ranking.rebalance || !ranking.bestVaultId) {
        console.log('[trade] No rebalance warranted. Exiting.')
        process.exit(0)
    }

    const vault = opportunities.find((o) => o.vaultId === ranking.bestVaultId)!
    console.log(`[trade] Selected: ${vault.vaultId} (${vault.vaultName})`)
    console.log(`         Primary asset: ${vault.assetSymbols[0]}`)
    console.log(`         Vault address: ${vault.vaultAddress}`)
    console.log()

    // 7. Build enter request — deposit amount from env or default
    const depositAmount = normalizeOptional(process.env.BONZO_TRADE_DEPOSIT_AMOUNT)
        ?? DEFAULT_DEPOSIT_UNITS

    const request = buildBonzoEnterRequest({
        agentId: 'bonzo-live-trade',
        strategyType: 'custom',
        opportunity: {
            toolId: 'bonzo-vaults',
            assetId: vault.vaultId,
            entryParams: {
                venue: 'bonzo-vaults',
                vaultId: vault.vaultId,
                vaultName: vault.vaultName,
                vaultType: vault.vaultType,
                assetSymbols: vault.assetSymbols,
                primaryAssetSymbol: vault.assetSymbols[0],
                tvl: vault.tvl,
                apr: vault.apr ?? 0,
                apy: vault.apy,
                rewardTokenSymbols: vault.rewardTokens.map((t) => t.symbol),
                shareTokenId: vault.shareTokenId,
                strategyAddress: vault.strategyAddress ?? vault.shareTokenId,
                vaultAddress: vault.vaultAddress ?? vault.shareTokenId,
                source: env.bonzoDataSource,
                fetchedAt: vault.fetchedAt,
                vault,
            },
        },
        amount: depositAmount,
    })

    console.log('[trade] Enter request:')
    console.log(`         vaultId       : ${request.params.vaultId}`)
    console.log(`         vaultAddress  : ${request.params.vaultAddress}`)
    console.log(`         depositAsset  : ${JSON.stringify(request.params.depositAssets)}`)
    console.log()

    // 8. Execute live deposit
    const { HederaBonzoLiveTransport } = await import('../hedera/bonzo-live-transport')
    const executor = new BonzoVaultExecutor(env, {
        mode: 'live',
        transport: new HederaBonzoLiveTransport(env),
    })

    const explorerBase =
        env.network === 'mainnet'
            ? 'https://hashscan.io/mainnet/tx/'
            : 'https://testnet.hashscan.io/tx/'

    console.log('[trade] Submitting LIVE deposit...')
    console.log(`         network = ${env.network}`)
    const response = await executor.enter(request)

    console.log('\n=== Result ===')
    console.log('Status :', response.status)
    console.log('Action :', response.action)

    if (response.data?.transactionId) {
        console.log('Tx ID  :', response.data.transactionId)
        console.log('Explorer:', explorerBase + response.data.transactionId)
    } else if (response.data?.executionPlan) {
        console.log('Mode   : simulate (live transport not available)')
    }

    if (response.status === 'error') {
        process.exitCode = 1
    }
}

main().catch((err) => {
    console.error('\n[error]', err)
    process.exit(1)
})
