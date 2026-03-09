import React from 'react'
import { CLMMScenarioPanel } from './CLMMScenarioPanel'
import { ReasoningPanel } from './ReasoningPanel'
import { MemoryTimelinePanel } from './MemoryTimelinePanel'
import { AlphaConfigPanel } from './AlphaConfigPanel'

export const DemoLayout: React.FC = () => {
  return (
    <div style={{ minHeight: '100vh', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif', padding: '32px', background: '#020617', color: '#e5e7eb', lineHeight: 1.5 }}>
      <header style={{ marginBottom: '32px' }}>
        <h1 style={{ fontSize: '2rem', marginBottom: '8px', fontWeight: 600, letterSpacing: '-0.02em' }}>
          MemoryVault Agent Protocol
        </h1>
        <p style={{ fontSize: '1.125rem', maxWidth: 720, opacity: 0.95, lineHeight: 1.6, marginBottom: '12px' }}>
          <strong>Verifiable memory before action.</strong> Every decision is committed to an immutable audit log before any funds move—so you can trust your agent won't go rogue.
        </p>
        <p style={{ fontSize: '0.9375rem', maxWidth: 720, opacity: 0.85, lineHeight: 1.5 }}>
          Plus, plug in your own private HTTP alpha feeds to make the agent smarter. This demo shows how it works with a single CLMM rebalancing scenario.
        </p>
      </header>
      <main
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1.1fr)',
          gridTemplateRows: 'auto auto',
          gap: '20px',
        }}
      >
        <section style={{ gridColumn: '1 / 2', gridRow: '1 / 2' }}>
          <CLMMScenarioPanel />
        </section>
        <section style={{ gridColumn: '2 / 3', gridRow: '1 / 2' }}>
          <ReasoningPanel />
        </section>
        <section style={{ gridColumn: '1 / 2', gridRow: '2 / 3' }}>
          <MemoryTimelinePanel />
        </section>
        <section style={{ gridColumn: '2 / 3', gridRow: '2 / 3' }}>
          <AlphaConfigPanel />
        </section>
      </main>
    </div>
  )
}

