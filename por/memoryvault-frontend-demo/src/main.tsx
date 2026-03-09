import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
// Initialize configuration (real data adapter setup)
import './config'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

