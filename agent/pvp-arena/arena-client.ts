/**
 * PvPArena Client — TypeScript client for the PvPArena smart contract on Base.
 *
 * Usage:
 *   1. Register the agent in the arena:     await registerInArena({ agentId: tokenId, wallet })
 *   2. Create a duel:                       await createDuel({ opponentAgentId, stake })
 *   3. After each trade:                   await submitPerformance({ duelId, pnlWei, sharpeScaled })
 *   4. Query:                              await getLeaderboard() | getAgent(tokenId)
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  decodeFunctionResult,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

// ─── ABI ────────────────────────────────────────────────────────────────────

const ARENA_ABI = [
  // Agent registration
  'function registerAgent(uint256 erc8004TokenId, address wallet) external',
  'function getAgent(uint256 agentId) external view returns (tuple(address wallet, int256 totalPnL, uint256 sharpeRatio, int256 maxDrawdown, uint256 tradeCount, uint256 wins, uint256 losses, uint256 lastUpdate, bool isActive, uint256 erc8004TokenId) memory)',
  'function getAgentScore(uint256 agentId) external view returns (int256)',
  'function getActiveDuels(uint256 agentId) external view returns (tuple(uint256 id, uint256 agentAId, uint256 agentBId, uint256 stakeAmount, int256 agentAScore, int256 agentBScore, int256 agentAPnL, int256 agentBPnL, bytes32 winner, uint256 startTime, uint256 endTime, uint256 duration, bool resolved) memory[] memory)',

  // Duel management
  'function createDuel(uint256 agentAId, uint256 agentBId, uint256 stake, uint256 duration) external',
  'function submitPerformance(uint256 duelId, int256 pnl, uint256 sharpe) external',
  'function forceResolveDuel(uint256 duelId) external',
  'function getDuel(uint256 duelId) external view returns (tuple(uint256 id, uint256 agentAId, uint256 agentBId, uint256 stakeAmount, int256 agentAScore, int256 agentBScore, int256 agentAPnL, int256 agentBPnL, bytes32 winner, uint256 startTime, uint256 endTime, uint256 duration, bool resolved) memory)',

  // Leaderboard
  'function getLeaderboard() external view returns (tuple(address wallet, int256 totalPnL, uint256 sharpeRatio, int256 maxDrawdown, uint256 tradeCount, uint256 wins, uint256 losses, uint256 lastUpdate, bool isActive, uint256 erc8004TokenId) memory[] memory)',
  'function registeredAgentCount() external view returns (uint256)',
  'function duelCount() external view returns (uint256)',
  'function identityRegistry() external view returns (address)',

  // Events (for indexer)
  'event AgentRegistered(uint256 indexed erc8004TokenId, address wallet)',
  'event DuelCreated(uint256 indexed duelId, uint256 indexed agentAId, uint256 indexed agentBId, uint256 stake, uint256 duration)',
  'event PerformanceSubmitted(uint256 indexed duelId, uint256 indexed agentId, int256 pnl, uint256 sharpe)',
  'event DuelResolved(uint256 indexed duelId, bytes32 winner, int256 agentAScore, int256 agentBScore)',
] as const

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ArenaAgent {
  wallet: Address
  totalPnL: bigint
  sharpeRatio: bigint
  maxDrawdown: bigint
  tradeCount: bigint
  wins: bigint
  losses: bigint
  lastUpdate: bigint
  isActive: boolean
  erc8004TokenId: bigint
}

export interface Duel {
  id: bigint
  agentAId: bigint
  agentBId: bigint
  stakeAmount: bigint
  agentAScore: bigint
  agentBScore: bigint
  agentAPnL: bigint
  agentBPnL: bigint
  winner: Hex
  startTime: bigint
  endTime: bigint
  duration: bigint
  resolved: boolean
}

export interface PvPArenaConfig {
  arenaAddress: Address
  walletPrivateKey?: Hex
  chain?: 'base_mainnet' | 'base_sepolia'
  rpcUrl?: string
}

export interface DuelCreatedEvent {
  duelId: bigint
  agentAId: bigint
  agentBId: bigint
  stake: bigint
  duration: bigint
}

export interface PerformanceSubmittedEvent {
  duelId: bigint
  agentId: bigint
  pnl: bigint
  sharpe: bigint
}

// ─── Decoded event types ───────────────────────────────────────────────────────

export interface DecodedArenaEvents {
  AgentRegistered: { erc8004TokenId: bigint; wallet: Address }[]
  DuelCreated: DuelCreatedEvent[]
  PerformanceSubmitted: PerformanceSubmittedEvent[]
  DuelResolved: { duelId: bigint; winner: Hex; agentAScore: bigint; agentBScore: bigint }[]
}

// ─── Client Factory ───────────────────────────────────────────────────────────

function getChain(config: PvPArenaConfig) {
  return config.chain === 'base_mainnet' ? base : baseSepolia
}

function getRpcUrl(config: PvPArenaConfig): string {
  if (config.rpcUrl) return config.rpcUrl
  if (config.chain === 'base_mainnet') return 'https://mainnet.base.org'
  return 'https://sepolia.base.org'
}

export function createArenaPublicClient(config: PvPArenaConfig): PublicClient {
  return createPublicClient({
    chain: getChain(config),
    transport: http(getRpcUrl(config)),
  })
}

export function createArenaWalletClient(config: PvPArenaConfig): WalletClient {
  if (!config.walletPrivateKey) {
    throw new Error('[PvPArena] walletPrivateKey required for write operations')
  }
  const account = privateKeyToAccount(config.walletPrivateKey)
  return createWalletClient({
    account,
    chain: getChain(config),
    transport: http(getRpcUrl(config)),
  })
}

// ─── Read-only operations ───────────────────────────────────────────────────

export async function getLeaderboard(
  client: PublicClient,
  arenaAddress: Address
): Promise<ArenaAgent[]> {
  const raw = await client.readContract({
    address: arenaAddress,
    abi: ARENA_ABI,
    functionName: 'getLeaderboard',
  }) as any[]
  return raw.map(decodeArenaAgent)
}

export async function getAgent(
  client: PublicClient,
  arenaAddress: Address,
  agentId: bigint
): Promise<ArenaAgent | null> {
  try {
    const raw = await client.readContract({
      address: arenaAddress,
      abi: ARENA_ABI,
      functionName: 'getAgent',
      args: [agentId],
    }) as any
    return decodeArenaAgent(raw)
  } catch {
    return null
  }
}

export async function getAgentScore(
  client: PublicClient,
  arenaAddress: Address,
  agentId: bigint
): Promise<bigint> {
  return client.readContract({
    address: arenaAddress,
    abi: ARENA_ABI,
    functionName: 'getAgentScore',
    args: [agentId],
  }) as Promise<bigint>
}

export async function getDuel(
  client: PublicClient,
  arenaAddress: Address,
  duelId: bigint
): Promise<Duel | null> {
  try {
    const raw = await client.readContract({
      address: arenaAddress,
      abi: ARENA_ABI,
      functionName: 'getDuel',
      args: [duelId],
    }) as any
    return decodeDuel(raw)
  } catch {
    return null
  }
}

export async function getActiveDuels(
  client: PublicClient,
  arenaAddress: Address,
  agentId: bigint
): Promise<Duel[]> {
  const raw = await client.readContract({
    address: arenaAddress,
    abi: ARENA_ABI,
    functionName: 'getActiveDuels',
    args: [agentId],
  }) as any[]
  return raw.map(decodeDuel)
}

export async function getArenaStats(
  client: PublicClient,
  arenaAddress: Address
): Promise<{ registeredAgents: bigint; duelCount: bigint; identityRegistry: Address }> {
  const [registeredAgents, duelCount, identityRegistry] = await client.multicall({
    contracts: [
      { address: arenaAddress, abi: ARENA_ABI, functionName: 'registeredAgentCount' },
      { address: arenaAddress, abi: ARENA_ABI, functionName: 'duelCount' },
      { address: arenaAddress, abi: ARENA_ABI, functionName: 'identityRegistry' },
    ],
  })
  return {
    registeredAgents: registeredAgents.result as bigint,
    duelCount: duelCount.result as bigint,
    identityRegistry: identityRegistry.result as Address,
  }
}

// ─── Write operations ────────────────────────────────────────────────────────

export async function registerInArena(params: {
  wallet: WalletClient
  arenaAddress: Address
  erc8004TokenId: bigint
  agentWallet: Address
}): Promise<{ txHash: Hex }> {
  const { wallet, arenaAddress, erc8004TokenId, agentWallet } = params
  const account = wallet.account

  const hash = await wallet.writeContract({
    address: arenaAddress,
    abi: ARENA_ABI,
    functionName: 'registerAgent',
    args: [erc8004TokenId, agentWallet],
    account,
  })

  console.log(`[PvPArena] Registered agent ${erc8004TokenId} — tx=${hash}`)
  return { txHash: hash }
}

export async function createArenaDuel(params: {
  wallet: WalletClient
  arenaAddress: Address
  callerAgentId: bigint
  opponentAgentId: bigint
  stakeWei?: bigint
  durationSeconds?: bigint
}): Promise<{ txHash: Hex; duelId: bigint }> {
  const { wallet, arenaAddress, callerAgentId, opponentAgentId, stakeWei, durationSeconds } = params
  const account = wallet.account

  // Duration: default 7 days, min 1 hour
  const duration = durationSeconds ?? BigInt(7 * 24 * 3600)
  // Stake: default 0 (friendly duel, no stake transfer in this MVP)
  const stake = stakeWei ?? 0n

  const hash = await wallet.writeContract({
    address: arenaAddress,
    abi: ARENA_ABI,
    functionName: 'createDuel',
    args: [callerAgentId, opponentAgentId, stake, duration],
    account,
  })

  // Fetch the duelId from emitted event
  const publicClient = createArenaPublicClient({
    arenaAddress,
    chain: wallet.chain?.id === 8453 ? 'base_mainnet' : 'base_sepolia',
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  const duelCreatedLog = receipt.logs.find((log) => {
    try {
      return log.topics[0] === publicClient.transport.type
    } catch {
      return false
    }
  })

  // Decode duelId from event
  let duelId = 0n
  for (const log of receipt.logs) {
    if (log.topics[0]) {
      try {
        const decoded = decodeEventLog({
          data: log.data,
          topics: log.topics,
          abi: ARENA_ABI,
          eventName: 'DuelCreated',
        })
        if (decoded && 'duelId' in decoded) {
          duelId = decoded.duelId as bigint
          break
        }
      } catch {
        // continue
      }
    }
  }

  console.log(`[PvPArena] Created duel ${duelId} — tx=${hash}`)
  return { txHash: hash, duelId }
}

export async function submitArenaPerformance(params: {
  wallet: WalletClient
  arenaAddress: Address
  duelId: bigint
  pnlWei: bigint
  sharpeScaled: bigint // e.g. 1500n = 1.5 Sharpe
}): Promise<{ txHash: Hex }> {
  const { wallet, arenaAddress, duelId, pnlWei, sharpeScaled } = params
  const account = wallet.account

  const hash = await wallet.writeContract({
    address: arenaAddress,
    abi: ARENA_ABI,
    functionName: 'submitPerformance',
    args: [duelId, pnlWei, sharpeScaled],
    account,
  })

  console.log(`[PvPArena] Submitted performance for duel ${duelId}: pnl=${pnlWei}, sharpe=${sharpeScaled} — tx=${hash}`)
  return { txHash: hash }
}

export async function forceResolve(params: {
  wallet: WalletClient
  arenaAddress: Address
  duelId: bigint
}): Promise<{ txHash: Hex }> {
  const { wallet, arenaAddress, duelId } = params
  const hash = await wallet.writeContract({
    address: arenaAddress,
    abi: ARENA_ABI,
    functionName: 'forceResolveDuel',
    args: [duelId],
    account: wallet.account,
  })
  console.log(`[PvPArena] Force-resolved duel ${duelId} — tx=${hash}`)
  return { txHash: hash }
}

// ─── Event indexing ──────────────────────────────────────────────────────────

export async function fetchArenaEvents(
  client: PublicClient,
  arenaAddress: Address,
  fromBlock: bigint,
  toBlock?: bigint
): Promise<DecodedArenaEvents> {
  const currentBlock = toBlock ?? await client.getBlockNumber()

  const logs = await client.getLogs({
    address: arenaAddress,
    fromBlock,
    toBlock: currentBlock,
    events: {
      AgentRegistered: ARENA_ABI.find((item) => item.type === 'event' && item.name === 'AgentRegistered')!,
      DuelCreated: ARENA_ABI.find((item) => item.type === 'event' && item.name === 'DuelCreated')!,
      PerformanceSubmitted: ARENA_ABI.find((item) => item.type === 'event' && item.name === 'PerformanceSubmitted')!,
      DuelResolved: ARENA_ABI.find((item) => item.type === 'event' && item.name === 'DuelResolved')!,
    },
  })

  return {
    AgentRegistered: [],
    DuelCreated: [],
    PerformanceSubmitted: [],
    DuelResolved: [],
  }
}

// ─── Decoding helpers ────────────────────────────────────────────────────────

function decodeArenaAgent(raw: any[]): ArenaAgent {
  return {
    wallet: raw[0] as Address,
    totalPnL: raw[1] as bigint,
    sharpeRatio: raw[2] as bigint,
    maxDrawdown: raw[3] as bigint,
    tradeCount: raw[4] as bigint,
    wins: raw[5] as bigint,
    losses: raw[6] as bigint,
    lastUpdate: raw[7] as bigint,
    isActive: raw[8] as boolean,
    erc8004TokenId: raw[9] as bigint,
  }
}

function decodeDuel(raw: any[]): Duel {
  return {
    id: raw[0] as bigint,
    agentAId: raw[1] as bigint,
    agentBId: raw[2] as bigint,
    stakeAmount: raw[3] as bigint,
    agentAScore: raw[4] as bigint,
    agentBScore: raw[5] as bigint,
    agentAPnL: raw[6] as bigint,
    agentBPnL: raw[7] as bigint,
    winner: raw[8] as Hex,
    startTime: raw[9] as bigint,
    endTime: raw[10] as bigint,
    duration: raw[11] as bigint,
    resolved: raw[12] as boolean,
  }
}

// Viem 2.x compatible event decode — use decodeEventLog from viem
import { decodeEventLog } from 'viem'

// ─── Convenience: Full agent arena flow ──────────────────────────────────────

/**
 * Run the full arena participation flow for an agent:
 * 1. Register in arena (if not already)
 * 2. Get active duels
 * 3. After each trade: submit performance
 * 4. After duel end: check if resolved
 */
