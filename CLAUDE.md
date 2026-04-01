# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MemoryVault Agent Protocol — A 3-layer protocol for autonomous DeFi AI agents with pluggable tools, private execution, and verifiable episodic memory built on Chainlink Runtime Environment (CRE).

**Key Innovation:** Standard Tool Interface allows adding new DeFi protocols (Aave, Curve, etc.) without changing agent logic. Each protocol = one CRE workflow.

## Development Commands

### Running Tests
```bash
bun test                    # Run all tests in agent/ directory
vitest run agent            # Alternative test command
```

### Agent Service
```bash
# Run agent with specific trader template
AGENT_ID=agent-alpha-01 bun run agent/index.ts
AGENT_ID=agent-gamma-01 bun run agent/index.ts
```

### ERC-8004 (Agent Identity & Reputation)
```bash
bun run erc8004:build-registration    # Build registration metadata
bun run erc8004:register              # Register agent on-chain
bun run erc8004:probe                 # Probe reliability metrics
bun run erc8004:publish               # Publish feedback on-chain
bun run erc8004:weekly                # Run weekly publisher
```

### Hedera Agent Deployment (HCS-10 / HCS-11)

**Bootstrap** — one-time operator setup (idempotent, safe to re-run):
```bash
bun --env-file=.env run agent/scripts/hedera-bootstrap.ts
```
Creates or attaches an HCS-10/HCS-11 agent identity, persists state to `HEDERA_STATE_STORE_PATH`, and publishes the HCS-11 profile.

**Live Bonzo Vault trade** (standalone, no memory commits):
```bash
# Mainnet live execution
HEDERA_NETWORK=mainnet \
HEDERA_OPERATOR_ID=<operator> \
HEDERA_OPERATOR_KEY=<key> \
BONZO_EXECUTION_MODE=live \
BONZO_CONTRACT_RPC_URL=<rpc> \
BONZO_DATA_SOURCE=contracts \
bun --env-file=.env run agent/scripts/bonzo-live-trade.ts
```

**Agent loop** (memory anchoring + Bonzo scan/enter/exit/monitor):
```bash
MEMORYVAULT_DEPLOYMENT_TARGET=hedera \
HEDERA_NETWORK=mainnet \
AGENT_ID=agent-hedera-01 \
bun --env-file=.env run agent/index.ts
```

**Required env vars for Hedera:**
- `HEDERA_NETWORK` — `mainnet` or `testnet`
- `HEDERA_OPERATOR_ID` / `HEDERA_OPERATOR_KEY` — operator account
- `HEDERA_MIRROR_NODE_URL` — e.g. `https://mainnet.mirrornode.hedera.com/api/v1`
- `HEDERA_STATE_STORE_PATH` — defaults to `.agent/hedera-state.json`

**For live Bonzo execution on mainnet, also:**
- `BONZO_EXECUTION_MODE=live`
- `BONZO_DATA_SOURCE=contracts`
- `BONZO_CONTRACT_RPC_URL` — Hedera JSON-RPC endpoint
- `BONZO_EXECUTOR_MODE=operator|dedicated` (default: `operator` reuses operator signer)
- `BONZO_EXECUTOR_ACCOUNT_ID` / `BONZO_EXECUTOR_PRIVATE_KEY` — required when `dedicated`

**For memory anchoring on mainnet:**
- `HEDERA_MEMORY_TOPIC_ID` — pre-created HCS topic for MemoryVault commitments
- `HEDERA_MEMORY_S3_BUCKET` / `HEDERA_MEMORY_S3_REGION` — S3 for encrypted blob storage
- `AES_KEY_VAR` — 32-byte hex AES-256 key for envelope encryption

### CRE Workflow Simulation

All CRE workflows must be run from the `cre-memoryvault/` directory:

