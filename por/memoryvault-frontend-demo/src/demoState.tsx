import React, { createContext, useContext, useMemo, useState } from 'react'
import type { AlphaSourceView, MemoryEntryView, ReasoningView } from './types/protocolViewModels'
import { alphaSources as initialAlphaSources, memoryEntries as initialMemoryEntries, reasoning as baseReasoning } from './fixtures/clmmOpportunity'

interface DemoState {
  alphaSources: AlphaSourceView[]
  memoryEntries: MemoryEntryView[]
  reasoning: ReasoningView
  addAlphaSource: (input: {
    name: string
    url: string
    apiKeyLabel: string
    apiKey: string
    headerName: string
  }) => void
  removeAlphaSource: (id: string) => void
}

const DemoStateContext = createContext<DemoState | undefined>(undefined)

export const DemoStateProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [alphaSources, setAlphaSources] = useState<AlphaSourceView[]>(initialAlphaSources)

  const addAlphaSource = (input: {
    name: string
    url: string
    apiKeyLabel: string
    apiKey: string
    headerName: string
  }) => {
    setAlphaSources((prev) => {
      if (prev.length >= 2) return prev
      const next: AlphaSourceView = {
        id: `alpha-${Date.now()}`,
        name: input.name || `Custom Alpha ${prev.length + 1}`,
        url: input.url,
        apiKeyLabel: input.apiKeyLabel,
        apiKey: input.apiKey,
        headerName: input.headerName,
        sampleSignal: 'Custom HTTP alpha feed configured by the investor.',
      }
      return [...prev, next]
    })
  }

  const removeAlphaSource = (id: string) => {
    setAlphaSources((prev) => prev.filter((s) => s.id !== id))
  }

  const reasoning: ReasoningView = useMemo(
    () => ({
      ...baseReasoning,
      inputs: baseReasoning.inputs,
    }),
    [],
  )

  const memoryEntries: MemoryEntryView[] = useMemo(() => initialMemoryEntries, [])

  const value: DemoState = {
    alphaSources,
    memoryEntries,
    reasoning,
    addAlphaSource,
    removeAlphaSource,
  }

  return <DemoStateContext.Provider value={value}>{children}</DemoStateContext.Provider>
}

export const useDemoState = (): DemoState => {
  const ctx = useContext(DemoStateContext)
  if (!ctx) {
    throw new Error('useDemoState must be used within a DemoStateProvider')
  }
  return ctx
}
