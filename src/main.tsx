import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
/*
 * 两份样式，职责不同：
 *
 *   styles.css          引擎结构 —— 安全区、对话占位、场景裁剪。跟主题无关。
 *   themes/neutral.css  中性默认主题 —— 没有主题包时的外观兜底。
 *
 * 中性主题必须**静态引入**：它是兜底，第一帧就得在，否则会闪一下无样式的
 * 页面。内容声明的其他主题（如 soft-watercolor）由 applyTheme 惰性加载，
 * 没用到的不会进首屏。
 */
import './styles.css'
import '../themes/neutral.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
