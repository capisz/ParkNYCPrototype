import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <App />,
)

const DEVELOPMENT_SW_RESET_KEY = 'nyc-parking-development-sw-reset'

async function clearDevelopmentServiceWorker(): Promise<void> {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations()
    const wasControlled = Boolean(navigator.serviceWorker.controller)
    await Promise.all(registrations.map(registration => registration.unregister()))

    if ('caches' in window) {
      const cacheNames = await window.caches.keys()
      await Promise.all(cacheNames
        .filter(name => name.startsWith('nyc-parking-shell-'))
        .map(name => window.caches.delete(name)))
    }

    if (wasControlled && !window.sessionStorage.getItem(DEVELOPMENT_SW_RESET_KEY)) {
      window.sessionStorage.setItem(DEVELOPMENT_SW_RESET_KEY, 'true')
      window.location.reload()
      return
    }
    window.sessionStorage.removeItem(DEVELOPMENT_SW_RESET_KEY)
  } catch {
    // Service-worker cleanup must never prevent the development app from loading.
  }
}

if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      void navigator.serviceWorker.register('/sw.js')
    })
  } else {
    void clearDevelopmentServiceWorker()
  }
}
