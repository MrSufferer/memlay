import { loadErc8004Config } from './config'
import { probeReliability } from './probe-reliability'
import { buildReliabilityFeedbackInputs } from './reputation-utils'
import { publishFeedbackEntries } from './publish-feedback'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value || value.trim().length === 0) {
    throw new Error(`[erc8004] Missing required environment variable: ${name}`)
  }
  return value
}

async function main() {
  const config = loadErc8004Config()
  const agentId = Number(requireEnv('ERC8004_AGENT_ID'))
  const dryRun = process.env.ERC8004_DRY_RUN === '1'

  const probeResults = await probeReliability(config.reliabilityEndpoints)

  console.log('[erc8004] Weekly reliability summary:')
  for (const result of probeResults) {
    console.log(
      `  ${result.endpointId}: reachable=${result.reachable} ` +
        `uptime=${result.uptimePct.toFixed(2)}% ` +
        `successRate=${result.successRatePct.toFixed(2)}% ` +
        `responseTimeMsMedian=${result.responseTimeMsMedian ?? 'n/a'}`
    )
  }

  const entries = buildReliabilityFeedbackInputs({ agentId, probeResults })
  console.log(`[erc8004] Prepared ${entries.length} feedback entries`)

  if (dryRun) {
    console.log('[erc8004] Dry run enabled, skipping on-chain publish.')
    return
  }

  const txHashes = await publishFeedbackEntries(entries)
  console.log('[erc8004] Weekly publish complete:')
  for (const txHash of txHashes) {
    console.log(`  tx: ${txHash}`)
  }
}

main().catch((error) => {
  console.error('[erc8004] run-weekly-publisher failed:', error)
  process.exit(1)
})
