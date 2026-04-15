/**
 * OKX / X Layer — Environment Configuration
 *
 * Follows the same patterns as agent/hedera/env.ts:
 * - loadSecretValue() supports direct env var OR _FILE fallback
 * - Normalize-once: trim whitespace, reject empty strings
 * - Type-safe enum parsers for network/mode switches
 *
 * Required env vars for OKX target:
 *   X_LAYER_NETWORK          — 'mainnet' | 'testnet'
 *   X_LAYER_RPC_URL          — primary RPC endpoint
 *   X_LAYER_PRIVATE_KEY or X_LAYER_PRIVATE_KEY_FILE — agent wallet key
 *
 * Optional:
 *   OKX_VAULT_API_KEY / _SECRET / _PASSPHRASE  — OKX Vault Wallet API credentials
 *   ONCHAINOS_API_KEY_VAR                       — Onchain OS MCP API key
 *   ONCHAINOS_MCP_ENDPOINT                      — MCP server URL (default: https://mcp.okx.com/v1/mcp)
 *   X_LAYER_ARENA_ADDRESS                        — deployed Arena contract
 *   AGENT_LOOP_INTERVAL_MS                       — loop cycle interval (default: 60000)
 */

import { readFileSync } from 'node:fs'

// ─── Public RPC fallbacks (no auth required) ────────────────────────────────

export const X_LAYER_PUBLIC_RPC_MAINNET = 'https://rpc.xlayer.tech'
export const X_LAYER_PUBLIC_RPC_TESTNET = 'https://testrpc.xlayer.tech'
export const X_LAYER_PUBLIC_RPC_TESTNET_ALT = 'https://xlayertestrpc.okx.com'

// ─── Types ───────────────────────────────────────────────────────────────────

export type XLayerNetwork = 'mainnet' | 'testnet'

export interface XLayerSignerConfig {
  accountId: string // EVM address as hex string
  privateKey: string
  privateKeySource: 'env' | 'file'
}

export interface XLayerEnvConfig {
  network: XLayerNetwork
  chainId: number // viem chain ID: 196=mainnet, 195=testnet
  rpcUrl: string
  explorerUrl: string // block explorer base URL
  signer: XLayerSignerConfig
  okxVaultApiKey?: string
  okxVaultApiSecret?: string
  okxVaultApiPassphrase?: string
  onchainOSApiKey?: string
  onchainOSMcpEndpoint: string
  arenaAddress?: string
  agentLoopIntervalMs: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function requireValue(name: string, value: string | undefined): string {
  const normalized = normalizeOptional(value)
  if (!normalized) {
    throw new Error(`[okx-env] Missing required environment variable: ${name}`)
  }
  return normalized
}

type SecretSource = 'env' | 'file'

function loadSecretValue(
  env: Record<string, string | undefined>,
  name: string
): { value: string; source: SecretSource } | undefined {
  const direct = normalizeOptional(env[name])
  const filePath = normalizeOptional(env[`${name}_FILE`])

  if (direct && filePath) {
    throw new Error(`[okx-env] Set either ${name} or ${name}_FILE, not both`)
  }

  if (filePath) {
    const fromFile = normalizeOptional(readFileSync(filePath, 'utf8'))
    if (!fromFile) {
      throw new Error(`[okx-env] Secret file for ${name} was empty: ${filePath}`)
    }
    return { value: fromFile, source: 'file' }
  }

  if (direct) {
    return { value: direct, source: 'env' }
  }

  return undefined
}

function parseXLayerNetwork(value: string | undefined): XLayerNetwork {
  const normalized = normalizeOptional(value) ?? 'testnet'
  switch (normalized.toLowerCase()) {
    case 'mainnet':
    case 'testnet':
      return normalized.toLowerCase() as XLayerNetwork
    default:
      throw new Error(
        `[okx-env] X_LAYER_NETWORK must be 'mainnet' or 'testnet', got: ${value}`
      )
  }
}

function parseNonNegativeInt(
  name: string,
  value: string | undefined,
  defaultValue: number
): number {
  const normalized = normalizeOptional(value)
  if (!normalized) return defaultValue
  const parsed = Number(normalized)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`[okx-env] ${name} must be a non-negative integer`)
  }
  return parsed
}

// ─── Loader ──────────────────────────────────────────────────────────────────

export function loadXLayerEnvConfig(
  env: Record<string, string | undefined> = process.env
): XLayerEnvConfig {
  const network = parseXLayerNetwork(env.X_LAYER_NETWORK)

  // Chain IDs (viem: xLayer = 196, xLayerTestnet = 195)
  const chainId = network === 'mainnet' ? 196 : 195

  // RPC — use env var or fall back to public defaults
  const rpcUrl = normalizeOptional(env.X_LAYER_RPC_URL)
    ?? (network === 'mainnet' ? X_LAYER_PUBLIC_RPC_MAINNET : X_LAYER_PUBLIC_RPC_TESTNET)

  // Explorer
  const explorerUrl = network === 'mainnet'
    ? 'https://www.oklink.com/xlayer'
    : 'https://www.oklink.com/xlayer-test'

  // Signer — require private key
  const privateKeySecret = loadSecretValue(env, 'X_LAYER_PRIVATE_KEY')
  if (!privateKeySecret) {
    throw new Error(
      '[okx-env] X_LAYER_PRIVATE_KEY or X_LAYER_PRIVATE_KEY_FILE is required'
    )
  }

  // OKX Vault API (optional — use if Vault Wallet API available)
  const okxVaultApiKey = normalizeOptional(env.OKX_VAULT_API_KEY)
  const okxVaultApiSecret = normalizeOptional(env.OKX_VAULT_API_SECRET)
  const okxVaultApiPassphrase = normalizeOptional(env.OKX_VAULT_API_PASSPHRASE)

  // Derive account address — we store as accountId field matching signer config shape
  // Address derivation happens in vault-wallet.ts using viem's privateKeyToAccount
  // Here we just carry the raw key; the vault-wallet module will compute the address

  return {
    network,
    chainId,
    rpcUrl,
    explorerUrl,
    signer: {
      accountId: '', // filled by vault-wallet.ts after address derivation
      privateKey: privateKeySecret.value,
      privateKeySource: privateKeySecret.source,
    },
    okxVaultApiKey,
    okxVaultApiSecret,
    okxVaultApiPassphrase,
    onchainOSApiKey: normalizeOptional(env.ONCHAINOS_API_KEY_VAR),
    onchainOSMcpEndpoint:
      normalizeOptional(env.ONCHAINOS_MCP_ENDPOINT)
      ?? 'https://mcp.okx.com/v1/mcp',
    arenaAddress: normalizeOptional(env.X_LAYER_ARENA_ADDRESS),
    agentLoopIntervalMs: parseNonNegativeInt(
      'AGENT_LOOP_INTERVAL_MS',
      env.AGENT_LOOP_INTERVAL_MS,
      60_000
    ),
  }
}
