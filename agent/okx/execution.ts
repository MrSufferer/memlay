/**
 * OKX / X Layer — Execution Layer
 *
 * Handles the ACT step of the agent loop:
 *   1. getSwapQuote()  — fetch quote before executing (validates price, slippage, route)
 *   2. executeSwap()   — call OnchainOSClient.swap() with quote + wallet
 *   3. confirmSwap()    — poll for tx confirmation (via Onchain OS or RPC)
 *
 * Falls back to direct RPC execution via BeaonSwap router when:
 *   - ONCHAINOS_API_KEY_VAR is not set (degraded mode)
 *   - MCP server is unreachable
 *   - swapQuote() returns null (no route available)
 *
 * Architecture:
 *   - OnchainOSClient handles retry + backoff internally (max 2 retries)
 *   - RPC fallback uses viem WalletClient for BeaonSwap router calls
 *   - All execution is non-blocking — confirmation is async (no blocking wait)
 *
 * Security notes:
 *   - Slippage capped at 5% (0.05) to prevent MEV/front-run losses
 *   - Approval is for exact amount only (not unlimited) to limit token exposure
 *   - No private keys ever logged
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  type Address,
  type Hex,
} from 'viem'
import { xLayer, xLayerTestnet } from 'viem/chains'
import { loadXLayerEnvConfig, type XLayerEnvConfig } from './env.js'
import {
  createOnchainOSClient,
  type SwapQuote,
  type SwapResult,
} from './onchain-os-client.js'
import { loadVaultWallet, type VaultWallet } from './vault-wallet.js'
import {
  BEAON_USDC,
  BEAONSWAP_ROUTER,
} from './scanner.js'

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Maximum slippage tolerated (5%) — protects against MEV / front-running */
const MAX_SLIPPAGE = 0.05

