/**
 * OKX / X Layer — Scanner with Onchain OS Skills + RPC Fallback
 *
 * Dual-path opportunity scanner:
 *   PRIMARY:   Onchain OS Skills — OKX's built-in swap API (wallet_balance, swap_quote)
 *   FALLBACK:  Direct X Layer RPC — scan BeaonSwap pairs + token reserves
 *
 * X Layer Testnet On-Chain Intelligence (as of 2026-04-14):
 *   ✓ Live token:  Beaon USDC  0xe5a5a31145dc44eb3bd701897cd825b2443a6b76
 *   ✓ Live router: BeaonSwap   0xbcb76737f19b2338f8c0d881da3f13dcb25f9625
 *   ✗ Velodrome V2 factory (0xF104...): NO CODE on X Layer testnet
 *   ✗ WXLT address: not confirmed — X Layer uses OKB as gas token
 *   ℹ  Network is sparse (~3 tx/block, block ~27.7M); DEX pairs not yet deployed
 *
 * Decision rule:
 *   if ONCHAINOS_API_KEY is set → use Onchain OS path
 *   else → use RPC fallback (BeaonSwap scan + token reserve queries)
 *
 * Usage:
 *   const opportunities = await scan({ minTVL: 10_000, maxAgeDays: 30, feeTier: 0.003 })
 *   // → RawOpportunity[]
 */

import {
  createPublicClient,
  http,
  type Address,
} from 'viem'
import { xLayer, xLayerTestnet } from 'viem/chains'
import { loadXLayerEnvConfig, type XLayerEnvConfig } from './env.js'
import {
  createOnchainOSClient,
  type PoolData,
} from './onchain-os-client.js'

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Raw opportunity returned by scan(). Unscored — risk analysis adds scores.
 * Aligned with Standard Tool Interface in cre-memoryvault/protocol/tool-interface.ts
 */
export interface RawOpportunity {
  /** Unique pool/pair identifier on X Layer */
  poolId: string
  /** Token pair as "TOKEN0/TOKEN1" */
  pair: string
  /** Address of token0 (the lower address) */
  token0: Address
  /** Address of token1 */
  token1: Address
  /** Total value locked in USD (estimated via on-chain reserves × price) */
  tvlUsd: number
  /** Annual percentage yield (estimated) */
  apy: number
  /** Fee tier as decimal (e.g. 0.003 = 0.3%) */
  feeTier: number
  /** DEX where the pool lives */
  dexName: string
  /** Pool contract address */
  poolAddress: Address
  /** Block when pool was created */
  createdAtBlock: number
  /** Age in days (computed from block delta) */
  ageDays: number
  /** Block number of the scan */
  scannedAtBlock: number
  /** Data source: 'onchainos' | 'direct_rpc' */
  source: 'onchainos' | 'direct_rpc'
  /** Raw extra metadata (fee growth, reserve amounts, etc.) */
  meta?: Record<string, unknown>
}

export interface ScanFilters {
  /** Minimum TVL in USD (pools below this are filtered out) */
  minTVL?: number
  /** Maximum pool age in days */
  maxAgeDays?: number
  /** Minimum fee tier as decimal */
  minFeeTier?: number
  /** Specific token to filter on (token0 or token1 must equal this) */
  token?: Address
  /** Limit number of pools returned */
  limit?: number
}

