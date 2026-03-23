import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { ERC8004ReputationRegistry } from '../../contracts/abi/ERC8004ReputationRegistry'
import { loadErc8004Config } from './config'
import { probeReliability } from './probe-reliability'
import { buildReliabilityFeedbackInputs } from './reputation-utils'
import type { ReputationFeedbackInput } from './types'

const INT128_MIN = -(2n ** 127n)
const INT128_MAX = 2n ** 127n - 1n

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value || value.trim().length === 0) {
    throw new Error(`[erc8004] Missing required environment variable: ${name}`)
  }
  return value
}

function withHexPrefix(value: string): Hex {
  return (value.startsWith('0x') ? value : `0x${value}`) as Hex
}

function assertInt128(value: bigint, context: string) {
  if (value < INT128_MIN || value > INT128_MAX) {
    throw new Error(`[erc8004] ${context} value out of int128 range: ${value.toString()}`)
  }
}

export async function publishFeedbackEntries(entries: ReputationFeedbackInput[]): Promise<string[]> {
  const rpcUrl = requireEnv('RPC_URL')
  const reputationRegistry = requireEnv('ERC8004_REPUTATION_REGISTRY') as Address
  const privateKey = withHexPrefix(requireEnv('ERC8004_WATCHTOWER_PRIVATE_KEY'))

  const account = privateKeyToAccount(privateKey)

  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl),
  })

  const walletClient = createWalletClient({
    chain: sepolia,
    transport: http(rpcUrl),
    account,
  })

  const txHashes: string[] = []

  for (const entry of entries) {
    assertInt128(entry.value, `${entry.tag1}:${entry.tag2}`)

    const { request } = await publicClient.simulateContract({
      account,
      address: reputationRegistry,
      abi: ERC8004ReputationRegistry,
      functionName: 'giveFeedback',
      args: [
        BigInt(entry.agentId),
        entry.value,
        entry.valueDecimals,
        entry.tag1,
        entry.tag2,
        entry.endpoint,
        entry.feedbackURI,
        entry.feedbackHash,
      ],
    })

    const txHash = await walletClient.writeContract(request)
    txHashes.push(txHash)

    console.log(
      `[erc8004] feedback published: tag1=${entry.tag1} tag2=${entry.tag2} ` +
        `value=${entry.value.toString()} decimals=${entry.valueDecimals} tx=${txHash}`
    )
  }

  return txHashes
}

if (import.meta.main) {
  const config = loadErc8004Config()
  const agentId = Number(requireEnv('ERC8004_AGENT_ID'))

  probeReliability(config.reliabilityEndpoints)
    .then((probeResults) => {
      const entries = buildReliabilityFeedbackInputs({ agentId, probeResults })
      return publishFeedbackEntries(entries)
    })
    .then((txHashes) => {
      console.log('[erc8004] publish-feedback completed')
      for (const tx of txHashes) {
        console.log(`  tx: ${tx}`)
      }
    })
    .catch((error) => {
      console.error('[erc8004] publish-feedback failed:', error)
      process.exit(1)
    })
}
