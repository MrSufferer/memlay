/**
 * OKX / X Layer — Onchain OS MCP Client
 *
 * Typed HTTP client for the Onchain OS MCP (Model Context Protocol) server.
 * Used by the OKX agent to execute on-chain operations via OKX's Onchain OS Skills.
 *
 * Transport: HTTP + JSON-RPC 2.0
 *   Onchain OS exposes an MCP-compatible HTTP endpoint at ONCHAINOS_MCP_ENDPOINT.
 *   We use a lightweight fetch-based transport (no @modelcontextprotocol/sdk needed).
 *
 * Priority tools (in order of use):
 *   1. wallet_balance   — verify agent wallet balance (loop startup)
 *   2. swap_quote       — get swap quote for execution (Task 2.4)
 *   3. swap             — execute a swap (Task 2.4)
 *   4. get_pool_data    — X Layer pool / liquidity data (scanner — Task 2.2)
 *   5. get_token_list   — supported token registry (helper)
 *
 * Fallback behaviour:
 *   - If ONCHAINOS_API_KEY_VAR is not set → logs degraded mode, all methods return null/empty
 *   - If MCP server unreachable → logs warning, returns null/empty (scanner falls back to RPC)
 *   - If individual tool call fails → retries up to 2 times with exponential backoff
 *
 * Security:
 *   - API key sent as Authorization: Bearer header
 *   - Never log request/response bodies that may contain sensitive data
 *
 * Usage:
 *   const client = await createOnchainOSClient()
 *   const balance = await client.walletBalance('0x...')
 *   const quote   = await client.swapQuote({ tokenIn: 'USDC', tokenOut: 'OKB', amountIn: '1000000' })
 *   const txHash  = await client.swap({ tokenIn: 'USDC', tokenOut: 'OKB', amountIn: '1000000', slippage: 0.005 })
 */

import { loadXLayerEnvConfig } from './env.js'
import type { Address, Hex } from 'viem'

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Represents the Onchain OS MCP client instance.
 * Obtain via createOnchainOSClient() — never construct directly.
 */
export interface OnchainOSClient {
  /** Check agent wallet balance on X Layer */
  walletBalance(address: Address): Promise<TokenBalance[]>

  /** Get a swap quote (does NOT execute) */
  swapQuote(params: SwapParams): Promise<SwapQuote | null>

  /** Execute a swap (calls Onchain OS to sign + broadcast) */
  swap(params: SwapParams & { slippage?: number }): Promise<SwapResult | null>

  /** Get pool / liquidity data for the scanner */
  getPoolData(params?: { chain?: string; limit?: number }): Promise<PoolData[]>

  /** Get list of supported tokens on X Layer */
  getTokenList(): Promise<TokenInfo[]>

  /** True if the client is connected and the MCP server is reachable */
  isConnected: boolean

  /** Close the client (cleanup, abort pending requests) */
  close(): void
}

// ─── Token Types ─────────────────────────────────────────────────────────────

export interface TokenBalance {
  token: string       // token symbol or address
  address: Address
  balance: string     // raw balance (hex string or decimal string)
  decimals: number
  balanceUsd?: number // estimated USD value
}

export interface TokenInfo {
  symbol: string
  address: Address
  decimals: number
  name: string
  logoUrl?: string
  isStablecoin?: boolean
  isNative?: boolean
}

// ─── Pool Types ──────────────────────────────────────────────────────────────

export interface PoolData {
  poolId: string
  dexName: string
  poolAddress: Address
  token0: TokenInfo
  token1: TokenInfo
  feeTier: number      // e.g. 0.003 = 0.3%
  tvlUsd: number
  volume24hUsd?: number
  apy?: number
  liquidity: string    // raw liquidity amount
}

// ─── Swap Types ─────────────────────────────────────────────────────────────

export interface SwapParams {
  tokenIn: string   // symbol or address of input token
  tokenOut: string  // symbol or address of output token
  amountIn: string  // raw amount (e.g. "1000000" for 1 USDC with 6 decimals)
}

export interface SwapQuote {
  tokenIn: string
  tokenOut: string
  amountIn: string
  amountOut: string        // estimated output
  amountOutMin: string     // minimum output after slippage
  priceImpact: number      // e.g. 0.005 = 0.5%
  route: string[]           // intermediate tokens in route
  estimatedExecutionPrice: string
  validUntil: number        // unix timestamp
}