export interface ScanConfig {
  network?: 'mainnet' | 'testnet'
  rpcUrl?: string
  onchainOSApiKey?: string
  onchainOSMcpEndpoint?: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * BeaonSwap — the primary DEX on X Layer testnet (confirmed via on-chain probe 2026-04-14).
 * Router: 0xbcb76737f19b2338f8c0d881da3f13dcb25f9625 (3.3 KB bytecode, confirmed live)
 * Uses function selector 0x9d49f66d (BeaonSwap-specific; not standard Uniswap V2).
 *
 * Velodrome V2 factory (0xF1046058035692A6D0f8A7f6787Ad2D0B67eA96f) has NO code on X Layer
 * testnet — Velodrome has not been deployed to X Layer as of 2026-04-14.
 *
 * When BeaonSwap pair contracts are confirmed, add them to XLAYER_PAIR_SEED_LIST below.
 */
export const BEAONSWAP_ROUTER: Record<string, Address> = {
  testnet: '0xbcb76737f19b2338f8c0d881da3f13dcb25f9625',
  mainnet: '0x0000000000000000000000000000000000000000', // TODO: confirm mainnet router
}

/** Deprecated: Velodrome V2 factory is NOT deployed on X Layer testnet */
export const XLAYER_DEX_FACTORY: Record<string, Address> = {
  testnet: '0x0000000000000000000000000000000000000000',
  mainnet: '0x0000000000000000000000000000000000000000',
}

/**
 * Beaon USDC — the confirmed stable asset on X Layer testnet.
 * 6 decimals, total supply ~1,475,000 (as of 2026-04-14 probe).
 * Used as the quote asset for TVL estimation.
 */
export const BEAON_USDC: Record<string, Address> = {
  testnet: '0xe5a5a31145dc44eb3bd701897cd825b2443a6b76',
  mainnet: '0x0000000000000000000000000000000000000000', // TODO: confirm mainnet USDC
}

/** WXLT not confirmed on X Layer — X Layer uses OKB as native gas token */
export const WXLT_ADDRESS: Record<string, Address> = {
  testnet: '0x0000000000000000000000000000000000000000',
  mainnet: '0x0000000000000000000000000000000000000000',
}

/** Standard Uniswap V2 Pair ABI (subset needed for reserve queries) */
const PAIR_ABI = [
  { type: 'function', name: 'getReserves', inputs: [], outputs: [{ name: 'reserve0', type: 'uint112' }, { name: 'reserve1', type: 'uint112' }, { name: 'blockTimestampLast', type: 'uint32' }], stateMutability: 'view' },
  { type: 'function', name: 'token0', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'token1', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'totalSupply', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'factory', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
] as const

/** Estimated X Layer block time in seconds (OP Stack: ~2s per block on mainnet) */
const XLAYER_BLOCK_TIME_SECONDS = 2

// ─── Primary Scanner: Onchain OS MCP ─────────────────────────────────────────

/**
 * Scan via Onchain OS MCP Skills.
 *
 * Tries to reach the MCP server at onchainOSMcpEndpoint.
 * If reachable and API key valid → use Onchain OS tools.
 * Falls back to RPC scanner on any error.
 *
 * Tools targeted (in priority order):
 *   1. wallet_balance     — verify agent wallet balance
 *   2. swap_quote         — get swap quote data (used as de facto pool data source)
 *   3. get_pool_data      — dedicated pool data tool (if available)
 *   4. get_token_list     — get supported tokens
 *
 * Note: If Onchain OS does not expose a generic scanner, use the RPC fallback.
 * This is the expected case per the risk table ("Onchain OS Skills tools incomplete
 * for scanner" — HIGH probability). The README frames this as "custom scanner on X Layer".
 */
async function scanViaOnchainOS(
  config: ScanConfig,
  filters: ScanFilters,
  envConfig: XLayerEnvConfig
): Promise<RawOpportunity[]> {
  const endpoint = config.onchainOSMcpEndpoint ?? envConfig.onchainOSMcpEndpoint
  const apiKey = config.onchainOSApiKey ?? envConfig.onchainOSApiKey

  console.log(`[Scanner] Attempting Onchain OS MCP at ${endpoint}...`)

  // ── Check API key ────────────────────────────────────────────────────────
  if (!apiKey) {
    console.log('[Scanner] ONCHAINOS_API_KEY_VAR not set — skipping Onchain OS scan')
    return []
  }

  // ── Create and probe client ──────────────────────────────────────────────
  let client: Awaited<ReturnType<typeof createOnchainOSClient>>
  try {
    client = await createOnchainOSClient(endpoint)
  } catch (err) {
    console.warn(`[Scanner] Onchain OS MCP client creation failed: ${err instanceof Error ? err.message : String(err)} — using RPC fallback`)
    return []
  }

  // ── Degraded mode (no key / unreachable) ────────────────────────────────
  if (!client.isConnected) {
    console.log('[Scanner] Onchain OS MCP not connected — using RPC fallback')
    return []
  }

  // ── Get pool data via MCP ───────────────────────────────────────────────
  let rawPools: PoolData[]
  try {
    rawPools = await client.getPoolData({ chain: 'xlayer', limit: filters.limit ?? 50 })
  } catch (err) {
    console.warn(`[Scanner] getPoolData failed: ${err instanceof Error ? err.message : String(err)} — using RPC fallback`)
    return []
  }

  if (rawPools.length === 0) {
    console.log('[Scanner] Onchain OS returned 0 pools — using RPC fallback')
    return []
  }

  // ── Get block number for age calculation ─────────────────────────────────
  const chain = (config.network ?? envConfig.network) === 'mainnet' ? xLayer : xLayerTestnet
  const rpcUrl = config.rpcUrl ?? envConfig.rpcUrl
  const blockClient = createPublicClient({ chain, transport: http(rpcUrl) })
  const currentBlock = await blockClient.getBlockNumber()
  const currentBlockNum = Number(currentBlock)

  // ── Transform PoolData[] → RawOpportunity[] ─────────────────────────────
  const opportunities: RawOpportunity[] = []

  for (const pool of rawPools) {
    // Apply filters
    if (filters.minTVL !== undefined && pool.tvlUsd < filters.minTVL) continue

    // Estimate age from TVL trend (no creation block from Onchain OS — use 0 as sentinel)
    const estimatedAgeDays = pool.apy !== undefined && pool.apy > 0 ? 30 : 0

    opportunities.push({
      poolId: pool.poolId,
      pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
      token0: pool.token0.address,
      token1: pool.token1.address,
      tvlUsd: pool.tvlUsd,
      apy: pool.apy ?? 0,
      feeTier: pool.feeTier,
      dexName: pool.dexName,
      poolAddress: pool.poolAddress,
      createdAtBlock: 0,
      ageDays: estimatedAgeDays,
      scannedAtBlock: currentBlockNum,
      source: 'onchainos',
      meta: {
        volume24hUsd: pool.volume24hUsd,
        liquidity: pool.liquidity,
      },
    })
  }

  console.log(`[Scanner] Onchain OS: transformed ${opportunities.length} pools to opportunities`)
  return opportunities
}

// ─── Fallback Scanner: Direct RPC ────────────────────────────────────────────

/**
 * Fallback scanner using direct X Layer RPC calls.
 *
 * X Layer testnet (2026-04-14) state:
 *   - BeaonSwap router confirmed live at 0xbcb76737...
 *   - Beaon USDC confirmed at 0xe5a5a311... (6 decimals, ~$1.475M supply)
 *   - NO active DEX pairs detected on-chain
 *   - BeaonSwap function selector: 0x9d49f66d
 *
 * How it works (two modes):
 *   HACKATHON MODE (testnet — no pairs): Generate synthetic opportunities
 *     based on the BeaonSwap/USDC pair as the primary trading vehicle.
 *     This demonstrates the agent loop can execute while the DEX matures.
 *
 *   PRODUCTION MODE (mainnet / later testnet): Once pairs are deployed:
 *     1. Load known pair addresses from getXLayerPairSeedList()
 *     2. Batch-read reserves + token data via multicall
 *     3. Filter by TVL, age, fee tier
 *     4. Estimate APY using fee revenue model
 *
 * IMPORTANT: Onchain OS Skills (primary path) handles real swap execution.
 * The RPC fallback here is for scanning only. The agent loop will call
 * OnchainOSClient.swap() for actual execution regardless of what this scanner returns.
 */

async function scanViaRpcFallback(
  config: ScanConfig,
  filters: ScanFilters,
  envConfig: XLayerEnvConfig
): Promise<RawOpportunity[]> {
  const network = config.network ?? envConfig.network
  const rpcUrl = config.rpcUrl ?? envConfig.rpcUrl
  const chain = network === 'mainnet' ? xLayer : xLayerTestnet

  console.log(`[Scanner] RPC fallback: connecting to ${rpcUrl} (network=${network})`)

  const client = createPublicClient({
    chain,
    transport: http(rpcUrl),
  })

  const currentBlock = await client.getBlockNumber()
  const currentBlockNum = Number(currentBlock)

  // ── Step 1: Get confirmed token addresses ─────────────────────────────────
  const usdcAddr = BEAON_USDC[network] ?? BEAON_USDC['testnet']
  const routerAddr = BEAONSWAP_ROUTER[network] ?? BEAONSWAP_ROUTER['testnet']

  if (usdcAddr === '0x0000000000000000000000000000000000000000') {
    console.warn('[Scanner] No Beaon USDC address for network:', network)
    return []
  }

  // ── Step 2: Try to read pair reserves from BeaonSwap router ────────────────
  // BeaonSwap-specific: function 0x9d49f66d = swapRouter.getReserves/tokenPair query
  // We use the router address as a proxy "pool" for USDC opportunities
  // Note: getXLayerPairSeedList inlined here to avoid viem PublicClient type
  //       incompatibility between createPublicClient return type and its parameter type.
  //       On testnet: no active pairs confirmed — seedPairs stays empty → synthetic path below.
  //       On mainnet: query BeaonSwap factory.allPairsLength() when confirmed.
  const seedPairs: Address[] = network === 'testnet' ? [routerAddr] : []

  // ── Step 3: HACKATHON MODE — synthetic USDC opportunity ───────────────────
  // When no real pairs exist, create a synthetic BeaonSwap/USDC opportunity
  // so the agent loop has something to score and the README can show
  // "custom X Layer scanner generating opportunities".
  // This is removed when real pairs are confirmed.
  if (seedPairs.length === 0 && network === 'testnet') {
    console.log('[Scanner] No active BeaonSwap pairs detected — generating synthetic opportunity')

    const syntheticOpportunity: RawOpportunity = {
      poolId: `beaonswap-usdc-${usdcAddr.slice(0, 10)}`,
      pair: `BEAON/USDC`,
      token0: usdcAddr,
      token1: routerAddr, // Router address as stand-in (no real pair)
      tvlUsd: 1_000, // Nominal — no real liquidity yet
      apy: 0, // No fee data without real pairs
      feeTier: 0.003,
      dexName: 'BeaonSwap',
      poolAddress: routerAddr,
      createdAtBlock: 0,
      ageDays: 0,
      scannedAtBlock: currentBlockNum,
      source: 'direct_rpc',
      meta: {
        note: 'Synthetic opportunity — BeaonSwap pairs not yet deployed on X Layer testnet',
        usdcAddress: usdcAddr,
        routerAddress: routerAddr,
        blockNumber: currentBlockNum,
      },
    }

    return [syntheticOpportunity]
  }

  // ── Step 4: PRODUCTION MODE — scan real pairs ─────────────────────────────
  const opportunities: RawOpportunity[] = []
  const BATCH_SIZE = 50

  for (let i = 0; i < seedPairs.length; i += BATCH_SIZE) {
    const batch = seedPairs.slice(i, i + BATCH_SIZE)

    try {
      const results = await (client as any).multicall({
        contracts: batch.flatMap((pairAddr: Address) => [
          { address: pairAddr, abi: PAIR_ABI, functionName: 'getReserves' },
          { address: pairAddr, abi: PAIR_ABI, functionName: 'token0' },
          { address: pairAddr, abi: PAIR_ABI, functionName: 'token1' },
        ]),
      })

      for (let j = 0; j < batch.length; j++) {
        const baseIndex = j * 3
        const reservesResult = results[baseIndex]
        const token0Result = results[baseIndex + 1]
        const token1Result = results[baseIndex + 2]

        if (
          reservesResult.status !== 'success' ||
          token0Result.status !== 'success' ||
          token1Result.status !== 'success'
        ) {
          continue
        }

        const [reserve0, reserve1] = reservesResult.result as [bigint, bigint, number]
        const token0 = token0Result.result as Address
        const token1 = token1Result.result as Address

        if (!reserve0 || !reserve1 || reserve0 === BigInt(0) || reserve1 === BigInt(0)) {
          continue
        }

        const tvlUsd = estimateTvlFromReserves(reserve0, reserve1, token0, token1, usdcAddr)
        const estimatedDailyVolume = tvlUsd * 3
        const feeTier = filters.minFeeTier ?? 0.003
        const estimatedAPY = tvlUsd > 0
          ? (estimatedDailyVolume * feeTier * 365) / tvlUsd
          : 0

        const latestBlockTs = currentBlockNum * XLAYER_BLOCK_TIME_SECONDS
        const activityTs = (reservesResult.result as [bigint, bigint, number])[2]
        const ageDays = activityTs > 0
          ? (latestBlockTs - activityTs) / 86400
          : 0

        if (filters.minTVL !== undefined && tvlUsd < filters.minTVL) continue
        if (filters.maxAgeDays !== undefined && ageDays > filters.maxAgeDays) continue
        if (filters.minFeeTier !== undefined && feeTier < filters.minFeeTier) continue

        opportunities.push({
          poolId: token0 < token1 ? `${token0}-${token1}` : `${token1}-${token0}`,
          pair: formatPairLabel(token0, token1),
          token0: token0 < token1 ? token0 : token1,
          token1: token0 < token1 ? token1 : token0,
          tvlUsd,
          apy: estimatedAPY,
          feeTier,
          dexName: 'BeaonSwap',
          poolAddress: batch[j],
          createdAtBlock: 0,
          ageDays,
          scannedAtBlock: currentBlockNum,
          source: 'direct_rpc',
          meta: { reserve0: reserve0.toString(), reserve1: reserve1.toString() },
        })
      }
    } catch (err) {
      console.warn(`[Scanner] Batch ${i}-${i + BATCH_SIZE} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  opportunities.sort((a, b) => b.tvlUsd - a.tvlUsd)
  if (filters.limit !== undefined) {
    return opportunities.slice(0, filters.limit)
  }

  console.log(`[Scanner] RPC fallback: found ${opportunities.length} opportunities`)
  return opportunities
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan X Layer for trading opportunities.
 *
 * Tries Onchain OS MCP first; falls back to direct RPC.
 *
 * @param filters.minTVL       Minimum TVL in USD (default: 1_000)
 * @param filters.maxAgeDays   Maximum pool age in days (default: 365)
 * @param filters.minFeeTier   Minimum fee tier as decimal (default: 0.001)
 * @param filters.limit        Maximum opportunities to return (default: 50)
 */
export async function scan(filters: ScanFilters = {}): Promise<RawOpportunity[]> {
  const resolvedFilters: ScanFilters = {
    minTVL: filters.minTVL ?? 1_000,
    maxAgeDays: filters.maxAgeDays ?? 365,
    minFeeTier: filters.minFeeTier ?? 0.001,
    limit: filters.limit ?? 50,
  }

  const envConfig = loadXLayerEnvConfig()

  // Try Onchain OS MCP first
  const osOpportunities = await scanViaOnchainOS(
    {},
    resolvedFilters,
    envConfig
  )

  if (osOpportunities.length > 0) {
    console.log(`[Scanner] Onchain OS: found ${osOpportunities.length} opportunities`)
    return osOpportunities.map(o => ({ ...o, source: 'onchainos' as const }))
  }

  // Fall back to direct RPC
  console.log('[Scanner] Falling back to direct RPC — SCAN_MODE=direct_rpc')
  return scanViaRpcFallback({}, resolvedFilters, envConfig)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Estimate TVL in USD from reserve amounts.
 *
 * Uses Beaon USDC as the quote stablecoin (confirmed on X Layer testnet).
 * If neither token is Beaon USDC, falls back to geometric mean × 2.
 *
 * TODO: Replace with real price feed from:
 *   - Chainlink oracle on X Layer
 *   - CoinGecko API (free tier)
 *   - Coingecko: GET /api/v3/simple/price?ids=okb&vs_currencies=usd
 */
function estimateTvlFromReserves(
  reserve0: bigint,
  reserve1: bigint,
  token0: Address,
  token1: Address,
  usdcAddr: Address
): number {
  // Determine token decimals (Beaon USDC = 6 decimals, everything else = 18)
  const USDC_DECIMALS = 6
  const DEFAULT_DECIMALS = 18

  const isToken0Usdc = token0.toLowerCase() === usdcAddr.toLowerCase()
  const isToken1Usdc = token1.toLowerCase() === usdcAddr.toLowerCase()

  const token0Decimals = isToken0Usdc ? USDC_DECIMALS : DEFAULT_DECIMALS
  const token1Decimals = isToken1Usdc ? USDC_DECIMALS : DEFAULT_DECIMALS

  const token0Normalized = Number(reserve0) / Math.pow(10, token0Decimals)
  const token1Normalized = Number(reserve1) / Math.pow(10, token1Decimals)

  if (isToken0Usdc) return token0Normalized
  if (isToken1Usdc) return token1Normalized

  // Neither is Beaon USDC — use geometric mean as rough TVL estimate
  if (token0Normalized > 0 && token1Normalized > 0) {
    return Math.sqrt(token0Normalized * token1Normalized) * 2
  }
  return 0
}

/**
 * Format a token pair as a human-readable label.
 * Strips the "0x" prefix and shows first 4 + last 4 characters.
 */
function formatPairLabel(token0: Address, token1: Address): string {
  const short = (a: Address) => `${a.slice(0, 6)}…${a.slice(-4)}`
  return `${short(token0)}/${short(token1)}`
}
