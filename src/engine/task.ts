/**
 * 运行时任务与取消。
 *
 * 通用引擎最容易失控的地方是异步：等 500ms、加载素材、挂起小游戏 —— 这些
 * 都可能横跨"玩家重开 / 读档 / 切场景"。如果它们回来之后还往引擎里写，
 * 新会话就被旧任务污染了。
 *
 * 所以所有异步动作统一拿一个 `TaskContext`：里面有一个 AbortSignal、
 * 一个会话号、一个场景 id。**写入前先问 `isCurrent()`**。
 */

/** 任务被取消时抛出的错误。调用方应当直接吞掉它，不要当成故障上报。 */
export class TaskCancelled extends Error {
  readonly reason: string

  constructor(reason = 'cancelled') {
    super(`任务已取消：${reason}`)
    this.name = 'TaskCancelled'
    this.reason = reason
  }
}

export function isTaskCancelled(error: unknown): boolean {
  return error instanceof TaskCancelled
}

export interface TaskContext {
  readonly signal: AbortSignal
  /** 会话号。重开 / 读档会 +1，旧任务据此作废。 */
  readonly sessionId: number
  /** 发起时的场景 id。null 表示不绑定场景。 */
  readonly sceneId: string | null
}

/**
 * 会话作用域。
 *
 * 一个 `SessionScope` 对应"一局游戏"。`restart()` 会中止所有在飞的任务并
 * 换一个新的会话号 —— 这是重开与读档时**唯一**需要的清理动作。
 */
export class SessionScope {
  private controller = new AbortController()
  private id = 1
  private disposed = false

  get sessionId(): number {
    return this.id
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  get aborted(): boolean {
    return this.controller.signal.aborted
  }

  /** 开始新会话：作废所有在飞任务，并换一个新的取消信号。 */
  restart(): number {
    this.controller.abort(new TaskCancelled('会话已重启'))
    this.controller = new AbortController()
    this.id += 1
    return this.id
  }

  /** 中止当前所有任务，但不换会话号（例如切场景）。 */
  abort(reason = 'aborted'): void {
    this.controller.abort(new TaskCancelled(reason))
  }

  /** 销毁：中止一切，之后不再接受新任务。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.controller.abort(new TaskCancelled('引擎已销毁'))
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** 取一个任务上下文。已销毁时返回一个"立刻就是取消态"的上下文。 */
  task(sceneId: string | null = null): TaskContext {
    return { signal: this.controller.signal, sessionId: this.id, sceneId }
  }

  /**
   * 这个任务是否仍然有效。
   *
   * 所有"await 回来之后要改引擎状态"的地方都必须先过这一关 ——
   * 光看 signal.aborted 不够：会话重启后 signal 是新的，旧任务的 ctx 却还
   * 记着旧会话号。
   */
  isCurrent(ctx: TaskContext): boolean {
    return !this.disposed && ctx.sessionId === this.id && !ctx.signal.aborted
  }
}

/**
 * 可取消的等待。
 *
 * 取消时 reject 一个 TaskCancelled —— 调用方要么让它冒泡到任务边界，
 * 要么显式吞掉。**不要**在这里 resolve，否则"等 500ms"会在重开后
 * 立刻返回并继续执行后面的演出指令。
 */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new TaskCancelled('等待开始前就已取消'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new TaskCancelled('等待被取消'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class PausableClock {
  private paused = false
  private readonly listeners = new Set<(paused: boolean) => void>()
  setPaused(paused: boolean): void {
    if (paused === this.paused) return
    this.paused = paused
    for (const listener of this.listeners) listener(paused)
  }
  delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(new TaskCancelled()); return }
      let remaining = Math.max(0, ms)
      let timer: ReturnType<typeof setTimeout> | null = null
      let began = 0
      const cleanup = (): void => {
        if (timer !== null) clearTimeout(timer)
        this.listeners.delete(onPause)
        signal.removeEventListener('abort', onAbort)
      }
      const finish = (): void => { cleanup(); resolve() }
      const schedule = (): void => { began = performance.now(); timer = setTimeout(finish, remaining) }
      const onAbort = (): void => { cleanup(); reject(new TaskCancelled('等待被取消')) }
      const onPause = (paused: boolean): void => {
        if (paused) {
          if (timer !== null) { clearTimeout(timer); timer = null; remaining = Math.max(0, remaining - (performance.now() - began)) }
        } else schedule()
      }
      this.listeners.add(onPause)
      signal.addEventListener('abort', onAbort, { once: true })
      if (!this.paused) schedule()
    })
  }
}

/** 跑一个可取消的异步步骤，把取消统一转成 null 而不是异常。 */
export async function runCancellable<T>(
  ctx: TaskContext,
  step: () => Promise<T>,
): Promise<T | null> {
  if (ctx.signal.aborted) return null
  try {
    return await step()
  } catch (error) {
    if (isTaskCancelled(error)) return null
    throw error
  }
}