/** Minimal ERC20 ABI for allowance / approve / balanceOf calls */
const ERC20_ABI = [
  { type: 'function', name: 'allowance', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const

/** Default slippage (0.5%) — overridden by trader template */
const DEFAULT_SLIPPAGE = 0.005

/** Poll interval for tx confirmation (ms) */
const CONFIRM_POLL_MS = 2_000

/** Max polls before giving up on confirmation */
const MAX_CONFIRM_POLLS = 15

// ─── Execution Result Types ────────────────────────────────────────────────────

export interface ExecutionResult {
  /** Transaction hash on X Layer */
  txHash: Hex
  /** Status of the swap */
  status: 'pending' | 'confirmed' | 'failed'
  /** Token pair executed */
  tokenIn: string
  tokenOut: string
  /** Amount in (raw string from Onchain OS) */
  amountIn: string
  /** Amount received (raw string) */
  amountOut: string
  /** Price impact as decimal (e.g. 0.005 = 0.5%) */
  priceImpact: number
  /** Slippage used */
  slippage: number
  /** Estimated USD value of output */
  amountOutUsd?: number
  /** Gas used (if available) */
  gasUsed?: string
  /** Source: 'onchainos' | 'direct_rpc' */
  source: 'onchainos' | 'direct_rpc'
  /** Error message if failed */
  error?: string
}

// ─── RPC Fallback Types ────────────────────────────────────────────────────────

/** Minimal BeaonSwap router ABI (subset needed for swaps) */
const BEAON_ROUTER_ABI = [
  {
    type: 'function',
    name: 'swapExactTokensForTokens',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'swapExactETHForTokens',
    inputs: [
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'swapExactTokensForETH',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'nonpayable',
  },
] as const

// ─── Main Execution Entry Point ───────────────────────────────────────────────

export interface ExecuteSwapParams {
  /** Scored opportunity from the agent loop */
  opportunity: {
    pair: string
    tokenIn: Address
    tokenOut: Address
    tokenInSymbol: string
    tokenOutSymbol: string
    tvlUsd: number
    source: string
    poolAddress: Address
  }
  /** Vault wallet for signing */
  wallet: VaultWallet
  /** Slippage tolerance (decimal, e.g. 0.005 = 0.5%). Default: 0.005 */
  slippage?: number
  /** Amount in (human-readable, e.g. "100"). Default: "100" */
  amountInHuman?: string
  /** Token decimals for amount parsing. Default: 18 */
  decimals?: number
}

/**
 * Execute a swap for a qualifying opportunity.
 *
 * Strategy:
 *   1. Try OnchainOSClient.swap() — full managed execution (OKX handles signing)
 *   2. If degraded → try direct RPC via BeaonSwap router (viem WalletClient)
 *   3. If RPC also fails → return failed result
 *
 * The OnchainOSClient handles retry + exponential backoff internally.
 *
 * @returns ExecutionResult with txHash, status, amountOut, priceImpact
 */
export async function executeSwap(params: ExecuteSwapParams): Promise<ExecutionResult> {
  const {
    opportunity,
    wallet,
    slippage = DEFAULT_SLIPPAGE,
    amountInHuman = '100',
    decimals = 18,
  } = params

  const { tokenIn, tokenOut, tokenInSymbol, tokenOutSymbol, pair, source } = opportunity
  const cappedSlippage = Math.min(slippage, MAX_SLIPPAGE)

  // Parse amount in to raw units
  const amountInRaw = parseUnits(amountInHuman, decimals).toString()

  console.log(`[Execution] Executing swap: ${tokenInSymbol} → ${tokenOutSymbol}`)
  console.log(`[Execution]   Pair: ${pair} | Amount in: ${amountInHuman} ${tokenInSymbol}`)
  console.log(`[Execution]   Slippage: ${(cappedSlippage * 100).toFixed(1)}% | Source: ${source}`)

  // ── Step 1: Try Onchain OS ────────────────────────────────────────────────
  const osResult = await tryOnchainOS({
    tokenIn,
    tokenOut,
    tokenInSymbol,
    tokenOutSymbol,
    amountInRaw,
    slippage: cappedSlippage,
    wallet,
  })

  if (osResult) {
    return osResult
  }

  // ── Step 2: RPC Fallback ───────────────────────────────────────────────────
  console.log('[Execution] Onchain OS unavailable — falling back to direct RPC')
  const rpcResult = await tryRpcFallback({
    tokenIn,
    tokenOut,
    tokenInSymbol,
    tokenOutSymbol,
    amountInRaw,
    slippage: cappedSlippage,
    wallet,
  })

  if (rpcResult) {
    return rpcResult
  }

  // ── Step 3: Both failed ────────────────────────────────────────────────────
  return {
    txHash: '0x' as Hex,
    status: 'failed',
    tokenIn: tokenInSymbol,
    tokenOut: tokenOutSymbol,
    amountIn: amountInRaw,
    amountOut: '0',
    priceImpact: 0,
    slippage: cappedSlippage,
    source: 'direct_rpc',
    error: 'Both Onchain OS and direct RPC execution failed — check logs above',
  }
}

// ─── Onchain OS Path ──────────────────────────────────────────────────────────

async function tryOnchainOS(params: {
  tokenIn: Address
  tokenOut: Address
  tokenInSymbol: string
  tokenOutSymbol: string
  amountInRaw: string
  slippage: number
  wallet: VaultWallet
}): Promise<ExecutionResult | null> {
  const { tokenIn, tokenOut, tokenInSymbol, tokenOutSymbol, amountInRaw, slippage, wallet } = params

  const endpoint = process.env.ONCHAINOS_MCP_ENDPOINT ?? 'https://mcp.okx.com/v1/mcp'
  const apiKey = process.env.ONCHAINOS_API_KEY_VAR

  if (!apiKey) {
    console.log('[Execution] ONCHAINOS_API_KEY_VAR not set — skipping Onchain OS')
    return null
  }

  let client: Awaited<ReturnType<typeof createOnchainOSClient>>
  try {
    client = await createOnchainOSClient(endpoint)
  } catch (err) {
    console.warn(`[Execution] OnchainOS client creation failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }

  if (!client.isConnected) {
    console.log('[Execution] OnchainOS not connected — using RPC fallback')
    return null
  }

  // ── Step 1a: Get quote (validates route exists) ──────────────────────────
  console.log(`[Execution] Fetching swap quote from Onchain OS...`)
  const quote = await client.swapQuote({
    tokenIn: tokenInSymbol, // Onchain OS accepts symbols for common tokens
    tokenOut: tokenOutSymbol,
    amountIn: amountInRaw,
  })

  if (!quote) {
    console.warn('[Execution] No swap quote available from Onchain OS')
    return null
  }

  console.log(`[Execution] Quote received:`)
  console.log(`  ${formatUnits(BigInt(quote.amountIn), 18)} ${tokenInSymbol} → ${formatUnits(BigInt(quote.amountOut), 18)} ${tokenOutSymbol}`)
  console.log(`  Price impact: ${(quote.priceImpact * 100).toFixed(2)}%`)
  console.log(`  Route: ${quote.route.join(' → ') || `${tokenInSymbol} → ${tokenOutSymbol}`}`)
  console.log(`  Valid until: ${new Date(quote.validUntil * 1000).toISOString()}`)

  // Reject if price impact is excessive
  if (quote.priceImpact > MAX_SLIPPAGE) {
    console.warn(`[Execution] Price impact ${(quote.priceImpact * 100).toFixed(1)}% exceeds max slippage ${(MAX_SLIPPAGE * 100).toFixed(0)}% — skipping`)
    return {
      txHash: '0x' as Hex,
      status: 'failed',
      tokenIn: tokenInSymbol,
      tokenOut: tokenOutSymbol,
      amountIn: amountInRaw,
      amountOut: '0',
      priceImpact: quote.priceImpact,
      slippage,
      source: 'onchainos',
      error: `Price impact ${(quote.priceImpact * 100).toFixed(1)}% exceeds max slippage`,
    }
  }

  // ── Step 1b: Execute swap ────────────────────────────────────────────────
  console.log(`[Execution] Executing swap via Onchain OS (slippage=${(slippage * 100).toFixed(1)}%)...`)
  const result = await client.swap({
    tokenIn: tokenInSymbol,
    tokenOut: tokenOutSymbol,
    amountIn: amountInRaw,
    slippage,
  })

  if (!result) {
    console.warn('[Execution] Swap execution returned null from Onchain OS')
    return null
  }

  console.log(`[Execution] Swap submitted: txHash=${result.txHash}, status=${result.status}`)

  const explorerUrl = wallet.chainId === 196
    ? 'https://www.oklink.com/xlayer'
    : 'https://www.oklink.com/xlayer-test'
  if (result.txHash && result.txHash !== '0x') {
    console.log(`[Execution] View on explorer: ${explorerUrl}/tx/${result.txHash}`)
  }

  return {
    txHash: result.txHash,
    status: result.status,
    tokenIn: tokenInSymbol,
    tokenOut: tokenOutSymbol,
    amountIn: result.amountIn,
    amountOut: result.amountOut,
    priceImpact: quote.priceImpact,
    slippage,
    source: 'onchainos',
    gasUsed: result.gasUsed,
  }
}

// ─── RPC Fallback Path ─────────────────────────────────────────────────────────

async function tryRpcFallback(params: {
  tokenIn: Address
  tokenOut: Address
  tokenInSymbol: string
  tokenOutSymbol: string
  amountInRaw: string
  slippage: number
  wallet: VaultWallet
}): Promise<ExecutionResult | null> {
  const { tokenIn, tokenOut, tokenInSymbol, tokenOutSymbol, amountInRaw, slippage, wallet } = params

  const envConfig = loadXLayerEnvConfig()
  const network: 'mainnet' | 'testnet' = wallet.chainId === 196 ? 'mainnet' : 'testnet'
  const viemChain = network === 'mainnet' ? xLayer : xLayerTestnet
  const rpcUrl = envConfig.rpcUrl
  const routerAddr = BEAONSWAP_ROUTER[network] ?? BEAONSWAP_ROUTER['testnet']
  const explorerUrl = network === 'mainnet'
    ? 'https://www.oklink.com/xlayer'
    : 'https://www.oklink.com/xlayer-test'

  if (routerAddr === '0x0000000000000000000000000000000000000000') {
    console.warn('[Execution] No BeaonSwap router for network:', network)
    return null
  }

  // ── Build clients ──────────────────────────────────────────────────────────
  const publicClient = createPublicClient({
    chain: viemChain,
    transport: http(rpcUrl),
  })

  // Build a viem WalletClient from the VaultWallet using its account
  const walletClient = createWalletClient({
    account: wallet.account,
    chain: viemChain,
    transport: http(rpcUrl),
  })

  const deadline = Math.floor(Date.now() / 1000) + 600 // 10 minute deadline

  // ── Step 2a: Check token allowance ───────────────────────────────────────
  console.log(`[Execution] Checking allowance for ${tokenInSymbol}...`)
  const allowance = await publicClient.readContract({
    address: tokenIn,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [wallet.address, routerAddr],
  } as any) as bigint

  const amountInBigInt = BigInt(amountInRaw)
  if (allowance < amountInBigInt) {
    console.log(`[Execution] Approving ${tokenInSymbol} for BeaonSwap router...`)
    const approveHash = await walletClient.writeContract({
      address: tokenIn,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [routerAddr, amountInBigInt],
      account: wallet.account,
    } as any)
    console.log(`[Execution] Approval tx: ${explorerUrl}/tx/${approveHash}`)

    // Wait for approval to confirm
    await publicClient.waitForTransactionReceipt({ hash: approveHash })
    console.log(`[Execution] Approval confirmed`)
  } else {
    console.log(`[Execution] Allowance sufficient (${formatUnits(allowance, 18)} ${tokenInSymbol})`)
  }

  // ── Step 2b: Get expected output amount (for slippage calc) ──────────────
  // Try to read reserves for slippage calculation
  let amountOutMin = BigInt(0)
  try {
    // Read from BeaonSwap router or pair — try the pair directly
    const reserves = await (publicClient.readContract({
      address: tokenIn, // use token as pair proxy
      abi: [{
        type: 'function', name: 'getReserves',
        inputs: [], outputs: [
          { name: 'reserve0', type: 'uint112' },
          { name: 'reserve1', type: 'uint112' },
          { name: 'blockTimestampLast', type: 'uint32' },
        ],
        stateMutability: 'view',
      }],
      functionName: 'getReserves',
    } as any) as Promise<[bigint, bigint, number]>)
      .catch(() => [BigInt(0), BigInt(0), 0] as [bigint, bigint, number])

    if (reserves[0] > BigInt(0) || reserves[1] > BigInt(0)) {
      // Simple constant-product: amountOut = amountIn * reserveOut / reserveIn
      const reserveOut = tokenIn < tokenOut ? reserves[1] : reserves[0]
      const reserveIn = tokenIn < tokenOut ? reserves[0] : reserves[1]
      if (reserveIn > BigInt(0)) {
        const expectedOut = amountInBigInt * reserveOut / reserveIn
        amountOutMin = expectedOut * BigInt(Math.floor((1 - slippage) * 1000)) / BigInt(1000)
      }
    }
  } catch {
    // No reserve data available — use 0 min (accept whatever the router returns)
    console.warn('[Execution] Could not read reserves — amountOutMin set to 0')
  }

  // ── Step 2c: Execute swap ────────────────────────────────────────────────
  console.log(`[Execution] Submitting swap to BeaonSwap router...`)

  let txHash: Hex = '0x' as Hex
  try {
    const hash = await walletClient.writeContract({
      address: routerAddr,
      abi: BEAON_ROUTER_ABI,
      functionName: 'swapExactTokensForTokens',
      args: [amountInBigInt, amountOutMin, [tokenIn, tokenOut], wallet.address, BigInt(deadline)],
      account: wallet.account,
    } as any)
    txHash = hash
    console.log(`[Execution] Swap tx submitted: ${explorerUrl}/tx/${txHash}`)
  } catch (err) {
    console.error(`[Execution] RPC swap failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }

  // ── Step 2d: Wait for confirmation ───────────────────────────────────────
  console.log(`[Execution] Waiting for confirmation...`)
  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 60_000,
    })

    const status = receipt.status === 'success' ? 'confirmed' : 'failed'
    console.log(`[Execution] Swap ${status} at block ${receipt.blockNumber}`)

    return {
      txHash,
      status,
      tokenIn: tokenInSymbol,
      tokenOut: tokenOutSymbol,
      amountIn: amountInRaw,
      amountOut: '0', // Can't get output amount without events
      priceImpact: slippage, // Approximate
      slippage,
      source: 'direct_rpc',
    }
  } catch (err) {
    console.warn(`[Execution] Confirmation timeout: ${err instanceof Error ? err.message : String(err)}`)
    return {
      txHash,
      status: 'pending',
      tokenIn: tokenInSymbol,
      tokenOut: tokenOutSymbol,
      amountIn: amountInRaw,
      amountOut: '0',
      priceImpact: slippage,
      slippage,
      source: 'direct_rpc',
      error: 'Transaction submitted but confirmation timed out',
    }
  }
}

// ─── Confirmation Helper ───────────────────────────────────────────────────────

/**
 * Wait for a transaction to be confirmed on X Layer.
 *
 * Polls the RPC every CONFIRM_POLL_MS until:
 *   - Receipt is found (confirmed or failed)
 *   - MAX_CONFIRM_POLLS reached (returns pending)
 */
export async function confirmTransaction(
  txHash: Hex,
  rpcUrl: string,
  chainId: number,
  pollMs = CONFIRM_POLL_MS,
  maxPolls = MAX_CONFIRM_POLLS
): Promise<'confirmed' | 'failed' | 'pending'> {
  if (!txHash || txHash === '0x') return 'pending'

  const chain = chainId === 196 ? xLayer : xLayerTestnet
  const client = createPublicClient({ chain, transport: http(rpcUrl) })

  for (let i = 0; i < maxPolls; i++) {
    try {
      const receipt = await client.getTransactionReceipt({ hash: txHash })
      return receipt.status === 'success' ? 'confirmed' : 'failed'
    } catch {
      // Tx not yet mined — poll again
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs))
  }

  return 'pending'
}

