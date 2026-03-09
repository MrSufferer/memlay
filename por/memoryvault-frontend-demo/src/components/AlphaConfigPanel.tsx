import React, { FormEvent, useState } from 'react'
import { useDemoState } from '../demoState'
import type { AlphaSourceView } from '../types/protocolViewModels'

// ── Crypto News 51 pre-built template ────────────────────────────────────────
const CRYPTONEWS51_TEMPLATE: Omit<AlphaSourceView, 'id' | 'apiKey'> = {
  name: 'Crypto News 51 — 24h news + sentiment',
  url: 'https://crypto-news51.p.rapidapi.com/api/v1/crypto/articles/search?title_keywords={TOKEN}&page=1&limit=5&time_frame=24h&format=json',
  apiKeyLabel: 'RapidAPI Key',
  headerName: 'x-rapidapi-key',
  sampleSignal:
    'Returns up to 5 articles from the last 24h with sentiment labels (positive / negative / neutral) for the pool token.',
}

const inputStyle: React.CSSProperties = {
  marginTop: 3,
  width: '100%',
  padding: '7px 10px',
  borderRadius: 7,
  border: '1px solid #1f2937',
  background: '#020617',
  color: '#e5e7eb',
  fontSize: 13,
  boxSizing: 'border-box',
}

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  opacity: 0.85,
  display: 'block',
}

