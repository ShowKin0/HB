/**
 * 小游戏容器。
 *
 * 引擎只负责：**挂载、生命周期、结果回收**，外加一套可配置的失败/跳过策略。
 * 内部怎么玩完全由你决定 —— 引擎不认识任何具体玩法。
 *
 * 加一个新小游戏：实现这个接口 + `registerMiniGame()` 一行，
 * 然后在剧本里写 `# minigame: 你的id(参数)`。
 *
 * ⚠️ 参数**不能由引擎统一解释**。
 * 早期版本在这里写死了 `length` / `speed` 两个位置参数 —— 那等于把某个
 * 具体玩法的约定焊进了通用容器。现在每个玩法声明自己的参数 Schema，
 * 引擎只负责把指令里的原文交给它。
 */

export interface MiniGameApi<R = unknown> {
  /** 完成，结果会被写回 ink。 */
  resolve(result: R): void
  /** 报告一次失败。达到 skipAfter 次后引擎会给出"跳过"入口。 */
  reportFailure(): void
  /** 玩家主动跳过。 */
  requestSkip(): void
  /** 当前已失败次数。 */
  readonly failures: number
  /**
   * 失败几次后允许跳过。null 表示这次不允许跳过。
   * 由引擎按"项目默认 → 玩法默认 → 调用覆盖"的顺序定下来，玩法只管读。
   */
  readonly skipAfter: number | null
}

export interface MiniGameHandle {
  destroy(): void
  /** 暂停。切后台、打开面板时调用；不实现表示该玩法不需要暂停。 */
  pause?(): void
  /** 恢复。 */
  resume?(): void
  /**
   * 快照当前进度。
   *
   * 快照用于同一挂载实例的暂停/恢复，snapshot 与 restore 必须成对实现。
   * 不实现时依赖 pause/resume 保留内存状态；页面重新加载后从调用前稳定检查点重播。
   * 引擎不会猜测进度，也不会自动重开未实现快照的玩法。
   */
  snapshot?(): unknown
  /** 从快照恢复。必须与 snapshot 成对实现。 */
  restore?(state: unknown): void
}

/**
 * 参数解析。
 *
 * `args` 是指令括号里的原始参数（已按逗号切开、去空白）。
 * 返回 null 表示参数不合法，引擎会报错并跳过这个小游戏。
 */
export interface MiniGameParams<P> {
  parse(args: string[]): P | null
}

/** 结果校验。用于把玩法的返回值收窄成引擎能写回 ink 的形状。 */
export interface MiniGameResultSpec<R> {
  /** 结果是否算"成功"。引擎据此写 minigame_success。 */
  isSuccess(result: R): boolean
}

/** 跳过策略。项目级默认可以被玩法或单次调用覆盖。 */
export interface MiniGameSkipPolicy {
  /** 失败几次后允许跳过。null 表示不允许。 */
  skipAfter: number | null
}

export interface MiniGame<P = unknown, R = unknown> {
  readonly id: string
  /** 展示名，会显示在小游戏面板顶部。 */
  readonly title: string
  /** 一句话玩法说明，显示在标题下方。 */
  readonly hint?: string
  /** 该玩法的参数 Schema。不声明时把位置参数原样作为 `args` 传下去。 */
  readonly params?: MiniGameParams<P>
  /** 该玩法的结果约定。不声明时按 `{ success }` 字段判断。 */
  readonly result?: MiniGameResultSpec<R>
  /** 该玩法的默认跳过策略。不声明时用项目默认。 */
  readonly skip?: MiniGameSkipPolicy
  mount(container: HTMLElement, params: P, api: MiniGameApi<R>): MiniGameHandle
}

/** 所有小游戏的统一结果形状，方便写回 ink。 */
export interface MiniGameResult {
  success: boolean
  skipped: boolean
  failures: number
}

// ── 参数解析小工具，玩法共用 ───────────────────────────────

/**
 * 位置参数 + `key=value` 命名参数。
 *
 * 支持 `tapSequence(3)` 和 `tapSequence(length=3, speed=1.2)` 两种写法 ——
 * 参数名由玩法自己定义，引擎不预设。
 */
export interface ParsedArgs {
  positional: string[]
  named: Record<string, string>
}

export function parseMiniGameArgs(args: string[]): ParsedArgs {
  const positional: string[] = []
  const named: Record<string, string> = {}
  for (const arg of args) {
    const eq = arg.indexOf('=')
    if (eq > 0) {
      named[arg.slice(0, eq).trim()] = arg.slice(eq + 1).trim()
    } else if (arg.length > 0) {
      positional.push(arg)
    }
  }
  return { positional, named }
}

/**
 * 取一个数字参数：优先命名参数，其次按顺序消费一个位置参数。
 * 越界会夹紧而不是报错 —— 内容写 `length=999` 时应当退化成上限，而不是崩掉。
 */
export function numberParam(
  parsed: ParsedArgs,
  name: string,
  fallback: number,
  range: { min: number; max: number },
): number {
  const raw = parsed.named[name] ?? parsed.positional.shift() ?? ''
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(range.max, Math.max(range.min, value))
}
