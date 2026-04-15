/**
 * OKX / X Layer — viem Chain Configuration
 *
 * Exports X Layer chain objects for use with viem clients.
 * Chain IDs:
 *   - Mainnet: 196
 *   - Testnet (X1 Testnet): 195
 *
 * Public RPC sources (no auth required):
 *   Mainnet:  https://rpc.xlayer.tech
 *   Testnet:  https://testrpc.xlayer.tech
 *             https://xlayertestrpc.okx.com
 *
 * Explorer:  https://www.oklink.com/xlayer (mainnet)
 *             https://www.oklink.com/xlayer-test (testnet)
 *
 * Faucet:    https://www.okx.com/xlayer/faucet
 */

import { xLayer, xLayerTestnet } from 'viem/chains'
import type { XLayerNetwork } from './env.js'

export { xLayer, xLayerTestnet }

/**
 * Returns the viem chain object for the given network.
 */
export function getViemChain(network: XLayerNetwork) {
  return network === 'mainnet' ? xLayer : xLayerTestnet
}

/**
 * Returns the default public RPC URL for the given network.
 * Use X_LAYER_RPC_URL env var to override.
 */
export function getDefaultRpcUrl(network: XLayerNetwork): string {
  return network === 'mainnet'
    ? 'https://rpc.xlayer.tech'
    : 'https://testrpc.xlayer.tech'
}

/**
 * Returns the block explorer base URL for the given network.
 */
export function getExplorerUrl(network: XLayerNetwork): string {
  return network === 'mainnet'
    ? 'https://www.oklink.com/xlayer'
    : 'https://www.oklink.com/xlayer-test'
}

/**
 * Returns the faucet URL for testnet funding.
 */
export const FAUCET_URL = 'https://www.okx.com/xlayer/faucet'

/**
 * The X Layer Faucet instructions for the README.
 */
export const FAUCET_INSTRUCTIONS = `
X Layer Testnet (X1) Faucet:
  1. Go to https://www.okx.com/xlayer/faucet
  2. Connect wallet or paste your test wallet address
  3. Request test XLT tokens

Note: Faucet may require OKX account. If unavailable, use the public RPC
with a faucet from the OKX developer portal at https://www.okx.com/xlayer/developers
`
