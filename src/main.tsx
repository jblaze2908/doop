import React from 'react'
import ReactDOM from 'react-dom/client'
import './lib/posthog'
import { App } from './App'
import { initDesktopShell } from './lib/desktop'
import { TooltipProvider } from './components/ui/tooltip'
import './assets/fonts/fonts.css'
import './styles.css'

initDesktopShell()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </React.StrictMode>,
)
