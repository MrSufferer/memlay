/**
 * MemoryVault Agent Protocol — Demo Scenarios
 *
 * T3.1: Scam rejection + tampering demo helper.
 *
 * This script is a thin wrapper that:
 *  - Assumes the mock data API is running (server/mock-data-api.ts)
 *  - Injects a scam pool + trust data (if desired)
 *  - Prints curl / CLI snippets to:
 *      - run the scanner via `cre workflow simulate`
 *      - run integrity-checker after a manual S3 tamper step
 *
 * It does NOT perform CRE simulations itself; those remain driven by the
 * commands in the planning doc. The goal is to give a repeatable set of
 * steps for the live demo.
 */

import fetch from 'node-fetch'

const MOCK_API_URL = process.env.MOCK_API_URL || 'http://localhost:3001'
const DATA_API_KEY = process.env.DATA_API_KEY_VAR || 'demo-secret-key-12345'

async function injectScamScenario() {
  const url = `${MOCK_API_URL}/pools/simulate`

  const body = {
    pool: {
      id: 'pool-weth-scam-demo',
      pair: 'WETH/SCAMDEMO',
      protocol: 'uniswap-v3',
      token: '0xScamDEMO00000000000000000000000000000000',
      age: '1d',
      tvl: 45000,
      feeAPY: 9999,
      feeTier: 10000,
      tickSpacing: 200,
      currentTick: 42,
    },
    trust: {
      token: '0xScamDEMO00000000000000000000000000000000',
      data: {
        tokenSniffer: { score: 10, honeypot: true, rugPull: true },
        etherscan: { verified: false, ownerRenounced: false, proxy: true },
        uncx: { liquidityLocked: false, lockDuration: '0', lockPct: 0 },
        holders: { top10Pct: 90, totalHolders: 25 },
      },
    },
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': DATA_API_KEY,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    throw new Error(`Failed to inject scam scenario: ${res.status} ${res.statusText}`)
  }

  const json = await res.json()
  console.log('\n[simulate-scenarios] Scam scenario injected into mock API:')
  console.log(JSON.stringify(json, null, 2))
}

async function main() {
  console.log('🔧 MemoryVault Demo Scenarios')
  console.log(`Mock API: ${MOCK_API_URL}`)

  await injectScamScenario().catch(err => {
    console.error('[simulate-scenarios] Error injecting scenario:', err)
    process.exit(1)
  })

  console.log('\nNext steps for live demo:')
  console.log('1) Run scanner (already wired to mock API + x-api-key):')
  console.log('   cd cre-memoryvault')
  console.log('   cre workflow simulate tools/uniswap-v3-lp --target staging-settings --trigger-index 0 --non-interactive')
  console.log('\n2) Observe that:')
  console.log('   - Scanner returns both legit and scam pools as RawOpportunity[].')
  console.log('   - Agent Risk Analysis Skill (demo stub) will classify any pool with SCAM in the pair/token as SCAM and log the rejection.')
  console.log('\n3) For tampering demo:')
  console.log('   - Use AWS CLI to tamper a single MemoryVault blob, for example:')
  console.log('       export S3_BUCKET=memoryvault-demo')
  console.log('       export S3_REGION=us-east-1')
  console.log('       export AGENT_ID=agent-alpha-01')
  console.log('       KEY=$(aws s3 ls \"s3://$S3_BUCKET/agents/$AGENT_ID/log/\" --region $S3_REGION | head -n 1 | awk \'{print $4}\')')
  console.log('       aws s3 cp \"s3://$S3_BUCKET/agents/$AGENT_ID/log/$KEY\" /tmp/entry.json --region $S3_REGION')
  console.log('       jq \'.tampered = true\' /tmp/entry.json > /tmp/entry-tampered.json')
  console.log('       aws s3 cp /tmp/entry-tampered.json \"s3://$S3_BUCKET/agents/$AGENT_ID/log/$KEY\" --region $S3_REGION')
  console.log('   - Then run:')
  console.log('       cd cre-memoryvault')
  console.log('       cre workflow simulate protocol/integrity-checker --target staging-settings --trigger-index 0 --non-interactive')
  console.log('   - Integrity checker should report mismatches and (in a real deployment) send a Pushover alert.')
}

main().catch(err => {
  console.error('[simulate-scenarios] Fatal error:', err)
  process.exit(1)
})

