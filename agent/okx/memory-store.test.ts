/**
 * MemoryStore smoke test — run with: bun run agent/okx/memory-store.test.ts
 */
import { createMemoryStore } from './memory-store.ts'

async function test() {
  console.log('=== MemoryStore Smoke Test ===\n')

  const store = await createMemoryStore({ agentId: 'test-okx-01' })

  // Store episodic entries
  const entry1 = await store.store({
    type: 'episodic',
    content: 'Entered BEAON/USDC position at TVL=$50k, APY=12.5%',
    tags: ['entry', 'BEAON', 'USDC'],
    importance: 8,
    metadata: { pair: 'BEAON/USDC', tvlUsd: 50000, apy: 12.5, pnlWei: 0 },
  })
  console.log('✅ Stored episodic entry:', entry1.id.slice(0, 8), `| decayFactor=${entry1.decayFactor.toFixed(3)}`)

  const entry2 = await store.store({
    type: 'episodic',
    content: 'Confirmed BEAON/USDC exit — PnL +1500000000000000 wei',
    tags: ['confirm', 'BEAON', 'USDC', 'profit'],
    importance: 9,
    metadata: { pnlWei: 1500000000000000, outcome: 'profit' },
  })
  console.log('✅ Stored confirm entry:', entry2.id.slice(0, 8))

  // Recall by query
  console.log('\n--- Recall: "BEAON entry" ---')
  const results = await store.recall({ query: 'BEAON entry', limit: 5, types: ['episodic'] })
  for (const r of results) {
    console.log(`  score=${r.score.toFixed(2)} recency=${r.recency.toFixed(2)} relevance=${r.relevance.toFixed(2)}`)
    console.log(`  content: ${r.entry.content.slice(0, 60)}...`)
  }

  // Recall by tags
  console.log('\n--- Recall: tag=["profit"] ---')
  const profitResults = await store.recall({ tags: ['profit'], limit: 3, types: ['episodic'] })
  console.log(`  ${profitResults.length} results`)
  for (const r of profitResults) {
    console.log(`  score=${r.score.toFixed(2)}: ${r.entry.content.slice(0, 60)}`)
  }

  // Stats
  const stats = await store.stats()
  console.log('\n--- Stats ---')
  console.log(`  Total: ${stats.total}`)
  for (const [type, count] of Object.entries(stats.byType)) {
    console.log(`  ${type}: ${count} (avgDecayFactor=${(stats.avgDecayFactor as any)[type].toFixed(3)})`)
  }

  // Dream cycle
  console.log('\n--- Dream Cycle ---')
  const dreamResults = await store.dream({ limitEpisodes: 10 })
  for (const r of dreamResults) {
    console.log(`  ${r.phase}: ${r.memoriesProduced} memories, ${r.durationMs}ms`)
  }

  // Final stats after dream
  const finalStats = await store.stats()
  console.log(`\n  Total after dream: ${finalStats.total}`)

  store.close()
  console.log('\n✅ All tests passed!')
}

test().catch((err) => {
  console.error('❌ Test failed:', err)
  process.exit(1)
})