export interface SwapResult {
  txHash: Hex
  status: 'pending' | 'confirmed' | 'failed'
  tokenIn: string
  tokenOut: string
  amountIn: string
  amountOut: string
  gasUsed?: string
}

// ─── MCP JSON-RPC Types ───────────────────────────────────────────────────────

interface McpRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: Record<string, unknown>
}

interface McpResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

// ─── Error Types ─────────────────────────────────────────────────────────────

export class OnchainOSError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'NOT_INITIALIZED'
      | 'API_KEY_MISSING'
      | 'ENDPOINT_UNREACHABLE'
      | 'TOOL_NOT_FOUND'
      | 'RATE_LIMITED'
      | 'INSUFFICIENT_BALANCE'
      | 'EXECUTION_FAILED'
      | 'UNKNOWN'
  ) {
    super(message)
    this.name = 'OnchainOSError'
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default MCP endpoint — override via ONCHAINOS_MCP_ENDPOINT env var */
const DEFAULT_MCP_ENDPOINT = 'https://mcp.okx.com/v1/mcp'

/** Onchain OS MCP protocol version */
const MCP_PROTOCOL_VERSION = '2024-11-05'

/** Timeout for individual MCP calls (ms) */
const MCP_TIMEOUT_MS = 10_000

/** Max retries for failed calls */
const MAX_RETRIES = 2

/** Initial backoff delay (ms) */
const INITIAL_BACKOFF_MS = 500

// ─── MCP Transport ───────────────────────────────────────────────────────────

/**
 * Thin HTTP transport for the Onchain OS MCP server.
 * Implements JSON-RPC 2.0 over HTTP using the fetch API.
 *
 * MCP message protocol:
 *   1. POST {endpoint} with JSON-RPC 2.0 request body
 *   2. Authorization: Bearer {apiKey} header
 *   3. Server responds with JSON-RPC 2.0 result or error
 *
 * Note: Unlike the standard MCP SDK, we don't use the full session/notification
 * protocol. We use a stateless request/response pattern which is sufficient for
 * the Onchain OS use case (tool call → result → done).
 */
async function mcpCall(
  endpoint: string,
  apiKey: string,
  method: string,
  params: Record<string, unknown> = {},
  attempt = 0
): Promise<unknown> {
  const requestId = Date.now() + Math.floor(Math.random() * 1_000_000)

  const body: McpRequest = {
    jsonrpc: '2.0',
    id: requestId,
    method,
    params,
  }

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'X-MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
    })
  } catch (err) {
    const err_ = err as { name?: string; message?: string }
    if (err_.name === 'TimeoutError' || err_.message?.includes('timeout')) {
      if (attempt < MAX_RETRIES) {
        const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt)
        console.warn(`[OnchainOS] MCP call timed out (attempt ${attempt + 1}/${MAX_RETRIES + 1}) — retrying in ${backoffMs}ms...`)
        await sleep(backoffMs)
        return mcpCall(endpoint, apiKey, method, params, attempt + 1)
      }
      throw new OnchainOSError(
        `MCP server timeout after ${MAX_RETRIES + 1} attempts: ${endpoint}`,
        'ENDPOINT_UNREACHABLE'
      )
    }
    throw new OnchainOSError(
      `MCP server unreachable: ${err_?.message ?? String(err)}`,
      'ENDPOINT_UNREACHABLE'
    )
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new OnchainOSError(
        `MCP API key rejected (HTTP ${response.status}) — check ONCHAINOS_API_KEY_VAR`,
        'API_KEY_MISSING'
      )
    }
    if (response.status === 429) {
      throw new OnchainOSError(
        `MCP server rate-limited (HTTP 429) — consider adding backoff`,
        'RATE_LIMITED'
      )
    }
    throw new OnchainOSError(
      `MCP server returned HTTP ${response.status}: ${response.statusText}`,
      'UNKNOWN'
    )
  }

  let data: McpResponse
  try {
    data = await response.json() as McpResponse
  } catch {
    throw new OnchainOSError(
      `MCP server returned invalid JSON`,
      'ENDPOINT_UNREACHABLE'
    )
  }

  if (data.error) {
    const errorCode = data.error.code
    const errorMsg = data.error.message

    // Retry on server errors (5xx)
    if (errorCode >= 500 && attempt < MAX_RETRIES) {
      const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt)
      console.warn(`[OnchainOS] MCP server error ${errorCode} (attempt ${attempt + 1}/${MAX_RETRIES + 1}) — retrying in ${backoffMs}ms...`)
      await sleep(backoffMs)
      return mcpCall(endpoint, apiKey, method, params, attempt + 1)
    }

    // Map known error codes
    if (errorMsg.toLowerCase().includes('tool not found') || errorMsg.toLowerCase().includes('not found')) {
      throw new OnchainOSError(`Tool not available on MCP server: ${method}`, 'TOOL_NOT_FOUND')
    }
    if (errorMsg.toLowerCase().includes('balance') || errorMsg.toLowerCase().includes('insufficient')) {
      throw new OnchainOSError(`Insufficient balance for operation: ${errorMsg}`, 'INSUFFICIENT_BALANCE')
    }
    if (errorMsg.toLowerCase().includes('swap') || errorMsg.toLowerCase().includes('execution')) {
      throw new OnchainOSError(`Swap execution failed: ${errorMsg}`, 'EXECUTION_FAILED')
    }

    throw new OnchainOSError(
      `MCP error [${errorCode}]: ${errorMsg}`,
      'UNKNOWN'
    )
  }

  return data.result
}

