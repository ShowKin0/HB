import { Component, type ErrorInfo, type ReactNode } from 'react'
import styles from './ui.module.css'

/**
 * 兜底错误边界。
 *
 * 在这之前项目里**一个错误边界都没有**。React 19 遇到渲染期抛错会卸载整棵
 * 组件树 —— 表现是**整个页面变白**，玩家丢掉整局，而且屏幕上没有任何解释。
 * 对一个要送给人的礼物应用来说，"白屏且不说为什么"是最糟的失败方式。
 *
 * 这里做三件事：
 *   1. 不让白屏：给一个能读的说明和"重新开始"按钮
 *   2. 把错误写到控制台，便于你自己复现
 *   3. 提供"清掉存档重来"的出口 —— 大半渲染崩溃是坏存档引起的，
 *      没有这个出口玩家就只能自己清浏览器数据
 */
interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 留一份完整堆栈：只显示在屏幕上不足以定位问题
    console.error('[crash] 渲染时出错：', error, info.componentStack)
  }

  private reset = (): void => {
    this.setState({ error: null })
  }

  private resetAndClearSave = (): void => {
    try {
      // 坏存档是渲染崩溃最常见的原因，给它一个出口
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('hb.')) localStorage.removeItem(key)
      }
    } catch {
      // 隐私模式下访问 localStorage 会抛，忽略即可
    }
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className={styles.crash} data-crash>
        <div className={styles.crashCard}>
          <p className={styles.crashTitle}>出了点问题</p>
          <p className={styles.crashHint}>
            游戏遇到一个错误停下来了。先试着继续；如果一直不行，就清掉存档从头开始 ——
            进度会丢失，但至少能玩下去。
          </p>
          <pre className={styles.crashDetail}>{error.message}</pre>
          <div className={styles.crashActions}>
            <button type="button" className={styles.primaryButton} onClick={this.reset}>
              继续
            </button>
            <button type="button" className={styles.ghostButton} onClick={this.resetAndClearSave}>
              清掉存档重来
            </button>
          </div>
        </div>
      </div>
    )
  }
}
