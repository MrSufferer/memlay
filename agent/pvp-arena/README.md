# PvPArena Deployment Guide

## Prerequisites

1. **ERC-8004 IdentityRegistry deployed on Base** — This is required BEFORE deploying PvPArena.
2. **Base Sepolia RPC URL** — Get from Alchemy or Infura
3. **Deployer private key** — Funded wallet on Base Sepolia

## Setup

### 1. Add to `.env`

```bash
# Base Sepolia
BASE_SEPOLIA_RPC_URL=https://base-sepolia.g.alchemy.com/v2/YOUR_KEY
BASE_MAINNET_RPC_URL=https://mainnet.base.org

# ERC-8004 on Base — MUST be deployed first
IDENTITY_REGISTRY_ADDRESS=0x...   # ERC-8004 Identity Registry on Base

# Deployer key
DEPLOYER_KEY=0x...
# Or reuse:
CRE_ETH_PRIVATE_KEY=0x...
```

### 2. Deploy to Base Sepolia

```bash
cd contracts

forge script script/DeployPvPArena.s.sol \
  --rpc-url base_sepolia \
  --private-key $DEPLOYER_KEY \
  --broadcast \
  --verify
```

Expected output:
```
[DeployPvPArena] Deployer: 0x...
[DeployPvPArena] Identity Registry: 0x...
[DeployPvPArena] PvPArena deployed at: 0x...

=== Add these to your .env ===
PVP_ARENA_ADDRESS=0x...
```

### 3. Add arena address to `.env`

```bash
PVP_ARENA_ADDRESS=0x...   # from deployment output
```

### 4. Register your agent in the arena

```bash
# Using the arena-client.ts
bun run agent/pvp-arena/scripts/register-agent.ts
```

### 5. Deploy to Base Mainnet

```bash
# Mainnet requires more setup — verify contract first on BaseScan
BASE_MAINNET_RPC_URL=https://mainnet.base.org \
forge script script/DeployPvPArena.s.sol \
  --rpc-url base_mainnet \
  --private-key $DEPLOYER_KEY \
  --broadcast \
  --verify \
  --etherscan-api-key YOUR_BASESCAN_KEY
```

## Running Tests

```bash
cd contracts
forge test --match-path test/PvPArena.t.sol -vv
```

## Contract Addresses (Update as you deploy)

| Environment | Arena Address | Identity Registry |
|---|---|---|
| Base Sepolia | `PVP_ARENA_ADDRESS` | `IDENTITY_REGISTRY_ADDRESS` |
| Base Mainnet | (deploy and update) | (must match mainnet ERC-8004) |

## Arena Client Usage

```typescript
import {
  createArenaWalletClient,
  createArenaPublicClient,
  registerInArena,
  createArenaDuel,
  submitArenaPerformance,
  getLeaderboard,
} from './pvp-arena/arena-client'

const wallet = createArenaWalletClient({
  arenaAddress: process.env.PVP_ARENA_ADDRESS as Address,
  walletPrivateKey: process.env.CRE_ETH_PRIVATE_KEY as Hex,
  chain: 'base_sepolia',
})

// Register agent
await registerInArena({
  wallet,
  arenaAddress: process.env.PVP_ARENA_ADDRESS as Address,
  erc8004TokenId: 1n,  // ERC-8004 tokenId from Sepolia registration
  agentWallet: wallet.account.address,
})

// After each trade — submit performance to the arena
await submitArenaPerformance({
  wallet,
  arenaAddress: process.env.PVP_ARENA_ADDRESS as Address,
  duelId: 0n,
  pnlWei: 1000000000000000000n, // +1 ETH
  sharpeScaled: 1500n,             // 1.5 Sharpe (scaled × 1000)
})

// Check leaderboard
const publicClient = createArenaPublicClient({
  arenaAddress: process.env.PVP_ARENA_ADDRESS as Address,
})
const leaderboard = await getLeaderboard(publicClient, process.env.PVP_ARENA_ADDRESS as Address)
console.log(leaderboard)
```