// ─── Client Factory ──────────────────────────────────────────────────────────

/**
 * Create an Onchain OS MCP client.
 *
 * Checks ONCHAINOS_API_KEY_VAR from env.
 * If not set → returns a degraded client that logs warnings and returns null/empty.
 * If set → attempts MCP handshake to verify connectivity.
 *
 * @param overrideEndpoint  Optional override for the MCP endpoint (useful for testing)
 */
export async function createOnchainOSClient(
  overrideEndpoint?: string
): Promise<OnchainOSClient> {
  const envConfig = loadXLayerEnvConfig()

  const apiKey = envConfig.onchainOSApiKey
  const endpoint = overrideEndpoint ?? envConfig.onchainOSMcpEndpoint ?? DEFAULT_MCP_ENDPOINT

  // ── Degraded mode: no API key ─────────────────────────────────────────────
  if (!apiKey) {
    console.warn('[OnchainOS] ONCHAINOS_API_KEY_VAR not set — Onchain OS disabled (degraded mode)')
    console.warn('[OnchainOS] Scanner will use RPC fallback. Set ONCHAINOS_API_KEY_VAR to enable.')
    return createDegradedClient()
  }

  // ── Probe MCP server ─────────────────────────────────────────────────────
  console.log(`[OnchainOS] Connecting to MCP server at ${endpoint}...`)

  let connected = false
  try {
    // Attempt a lightweight probe to verify the endpoint is reachable
    await mcpCall(endpoint, apiKey, 'tools/list', {})
    connected = true
  } catch (err) {
    const err_ = err as Error
    console.warn(`[OnchainOS] MCP server probe failed: ${err_.message}`)
    console.warn(`[OnchainOS] Falling back to RPC mode. Scanner will use RPC fallback.`)
    return createDegradedClient()
  }

  console.log(`[OnchainOS] ✅ Connected to Onchain OS MCP server`)

  // ── Build real client ─────────────────────────────────────────────────────
  return buildConnectedClient(endpoint, apiKey)
}

// ─── Connected Client ────────────────────────────────────────────────────────

