#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CRE_DIR="$ROOT_DIR/cre-memoryvault"
OUT_DIR="$CRE_DIR/deployments"
OUT_FILE="$OUT_DIR/sepolia-workflows.json"

mkdir -p "$OUT_DIR"

declare -A IDS

deploy_and_activate() {
  local key="$1"
  local path="$2"
  local target="$3"

  echo "[deploy] $key -> $path ($target)"
  local output
  output="$(cd "$CRE_DIR" && cre workflow deploy "$path" --target "$target" --yes 2>&1)"
  echo "$output"

  local workflow_id
  workflow_id="$(echo "$output" | grep -Eo '0x[a-fA-F0-9]{64}|[a-fA-F0-9]{64}' | head -n1 || true)"
  workflow_id="${workflow_id#0x}"
  IDS["$key"]="$workflow_id"

  echo "[activate] $key -> $path ($target)"
  (cd "$CRE_DIR" && cre workflow activate "$path" --target "$target" --yes)
}

deploy_and_activate scanner tools/uniswap-v3-lp production-settings
deploy_and_activate monitor tools/uniswap-v3-lp monitor-staging-settings
deploy_and_activate memory_writer protocol/memory-writer production-settings
deploy_and_activate audit_reader protocol/audit-reader production-settings
deploy_and_activate integrity_checker protocol/integrity-checker production-settings

cat > "$OUT_FILE" <<JSON
{
  "network": "sepolia",
  "gatewayUrl": "${CRE_GATEWAY_URL:-}",
  "workflowIds": {
    "scanner": "${IDS[scanner]}",
    "monitor": "${IDS[monitor]}",
    "memoryWriter": "${IDS[memory_writer]}",
    "auditReader": "${IDS[audit_reader]}",
    "integrityChecker": "${IDS[integrity_checker]}"
  }
}
JSON

echo "[done] Wrote deployment artifact: $OUT_FILE"
