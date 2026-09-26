import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { registerServiceWorker } from './lib/notify'
import './styles/theme.css'

// Keep theme, drafts, and open sessions when the app name changed.
const legacyKeys: string[] = []
for (let i = 0; i < localStorage.length; i++) {
  const key = localStorage.key(i)
  if (key?.startsWith('pi-web')) legacyKeys.push(key)
}
for (const key of legacyKeys) {
  const next = `devden${key.slice('pi-web'.length)}`
  if (localStorage.getItem(next) == null) {
    const value = localStorage.getItem(key)
    if (value != null) localStorage.setItem(next, value)
  }
}

registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
