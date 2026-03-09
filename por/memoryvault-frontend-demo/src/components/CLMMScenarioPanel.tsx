import React, { useMemo, useState } from 'react'
import { clmmOpportunity } from '../fixtures/clmmOpportunity'

type Step = 'idle' | 'reasoning' | 'memoryCommitted' | 'executed'

const stepOrder: Step[] = ['idle', 'reasoning', 'memoryCommitted', 'executed']

const stepLabels: Record<Step, string> = {
  idle: '1. Opportunity detected',
  reasoning: '2. Risk analysis running',
  memoryCommitted: '3. Reasoning committed to MemoryVault',
  executed: '4. CLMM rebalance executed (simulated)',
}

const stepCaption: Record<Step, React.ReactNode> = {
  idle: 'The agent has detected a CLMM opportunity from public on-chain data. No action has been taken yet.',
  reasoning:
    'The Risk Analysis Skill evaluates the opportunity using public data plus your private HTTP alpha feeds. This scoring happens before any funds move.',
  memoryCommitted: (
    <>
      🔒 <strong>Critical step:</strong> The agent commits its reasoning and decision to MemoryVault, creating a verifiable, tamper-evident record. This happens <em>before</em> any execution.
    </>
  ),
  executed:
    'Only after the reasoning is locked in MemoryVault does the agent execute the rebalance. You can always audit what the agent decided and why.',
}

export const CLMMScenarioPanel: React.FC = () => {
  const [step, setStep] = useState<Step>('idle')

  const currentStepIndex = useMemo(() => stepOrder.indexOf(step), [step])

  const handleAdvance = () => {
    const idx = stepOrder.indexOf(step)
    const next = stepOrder[Math.min(idx + 1, stepOrder.length - 1)]
    setStep(next)
  }

  const handleReset = () => setStep('idle')

  const before = clmmOpportunity.beforePosition
  const after = clmmOpportunity.afterPosition

  const showAfter = currentStepIndex >= stepOrder.indexOf('executed')

  return (
    <div style={{ borderRadius: 12, padding: 20, background: '#020817', border: '1px solid #1f2937', boxShadow: '0 1px 3px rgba(0, 0, 0, 0.3)' }}>
      <h2 style={{ fontSize: '1.25rem', marginBottom: 8, fontWeight: 600 }}>CLMM Rebalancing Scenario</h2>
      <p style={{ fontSize: 14, opacity: 0.9, marginBottom: 16, lineHeight: 1.5 }}>
        A single Uniswap V3 CLMM pool opportunity. Watch how the agent <strong style={{ opacity: 1 }}>commits its reasoning to MemoryVault before executing</strong>—this is the verifiable memory guarantee that prevents rogue behavior.
      </p>

      {/* Step state machine */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          {stepOrder.map((s, idx) => {
            const isActive = s === step
            const isCompleted = idx < currentStepIndex
            const baseColor = isActive ? '#22c55e' : isCompleted ? '#4b5563' : '#111827'
            const borderColor = isActive ? '#22c55e' : '#4b5563'

            return (
              <div
                key={s}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '6px 10px',
                  borderRadius: 999,
                  border: `1px solid ${borderColor}`,
                  background: baseColor,
                  color: '#e5e7eb',
                  fontSize: 11,
                  gap: 6,
                }}
              >
                <span
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 999,
                    background: '#020617',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 10,
                  }}
                >
                  {idx + 1}
                </span>
                <span>{stepLabels[s]}</span>
              </div>
            )
          })}
        </div>
        <p style={{ fontSize: 13, opacity: 0.85, marginBottom: 8, lineHeight: 1.5 }}>{stepCaption[step]}</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={handleAdvance}
            disabled={step === 'executed'}
            style={{
              padding: '6px 12px',
              borderRadius: 999,
              border: '1px solid #22c55e',
              background: step === 'executed' ? '#0f172a' : '#22c55e',
              color: step === 'executed' ? '#9ca3af' : '#020617',
              fontSize: 13,
              cursor: step === 'executed' ? 'default' : 'pointer',
            }}
          >
            {step === 'executed' ? 'Scenario complete' : 'Next step'}
          </button>
          {step !== 'idle' && (
            <button
              type="button"
              onClick={handleReset}
              style={{
                padding: '6px 12px',
                borderRadius: 999,
                border: '1px solid #4b5563',
                background: '#020617',
                color: '#e5e7eb',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {/* CLMM snapshot */}
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
          <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.08, opacity: 0.7, marginBottom: 4 }}>
            Pool
          </div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{clmmOpportunity.poolLabel}</div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 4 }}>
            <span>TVL: ${clmmOpportunity.tvlUsd.toLocaleString()}</span>
            <span>Fee APR: {clmmOpportunity.feeApr}%</span>
          </div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 4 }}>
            <span>Risk: {clmmOpportunity.riskLevel}</span>
            <span>Opportunity score: {clmmOpportunity.opportunityScore}/100</span>
            <span>Trust score: {clmmOpportunity.trustScore}/100</span>
          </div>
          <p style={{ opacity: 0.8, marginTop: 4, fontSize: 12, lineHeight: 1.4 }}>
            These metrics come from public on-chain data (Uniswap V3 subgraph). Your private HTTP alpha feeds influence the <em>scores</em> and <em>risk assessment</em>, but not the raw pool data itself.
          </p>
        </div>

        <div
          style={{
            padding: 12,
            borderRadius: 10,
            background: '#020617',
            border: '1px solid #1f2937',
          }}
        >
          <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.08, opacity: 0.7, marginBottom: 4 }}>
            CLMM position
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ opacity: 0.85 }}>Before rebalance</span>
            <span style={{ fontWeight: 500 }}>${before.tvlUsd.toLocaleString()}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ opacity: 0.85 }}>Exposure</span>
            <span style={{ fontWeight: 500 }}>{(before.exposure * 100).toFixed(0)}%</span>
          </div>

          <div
            style={{
              height: 4,
              borderRadius: 999,
              background: '#111827',
              overflow: 'hidden',
              marginBottom: 10,
            }}
          >
            <div
              style={{
                width: `${Math.min(before.exposure * 100, 100)}%`,
                height: '100%',
                background: '#4b5563',
              }}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ opacity: showAfter ? 0.85 : 0.45 }}>
              After rebalance {showAfter ? '' : '(revealed after execution)'}
            </span>
            <span style={{ fontWeight: 500, opacity: showAfter ? 1 : 0.5 }}>
              {showAfter ? `$${after.tvlUsd.toLocaleString()}` : '—'}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ opacity: showAfter ? 0.85 : 0.45 }}>Exposure</span>
            <span style={{ fontWeight: 500, opacity: showAfter ? 1 : 0.5 }}>
              {showAfter ? `${(after.exposure * 100).toFixed(0)}%` : '—'}
            </span>
          </div>

          <div
            style={{
              height: 4,
              borderRadius: 999,
              background: '#111827',
              overflow: 'hidden',
              marginBottom: 8,
            }}
          >
            <div
              style={{
                width: `${Math.min(after.exposure * 100, 100)}%`,
                height: '100%',
                background: showAfter ? '#22c55e' : '#1f2937',
                transition: 'background-color 150ms ease-out',
              }}
            />
          </div>

          <p style={{ fontSize: 12, opacity: 0.8, lineHeight: 1.4 }}>
            The "after" position only appears <strong>after</strong> reasoning is committed to MemoryVault. This enforces the memory-before-action guarantee—no execution without a verifiable audit trail.
          </p>
        </div>
      </div>
    </div>
  )
}