```bash
cd cre-memoryvault

# Scanner — fetch live Uniswap V3 pools
cre workflow simulate tools/uniswap-v3-lp \
  --target staging-settings --trigger-index 0 --non-interactive

# Monitor — check active positions for exit signals
cre workflow simulate tools/uniswap-v3-lp \
  --target monitor-staging-settings --trigger-index 0 --non-interactive

# Memory Writer — commit entry to S3 + Sepolia
cre workflow simulate protocol/memory-writer \
  --target staging-settings --trigger-index 0 --non-interactive \
  --http-payload '{"agentId":"agent-alpha-01","entryKey":"test-01","entryData":{"action":"test"}}'

# Audit Reader — read + verify decision log
cre workflow simulate protocol/audit-reader \
  --target staging-settings --trigger-index 0 --non-interactive \
  --http-payload '{"agentId":"agent-alpha-01"}'

# Integrity Checker — detect tampered S3 blobs
cre workflow simulate protocol/integrity-checker \
  --target staging-settings --trigger-index 0 --non-interactive
```

### Demo
```bash
chmod +x demo/run-demo.sh
./demo/run-demo.sh
```

## Architecture

### 3-Layer Design

```
Agent Skills Layer (agent/)
    ↓ Standard Tool Interface
Protocol Layer (cre-memoryvault/protocol/)
    ↓ CRE workflows (ToolRequest/ToolResponse)
Tools Layer (cre-memoryvault/tools/)
```

### Key Directories

| Path | Purpose |
|------|---------|
| `agent/` | Agent service + skills (risk-analysis, decision, memory-client, cre-trigger, ace-client) |
| `agent/templates/` | Trader strategy templates (JSON) — configure behavior without code changes |
| `agent/erc8004/` | ERC-8004 agent identity & reputation system integration |
| `cre-memoryvault/protocol/` | Protocol CRE workflows (memory-writer, audit-reader, integrity-checker) + Standard Tool Interface types |
| `cre-memoryvault/tools/` | Pluggable tool implementations (uniswap-v3-lp scanner + monitor) |
| `contracts/` | Solidity contracts (MemoryRegistry.sol, ERC-8004 registries) |
| `por/` | Original Proof-of-Reserve + LLM demo (standalone) |
| `server/` | Mock data API + Uniswap subgraph metrics adapter |
| `demo/` | End-to-end demo script + scenario helpers |

### Agent Service Flow

```
1. Load trader template (agent/templates/{agentId}.json)
2. For each tool in template.strategy.tools:
   - CRETrigger: subprocess `cre workflow simulate tools/{toolId}`
   - Risk Analysis Skill: RawOpportunity → ScoredOpportunity (Gemini + alpha)
   - Decision Skill: filter by thresholds (score≥80, trust≥75, etc.)
   - MemoryClient: commit reasoning to S3 + on-chain hash BEFORE acting
   - ACEClient: execute private transfer (stubbed in MVP)
   - MemoryClient: confirm action after execution
```

### Standard Tool Interface

All tools in `cre-memoryvault/tools/` must implement:

**Scanner (`scan` action):**
- Fetches public protocol data via HTTPClient
- Returns `RawOpportunity[]` with no scores
- Risk Analysis Skill adds scoring

**Monitor (`monitor` action):**
- Checks active positions
- Returns `ExitSignal[]` when thresholds breached

**Types:** See `cre-memoryvault/protocol/tool-interface.ts`

## CRE WASM Constraints

CRE workflows compile to WASM. These constraints apply to code in `cre-memoryvault/` only (not `agent/`):

- No `crypto.subtle` or `crypto.getRandomValues` — use `keccak256` from viem
- No `btoa`/`atob` — implement manual base64 encode/decode
- No shared utils across workflow directories — inline helpers in each workflow
- `runtime.now()` returns `Date` not `number` — convert via `new Date(String(runtime.now())).getTime()`
- `runtime.getSecret()` is sequential — fetch secrets one at a time
- `gasLimit` must be a string in config schema
- All env var names in `secrets.yaml` must have `_VAR` suffix

## Environment Configuration

Copy `.env.sample` to `.env` and fill in:

