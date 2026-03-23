/**
 * Bonzo Live Trade — Standalone Script
 *
 * Discovers vaults, ranks by APY, and submits a live single-asset deposit
 * WITHOUT going through the full agent loop or memory commits.
 *
 * Usage (from repo root):
 *   bun --env-file=cre-memoryvault/.env run agent/scripts/bonzo-live-trade.ts
 *
 * Prerequisites:
 *   - Hedera vars set in cre-memoryvault/.env
 *   - BONZO_CONTRACT_RPC_URL set
 *
 * This script does NOT commit memory. It executes the raw Bonzo deposit tx only.
 */

import { loadHederaEnvConfig } from '../hedera/env'
import { BonzoVaultExecutor, buildBonzoEnterRequest } from '../tools/bonzo-vaults/execution'
import { createBonzoVaultDiscoverySource } from '../tools/bonzo-vaults/discovery'
import { selectBestBonzoVault } from '../tools/bonzo-vaults/ranking'

// Inline vault catalog with real Bonzo testnet vault contract addresses.
// Source: https://docs.bonzo.finance/hub/developer/bonzo-vaults-beta/vaults-contracts
const TESTNET_VAULTS = [
  {
    vaultId: 'sauce-hbar-single',
    vaultName: 'SAUCE (Paired with HBAR)',
    vaultType: 'High Volatility | Medium',
    assetSymbols: ['SAUCE', 'HBAR'],
    shareTokenId: '0x8e253F359Ba5DDD62644b1e5DAbD3D7748fb8193',
    vaultAddress: '0x8e253F359Ba5DDD62644b1e5DAbD3D7748fb8193', // TBD: verify on testnet
    strategyAddress: '0x8e253F359Ba5DDD62644b1e5DAbD3D7748fb8193', // TBD: verify on testnet
    strategyFamily: 'single-asset-dex',
    launchStatus: 'live',
    sourceDocs: ['https://docs.bonzo.finance'],
  },
  {
    vaultId: 'usdc-hbar-single',
    vaultName: 'USDC (Paired with HBAR)',
    vaultType: 'High Volatility | Wide',
    assetSymbols: ['USDC', 'HBAR'],
    shareTokenId: '0x1b90B8f8ab3059cf40924338D5292FfbAEd79089',
    vaultAddress: '0x1b90B8f8ab3059cf40924338D5292FfbAEd79089', // TBD: verify on testnet
    strategyAddress: '0x1b90B8f8ab3059cf40924338D5292FfbAEd79089', // TBD: verify on testnet
    strategyFamily: 'single-asset-dex',
    launchStatus: 'live',
    sourceDocs: ['https://docs.bonzo.finance'],
  },
]

