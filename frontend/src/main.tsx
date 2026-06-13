import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { FreehandDemo } from './freehand/FreehandDemo'
import './index.css'

// research 演示路由：?freehand 进自由画笔绘制过程演示（不影响主应用）
const isFreehandDemo = typeof location !== 'undefined' && /[?&]freehand\b/.test(location.search)

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isFreehandDemo ? <FreehandDemo /> : <App />}</StrictMode>,
)
