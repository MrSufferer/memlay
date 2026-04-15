/**
 * OKX / X Layer — Public API
 *
 * Re-exports the public surface area of the OKX agent module.
 * Import from here rather than sub-modules for a stable API.
 */

// Environment
export {
  loadXLayerEnvConfig,
  type XLayerEnvConfig,
  type XLayerNetwork,
  type XLayerSignerConfig,
  X_LAYER_PUBLIC_RPC_MAINNET,
  X_LAYER_PUBLIC_RPC_TESTNET,
  X_LAYER_PUBLIC_RPC_TESTNET_ALT,
} from './env.js'

// Chain config
export {
  xLayer,
  xLayerTestnet,
  getViemChain,
  getDefaultRpcUrl,
  getExplorerUrl,
  FAUCET_URL,
  FAUCET_INSTRUCTIONS,
} from './chains.js'

// RPC
export {
  verifyConnectivity,
  printConnectivityReport,
  requireConnectivity,
  type ConnectivityReport,
} from './rpc.js'

// Vault Wallet
export {
  loadVaultWallet,
  signAndSend,
  signMessage,
  verifySignature,
  type VaultWallet,
  type VaultWalletOptions,
  type VaultWalletError as VaultWalletErrorType,
} from './vault-wallet.js'

// Scanner
export {
  scan,
  type RawOpportunity,
  type ScanFilters,
  type ScanConfig,
} from './scanner.js'

// Loop
export {
  runAgentLoop,
  type LoopCycle,
} from './loop.js'

// Arena
export {
  createXLayerArenaPublicClient,
  createXLayerArenaWalletClient,
  getXLayerLeaderboard,
  getXLayerAgentStats,
  isXLayerAgentRegistered,
  getXLayerAgentRank,
  getXLayerArenaStats,
  registerXLayerAgent,
  reportXLayerTrade,
  challengeXLayerAgent,
  resolveXLayerChallenge,
  arenaReportCycle,
  type ArenaAgentStats,
  type ArenaChallenge,
  type XLayerArenaConfig,
  type TradeReportedEvent,
} from './arena-client.js'
