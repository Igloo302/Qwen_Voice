import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import MemoryCenter from './memory/MemoryCenter.jsx'
import DevLabCenter from './devlab/DevLabCenter.jsx'
import { setRuntimeLanguage, t } from './i18n.js'
import './styles.css'

const parameters = new URLSearchParams(window.location.search)
const memoryView = parameters.get('view') === 'memory'
const devLabView = ['debug', 'lab'].includes(parameters.get('view'))
if (memoryView || devLabView) {
  document.documentElement.dataset.view = memoryView ? 'memory' : 'debug'
  setRuntimeLanguage(parameters.get('lang') || navigator.language)
  document.title = t(memoryView ? '我的记忆' : '🧪 创意实验室 (DevLab)')
}

if (parameters.get('desktop') === 'orb') {
  document.documentElement.dataset.desktop = 'orb'
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {devLabView
      ? <DevLabCenter />
      : memoryView ? <MemoryCenter /> : <App />}
  </StrictMode>,
)
