import React from 'react'
import { DemoLayout } from './components/DemoLayout'
import { DemoStateProvider } from './demoState'

export const App: React.FC = () => {
  return (
    <DemoStateProvider>
      <DemoLayout />
    </DemoStateProvider>
  )
}

