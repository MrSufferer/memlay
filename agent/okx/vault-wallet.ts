/**
 * OKX / X Layer — Vault Wallet
 *
 * Agent's on-chain identity and transaction signer for X Layer.
 *
 * PRIMARY PATH: OKX Vault Wallet API
 *   - Research OKX Vault Wallet API endpoints
 *   - If available: derive key via MPC API, use for signing
 *   - MVP: may require OKX account auth (browser-based flow)
 *
 * FALLBACK PATH (hackathon default):
 *   - Raw private key from X_LAYER_PRIVATE_KEY env var
 *   - Address derived via viem's privateKeyToAccount
 *   - SECURITY NOTE: raw key is hackathon-only; production requires MPC/TEE
 *
 * Architecture:
 *   vault-wallet.ts (this module) is the ONLY place
 *   privateKeyToAccount is called. All other modules
 *   receive the signer interface, never raw keys.
 *
 * Usage:
 *   const wallet = await loadVaultWallet()
 *   wallet.address          // hex EVM address
 *   wallet.signTransaction(tx) // viem WalletClient account signer
 *   wallet.sendTransaction(tx) // broadcast via walletClient
 */

import {
  createWalletClient,
  http,
  type Address,
  type Hex,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { xLayer, xLayerTestnet } from 'viem/chains'
import { loadXLayerEnvConfig, type XLayerEnvConfig } from './env.js'

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * The vault wallet interface returned by loadVaultWallet().
 * Only this interface should be used by other modules — never raw private keys.
 */
export interface VaultWallet {
  /** EVM address of the agent wallet */
  address: Address
  /** viem account derived from private key (for signing) */
  account: ReturnType<typeof privateKeyToAccount>
  /** Full viem WalletClient (account + chain + transport) */
  walletClient: WalletClient
  /** Chain ID the wallet is configured for */
  chainId: number
  /** True if using OKX Vault API; false if using raw private key fallback */
  isVaultApi: boolean
  /** Human-readable source label */
  source: 'OKX_VAULT_API' | 'RAW_PRIVATE_KEY'
  /** Raw private key (hex) — stored for reuse when creating derived wallet clients */
  signingKey: Hex
}

export interface VaultWalletOptions {
  network?: 'mainnet' | 'testnet'
  rpcUrl?: string
}

// ─── Error Types ─────────────────────────────────────────────────────────────

export class VaultWalletError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'MISSING_PRIVATE_KEY'
      | 'MISSING_VAULT_API_KEYS'
      | 'INVALID_KEY_FORMAT'
      | 'VAULT_API_ERROR'
      | 'CHAIN_MISMATCH'
  ) {
    super(message)
    this.name = 'VaultWalletError'
  }
}

// ─── Main Loader ─────────────────────────────────────────────────────────────

/**
 * Load the vault wallet.
 *
 * Checks env for OKX Vault API credentials first.
 * Falls back to raw private key if Vault API unavailable.
 *
 * @param options.overrideNetwork - Force a specific network (default: from env)
 * @param options.overrideRpcUrl  - Force a specific RPC (default: from env)
 */
export async function loadVaultWallet(
  options: VaultWalletOptions = {}
): Promise<VaultWallet> {
  const envConfig = loadXLayerEnvConfig()
  const network = options.network ?? envConfig.network
  const rpcUrl = options.rpcUrl ?? envConfig.rpcUrl

  const viemChain = network === 'mainnet' ? xLayer : xLayerTestnet
  const chainId = network === 'mainnet' ? 196 : 195

  // ── Path 1: OKX Vault API ────────────────────────────────────────────────
  if (envConfig.okxVaultApiKey && envConfig.okxVaultApiSecret && envConfig.okxVaultApiPassphrase) {
    console.log('[VaultWallet] Using OKX Vault API credentials')
    return buildVaultApiWallet({
      apiKey: envConfig.okxVaultApiKey,
      apiSecret: envConfig.okxVaultApiSecret,
      apiPassphrase: envConfig.okxVaultApiPassphrase,
      chainId,
      rpcUrl,
    })
  }

  // ── Path 2: Raw Private Key (hackathon fallback) ─────────────────────────
  if (envConfig.signer.privateKey) {
    console.log('[VaultWallet] ⚠️  Using RAW PRIVATE KEY — hackathon fallback only')
    console.log('[VaultWallet] SECURITY NOTE: For production, use OKX Vault Wallet API or MPC/TEE solution.')
    return buildRawKeyWallet({
      privateKey: envConfig.signer.privateKey,
      chainId,
      rpcUrl,
    })
  }

  throw new VaultWalletError(
    'No vault wallet credentials found. Set OKX_VAULT_API_KEY/_SECRET/_PASSPHRASE ' +
    'or X_LAYER_PRIVATE_KEY in your .env file.',
    'MISSING_PRIVATE_KEY'
  )
}