function buildConnectedClient(endpoint: string, apiKey: string): OnchainOSClient {
  let requestCounter = 0

  async function call<T = unknown>(toolName: string, params: Record<string, unknown> = {}): Promise<T | null> {
    try {
      const result = await mcpCall(endpoint, apiKey, `tools/call`, {
        tool: toolName,
        params,
      })
      return result as T ?? null
    } catch (err) {
      if (err instanceof OnchainOSError) {
        // Log non-fatal errors but don't crash
        console.warn(`[OnchainOS] Tool '${toolName}' failed: ${err.message}`)
      }
      return null
    }
  }

  return {
    isConnected: true,

    async walletBalance(address: Address): Promise<TokenBalance[]> {
      const result = await call<OnchainOSBalanceResult>('wallet_balance', {
        chain: 'xlayer',
        address: address.toLowerCase(),
      })
      if (!result?.balances) return []
      return result.balances.map((b: any) => ({
        token: b.token ?? b.symbol ?? 'UNKNOWN',
        address: (b.tokenAddress ?? b.address ?? '0x0000000000000000000000000000000000000000') as Address,
        balance: b.balance ?? '0',
        decimals: Number(b.decimals ?? 18),
        balanceUsd: b.balanceUsd ?? b.balanceUSD ? Number(b.balanceUsd ?? b.balanceUSD) : undefined,
      }))
    },

    async swapQuote(params: SwapParams): Promise<SwapQuote | null> {
      const result = await call<OnchainOSSwapResult>('swap_quote', {
        chain: 'xlayer',
        token_in: params.tokenIn,
        token_out: params.tokenOut,
        amount_in: params.amountIn,
      })
      if (!result) return null
      return {
        tokenIn: result.token_in ?? params.tokenIn,
        tokenOut: result.token_out ?? params.tokenOut,
        amountIn: result.amount_in ?? params.amountIn,
        amountOut: result.amount_out ?? '0',
        amountOutMin: result.amount_out_min ?? result.amount_out ?? '0',
        priceImpact: Number(result.price_impact ?? result.priceImpact ?? 0),
        route: result.route ?? [],
        estimatedExecutionPrice: result.estimated_execution_price ?? result.executionPrice ?? '0',
        validUntil: Number(result.valid_until ?? result.validUntil ?? Date.now() / 1000 + 60),
      }
    },

    async swap(params: SwapParams & { slippage?: number }): Promise<SwapResult | null> {
      const slippage = params.slippage ?? 0.005
      const result = await call<OnchainOSSwapExecuteResult>('swap', {
        chain: 'xlayer',
        token_in: params.tokenIn,
        token_out: params.tokenOut,
        amount_in: params.amountIn,
        slippage_tolerance: slippage,
      })
      if (!result) return null
      return {
        txHash: (result.tx_hash ?? result.txHash ?? '0x') as Hex,
        status: (result.status ?? 'pending') as 'pending' | 'confirmed' | 'failed',
        tokenIn: result.token_in ?? params.tokenIn,
        tokenOut: result.token_out ?? params.tokenOut,
        amountIn: result.amount_in ?? params.amountIn,
        amountOut: result.amount_out ?? '0',
        gasUsed: result.gas_used ?? result.gasUsed,
      }
    },

    async getPoolData(params?: { chain?: string; limit?: number }): Promise<PoolData[]> {
      const result = await call<OnchainOSPoolResult[]>('get_pool_data', {
        chain: params?.chain ?? 'xlayer',
        limit: params?.limit ?? 50,
      })
      if (!result || !Array.isArray(result)) return []
      return result.map((p: any) => ({
        poolId: p.pool_id ?? p.poolId ?? p.id ?? '',
        dexName: p.dex ?? p.dexName ?? p.exchange ?? 'Unknown',
        poolAddress: (p.pool_address ?? p.poolAddress ?? p.address ?? '0x0000000000000000000000000000000000000000') as Address,
        token0: {
          symbol: p.token0?.symbol ?? p.token0Symbol ?? p.token_a_symbol ?? '?',
          address: (p.token0?.address ?? p.token0Address ?? p.token_a ?? '0x0000000000000000000000000000000000000000') as Address,
          decimals: Number(p.token0?.decimals ?? p.token0Decimals ?? 18),
          name: p.token0?.name ?? p.token0Name ?? '',
        },
        token1: {
          symbol: p.token1?.symbol ?? p.token1Symbol ?? p.token_b_symbol ?? '?',
          address: (p.token1?.address ?? p.token1Address ?? p.token_b ?? '0x0000000000000000000000000000000000000000') as Address,
          decimals: Number(p.token1?.decimals ?? p.token1Decimals ?? 18),
          name: p.token1?.name ?? p.token1Name ?? '',
        },
        feeTier: Number(p.fee_tier ?? p.feeTier ?? p.fee ?? 0.003),
        tvlUsd: Number(p.tvl_usd ?? p.tvlUsd ?? p.tvl ?? 0),
        volume24hUsd: p.volume_24h_usd ? Number(p.volume_24h_usd) : undefined,
        apy: p.apy ? Number(p.apy) : undefined,
        liquidity: p.liquidity ?? p.reserve ?? '0',
      }))
    },

    async getTokenList(): Promise<TokenInfo[]> {
      const result = await call<OnchainOSTokenResult[]>('get_token_list', {
        chain: 'xlayer',
      })
      if (!result || !Array.isArray(result)) return []
      return result.map((t: any) => ({
        symbol: t.symbol ?? '?',
        address: (t.address ?? t.token ?? '0x0000000000000000000000000000000000000000') as Address,
        decimals: Number(t.decimals ?? 18),
        name: t.name ?? t.symbol ?? '',
        logoUrl: t.logo_url ?? t.logoUrl,
        isStablecoin: Boolean(t.is_stablecoin ?? t.isStablecoin),
        isNative: Boolean(t.is_native ?? t.isNative),
      }))
    },

    close(): void {
      // Stateless HTTP transport — nothing to close, but interface requires it
      console.log('[OnchainOS] Client closed')
    },
  }
}

