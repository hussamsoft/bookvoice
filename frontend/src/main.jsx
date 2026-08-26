import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
/* Fonts — per-subset entrypoints keep the bundle lean; variable packages
 * ship one axis file covering all subsets (unicode-range splits at runtime). */
import '@fontsource-variable/fraunces/wght.css'
import '@fontsource-variable/literata/wght.css'
import '@fontsource/ibm-plex-sans/latin-400.css'
import '@fontsource/ibm-plex-sans/latin-500.css'
import '@fontsource/ibm-plex-sans/latin-600.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/noto-naskh-arabic/arabic-400.css'
import '@fontsource/noto-naskh-arabic/arabic-700.css'
import './styles/tokens.css'
import './styles/base.css'
import './styles/shell.css'
import './styles/controls.css'
import './styles/reader.css'
import './styles/studio.css'
import App from './App.jsx'
import AccessGate from './components/AccessGate.jsx'
import { ToastProvider } from './components/Toast.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ToastProvider>
      <ErrorBoundary>
        <AccessGate>
          <App />
        </AccessGate>
      </ErrorBoundary>
    </ToastProvider>
  </StrictMode>,
)
