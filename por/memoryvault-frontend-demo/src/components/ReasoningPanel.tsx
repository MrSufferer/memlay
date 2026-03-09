import React from 'react'
import { clmmOpportunity } from '../fixtures/clmmOpportunity'
import { useDemoState } from '../demoState'

export const ReasoningPanel: React.FC = () => {
  const { reasoning, alphaSources } = useDemoState()
  const publicInputs = reasoning.inputs.filter((i) => i.type === 'public')

  return (
    <div style={{ borderRadius: 12, padding: 20, background: '#020817', border: '1px solid #1f2937', boxShadow: '0 1px 3px rgba(0, 0, 0, 0.3)' }}>
      <h2 style={{ fontSize: '1.25rem', marginBottom: 8, fontWeight: 600 }}>Risk Analysis Reasoning</h2>
      <p style={{ fontSize: 14, opacity: 0.9, marginBottom: 16, lineHeight: 1.5 }}>
        The Risk Analysis Skill evaluates this opportunity using <strong style={{ opacity: 1 }}>public on-chain data</strong> combined with <strong style={{ opacity: 1 }}>your private HTTP alpha feeds</strong>. This is how you make the agent smarter with your own data sources.
      </p>

      {/* Headline scores */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          marginBottom: 12,
          flexWrap: 'wrap',
          fontSize: 13,
        }}
      >
        <div
          style={{
            padding: '8px 10px',
            borderRadius: 10,
            background: '#020617',
            border: '1px solid #1f2937',
            minWidth: 120,
          }}
        >
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.08, opacity: 0.7, marginBottom: 2 }}>
            Risk level
          </div>
          <div style={{ fontWeight: 600 }}>{clmmOpportunity.riskLevel}</div>
        </div>
        <div
          style={{
            padding: '8px 10px',
            borderRadius: 10,
            background: '#020617',
            border: '1px solid #1f2937',
            minWidth: 140,
          }}
        >
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.08, opacity: 0.7, marginBottom: 2 }}>
            Opportunity score
          </div>
          <div style={{ fontWeight: 600 }}>{clmmOpportunity.opportunityScore}/100</div>
        </div>
        <div
          style={{
            padding: '8px 10px',
            borderRadius: 10,
            background: '#020617',
            border: '1px solid #1f2937',
            minWidth: 140,
          }}
        >
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.08, opacity: 0.7, marginBottom: 2 }}>
            Trust score
          </div>
          <div style={{ fontWeight: 600 }}>{clmmOpportunity.trustScore}/100</div>
        </div>
      </div>

      {/* Summary + details */}
      <div
        style={{
          padding: 12,
          borderRadius: 10,
          background: '#020617',
          border: '1px solid #1f2937',
          marginBottom: 14,
          fontSize: 13,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>Why the agent recommends this CLMM</div>
        <p style={{ marginBottom: 8, opacity: 0.95, lineHeight: 1.5 }}>{reasoning.summary}</p>
        <p style={{ opacity: 0.8, lineHeight: 1.5, fontSize: 13 }}>{reasoning.details}</p>
      </div>

      {/* Inputs split: public vs private */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 12,
          fontSize: 13,
        }}
      >
        <div
          style={{
            padding: 12,
            borderRadius: 10,
            background: '#020617',
            border: '1px solid #1f2937',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 6,
            }}
          >
            <div style={{ fontWeight: 500 }}>Public inputs</div>
            <span
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 999,
                background: '#111827',
                opacity: 0.9,
              }}
              title="Public data available to anyone on-chain"
            >
              Public data
            </span>
          </div>
          <ul style={{ listStyle: 'none', paddingLeft: 0, margin: 0 }}>
            {publicInputs.map((input) => (
              <li key={input.source} style={{ marginBottom: 6 }}>
                <div style={{ fontWeight: 500 }}>{input.source}</div>
                <div style={{ opacity: 0.85 }}>{input.description}</div>
              </li>
            ))}
          </ul>
        </div>

        <div
          style={{
            padding: 12,
            borderRadius: 10,
            background: '#020617',
            border: '1px solid #1f2937',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 6,
            }}
          >
            <div style={{ fontWeight: 500 }}>Private HTTP alpha</div>
            <span
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 999,
                background: '#111827',
                opacity: 0.9,
              }}
              title="Your private HTTP endpoints configured with API keys"
            >
              Your private alpha
            </span>
          </div>
          {alphaSources.length === 0 ? (
            <p style={{ opacity: 0.8, lineHeight: 1.5 }}>
              No private alpha sources configured yet. <strong>Use the panel below</strong> to add 1–2 custom HTTP endpoints with your API keys. The agent will use these as confidential inputs when scoring opportunities.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', paddingLeft: 0, margin: 0 }}>
              {alphaSources.map((source) => (
                <li key={source.id} style={{ marginBottom: 6 }}>
                  <div style={{ fontWeight: 500 }}>{source.name}</div>
                  <div style={{ fontSize: 12, opacity: 0.8, wordBreak: 'break-all' }}>{source.url}</div>
                  <div style={{ opacity: 0.85 }}>{source.sampleSignal}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