async function main() {
  console.log('=== Bonzo Live Trade Script ===\n')

  // 1. Load Hedera env
  let env: ReturnType<typeof loadHederaEnvConfig>
  try {
    env = loadHederaEnvConfig()
    console.log(`[env] network=${env.network}, operator=${env.operatorAccountId}`)
    console.log(`[env] bonzoExecutionMode=${env.bonzoExecutionMode}, bonzoDataSource=${env.bonzoDataSource}`)
  } catch (err) {
    console.error('[env] Failed to load env:', (err as Error).message)
    console.error('Ensure HEDERA_OPERATOR_KEY and HEDERA_OPERATOR_ID are set in cre-memoryvault/.env')
    process.exit(1)
  }

  // 2. Set up discovery with inline vault catalog
  const vaultCatalogJson = JSON.stringify(TESTNET_VAULTS)
  const snapshotJson = JSON.stringify([
    { vaultId: 'sauce-hbar-single', apy: 8.8, tvl: 910000, rewardTokens: [{ symbol: 'SAUCE' }], fetchedAt: new Date().toISOString() },
    { vaultId: 'usdc-hbar-single', apy: 5.2, tvl: 1200000, rewardTokens: [{ symbol: 'BONZO' }], fetchedAt: new Date().toISOString() },
  ])

  // Override bonzoContractEnv inline — avoids needing BONZO_CONTRACT_VAULTS_JSON in .env
  const envWithCatalog: typeof env = {
    ...env,
    bonzoDataSource: 'contracts',
    bonzoExecutionMode: 'live', // override to live for this script
    bonzoContractEnv: {
      ...env.bonzoContractEnv,
      BONZO_CONTRACT_VAULTS_JSON: vaultCatalogJson,
      BONZO_CONTRACT_VAULT_SNAPSHOTS_JSON: snapshotJson,
    },
  }

  // 3. Validate live config (RPC URL, non-mock)
  const { validateHederaBonzoLiveConfig } = await import('../hedera/bonzo-live-transport')
  try {
    validateHederaBonzoLiveConfig(envWithCatalog)
    console.log('[config] Live mode validation passed')
  } catch (err) {
    console.error('[config] Live mode validation failed:', (err as Error).message)
    process.exit(1)
  }

  // 4. Discover vaults
  const discovery = createBonzoVaultDiscoverySource(envWithCatalog)
  console.log('[discovery] Fetching vaults...')
  const opportunities = await discovery.discoverVaults()
  console.log(`[discovery] Found ${opportunities.length} vaults:`)
  for (const opp of opportunities) {
    console.log(`  - ${opp.vaultId} (${opp.vaultName}): APY=${opp.apy}%, TVL=${opp.tvl}`)
  }
  console.log()

  // 5. Rank by APY (no current position → selects best vault)
  const ranking = selectBestBonzoVault({
    opportunities,
    currentPosition: null, // no existing position
    minApyDeltaBps: 0,
  })

  console.log('[ranking] Best vault:', ranking.bestVaultId)
  console.log('[ranking] APY:', ranking.bestApy, '%')
  console.log('[ranking] Rebalance:', ranking.rebalance)
  console.log('[ranking] Reason:', ranking.reason)
  console.log()

  if (!ranking.rebalance || !ranking.bestVaultId) {
    console.log('[trade] No rebalance warranted. Exiting.')
    process.exit(0)
  }

  const vault = opportunities.find((o) => o.vaultId === ranking.bestVaultId)!
  console.log(`[trade] Selected vault: ${vault.vaultId}`)
  console.log(`[trade] Primary asset: ${vault.assetSymbols[0]}`)
  console.log()

  // 6. Build enter request
  const request = buildBonzoEnterRequest({
    agentId: 'bonzo-live-trade',
    strategyType: 'custom',
    opportunity: {
      toolId: 'bonzo-vaults',
      assetId: vault.vaultId,
      entryParams: {
        vaultId: vault.vaultId,
        vaultName: vault.vaultName,
        vaultType: vault.vaultType,
        assetSymbols: vault.assetSymbols,
        primaryAssetSymbol: vault.assetSymbols[0],
        tvl: vault.tvl,
        apr: vault.apr,
        apy: vault.apy,
        rewardTokenSymbols: vault.rewardTokens.map((t) => t.symbol),
        shareTokenId: vault.shareTokenId,
        strategyAddress: vault.strategyAddress,
        vaultAddress: vault.vaultAddress,
        source: vault.source,
        fetchedAt: vault.fetchedAt,
        vault,
      },
    },
    amount: '1', // 1 unit of primary asset (adjust as needed)
  })

  console.log('[trade] Enter request built:')
  console.log(`  vaultId: ${request.params.vaultId}`)
  console.log(`  depositAsset: ${JSON.stringify(request.params.depositAssets)}`)
  console.log()

  // 7. Execute live deposit
  const { HederaBonzoLiveTransport } = await import('../hedera/bonzo-live-transport')
  const executor = new BonzoVaultExecutor(envWithCatalog, {
    mode: 'live',
    transport: new HederaBonzoLiveTransport(envWithCatalog),
  })

  console.log('[trade] Submitting LIVE deposit to Hedera testnet...')
  const response = await executor.enter(request)

  console.log('\n=== Result ===')
  console.log('Status:', response.status)
  console.log('Action:', response.action)
  if (response.data?.transactionId) {
    console.log('Transaction ID:', response.data.transactionId)
    console.log('Explorer: https://testnet.hashscan.io/tx/' + response.data.transactionId)
  }
}

main().catch((err) => {
  console.error('\n[error]', err)
  process.exit(1)
})
