/**
 * 全局错误上报。
 *
 * 错误边界只能接住**渲染期**的异常。异步里的失败（`void drainStory()`
 * 之后的 promise、事件回调、定时器）不走那条路：它们变成
 * `unhandledrejection` / `error`，只写进控制台 —— 手机上没人看控制台，
 * 表现就是"点了没反应"，而且一点线索都没有。
 *
 * 这里把它们接到轻提示上，让问题**在屏幕上可见**。
 */

import { useUi } from '../state/store.ts'

/** 同一条错误反复刷屏时只报一次。 */
const reported = new Set<string>()

/** 最多记这么多条，避免长时间运行把内存涨起来。 */
const MAX_TRACKED = 64

/**
 * 把任意抛出物变成一句能读的话。
 *
 * ⚠️ 这里必须**保证返回字符串**。JSON.stringify(undefined) 返回的是
 * undefined 而不是字符串 —— 一眼看过去像没问题（函数签名写着 string），
 * 但调用方紧接着 .slice() 就会抛 TypeError，**错误上报器自己成了错误源**。
 * 这条是被"上报本身出错也不会把游戏搞挂"的用例抓出来的。
 */
function describe(reason: unknown): string {
  if (reason instanceof Error) return reason.message || reason.name
  if (typeof reason === 'string') return reason
  try {
    const text = JSON.stringify(reason)
    return typeof text === 'string' ? text : String(reason)
  } catch {
    return String(reason)
  }
}

export function reportError(reason: unknown, source: string): void {
  const detail = describe(reason).slice(0, 200)
  const key = `${source}:${detail}`
  if (reported.has(key)) return
  if (reported.size >= MAX_TRACKED) reported.clear()
  reported.add(key)

  // 控制台保留完整信息，屏幕上只给一句能读的
  console.error(`[${source}]`, reason)
  try {
    useUi.getState().toast(`${source}：${detail}`, 'error')
  } catch {
    // store 还没初始化时忽略 —— 上报本身绝不能把启动搞挂
  }
}

/** 只装一次。重复调用是安全的。 */
let installed = false

export function installGlobalErrorReporting(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  window.addEventListener('unhandledrejection', (event) => {
    reportError(event.reason, '未处理的异步错误')
  })

  window.addEventListener('error', (event) => {
    // 资源加载失败也会走到这里（img/script），那些已经有各自的降级路径
    if (!event.error) return
    reportError(event.error, '运行时错误')
  })
}

/** 仅供测试：清掉去重记录。 */
export function resetReportedErrors(): void {
  reported.clear()
}