**Required for agent:**
- `CRE_ETH_PRIVATE_KEY` — Sepolia EOA for on-chain memory commits
- `RPC_URL` — Ethereum Sepolia RPC endpoint
- `GEMINI_API_KEY_VAR` — Gemini API key for risk analysis
- `AES_KEY_VAR` — 32-byte hex key for MemoryVault encryption

**Optional:**
- `CRE_RUNTIME_MODE` — `auto` | `simulate` | `deployed` (default: auto)
- `CRE_GATEWAY_URL` — Deployed CRE trigger gateway URL
- `CRE_WORKFLOW_ID_*` — Workflow IDs for deployed mode
- `RAPIDAPI_KEY_VAR` — crypto-news51 alpha source
- `AWS_ACCESS_KEY_ID_VAR` / `AWS_SECRET_ACCESS_KEY_VAR` — S3 for episodic memory
- `ACE_API_URL` — ACE privacy layer (stubbed in MVP)
- `ERC8004_IDENTITY_REGISTRY` / `ERC8004_REPUTATION_REGISTRY` — deployed contract addresses on Sepolia
- `ERC8004_BASE_URL` — base URL for computing registration URI (default: `https://example.github.io/cre-por-llm-demo`)
- `ERC8004_REGISTRATION_URI` — optional: fully-specified override for the on-chain URI written by `erc8004:register`
- `ERC8004_OWNER_PRIVATE_KEY` — private key for on-chain registration transactions (falls back to `CRE_ETH_PRIVATE_KEY`)
- `ERC8004_AGENT_ID` — set after initial registration to enable update mode (`setAgentURI`)
- `ERC8004_DRY_RUN=1` — skip on-chain transaction in `erc8004:weekly` and `erc8004:publish`

**Important:** `cre-memoryvault/.env` must contain the same secrets (CRE CLI reads it for workflow simulations). Easiest approach: `cp .env cre-memoryvault/.env`

## Adding a New Tool

To add a new DeFi protocol (e.g., Aave):

1. Create `cre-memoryvault/tools/{tool-name}/` directory
2. Implement `scanner.ts` (scan action → RawOpportunity[])
3. Implement `monitor.ts` (monitor action → ExitSignal[])
4. Add `workflow.yaml` and `config.staging.json`
5. Register in `agent/cre-trigger.ts` TOOL_WORKFLOW_DIRS map
6. Add tool ID to trader template `strategy.tools` array

**Zero changes needed:** agent skills, protocol workflows, or MemoryVault.

## Trader Templates

Templates in `agent/templates/*.json` configure agent behavior:

- `strategy.tools` — which tools to use (e.g., ["uniswap-v3-lp", "aave-lending"])
- `strategy.entryThresholds` — minOpportunityScore, minTrustScore, maxRiskLevel
- `strategy.exitTriggers` — which signals trigger position exit
- `customInstructions` — injected into Gemini system prompt for personalized risk assessment
- `alpha.sources` — which news/data sources to query

Change trader behavior by editing templates, not code.

## On-Chain Contracts

**MemoryRegistry.sol**
- Network: Ethereum Sepolia
- Address: `0x61C7120F79f17bf9e46dC14251efe5a2659aEfb1`
- Purpose: Stores keccak256 hash commitments of agent memory entries before actions

**ERC-8004 Registries**
- Identity Registry: Agent registration and metadata
- Reputation Registry: Reliability scores and feedback
- Config: `agent/erc8004/config.sepolia.json`

## Testing Strategy

- Unit tests: `*.test.ts` files alongside implementation
- Fallback tests: `*.fallback.test.ts` for runtime mode fallback logic
- Run with `bun test` or `vitest run agent`

## AI DevKit Integration

This project uses ai-devkit for structured development:

- Phase docs: `docs/ai/` (requirements, design, planning, implementation, testing, deployment, monitoring)
- Memory: Use `npx ai-devkit@latest memory search/store` for project knowledge
- Skills: Check `agent/skills/` and `.claude/commands/` for installed capabilities
- Commands: `/review-requirements`, `/review-design`, `/execute-plan`, `/check-implementation`, `/writing-test`, `/code-review`
