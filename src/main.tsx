import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import '@capra/theme/base.css'
import '@capra/core/styles.css'
import '@capra/icons/styles.css'
import App from './App'
import { installThemeBridge } from './host-theme'
import { themeStore } from './host-theme'
import './App.css'

installThemeBridge(themeStore.set)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={window.CRIBL_BASE_PATH}>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