// ─── OKX Vault API Path ───────────────────────────────────────────────────────

interface VaultApiWalletParams {
  apiKey: string
  apiSecret: string
  apiPassphrase: string
  chainId: number
  rpcUrl: string
}

async function buildVaultApiWallet(
  params: VaultApiWalletParams
): Promise<VaultWallet> {
  // ─────────────────────────────────────────────────────────────────────────
  // TODO: Implement OKX Vault Wallet API integration
  //
  // Known OKX Vault Wallet API patterns (to research):
  //   Base URL: https://www.okx.com/api/v5/wallet
  //   Endpoints to research:
  //     POST /wallet/v3/agent/create     — create agent wallet
  //     POST /wallet/v3/agent/sign        — sign transaction
  //     GET  /wallet/v3/agent/balance     — get token balances
  //   Auth: OKX API key + secret + passphrase (HMAC-SHA256)
  //
  // MPC/TEE alternative (if Vault API unavailable):
  //   OKX Web3 Hub may expose MPC key shares via their SDK:
  //     https://www.okx.com/web3/build/docs/wallet
  //
  // If Vault API does not support autonomous signing (requires user approval):
  //   Use raw private key as the agent's EVM identity instead.
  // ─────────────────────────────────────────────────────────────────────────

  throw new VaultWalletError(
    'OKX Vault Wallet API integration not yet implemented.\n' +
    'Set X_LAYER_PRIVATE_KEY as a fallback to continue.\n' +
    'To implement: research OKX Vault API at https://www.okx.com/web3/build/docs/wallet',
    'MISSING_VAULT_API_KEYS'
  )
}

// ─── Raw Private Key Path ─────────────────────────────────────────────────────

interface RawKeyWalletParams {
  privateKey: string
  chainId: number
  rpcUrl: string
}

function buildRawKeyWallet(params: RawKeyWalletParams): VaultWallet {
  const { privateKey, chainId, rpcUrl } = params

  // Validate key format (must be hex string with 0x prefix, 64 chars after prefix)
  const cleanKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(cleanKey)) {
    throw new VaultWalletError(
      `Invalid private key format: expected 0x + 64 hex chars, got ${cleanKey.length} chars. ` +
      'Ensure X_LAYER_PRIVATE_KEY is a valid 32-byte hex string.',
      'INVALID_KEY_FORMAT'
    )
  }

  const account = privateKeyToAccount(cleanKey as Hex)
  const chain = chainId === 196 ? xLayer : xLayerTestnet

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  })

  return {
    address: account.address,
    account,
    walletClient,
    chainId,
    isVaultApi: false,
    source: 'RAW_PRIVATE_KEY',
    signingKey: cleanKey,
  }
}

// ─── Signing Helpers ───────────────────────────────────────────────────────────

/**
 * Sign and broadcast a raw transaction.
 * Convenience wrapper around walletClient.
 */
export async function signAndSend(params: {
  wallet: VaultWallet
  to: Address
  data?: Hex
  value?: bigint
  gasLimit?: bigint
}): Promise<{ txHash: Hex }> {
  const { wallet, to, data, value, gasLimit } = params

  const request = await wallet.walletClient.prepareTransactionRequest({
    to,
    data,
    value: value ?? 0n,
    gas: gasLimit,
  })

  const hash = await wallet.walletClient.sendTransaction(request)
  console.log(`[VaultWallet] Transaction sent — tx=${hash}`)
  return { txHash: hash }
}

/**
 * Sign a message (personal_sign / EIP-191) using the vault wallet.
 * Used for agent identity attestations (e.g., signing trade decision rationale).
 */
export async function signMessage(
  wallet: VaultWallet,
  message: string
): Promise<Hex> {
  const signature = await wallet.walletClient.signMessage({ message })
  console.log(`[VaultWallet] Message signed by ${wallet.address} — sig=${signature.slice(0, 10)}...`)
  return signature
}

/**
 * Verify a signature against the vault wallet address.
 */
export function verifySignature(
  wallet: VaultWallet,
  message: string,
  signature: Hex
): boolean {
  const recovered = wallet.account.signMessage({ message })
  return recovered === signature
}