// ─── Degraded Client (no API key / unreachable) ──────────────────────────────

function createDegradedClient(): OnchainOSClient {
  return {
    isConnected: false,

    async walletBalance(): Promise<TokenBalance[]> {
      console.debug('[OnchainOS] walletBalance: degraded mode — returning empty')
      return []
    },

    async swapQuote(): Promise<SwapQuote | null> {
      console.debug('[OnchainOS] swapQuote: degraded mode — returning null')
      return null
    },

    async swap(): Promise<SwapResult | null> {
      console.debug('[OnchainOS] swap: degraded mode — returning null')
      return null
    },

    async getPoolData(): Promise<PoolData[]> {
      console.debug('[OnchainOS] getPoolData: degraded mode — returning empty')
      return []
    },

    async getTokenList(): Promise<TokenInfo[]> {
      console.debug('[OnchainOS] getTokenList: degraded mode — returning empty')
      return []
    },

    close(): void {
      // no-op
    },
  }
}

// ─── Onchain OS Raw Response Types ───────────────────────────────────────────
// These map from the Onchain OS API response shape to our typed interfaces.

interface OnchainOSBalanceResult {
  balances?: Array<{
    token?: string
    symbol?: string
    tokenAddress?: string
    address?: string
    balance?: string
    decimals?: number | string
    balanceUsd?: number | string
    balanceUSD?: number | string
  }>
}

interface OnchainOSSwapResult {
  token_in?: string
  token_out?: string
  amount_in?: string
  amount_out?: string
  amount_out_min?: string
  price_impact?: number | string
  priceImpact?: number | string
  route?: string[]
  estimated_execution_price?: string
  executionPrice?: string
  valid_until?: number | string
  validUntil?: number | string
}

interface OnchainOSSwapExecuteResult extends OnchainOSSwapResult {
  tx_hash?: string
  txHash?: string
  status?: string
  gas_used?: string
  gasUsed?: string
}

interface OnchainOSPoolResult {
  pool_id?: string
  poolId?: string
  id?: string
  dex?: string
  dexName?: string
  exchange?: string
  pool_address?: string
  poolAddress?: string
  address?: string
  token0?: {
    symbol?: string
    address?: string
    decimals?: number | string
    name?: string
  }
  token0Symbol?: string
  token0Address?: string
  token0Decimals?: number | string
  token0Name?: string
  token_a_symbol?: string
  token_a?: string
  token1?: {
    symbol?: string
    address?: string
    decimals?: number | string
    name?: string
  }
  token1Symbol?: string
  token1Address?: string
  token1Decimals?: number | string
  token1Name?: string
  token_b_symbol?: string
  token_b?: string
  fee_tier?: number | string
  feeTier?: number | string
  fee?: number | string
  tvl_usd?: number | string
  tvlUsd?: number | string
  tvl?: number | string
  volume_24h_usd?: number | string
  apy?: number | string
  liquidity?: string
  reserve?: string
}

interface OnchainOSTokenResult {
  symbol?: string
  address?: string
  token?: string
  decimals?: number | string
  name?: string
  logo_url?: string
  logoUrl?: string
  is_stablecoin?: boolean
  isStablecoin?: boolean
  is_native?: boolean
  isNative?: boolean
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

