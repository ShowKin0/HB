/**
 * 小游戏容器。
 *
 * 引擎只负责三件事：**挂载、生命周期、结果回收**，外加一套统一的失败/跳过策略。
 * 内部怎么玩完全由你决定 —— 引擎不认识任何具体玩法。
 *
 * 加一个新小游戏：实现这个接口 + `registerMiniGame()` 一行，
 * 然后在剧本里写 `# minigame: 你的id(参数)`。
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
  /** 失败几次后允许跳过。生日礼物不能卡关，这是硬约束。 */
  readonly skipAfter: number
}

export interface MiniGameHandle {
  destroy(): void
}

export interface MiniGame<P = unknown, R = unknown> {
  readonly id: string
  /** 展示名，会显示在小游戏面板顶部。 */
  readonly title: string
  /** 一句话玩法说明，显示在标题下方。 */
  readonly hint?: string
  mount(container: HTMLElement, params: P, api: MiniGameApi<R>): MiniGameHandle
}

/** 所有小游戏的统一结果形状，方便写回 ink。 */
export interface MiniGameResult {
  success: boolean
  skipped: boolean
  failures: number
}