export async function arenaParticipationLoop(params: {
  arenaAddress: Address
  agentWallet: WalletClient
  erc8004TokenId: bigint
  recentTrades: { pnlWei: bigint; sharpeScaled: bigint; timestamp: number }[]
}): Promise<{
  registered: boolean
  activeDuels: Duel[]
  pendingSubmissions: { duelId: bigint; pnlWei: bigint; sharpeScaled: bigint }[]
}> {
  const { arenaAddress, agentWallet, erc8004TokenId, recentTrades } = params
  const publicClient = createArenaPublicClient({
    arenaAddress,
    chain: agentWallet.chain?.id === 8453 ? 'base_mainnet' : 'base_sepolia',
  })

  // Check if already registered
  const agent = await getAgent(publicClient, arenaAddress, erc8004TokenId)
  const registered = agent !== null && agent.isActive

  if (!registered) {
    console.log(`[PvPArena] Agent ${erc8004TokenId} not registered — registering...`)
    await registerInArena({
      wallet: agentWallet,
      arenaAddress,
      erc8004TokenId,
      agentWallet: agentWallet.account.address,
    })
  }

  // Get active duels
  const activeDuels = await getActiveDuels(publicClient, arenaAddress, erc8004TokenId)

  // Map recent trades to active duels
  const pendingSubmissions = activeDuels
    .filter((d) => !d.resolved)
    .map((d) => {
      // For simplicity: submit the most recent trade to each active duel
      // In production: track which trades belong to which duel
      const trade = recentTrades[recentTrades.length - 1]
      return trade
        ? { duelId: d.id, pnlWei: trade.pnlWei, sharpeScaled: trade.sharpeScaled }
        : null
    })
    .filter(Boolean) as { duelId: bigint; pnlWei: bigint; sharpeScaled: bigint }[]

  return { registered, activeDuels, pendingSubmissions }
}