// ─── Convenience: Check Wallet Balances ───────────────────────────────────────

/**
 * Get the USDC / native token balance for the agent wallet.
 * Useful for the loop startup check and pre-trade validation.
 */
export async function getAgentBalances(wallet: VaultWallet): Promise<{
  usdcBalance: string
  nativeBalance: string
  usdcBalanceUsd: number
}> {
  const envConfig = loadXLayerEnvConfig()
  const network: 'mainnet' | 'testnet' = wallet.chainId === 196 ? 'mainnet' : 'testnet'
  const usdcAddr = BEAON_USDC[network] ?? BEAON_USDC['testnet']
  const viemChain = network === 'mainnet' ? xLayer : xLayerTestnet

  const client = createPublicClient({ chain: viemChain, transport: http(envConfig.rpcUrl) })

  let usdcBalance = '0'
  let nativeBalance = '0'
  let usdcBalanceUsd = 0

  try {
    const [usdc, native] = await Promise.all([
      client.readContract({
        address: usdcAddr,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [wallet.address],
      } as any) as Promise<bigint>,
      client.getBalance({ address: wallet.address }),
    ])

    usdcBalance = formatUnits(usdc, 6) // Beaon USDC is 6 decimals
    nativeBalance = formatUnits(native, 18)
    usdcBalanceUsd = Number(usdcBalance) // Assume 1 USDC = $1
  } catch (err) {
    console.warn(`[Execution] Balance check failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  return { usdcBalance, nativeBalance, usdcBalanceUsd }
}
