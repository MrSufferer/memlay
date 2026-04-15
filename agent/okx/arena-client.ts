/**
 * X Layer Arena Client — TypeScript client for Arena.sol on X Layer.
 *
 * X Layer variant of agent/pvp-arena/arena-client.ts (Base).
 * Key differences:
 *   - Agent IDs are simple uint256 (no ERC-8004 dependency)
 *   - Additional challenge/resolve duel mechanics for PvP framing
 *   - TradeReported events (vs. PerformanceSubmitted on Base)
 *   - leaderboard ranked by cumulativePnL descending
 *
 * Usage:
 *   1. registerAgent({ name, extraData }) → one-time per wallet
 *   2. reportTrade({ pnl, sharpeScaled, extraData }) → after every agent trade
 *   3. challenge({ opponent, stakeAmount, durationBlocks }) → optional PvP duel
 *   4. resolveChallenge({ challengeId, challengerPnL, opponentPnL }) → resolve duel
 *   5. getLeaderboard() / getAgentStats(wallet) → read-only queries
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { xLayer, xLayerTestnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

// ─── ABI ──────────────────────────────────────────────────────────────────────

export const ARENA_ABI = [
  // Agent registration
  'function registerAgent(string calldata agentName, bytes calldata extraData) external payable',
  'function deactivateAgent() external',
  'function reactivateAgent() external',
  'function updateExtraData(bytes calldata extraData) external',

  // Agent queries
  'function getLeaderboard() external view returns (tuple(address wallet, string agentName, int256 cumulativePnL, uint256 sharpeRatioScaled, int256 maxDrawdown, uint256 tradeCount, uint256 wins, uint256 losses, uint256 lastActivityBlock, uint256 registeredAt, bool isActive, bytes extraData) memory[] memory)',
  'function getAgentStats(address wallet) external view returns (tuple(address wallet, string agentName, int256 cumulativePnL, uint256 sharpeRatioScaled, int256 maxDrawdown, uint256 tradeCount, uint256 wins, uint256 losses, uint256 lastActivityBlock, uint256 registeredAt, bool isActive, bytes extraData) memory)',
  'function isAgentRegistered(address wallet) external view returns (bool)',
  'function getAgentRank(address wallet) external view returns (uint256 rank)',
  'function agentCount() external view returns (uint256)',
  'function getActiveChallengeCount(address agent) external view returns (uint256)',

  // Trade reporting
  'function reportTrade(int256 pnl, uint256 sharpeScaled, bytes calldata extraData) external payable',

  // Challenges
  'function challenge(address opponent, uint256 stakeAmount, uint256 durationBlocks) external payable',
  'function resolveChallenge(bytes32 challengeId, int256 challengerPnL, int256 opponentPnL) external',

  // Owner
  'function pause() external',
  'function unpause() external',
  'function setRegistrationFee(uint256 newFee) external',
  'function registrationFee() external view returns (uint256)',

  // Events
  'event AgentRegistered(address indexed wallet, string agentName, uint256 registeredAtBlock)',
  'event TradeReported(address indexed wallet, uint256 tradeIndex, int256 pnl, uint256 sharpeScaled, int256 drawdownAtTrade)',
  'event LeaderboardUpdated(address indexed wallet, uint256 newRank, int256 cumulativePnL)',
  'event ChallengeCreated(bytes32 indexed challengeId, address indexed challenger, address indexed opponent, uint256 stakeAmount, uint256 durationBlocks)',
  'event ChallengeResolved(bytes32 indexed challengeId, address winner, int256 challengerScore, int256 opponentScore)',
  'event AgentDeactivated(address indexed wallet, uint256 deactivatedAtBlock)',
  'event AgentReactivated(address indexed wallet, uint256 reactivatedAtBlock)',
] as const

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ArenaAgentStats {
  wallet: Address
  agentName: string
  cumulativePnL: bigint
  sharpeRatioScaled: bigint
  maxDrawdown: bigint
  tradeCount: bigint
  wins: bigint
  losses: bigint
  lastActivityBlock: bigint
  registeredAt: bigint
  isActive: boolean
  extraData: Hex
}

export interface ArenaChallenge {
  challenger: Address
  opponent: Address
  stakeAmount: bigint
  startBlock: bigint
  durationBlocks: bigint
  challengerScore: bigint
  opponentScore: bigint
  winner: Hex
  resolved: boolean
  expired: boolean
}

export interface XLayerArenaConfig {
  arenaAddress: Address
  walletPrivateKey?: Hex
  network?: 'mainnet' | 'testnet'
  rpcUrl?: string
}

export interface TradeReportedEvent {
  wallet: Address
  tradeIndex: bigint
  pnl: bigint
  sharpeScaled: bigint
  drawdownAtTrade: bigint
}

// ─── Client Factories ─────────────────────────────────────────────────────────

function getChain(config: XLayerArenaConfig) {
  return config.network === 'mainnet' ? xLayer : xLayerTestnet
}

function getRpcUrl(config: XLayerArenaConfig): string {
  if (config.rpcUrl) return config.rpcUrl
  return config.network === 'mainnet'
    ? 'https://rpc.xlayer.tech'
    : 'https://testrpc.xlayer.tech'
}

export function createXLayerArenaPublicClient(config: XLayerArenaConfig): PublicClient {
  return createPublicClient({
    chain: getChain(config),
    transport: http(getRpcUrl(config)),
  })
}

export function createXLayerArenaWalletClient(config: XLayerArenaConfig): WalletClient {
  if (!config.walletPrivateKey) {
    throw new Error('[XLayerArena] walletPrivateKey required for write operations')
  }
  const account = privateKeyToAccount(config.walletPrivateKey)
  return createWalletClient({
    account,
    chain: getChain(config),
    transport: http(getRpcUrl(config)),
  })
}

// ─── Read Operations ──────────────────────────────────────────────────────────

export async function getXLayerLeaderboard(
  client: PublicClient,
  arenaAddress: Address
): Promise<ArenaAgentStats[]> {
  const raw = await client.readContract({
    address: arenaAddress,
    abi: ARENA_ABI,
    functionName: 'getLeaderboard',
  }) as any[]
  return raw.map(decodeArenaAgentStats)
}

export async function getXLayerAgentStats(
  client: PublicClient,
  arenaAddress: Address,
  wallet: Address
): Promise<ArenaAgentStats | null> {
  try {
    const raw = await client.readContract({
      address: arenaAddress,
      abi: ARENA_ABI,
      functionName: 'getAgentStats',
      args: [wallet],
    }) as any
    return decodeArenaAgentStats(raw)
  } catch {
    return null
  }
}

export async function isXLayerAgentRegistered(
  client: PublicClient,
  arenaAddress: Address,
  wallet: Address
): Promise<boolean> {
  return client.readContract({
    address: arenaAddress,
    abi: ARENA_ABI,
    functionName: 'isAgentRegistered',
    args: [wallet],
  }) as Promise<boolean>
}

export async function getXLayerAgentRank(
  client: PublicClient,
  arenaAddress: Address,
  wallet: Address
): Promise<bigint> {
  return client.readContract({
    address: arenaAddress,
    abi: ARENA_ABI,
    functionName: 'getAgentRank',
    args: [wallet],
  }) as Promise<bigint>
}

export async function getXLayerArenaStats(
  client: PublicClient,
  arenaAddress: Address
): Promise<{ agentCount: bigint; registrationFee: bigint }> {
  const [agentCount, registrationFee] = await client.multicall({
    contracts: [
      { address: arenaAddress, abi: ARENA_ABI, functionName: 'agentCount' },
      { address: arenaAddress, abi: ARENA_ABI, functionName: 'registrationFee' },
    ],
  })
  return {
    agentCount: agentCount.result as bigint,
    registrationFee: registrationFee.result as bigint,
  }
}

// ─── Write Operations ─────────────────────────────────────────────────────────

export async function registerXLayerAgent(params: {
  wallet: WalletClient
  arenaAddress: Address
  agentName: string
  extraData?: Hex
}): Promise<{ txHash: Hex }> {
  const { wallet, arenaAddress, agentName, extraData } = params
  const hash = await wallet.writeContract({
    address: arenaAddress,
    abi: ARENA_ABI,
    functionName: 'registerAgent',
    args: [agentName, extraData ?? '0x'],
    account: wallet.account,
  })
  console.log(`[XLayerArena] Registered agent "${agentName}" — tx=${hash}`)
  return { txHash: hash }
}

export async function reportXLayerTrade(params: {
  wallet: WalletClient
  arenaAddress: Address
  pnlWei: bigint
  sharpeScaled: bigint // e.g. 1500n = 1.5 Sharpe
  extraData?: Hex
}): Promise<{ txHash: Hex }> {
  const { wallet, arenaAddress, pnlWei, sharpeScaled, extraData } = params
  const hash = await wallet.writeContract({
    address: arenaAddress,
    abi: ARENA_ABI,
    functionName: 'reportTrade',
    args: [pnlWei, sharpeScaled, extraData ?? '0x'],
    account: wallet.account,
  })
  console.log(`[XLayerArena] Reported trade: pnl=${pnlWei}, sharpe=${sharpeScaled} — tx=${hash}`)
  return { txHash: hash }
}

export async function challengeXLayerAgent(params: {
  wallet: WalletClient
  arenaAddress: Address
  opponent: Address
  stakeWei?: bigint
  durationBlocks?: bigint
}): Promise<{ txHash: Hex; challengeId: Hex }> {
  const { wallet, arenaAddress, opponent, stakeWei, durationBlocks } = params
  const stake = stakeWei ?? 0n
  const duration = durationBlocks ?? 6500n // ~24h at 12s block time

  const hash = await wallet.writeContract({
    address: arenaAddress,
    abi: ARENA_ABI,
    functionName: 'challenge',
    args: [opponent, stake, duration],
    account: wallet.account,
    value: stake,
  })

  // Derive challengeId from tx hash (non-deterministic, just log it)
  const challengeId = hash // For full resolution, listen for ChallengeCreated event
  console.log(`[XLayerArena] Challenge issued to ${opponent} — tx=${hash}`)
  return { txHash: hash, challengeId }
}

export async function resolveXLayerChallenge(params: {
  wallet: WalletClient
  arenaAddress: Address
  challengeId: Hex
  challengerPnLWei: bigint
  opponentPnLWei: bigint
}): Promise<{ txHash: Hex }> {
  const { wallet, arenaAddress, challengeId, challengerPnLWei, opponentPnLWei } = params
  const hash = await wallet.writeContract({
    address: arenaAddress,
    abi: ARENA_ABI,
    functionName: 'resolveChallenge',
    args: [challengeId, challengerPnLWei, opponentPnLWei],
    account: wallet.account,
  })
  console.log(`[XLayerArena] Resolved challenge ${challengeId} — tx=${hash}`)
  return { txHash: hash }
}

// ─── Event Indexing ───────────────────────────────────────────────────────────

export async function fetchXLayerArenaEvents(
  client: PublicClient,
  arenaAddress: Address,
  fromBlock: bigint,
  toBlock?: bigint
): Promise<{
  agentRegistered: { wallet: Address; agentName: string; block: bigint }[]
  tradeReported: TradeReportedEvent[]
  leaderboardUpdated: { wallet: Address; rank: bigint; pnl: bigint }[]
  challengeCreated: { challengeId: Hex; challenger: Address; opponent: Address; stake: bigint; duration: bigint }[]
  challengeResolved: { challengeId: Hex; winner: Address; challengerScore: bigint; opponentScore: bigint }[]
}> {
  const latest = toBlock ?? await client.getBlockNumber()

  const agentRegisteredEvent = ARENA_ABI.find(
    (item) => item.type === 'event' && item.name === 'AgentRegistered'
  ) as any
  const tradeReportedEvent = ARENA_ABI.find(
    (item) => item.type === 'event' && item.name === 'TradeReported'
  ) as any
  const leaderboardUpdatedEvent = ARENA_ABI.find(
    (item) => item.type === 'event' && item.name === 'LeaderboardUpdated'
  ) as any
  const challengeCreatedEvent = ARENA_ABI.find(
    (item) => item.type === 'event' && item.name === 'ChallengeCreated'
  ) as any
  const challengeResolvedEvent = ARENA_ABI.find(
    (item) => item.type === 'event' && item.name === 'ChallengeResolved'
  ) as any

  const [aReg, tRep, lUpd, cCrt, cRes] = await Promise.all([
    client.getLogs({ address: arenaAddress, fromBlock, toBlock: latest, events: agentRegisteredEvent }),
    client.getLogs({ address: arenaAddress, fromBlock, toBlock: latest, events: tradeReportedEvent }),
    client.getLogs({ address: arenaAddress, fromBlock, toBlock: latest, events: leaderboardUpdatedEvent }),
    client.getLogs({ address: arenaAddress, fromBlock, toBlock: latest, events: challengeCreatedEvent }),
    client.getLogs({ address: arenaAddress, fromBlock, toBlock: latest, events: challengeResolvedEvent }),
  ])

  return {
    agentRegistered: aReg.map((log: any) => ({
      wallet: log.args.wallet as Address,
      agentName: log.args.agentName as string,
      block: BigInt(log.blockNumber),
    })),
    tradeReported: tRep.map((log: any) => ({
      wallet: log.args.wallet as Address,
      tradeIndex: log.args.tradeIndex as bigint,
      pnl: log.args.pnl as bigint,
      sharpeScaled: log.args.sharpeScaled as bigint,
      drawdownAtTrade: log.args.drawdownAtTrade as bigint,
    })),
    leaderboardUpdated: lUpd.map((log: any) => ({
      wallet: log.args.wallet as Address,
      rank: log.args.newRank as bigint,
      pnl: log.args.cumulativePnL as bigint,
    })),
    challengeCreated: cCrt.map((log: any) => ({
      challengeId: log.args.challengeId as Hex,
      challenger: log.args.challenger as Address,
      opponent: log.args.opponent as Address,
      stake: log.args.stakeAmount as bigint,
      duration: log.args.durationBlocks as bigint,
    })),
    challengeResolved: cRes.map((log: any) => ({
      challengeId: log.args.challengeId as Hex,
      winner: log.args.winner as Address,
      challengerScore: log.args.challengerScore as bigint,
      opponentScore: log.args.opponentScore as bigint,
    })),
  }
}

// ─── Decoding Helpers ─────────────────────────────────────────────────────────

function decodeArenaAgentStats(raw: any[]): ArenaAgentStats {
  return {
    wallet: raw[0] as Address,
    agentName: raw[1] as string,
    cumulativePnL: raw[2] as bigint,
    sharpeRatioScaled: raw[3] as bigint,
    maxDrawdown: raw[4] as bigint,
    tradeCount: raw[5] as bigint,
    wins: raw[6] as bigint,
    losses: raw[7] as bigint,
    lastActivityBlock: raw[8] as bigint,
    registeredAt: raw[9] as bigint,
    isActive: raw[10] as boolean,
    extraData: raw[11] as Hex,
  }
}

// ─── Convenience: Full arena participation flow ─────────────────────────────────

/**
 * Standard agent loop integration point:
 * after each trade cycle, call reportTrade() with the session's PnL.
 *
 * @param params.recentTrades - trades from this loop cycle (PnL, Sharpe, timestamp)
 * @param params.rollingSharpe - computed Sharpe ratio for the cycle
 */
export async function arenaReportCycle(params: {
  wallet: WalletClient
  arenaAddress: Address
  cyclePnLWei: bigint
  cycleSharpeScaled: bigint
  tradeMeta?: { tokenPair: string; entryHash: string; exitHash: string }
}): Promise<{ txHash: Hex }> {
  const extraData = params.tradeMeta
    ? new TextEncoder().encode(JSON.stringify(params.tradeMeta))
    : '0x'

  return reportXLayerTrade({
    wallet: params.wallet,
    arenaAddress: params.arenaAddress,
    pnlWei: params.cyclePnLWei,
    sharpeScaled: params.cycleSharpeScaled,
    extraData,
  })
}

// ─── ABI Export for contracts/arena.json ──────────────────────────────────────
// (ARENA_ABI already exported at declaration point above)