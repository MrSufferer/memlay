import React from 'react'
import { useDemoState } from '../demoState'

const formatTime = (iso: string) => {
  const d = new Date(iso)
  return d.toISOString().split('T')[1]?.replace('Z', 'Z') ?? iso
}

export const MemoryTimelinePanel: React.FC = () => {
  const { memoryEntries, alphaSources } = useDemoState()
  const sorted = [...memoryEntries].sort((a, b) => a.timestamp.localeCompare(b.timestamp))

  return (
    <div style={{ borderRadius: 12, padding: 20, background: '#020817', border: '1px solid #1f2937', boxShadow: '0 1px 3px rgba(0, 0, 0, 0.3)' }}>
      <h2 style={{ fontSize: '1.25rem', marginBottom: 8, fontWeight: 600 }}>MemoryVault Timeline</h2>
      <p style={{ fontSize: 14, opacity: 0.9, marginBottom: 16, lineHeight: 1.5 }}>
        <strong style={{ opacity: 1 }}>This is the verifiable audit trail.</strong> Notice how the decision and reasoning are committed to MemoryVault <em>before</em> execution. This tamper-evident log is anchored on-chain, so you can always verify what the agent decided and when.
      </p>
      <ol style={{ listStyle: 'none', paddingLeft: 0, margin: 0, fontSize: 13 }}>
        {sorted.map((entry, idx) => {
          const isDecision = entry.type === 'rebalancing-decision'
          const isExecuted = entry.type === 'rebalancing-executed'
          const badgeColor = isDecision ? '#22c55e' : isExecuted ? '#f97316' : '#4b5563'

          return (
            <li key={entry.id} style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 10 }}>
              <span
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 999,
                  background: badgeColor,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  marginRight: 8,
                }}
              >
                {idx + 1}
              </span>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <span style={{ fontWeight: 500 }}>{entry.type}</span>
                  <span
                    style={{
                      fontSize: 11,
                      padding: '1px 6px',
                      borderRadius: 999,
                      background: '#111827',
                      opacity: 0.9,
                    }}
                  >
                    {formatTime(entry.timestamp)}
                  </span>
                  {isDecision && (
                    <span
                      style={{
                        fontSize: 11,
                        padding: '1px 6px',
                        borderRadius: 999,
                        border: '1px solid #22c55e',
                        color: '#bbf7d0',
                      }}
                    >
                      🔒 committed before action
                    </span>
                  )}
                </div>
                <div style={{ opacity: 0.85, marginBottom: 2 }}>{entry.data.summary}</div>
                {entry.data.reasoning && (
                  <div style={{ fontSize: 12, opacity: 0.8 }}>
                    <span style={{ fontWeight: 500 }}>Reasoning: </span>
                    {entry.data.reasoning}
                  </div>
                )}
                {isDecision && alphaSources.length > 0 && (
                  <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}>
                    <span style={{ fontWeight: 500 }}>Private HTTP sources: </span>
                    {alphaSources.map((s) => s.name).join(', ')}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

