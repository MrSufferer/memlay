# Hedera / Bonzo Agent — Status & Run Instructions

## Done

- ✅ HCS-10/HCS-11 bootstrap, profile publish, state store
- ✅ Bonzo scan, APY ranking, monitor, enter/exit
- ✅ `HederaBonzoLiveTransport` (single-asset vault deposit/withdraw) — code complete, untested on-chain
- ✅ Memory commit (S3 blob + HCS topic)
- ✅ Full agent loop with monitor-first ordering
- ✅ **First real HCS transaction submitted on Hedera testnet** (profile publish, TX `0.0.2659396-1774285643-082305883`)

## Bonzo Live Trading — Current Status

**Bonzo Vaults are mainnet-only on Hedera.** The ICHI Vault Factory and Pool Factory have zero contract code on Hedera testnet. Live Bonzo trades cannot be executed on testnet.

- ✅ Scan, rank, and simulate mode all work
- ❌ Live deposit/withdraw blocked: no testnet vault contracts exist

To attempt live Bonzo trading, deploy to Hedera mainnet or wait for Bonzo to deploy to testnet.

## What's Needed for Bonzo on Mainnet

```bash
# Add to cre-memoryvault/.env
HEDERA_NETWORK=mainnet
HEDERA_OPERATOR_ID=0.0.XXXXX
HEDERA_OPERATOR_KEY=0x...
HEDERA_MIRROR_NODE_URL=https://mainnet.mirrornode.hedera.com/api/v1
BONZO_DATA_SOURCE=contracts
BONZO_CONTRACT_RPC_URL=https://mainnet.hashio.io/api
BONZO_CONTRACT_VAULTS_JSON='[{"vaultId":"usdc-hbar-single","shareTokenId":"0x1b90B8f8ab3059cf40924338D5292FfbAEd79089","vaultAddress":"<from Bonzo docs>","strategyAddress":"<from Bonzo docs>","assetSymbols":["USDC","HBAR"],"strategyFamily":"single-asset-dex","launchStatus":"live","vaultName":"USDC (Paired with HBAR)","vaultType":"High Volatility | Wide"}]'
BONZO_EXECUTION_MODE=live
```

## Run Commands

```bash
# Unit tests
bun test

# Bootstrap identity (creates or attaches Hedera agent via HCS-10)
bun --env-file=cre-memoryvault/.env run agent/hedera/identity/bootstrap-agent.ts

# Publish HCS-11 profile — submits a real Hedera testnet TX
bun --env-file=cre-memoryvault/.env run agent/hedera/identity/publish-profile.ts

# Full agent loop — simulate
HEDERA_STATE_STORE_PATH=cre-memoryvault/.agent/hedera-state.json \
bun --env-file=cre-memoryvault/.env run agent/index.ts

# Standalone Bonzo trade script (discovery → rank → live deposit)
HEDERA_STATE_STORE_PATH=cre-memoryvault/.agent/hedera-state.json \
bun --env-file=cre-memoryvault/.env run agent/scripts/bonzo-live-trade.ts
```

## Key Files

| File | Purpose |
|---|---|
| `agent/scripts/bonzo-live-trade.ts` | One-shot vault discovery + rank + live deposit |
| `agent/hedera/bonzo-live-transport.ts` | Live EVM deposit/withdraw via viem |
| `agent/tools/bonzo-vaults/discovery.ts` | Vault catalog (mock/contracts/api) |
| `agent/tools/bonzo-vaults/ranking.ts` | APY delta ranking |
| `agent/tools/bonzo-vaults/runtime.ts` | Scan + monitor runtime |
| `agent/hedera/memory/runtime.ts` | S3 + HCS memory commit |
| `agent/hedera/identity/bootstrap.ts` | HCS-10 create-or-attach |
| `agent/hedera/env.ts` | Env loader — fails fast if vars missing |

## Known Accounts (Testnet)

| Account | Purpose |
|---|---|
| `0.0.4689032` | Operator / executor account (~69 HBAR) |
| `0.0.8345807` | Agent account |
| `0.0.8347006` | HCS-11 profile topic (published 2026-03-24) |

**Confirmed on-chain TX:** `0.0.2659396-1774285643-082305883` — HCS-11 profile inscription, SUCCESS on Hedera testnet.
