import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import MemoryGraph from './MemoryGraph.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
    <MemoryGraph/>,
  </StrictMode>,
)
