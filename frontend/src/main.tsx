import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if ('serviceWorker' in navigator) {
  // The first registration claims an uncontrolled page and fires controllerchange
  // too; reloading there costs every first visit a round trip for nothing.
  const hadController = Boolean(navigator.serviceWorker.controller)
  let reloadingForUpdate = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloadingForUpdate) return
    reloadingForUpdate = true
    window.location.reload()
  })
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => undefined))
}
