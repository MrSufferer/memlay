# Hedera / Bonzo Agent — Status & Run Instructions

## Done

All code is implemented and unit-tested:
- HCS-10/HCS-11 bootstrap, profile publish, state store
- Bonzo scan, APY ranking, monitor, enter/exit
- `HederaBonzoLiveTransport` (single-asset vault deposit/withdraw)
- Memory commit (S3 blob + HCS topic)
- Full agent loop with monitor-first ordering

## Why No Live Transactions Yet

The Hedera backend was never instantiated in a real environment. The `.env` has zero Hedera variables. `loadHederaEnvConfig()` throws before any transaction is attempted.

## What's Needed

**Required in `.env`:**

```bash
MEMORYVAULT_DEPLOYMENT_TARGET=hedera
HEDERA_NETWORK=testnet
HEDERA_OPERATOR_ID=0.0.XXXXX
HEDERA_OPERATOR_KEY=0x...
HEDERA_MIRROR_NODE_URL=https://testnet.mirrornode.hedera.com/api/v1
HEDERA_MEMORY_TOPIC_ID=0.0.YYYYY          # create an HCS topic on testnet first
BONZO_DATA_SOURCE=contracts
BONZO_CONTRACT_RPC_URL=https://testnet.hashio.io/api
BONZO_EXECUTION_MODE=simulate              # switch to live once loop works
```

> **Vault addresses:** provide `BONZO_CONTRACT_VAULTS_JSON` with actual vault contract addresses from [docs.bonzo.finance](https://docs.bonzo.finance/hub/developer/bonzo-vaults-beta/vaults-contracts). The built-in catalog uses share/LP token addresses — not the vault contract addresses needed for live execution.

## Run Commands

```bash
# Unit tests
bun test

# Bootstrap identity (requires HEDERA_OPERATOR_* vars)
bun run agent/hedera/identity/bootstrap-agent.ts

# Publish HCS-11 profile
bun run agent/hedera/identity/publish-profile.ts

# Full agent loop — simulate (start here to verify the loop)
MEMORYVAULT_DEPLOYMENT_TARGET=hedera \
AGENT_ID=agent-hedera-01 \
BONZO_EXECUTION_MODE=simulate \
bun run agent/index.ts

# Full agent loop — live (requires all vars above + funded executor account)
MEMORYVAULT_DEPLOYMENT_TARGET=hedera \
AGENT_ID=agent-hedera-01 \
BONZO_EXECUTION_MODE=live \
bun run agent/index.ts
```

## Key Files

| File | Purpose |
|---|---|
| `agent/core/backend.ts` | `HederaExecutionRuntime` — wires live transport in `live` mode |
| `agent/hedera/bonzo-live-transport.ts` | Live EVM deposit/withdraw |
| `agent/tools/bonzo-vaults/discovery.ts` | Vault catalog (mock/contracts/api) |
| `agent/tools/bonzo-vaults/ranking.ts` | APY delta ranking |
| `agent/tools/bonzo-vaults/runtime.ts` | Scan + monitor runtime |
| `agent/hedera/memory/runtime.ts` | S3 + HCS memory commit |
| `agent/hedera/identity/bootstrap.ts` | HCS-10 create-or-attach |
| `agent/hedera/env.ts` | Env loader — fails fast if vars missing |
