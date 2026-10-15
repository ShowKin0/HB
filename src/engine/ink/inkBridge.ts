import { Story } from 'inkjs'
import { parseDirective, type RawDirective } from '../../schema/directive.rules.ts'

/**
 * ink 运行时桥接。
 *
 * 这一层只做一件事：把 inkjs 的接口收窄成一个引擎能用的形状。
 * 游戏逻辑（分支、条件、开关、物品、谜题判定）全部留在 .ink 里 ——
 * 这是"改剧情不用改代码"的前提。
 */

export interface StoryLine {
  text: string
  /** 原始 tag 文本，如 ['vo: line_042', 'bg: room_night']。 */
  tags: string[]
  /** 解析后的演出指令。 */
  directives: RawDirective[]
}

export interface ChoiceView {
  index: number
  text: string
  tags: string[]
}

/** ink 的返回值可能是布尔、数字、字符串或包装对象，统一转成布尔。 */
function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value.length > 0 && value !== '0' && value !== 'false'
  if (value && typeof value === 'object') {
    const boxed = value as { valueOf?: () => unknown; isTruthy?: boolean }
    if (typeof boxed.isTruthy === 'boolean') return boxed.isTruthy
    if (typeof boxed.valueOf === 'function') return toBoolean(boxed.valueOf())
  }
  return false
}

export class InkBridge {
  private story: Story | null = null
  private storyJson = ''
  private readonly conditionCache = new Map<string, boolean>()
  private readonly externalConditions = new Set<string>()
  private evaluatingCondition: string | null = null
  /**
   * 已经报过错的条件函数名。和 conditionCache 分开存，**不随剧情推进清空** ——
   * 否则一个写错的条件会在每次推进时重复报错。
   */
  private readonly failedConditions = new Set<string>()
  private reportedMissing = new Set<string>()

  /** 运行时错误回调。引擎把它接到 UI 的错误浮层上，而不是让页面崩掉。 */
  onError: ((message: string) => void) | null = null

  get ready(): boolean {
    return this.story !== null
  }

  get hasContent(): boolean {
    return this.story?.canContinue ?? false
  }

  get choices(): ChoiceView[] {
    const story = this.story
    if (!story || story.canContinue) return []
    /*
     * 参数显式标注类型。
     *
     * `inkjs` 的 `Story.d.ts` 里 `currentChoices: Choice[]` 的那个 `Choice`
     * 在本项目的编译配置下没能解析成形，整个数组退化成 `any[]`，于是这里
     * 撞上 `noImplicitAny`。它**一直存在**，只是被 `tsc -b` 的增量编译掩盖着
     * ——`inkBridge.ts` 没改过就永远不会重查，换 `--force` 才暴露出来。
     */
    return story.currentChoices.map(
      (choice: { index: number; text: string; tags?: string[] | null }) => ({
        index: choice.index,
        text: choice.text,
        tags: [...(choice.tags ?? [])],
      }),
    )
  }

  /** 已加载的剧本源码 JSON，用于重置。 */
  get source(): string {
    return this.storyJson
  }

  load(storyJson: string): void {
    this.storyJson = storyJson
    const story = new Story(storyJson)
    story.onError = (message: string) => {
      this.reportError(message)
    }
    /*
     * 让剧本能读到引擎侧的标记。
     *
     * `# flag:` / `# unlock:` 会把标记写进 `engine.flags` 并随存档持久化，
     * 但此前**剧本完全看不见它们** —— 内容写了标记却无法据此分支，
     * 等于只能写、不能读。
     *
     * 用法（在 .ink 里声明之后就能当条件用）：
     *
     *     EXTERNAL hb_flag(key)
     *     === function met_mom() ===
     *     ~ return hb_flag("met_mom")
     *
     * 绑定本身是安全的：ink 没声明 EXTERNAL 时这个函数永远不会被调用。
     * 反过来，声明了 EXTERNAL 却没绑定，inkjs 会在运行时直接报错 ——
     * 所以这里**无条件**绑上，不能按需绑。
     */
    /*
     * 无条件绑上，不能按需绑 —— 理由见上面那段注释。
     */
    story.BindExternalFunction('hb_flag', (key: unknown) => {
      if (this.evaluatingCondition) this.externalConditions.add(this.evaluatingCondition)
      return this.readFlag?.(String(key)) ?? false
    })
    this.story = story
    this.conditionCache.clear()
    this.externalConditions.clear()
    this.failedConditions.clear()
    this.reportedMissing.clear()
  }

  /**
   * 读取引擎侧标记的回调，由 Game 注入。
   *
   * 用回调而不是把 flags 传进来：标记是**可变**的，每次 `# flag:` 都会改，
   * 桥不该持有一份会过期的快照。
   */
  readFlag: ((key: string) => boolean) | null = null