export const AlphaConfigPanel: React.FC = () => {
  const { alphaSources, addAlphaSource, removeAlphaSource } = useDemoState()

  // ── template-loaded form state ────────────────────────────────────────────
  const [name, setName] = useState(CRYPTONEWS51_TEMPLATE.name)
  const [url, setUrl] = useState(CRYPTONEWS51_TEMPLATE.url)
  const [headerName, setHeaderName] = useState(CRYPTONEWS51_TEMPLATE.headerName)
  const [apiKeyLabel, setApiKeyLabel] = useState(CRYPTONEWS51_TEMPLATE.apiKeyLabel)
  const [apiKey, setApiKey] = useState('')

  const loadTemplate = () => {
    setName(CRYPTONEWS51_TEMPLATE.name)
    setUrl(CRYPTONEWS51_TEMPLATE.url)
    setHeaderName(CRYPTONEWS51_TEMPLATE.headerName)
    setApiKeyLabel(CRYPTONEWS51_TEMPLATE.apiKeyLabel)
    setApiKey('')  // user must fill their own key
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!url.trim() || !apiKey.trim()) return
    addAlphaSource({
      name: name.trim() || url.trim(),
      url: url.trim(),
      apiKeyLabel: apiKeyLabel.trim() || headerName.trim(),
      apiKey: apiKey.trim(),
      headerName: headerName.trim() || 'x-api-key',
    })
    // reset to template defaults after add
    loadTemplate()
  }

  const maxReached = alphaSources.length >= 2

  return (
    <div style={{ borderRadius: 12, padding: 20, background: '#020817', border: '1px solid #1f2937' }}>
      <h2 style={{ fontSize: '1.15rem', marginBottom: 6, fontWeight: 600 }}>
        Private Alpha Sources
      </h2>
      <p style={{ fontSize: 13, opacity: 0.8, marginBottom: 14, lineHeight: 1.55 }}>
        Add HTTP alpha feeds (news, signals, on-chain data). The agent fetches each source
        <strong style={{ color: '#22c55e' }}> using your API key locally</strong> — only the
        <em> response content</em> is forwarded to Gemini for scoring.{' '}
        <strong>Your credentials never leave the browser.</strong>
      </p>

      {/* Privacy model callout */}
      <div style={{
        fontSize: 12, padding: '8px 12px', borderRadius: 8, marginBottom: 14,
        background: '#0c1a0c', border: '1px solid #166534', color: '#86efac',
        lineHeight: 1.5,
      }}>
        🔒 <strong>Privacy model:</strong>{' '}
        <code style={{ fontSize: 11 }}>browser → alpha API (your key)</code>{' '}
        →{' '}
        <code style={{ fontSize: 11 }}>response only → Gemini</code>.
        In the real protocol, this uses{' '}
        <code style={{ fontSize: 11 }}>ConfidentialHTTPClient</code> inside the CRE WASM runtime.
      </div>

      {/* Template quick-load */}
      <div style={{
        fontSize: 12, padding: '8px 12px', borderRadius: 8, marginBottom: 14,
        background: '#0d1117', border: '1px solid #1f2937',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      }}>
        <div>
          <strong style={{ fontSize: 13 }}>Template:</strong>{' '}
          <span style={{ opacity: 0.75 }}>Crypto News 51 — 24h news with sentiment via RapidAPI</span>
        </div>
        <button
          type="button"
          onClick={loadTemplate}
          style={{
            whiteSpace: 'nowrap', padding: '4px 10px', borderRadius: 999, fontSize: 12,
            border: '1px solid #3b82f6', background: '#0c1a2e', color: '#93c5fd', cursor: 'pointer',
          }}
        >
          Load template
        </button>
      </div>

      <form onSubmit={handleSubmit} style={{ fontSize: 13 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
          <label style={labelStyle}>
            Name
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g., My Research Feed" style={inputStyle} />
          </label>

          <label style={labelStyle}>
            URL{' '}
            <span style={{ opacity: 0.5 }}>— use <code style={{ fontSize: 11 }}>{'{TOKEN}'}</code> for the pool token symbol</span>
            <input type="url" value={url} onChange={e => setUrl(e.target.value)}
              placeholder="https://api.example.com/news?q={TOKEN}" style={inputStyle} required />
          </label>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label style={labelStyle}>
              Header name
              <input type="text" value={headerName} onChange={e => setHeaderName(e.target.value)}
                placeholder="x-rapidapi-key" style={inputStyle} />
            </label>
            <label style={labelStyle}>
              Key label (display only)
              <input type="text" value={apiKeyLabel} onChange={e => setApiKeyLabel(e.target.value)}
                placeholder="RapidAPI Key" style={inputStyle} />
            </label>
          </div>

          <label style={labelStyle}>
            API key{' '}
            <span style={{ color: '#22c55e', opacity: 0.9 }}>
              (stored in browser only — not sent to Gemini)
            </span>
            <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
              placeholder="Paste your API key here" style={{ ...inputStyle, letterSpacing: apiKey ? '0.1em' : 'normal' }}
              required />
          </label>
        </div>

        <button
          type="submit"
          disabled={maxReached || !apiKey.trim()}
          style={{
            padding: '7px 16px', borderRadius: 999, fontSize: 13, fontWeight: 500,
            border: '1px solid #22c55e',
            background: (maxReached || !apiKey.trim()) ? '#0f172a' : '#22c55e',
            color: (maxReached || !apiKey.trim()) ? '#4b5563' : '#020617',
            cursor: (maxReached || !apiKey.trim()) ? 'default' : 'pointer',
          }}
        >
          {maxReached ? 'Max 2 sources for this demo' : 'Add alpha source'}
        </button>
      </form>

      {/* Active sources list */}
      {alphaSources.length > 0 && (
        <div style={{ borderTop: '1px solid #1f2937', marginTop: 14, paddingTop: 14 }}>
          <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>Active sources</div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {alphaSources.map(s => (
              <li key={s.id} style={{
                padding: '8px 10px', borderRadius: 8, background: '#020617',
                border: '1px solid #1f2937', fontSize: 12,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</span>
                  {removeAlphaSource && (
                    <button
                      onClick={() => removeAlphaSource(s.id)}
                      style={{
                        border: 'none', background: 'none', color: '#6b7280',
                        cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px',
                      }}
                      title="Remove"
                    >×</button>
                  )}
                </div>
                <div style={{ opacity: 0.6, wordBreak: 'break-all', marginBottom: 2 }}>{s.url}</div>
                <div style={{ opacity: 0.6 }}>
                  Header: <code style={{ fontSize: 11 }}>{s.headerName}</code>
                  {' · '}
                  Key: <code style={{ fontSize: 11 }}>{'•'.repeat(Math.min(8, s.apiKey.length))}…</code>
                </div>
                <div style={{ marginTop: 4, color: '#86efac', opacity: 0.9 }}>{s.sampleSignal}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
