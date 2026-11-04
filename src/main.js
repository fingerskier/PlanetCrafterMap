// Entry point (Vite). The pure logic lives in src/lib/, the DOM/Leaflet wiring in src/ui/.

import 'leaflet/dist/leaflet.css'
import './styles.css'
import { startApp } from './ui/app.js'

startApp({ baseUrl: import.meta.env.BASE_URL }).catch((e) => {
  console.error(e)
  document.documentElement.dataset.error = '1'
})

// Set by the vite-plugin-pwa registration script (injectRegister: 'script'); used by the offline e2e test.
navigator.serviceWorker?.ready.then(() => {
  document.documentElement.dataset.sw = 'ready'
})
