#!/usr/bin/env bash
set -euo pipefail

# MemoryVault Agent Protocol — End-to-End Demo Script (T3.2)
#
# This script stitches together the core pieces for a local demo:
#  1) (Optional) Start the mock data API for scam injection
#  2) (Optional) Inject scam + trust scenarios via mock API
#  3) Run the Uniswap V3 scanner workflow — fetches live pool data from
#     The Graph Uniswap V3 subgraph via CRE workflow simulation
#  4) Run the agent once:
#       - CRETrigger spawns `cre workflow simulate` as subprocess → scan results
#       - Risk Analysis Skill scores each pool via Gemini + crypto-news51 alpha
#       - Decision Skill filters (score >= 80, trust >= 75, not SCAM)
#       - MemoryClient spawns `cre workflow simulate protocol/memory-writer`
#         to commit reasoning to S3 + MemoryRegistry on Sepolia (BEFORE acting)
#       - ACE private transfer (stubbed — T2.5 out of scope)
#  5) Run the monitor workflow to check active positions for exit signals
#  6) Show how to run audit-reader and integrity-checker
#
# NOTE: ACE private transfer is a stub. The focus is on the 3-layer protocol:
#       Tool (CRE workflow) → Skills (Gemini + alpha) → Protocol (MemoryVault).
#
# PREREQUISITES:
#   bun >= 1.2.21     (bun --version)
#   cre >= 1.3.0      (cre --version)
#   .env at repo root:  GEMINI_API_KEY_VAR, RAPIDAPI_KEY_VAR,
#                       AWS_ACCESS_KEY_ID_VAR, AWS_SECRET_ACCESS_KEY_VAR,
#                       AES_KEY_VAR, PRIVATE_KEY, RPC_URL
#   cre-memoryvault/.env must also have the same values (CRE CLI reads it)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRE_DIR="$ROOT_DIR/cre-memoryvault"
AGENT_ID="${AGENT_ID:-agent-alpha-01}"

print_header() {
  echo
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

print_header "MemoryVault Agent Protocol — End-to-End Demo"
echo "  Root dir:  $ROOT_DIR"
echo "  CRE dir:   $CRE_DIR"
echo "  Agent ID:  $AGENT_ID"

# ─── Step 1: (Optional) Mock Data API ─────────────────────────────────────────
print_header "Step 1 — Mock Data API (for scam injection)"
cd "$ROOT_DIR"
if ! pgrep -f "server/mock-data-api.ts" >/dev/null 2>&1; then
  echo "  Starting mock API on :3001..."
  bun run server/mock-data-api.ts >/dev/null 2>&1 &
  MOCK_API_PID=$!
  sleep 1
  echo "  Mock API started (pid=$MOCK_API_PID)"
else
  echo "  Mock API already running"
fi

# ─── Step 2: (Optional) Inject Scam Scenario ──────────────────────────────────
print_header "Step 2 — Inject Scam Scenario (WETH/SCAMDEMO into mock API)"
cd "$ROOT_DIR"
bun run demo/simulate-scenarios.ts || echo "  WARNING: Scenario injection skipped (mock API may not be running)"

# ─── Step 3: Scanner — Uniswap V3 CRE Workflow ────────────────────────────────
print_header "Step 3 — Uniswap V3 Scanner (CRE workflow simulate)"
echo "  Fetching live pool data from The Graph Uniswap V3 subgraph."
echo "  This is the same call the agent makes internally via CRETrigger."
echo
cd "$CRE_DIR"
cre workflow simulate tools/uniswap-v3-lp \
  --target staging-settings \
  --trigger-index 0 \
  --non-interactive
echo
echo "  NOTE: Scanner returns RawOpportunity[] with NO scores."
echo "        Scoring is the Risk Analysis Skill's job — not the tool's."

# ─── Step 4: Agent Loop ───────────────────────────────────────────────────────
print_header "Step 4 — Agent Loop (scan -> score -> filter -> memory commit -> ACE stub)"
echo "  What happens inside bun run agent/index.ts:"
echo "    1. CRETrigger spawns: cre workflow simulate tools/uniswap-v3-lp (subprocess)"
echo "    2. Risk Analysis Skill: Gemini + crypto-news51 alpha -> ScoredOpportunity[]"
echo "    3. Decision Skill: filter by template thresholds (score>=80, trust>=75, not SCAM)"
echo "    4. For each qualifying pool:"
echo "       a. MemoryClient spawns: cre workflow simulate protocol/memory-writer"
echo "          -> XOR-encrypt entry -> S3 PUT -> keccak256 hash -> MemoryRegistry.sol"
echo "       b. ACE private transfer (STUBBED — logs intent only)"
echo "       c. Confirmation memory commit"
echo
cd "$ROOT_DIR"
AGENT_ID="$AGENT_ID" bun run agent/index.ts

# ─── Step 5: Monitor — Check Active Positions ─────────────────────────────────
print_header "Step 5 — Position Monitor (CRE workflow simulate)"
echo "  Checking active positions for exit signals..."
echo
cd "$CRE_DIR"
cre workflow simulate tools/uniswap-v3-lp \
  --target monitor-staging-settings \
  --trigger-index 0 \
  --non-interactive

# ─── Step 6: Post-Demo — Audit + Tampering ────────────────────────────────────
print_header "Step 6 — Audit & Tampering Detection (run these manually)"

echo
echo "  ── Read the verified decision log ──────────────────────────────────────"
echo "  cd cre-memoryvault"
cat <<'EOF'
  cre workflow simulate protocol/audit-reader \
    --target staging-settings \
    --trigger-index 0 \
    --non-interactive \
    --http-payload '{"agentId":"agent-alpha-01"}'
EOF

echo
echo "  ── Tampering demo: modify an S3 blob and run integrity checker ─────────"
echo "  # 1. Grab the first log key for this agent:"
echo "  export S3_BUCKET=memory-layer"
echo "  export S3_REGION=ap-southeast-2"
echo "  export AGENT_ID=$AGENT_ID"
echo "  KEY=\$(aws s3 ls \"s3://\$S3_BUCKET/agents/\$AGENT_ID/log/\" --region \$S3_REGION | head -n 1 | awk '{print \$4}')"
echo
echo "  # 2. Download, append junk (tamper), re-upload:"
echo "  aws s3 cp \"s3://\$S3_BUCKET/agents/\$AGENT_ID/log/\$KEY\" /tmp/entry.b64 --region \$S3_REGION"
echo "  printf 'TAMPERED' >> /tmp/entry.b64"
echo "  aws s3 cp /tmp/entry.b64 \"s3://\$S3_BUCKET/agents/\$AGENT_ID/log/\$KEY\" --region \$S3_REGION"
echo
echo "  # 3. Run integrity checker (expect mismatch report):"
echo "  cd cre-memoryvault"
cat <<'EOF'
  cre workflow simulate protocol/integrity-checker \
    --target staging-settings \
    --trigger-index 0 \
    --non-interactive
EOF

print_header "Demo complete"
echo "  What was demonstrated:"
echo "  [1] Standard Tool Interface: scanner returns RawOpportunity[], skill adds scores"
echo "  [2] SCAM rejection:          SCAM pools logged and never executed"
echo "  [3] Memory-before-action:    S3 + Sepolia hash committed before ACE stub"
echo "  [4] Verifiable audit trail:  audit-reader reads and on-chain verifies all entries"
echo "  [5] Tamper detection:        integrity-checker detects any modified S3 blobs"
echo "  [6] Extensibility:           add a new tool = new CRE workflow + toolId in template"
echo
