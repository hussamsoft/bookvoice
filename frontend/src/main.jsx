import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
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
