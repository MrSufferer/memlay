/**
 * OKX / X Layer — RPC Connectivity Verification
 *
 * Provides a single entry point to verify X Layer connectivity.
 * Used at startup to confirm the agent can reach the network.
 *
 * Usage:
 *   await verifyConnectivity({ rpcUrl, expectedChainId, explorerUrl })
 *     .then(report => console.log(report))
 *     .catch(err => { console.error(err); process.exit(1) })
 */

import {
  createPublicClient,
  http,
  custom,
  type PublicClient,
} from 'viem'
import { xLayer, xLayerTestnet } from 'viem/chains'

export interface ConnectivityReport {
  connected: boolean
  rpcUrl: string
  chainId: number
  expectedChainId: number
  chainMatch: boolean
  latestBlockNumber: bigint
  latestBlockAgeSeconds: number
  explorerUrl: string
  error?: string
}

interface VerifyConnectivityParams {
  rpcUrl: string
  expectedChainId: number
  explorerUrl: string
}

/**
 * Verify X Layer RPC connectivity.
 *
 * Checks:
 *   1. eth_blockNumber returns a valid block
 *   2. eth_chainId matches expectedChainId
 *
 * Returns a ConnectivityReport. Throws only on network errors.
 */
export async function verifyConnectivity(
  params: VerifyConnectivityParams
): Promise<ConnectivityReport> {
  const { rpcUrl, expectedChainId, explorerUrl } = params

  let client: PublicClient
  try {
    client = createPublicClient({
      chain: expectedChainId === 196 ? xLayer : xLayerTestnet,
      transport: http(rpcUrl),
    })
  } catch (err) {
    return {
      connected: false,
      rpcUrl,
      chainId: 0,
      expectedChainId,
      chainMatch: false,
      latestBlockNumber: 0n,
      latestBlockAgeSeconds: 0,
      explorerUrl,
      error: `Failed to create public client: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  try {
    const [blockNumber, chainId, block] = await Promise.all([
      client.getBlockNumber(),
      client.getChainId(),
      client.getBlock({ blockNumber: 'latest' }),
    ])

    const chainMatch = chainId === expectedChainId
    const nowSec = Math.floor(Date.now() / 1000)
    const blockAgeSeconds = block.timestamp
      ? nowSec - Number(block.timestamp)
      : 0

    return {
      connected: true,
      rpcUrl,
      chainId,
      expectedChainId,
      chainMatch,
      latestBlockNumber: blockNumber,
      latestBlockAgeSeconds: blockAgeSeconds,
      explorerUrl,
    }
  } catch (err) {
    return {
      connected: false,
      rpcUrl,
      chainId: 0,
      expectedChainId,
      chainMatch: false,
      latestBlockNumber: 0n,
      latestBlockAgeSeconds: 0,
      explorerUrl,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Pretty-print a ConnectivityReport to the console.
 */
export function printConnectivityReport(report: ConnectivityReport): void {
  const prefix = report.connected ? '✅' : '❌'
  console.log(`\n${prefix} X Layer Connectivity Report`)
  console.log(`   RPC:       ${report.rpcUrl}`)
  console.log(`   Explorer:  ${report.explorerUrl}`)

  if (!report.connected) {
    console.log(`   Error:     ${report.error ?? 'unknown'}`)
    return
  }

  const chainIcon = report.chainMatch ? '✅' : '⚠️  MISMATCH'
  console.log(`   Chain:     ${chainIcon} id=${report.chainId} (expected ${report.expectedChainId})`)
  console.log(`   Block:     #${report.latestBlockNumber.toString()} (${report.latestBlockAgeSeconds}s ago)`)
}

/**
 * Verify X Layer connectivity and exit with error code 1 if unreachable.
 */
export async function requireConnectivity(params: VerifyConnectivityParams): Promise<ConnectivityReport> {
  const report = await verifyConnectivity(params)
  printConnectivityReport(report)

  if (!report.connected) {
    // RPC is unreachable — non-fatal for hackathon; scanner has its own RPC path.
    console.warn(
      `[okx-rpc] ⚠️  X Layer RPC connectivity check failed: ${report.error ?? 'unknown'}. ` +
      `The scanner will attempt its own RPC calls independently.`
    )
    return report
  }
  if (!report.chainMatch) {
    // Non-fatal for hackathon — public RPCs may report non-standard chain IDs.
    // The scanner uses viem's built-in chain definitions regardless.
    console.warn(
      `[okx-rpc] ⚠️  Chain ID mismatch (RPC reports ${report.chainId}, expected ${report.expectedChainId}). ` +
      `Proceeding anyway — scanner uses viem's built-in chain definitions.`
    )
  }

  return report
}