  reset(): void {
    if (this.storyJson) this.load(this.storyJson)
  }

  private reportError(message: string): void {
    if (this.reportedMissing.has(message)) return
    this.reportedMissing.add(message)
    this.onError?.(message)
  }

  /** 已知的 knot / function 名字集合，用于热点引用校验与调试。 */
  hasKnot(name: string): boolean {
    const story = this.story
    if (!story) return false
    try {
      return story.HasFunction(name)
    } catch {
      return false
    }
  }

  /**
   * 推进一行。
   *
   * 返回 null 表示故事已让出控制权 —— 要么在等玩家选选项，要么已结束。
   * 注意：只有文本与 tag 的**空文本行**是合法的，它承载独立的演出指令。
   */
  next(): StoryLine | null {
    const story = this.story
    if (!story || !story.canContinue) return null

    let text: string
    let rawTags: string[]
    try {
      text = story.Continue() ?? ''
      rawTags = [...(story.currentTags ?? [])]
    } catch (error) {
      this.reportError((error as Error).message)
      return null
    }

    // 推进之后条件值可能变化，缓存作废
    this.conditionCache.clear()

    const directives: RawDirective[] = []
    for (const tag of rawTags) {
      const parsed = parseDirective(tag)
      if (parsed) directives.push(parsed)
    }
    return { text: text.trim(), tags: rawTags, directives }
  }

  choose(index: number): boolean {
    const story = this.story
    if (!story) return false
    if (index < 0 || index >= story.currentChoices.length) return false
    try {
      story.ChooseChoiceIndex(index)
      this.conditionCache.clear()
      return true
    } catch (error) {
      this.reportError((error as Error).message)
      return false
    }
  }

  /**
   * 跳到某个 knot。
   *
   * resetCallstack 为 true：画布热点可以在任何时刻打断当前流程
   * （包括玩家正面对选项列表时），不会把调用栈搞脏。
   */
  jumpTo(knot: string, resetCallstack = true): boolean {
    const story = this.story
    if (!story) return false
    if (!this.hasKnot(knot)) {
      this.reportError(`ink 里不存在名为 "${knot}" 的 knot`)
      return false
    }
    try {
      story.ChoosePathString(knot, resetCallstack)
      this.conditionCache.clear()
      return true
    } catch (error) {
      this.reportError((error as Error).message)
      return false
    }
  }

  /**
   * 求值一个 ink 函数，用作热点/出口的显示条件。
   *
   * 结果按调用参数缓存，避免每帧对每个热点都跑一遍 ink 虚拟机；
   * 任何推进动作都会让缓存失效。
   */
  evaluate(name: string, args: (string | number | boolean)[] = []): boolean {
    const story = this.story
    if (!story) return false

    const key = JSON.stringify([name, args])
    const cached = this.conditionCache.get(key)
    if (cached !== undefined && !this.externalConditions.has(key)) return cached

    let result = false
    this.evaluatingCondition = key
    try {
      result = toBoolean(story.EvaluateFunction(name, args))
    } catch (error) {
      // 报一次就够：函数名写错了，重试多少次结果都一样。
      // 失败集合刻意**不跟着条件缓存一起清** —— 否则每次剧情推进都会把
      // 同一个错误重新报一遍，而 visibleWhen 现在是每帧求值的，
      // 会直接把提示刷爆。
      if (!this.failedConditions.has(key)) {
        this.failedConditions.add(key)
        this.reportError((error as Error).message)
      }
      result = false
    } finally {
      this.evaluatingCondition = null
    }
    this.conditionCache.set(key, result)
    return result
  }

  /** 读取 ink 全局变量的当前值。 */
  variable(name: string): unknown {
    const story = this.story
    if (!story) return undefined
    try {
      return story.variablesState.$(name)
    } catch {
      return undefined
    }
  }

  /**
   * 写 ink 全局变量。
   *
   * 小游戏结果、外部系统状态都从这里回灌进剧本，让 ink 继续做逻辑判断 ——
   * 逻辑真相源始终只有 ink 一个。
   */
  setVariable(name: string, value: string | number | boolean): boolean {
    const story = this.story
    if (!story) return false
    try {
      const state = story.variablesState as unknown as {
        $(variableName: string, value: string | number | boolean): void
      }
      state.$(name, value)
      this.conditionCache.clear()
      return true
    } catch (error) {
      this.reportError(`无法写入 ink 变量 "${name}"：${(error as Error).message}`)
      return false
    }
  }

  saveState(): string {
    return this.story ? this.story.state.ToJson() : ''
  }

  loadState(json: string): boolean {
    const story = this.story
    if (!story || !json) return false
    try {
      story.state.LoadJson(json)
      this.conditionCache.clear()
      return true
    } catch (error) {
      this.reportError(`存档中的剧情状态无法载入：${(error as Error).message}`)
      return false
    }
  }
}
