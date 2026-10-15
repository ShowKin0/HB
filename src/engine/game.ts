import { prepareActorRenderer } from '../actorRenderers/registry.ts'
import type { Save, EngineState, FlagValue } from '../schema/save.ts'
import { sceneObjectKey } from '../schema/save.ts'
import type { Exit, Hotspot } from '../schema/scene.ts'
import type { GameContent } from '../content/load.ts'
import { AssetStore } from './assets.ts'
import { AudioBus, DEFAULT_AUDIO_SETTINGS, type AudioSettings } from './audio.ts'
import { registerBuiltinDirectives } from './directives/builtin.ts'
import { applyDirectives, type DirectiveContext } from './directives/registry.ts'
import { getMiniGame } from '../minigames/registry.ts'
import type { MiniGameHandle } from '../minigames/types.ts'
import { InkBridge, type ChoiceView } from './ink/inkBridge.ts'
import { createEmptyEngineState, SaveManager } from './save.ts'
import { sanitizeCapabilityState } from '../schema/save.ts'
import { SceneRuntime } from './scene/runtime.ts'
import {
  acceptsDrop,
  eventNameFor,
  resolveClick,
  resolveDrop,
  type InteractionContext,
  type InteractionIntent,
} from './interaction/resolver.ts'
import { EventBridge, type InteractionEvent } from './interaction/events.ts'
import type { GestureEvent, InputOwner } from './input/router.ts'
import { SessionScope, PausableClock, TaskCancelled, isTaskCancelled } from './task.ts'
import { capabilityWarning, type CapabilityId, type Project } from '../content/project.rules.ts'
import type { DialogueLayoutOverride } from '../schema/layout.rules.ts'
import type { Pt } from './math.ts'
import { stopActor, type Actor } from './actor/actor.ts'
import { CanvasStage } from '../render/stage.ts'
import { createFxState, triggerFx, updateFx, type FxState } from '../render/fx.ts'
import { DEFAULT_DEBUG, renderScene, type DebugFlags } from '../render/sceneRenderer.ts'

/**
 * 暂停原因。
 *
 * 用**集合**而不是布尔量：关掉设置面板时如果游戏还在后台，不该恢复。
 * 只有所有原因都解除，游戏才真的继续。
 */
export type PauseReason = 'hidden' | 'panel' | 'orientation' | 'minigame'

export interface DialogueLine {
  text: string
  speaker: string | null
  portrait: string | null
}

/**
 * 标记的真假。
 *
 * `# unlock:` 写的是 `true`，`# flag:` 写的是作者给的值（可能是数字或字符串），
 * 而剧本那边只能收布尔。这里把三种类型收敛成一条**明确**的规则，
 * 而不是靠 JS 的隐式转换 —— `# flag: seen 0` 该是假，`"false"` 也该是假。
 */
function truthyFlag(value: FlagValue | undefined): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value !== '' && value !== 'false' && value !== '0'
  return false
}

export interface DebugInfo {
  fps: number
  sceneId: string | null
  actorU: number
  actorV: number
  phase: number
  walkBlend: number
  speed: number
  facing: number
  missingAssets: string[]
  /** 图片缓存的占用与淘汰统计。 */
  imageCache: { entries: number; bytes: number; budgetBytes: number; evictions: number }
  warnings: string[]
  /** 调试浮层与编辑器的退出/进入回调，由 UI 提供。 */
  editorOnly: boolean
  /** 当前场景模式：walk 可走动，focus 固定镜头。 */
  sceneMode: 'walk' | 'focus' | null
  /** 最近一次交互事件，形如 "photo_frame_inspect @ photo_frame"。 */
  lastEvent: string | null
  /** 物件 id → 当前视觉状态名（不可见显示 hidden）。 */
  objectStates: Record<string, string>
  /**
   * `# flag:` / `# unlock:` 写下的标记，以及 `getFlag` 读到的值。
   *
   * 这些标记一直会被写进 `engine.flags` 并随存档持久化，但**没有任何地方
   * 能把它们显示出来** —— 作者写了 `# flag: met_mom`，游戏里看不到任何变化，
   * 也无从判断到底有没有生效。放进调试信息至少让它可观察。
   */
  flags: Record<string, FlagValue>
}

export interface GameHooks {
  onLine(line: DialogueLine | null): void
  onChoices(choices: ChoiceView[]): void
  onScene(sceneId: string, title: string, aspect: number): void
  onInventory(items: string[], selected: string | null): void
  onError(message: string): void
  onDebug(info: DebugInfo): void
}

export interface GameOptions {
  canvas: HTMLCanvasElement
  content: GameContent
  hooks: GameHooks
  saves?: SaveManager
  audio?: AudioBus
  /**
   * 初始音量设置。
   *
   * 由调用方在**构造时**传进来，而不是构造完再纠正：这套设置是持久化的，
   * "先起默认值、等 UI 挂载后再同步"会让重开游戏的头几秒用错音量，
   * 而且同步时机依赖 React 的 effect 调度 —— 那条路已经翻过一次车
   * （设置面板不打开就永远不同步）。
   */
  audioSettings?: AudioSettings
  debug?: DebugFlags
  /** 编辑器模式：不推进剧情，只负责场景与角色。 */
  editorOnly?: boolean
}

/** 音频路径约定：含斜杠视为完整相对路径，否则按类别补目录与后缀。 */
function resolveAudio(kind: 'bgm' | 'sfx' | 'vo', value: string): string {
  if (value.includes('/')) return value
  const ext = kind === 'vo' ? 'm4a' : 'ogg'
  return `audio/${kind}/${value}.${ext}`
}

/**
 * 游戏编排。
 *
 * 职责边界很清楚：引擎提供能力，ink 提供逻辑，这里只做搬运 ——
 * 把 ink 吐出的文本与 tag 变成 UI 状态与演出，把玩家的点击变成 ink 跳转。
 *
 * 每帧变化的量（角色位置、相位）**不放进 React**，只以低频的调试信息
 * 推给 UI，避免每帧触发整棵组件树重渲染。
 */
export class Game {
  /**
   * 当前存活的引擎实例数。开发期自检用。
   *
   * React StrictMode 会 mount → cleanup → mount，而 start() 里有多个 await，
   * 只要漏掉一次销毁，就会有两个 Game 同时跑 rAF、同时往一块画布上画。
   * 这个计数器让那种泄漏在测试里立刻现形。
   */
  static liveInstances = 0

  readonly assets = new AssetStore({
    collectImageDependencies: (_path, value) => {
      if (!value || typeof value !== 'object') return []
      const atlas = value as { image?: unknown; parts?: unknown }
      const paths: string[] = typeof atlas.image === 'string' ? [atlas.image] : []
      if (atlas.parts && typeof atlas.parts === 'object') {
        for (const part of Object.values(atlas.parts)) {
          if (part && typeof part === 'object' && typeof (part as { image?: unknown }).image === 'string') paths.push((part as { image: string }).image)
        }
      }
      return paths
    },
  })
  private retainedScenePaths: string[] = []
  private retainedBackgroundPath: string | null = null
  readonly audio: AudioBus
  readonly saves: SaveManager
  readonly fx: FxState = createFxState()
  readonly ink = new InkBridge()

  private readonly content: GameContent
  private readonly hooks: GameHooks
  private readonly stage: CanvasStage
  private readonly editorOnly: boolean
  private debug: DebugFlags

  private runtime: SceneRuntime | null = null
  private sceneRequest = 0
  private backgroundRequest = 0
  private readonly resources = new Map<string, unknown>()
  private engine: EngineState = createEmptyEngineState()
  private selectedItem: string | null = null
  /** 当前正在显示的台词。存档检查点要用它还原「这句话还没被点掉」。 */
  private currentLine: DialogueLine | null = null
  private currentSpeaker: string | null = null
  private currentPortrait: string | null = null
  private disposed = false
  private elapsed = 0
  private playMs = 0
  private autosaveDirty = false
  private stableSave: { inkState: string; engine: EngineState } | null = null
  private autosaveCooldown = 0
  private storyBusy = false
  private storyPhase: 'idle' | 'interaction' | 'entry' = 'idle'
  /** 由 # scene: 指令挂起的场景切换，在 drainStory 释放锁之后才执行。 */
  private pendingSceneId: string | null = null
  /** 推进中被打断时排队的 knot，等锁释放后立刻执行。 */
  private queuedKnot: string | null = null
  /**
   * 剧情代次。读档/重开会让正在跑的 drainStory 立刻作废 ——
   * 否则它 await 回来之后会继续在**新的** story 对象上推进，剧情直接乱套。
   */
  private storyGeneration = 0
  /** 最近一次推进出错的代次。出错后不再继续回 hub，避免把半截状态又推一次。 */
  private lastStoryError = -1
  /**
   * 会话作用域：重开 / 读档会重启它，从而作废所有在飞的异步任务。
   * 等 500ms、加载素材、挂起小游戏都拿它的信号，取消时不会污染新会话。
   */
  private readonly scope = new SessionScope()
  private readonly storyClock = new PausableClock()
  /** 正在运行的小游戏句柄。暂停 / 恢复要转发给它。 */
  private activeMiniGame: MiniGameHandle | null = null
  /** 暂停时抓的小游戏进度快照，恢复时交还。 */
  private miniGameSnapshot: unknown = null
  /** 已经报过"未声明能力"的 id，每种只报一次。 */
  private readonly capabilityWarned = new Set<string>()
  /** 暂停原因集合。只有全部解除才恢复，避免关掉面板却错误恢复了后台中的游戏。 */
  private readonly pauseReasons = new Set<PauseReason>()
  /**
   * 对话层是否停掉世界输入。由内容/主题的 `pauseWorldInput` 决定，
   * **不是核心写死的**。
   *
   * 它和"有一句台词在等玩家"不是一回事：后者本来就把点击导向推进对话；
   * 这一项额外管的是**对话层可见但没有待推进内容**时（挂起的 `# wait:`、
   * 模态聊天面板等），点击不该穿透到场景。
   */
  private dialogueBlocksInput = false
  /**
   * 上一次 resize 的参数。
   *
   * 换场景时要原样重放它 —— 走动深度的收窄只在 resize 里算，而换场景
   * 本身不触发 resize（UI 侧的尺寸没变）。不重放的话新场景的地面不会收窄。
   */
  private lastResize: {
    w: number
    h: number
    bottom: number
    right: number
    groundBottom: number
  } | null = null
  private waitingForAdvance = false
  private frameCount = 0
  private fpsAccum = 0
  private fps = 0
  private debugAccum = 0

  /**
   * 交互层。
   *
   * 输入先经过 resolver 解析成"交互意图"，再由 runIntent 统一执行：
   * 改场景状态 → 发事件 → 推进剧情。解析器是纯函数，所以这段逻辑能单测。
   */
  private readonly bridge: EventBridge
  /** 当前悬停的物件 id，用于渲染高亮。 */
  private hoverId: string | null = null
  /** 按下时若目标接受手上的物品，就先"预备拖拽"，等指针移开阈值再算真的拖。 */
  private dragArmed: { hotspotId: string; itemId: string; origin: Pt } | null = null
  private dragPoint: Pt | null = null
  /** 拖拽中指针下方的、确实能接收该物品的物件 id。 */
  private dropTargetId: string | null = null
  /** 最近一次交互事件，供调试面板显示。 */
  private lastEvent: InteractionEvent | null = null
  /** 已经报过的交互层告警，避免同一个问题刷屏。 */
  private readonly warnedInteractions = new Set<string>()

  // ── 输入状态 ─────────────────────────────────────────────
  /** UI 侧声明的输入占用：面板 / 小游戏打开时压过场景交互。 */
  private uiOwner: 'none' | 'panel' | 'minigame' = 'none'
  /** 按下时命中的物件 id，用于按压高亮。 */
  private pressedId: string | null = null

  constructor(options: GameOptions) {
    this.content = options.content
    this.hooks = options.hooks
    this.stage = new CanvasStage(options.canvas, { aspect: 16 / 9 })
    this.saves = options.saves ?? new SaveManager()
    this.audio = options.audio ?? new AudioBus()
    this.debug = options.debug ?? { ...DEFAULT_DEBUG }
    this.editorOnly = options.editorOnly ?? false

    registerBuiltinDirectives()
    this.ink.onError = (message) => this.hooks.onError(message)
    this.audio.setSettings(options.audioSettings ?? DEFAULT_AUDIO_SETTINGS)
    this.bridge = new EventBridge({
      // 事件走两条路：记进存档供剧情判断"发生过"，以及同步给 ink 的 last_event
      record: (event) => {
        this.engine.events[event.name] = (this.engine.events[event.name] ?? 0) + 1
        this.autosaveDirty = true
      },
      notifyInk: (event) => {
        // 剧本里声明 VAR last_event = "" 就能用 { last_event == "xxx": ... } 分支。
        // 没声明时这里不会报错，只是剧本读不到它。
        if (this.ink.ready) this.ink.setVariable('last_event', event.name)
      },
      trace: (event) => {
        this.lastEvent = event
      },
    })
    Game.liveInstances += 1
  }

  /** 存活实例数，供开发期自检与测试读取。 */
  get liveInstanceCount(): number {
    return Game.liveInstances
  }

  get sceneRuntime(): SceneRuntime | null {
    return this.runtime
  }

  /**
   * 实际使用的设备像素比上限。
   *
   * 来自 project.json 的 mobile.maxDpr。暴露出来是为了能验证它**真的生效**
   * —— 一个改了没反应的配置字段比没有这个字段更糟。
   */
  get renderDprLimit(): number {
    return this.stage.dprLimit
  }

  /** 当前视口，供自动化测试把场景坐标换算成页面坐标。 */
  get viewport(): {
    x: number
    y: number
    w: number
    h: number
    /** 场景可见部分的纵向范围。contain 恒为 [0,1]；cover 下是剩下那一段。 */
    visibleV0: number
    visibleV1: number
  } {
    const v = this.stage.viewport
    return { x: v.x, y: v.y, w: v.w, h: v.h, visibleV0: v.visibleV0, visibleV1: v.visibleV1 }
  }

  get engineState(): EngineState {
    return this.engine
  }

  /**
   * 角色实际能走到的纵向范围（归一化场景坐标）。
   *
   * 画面可见范围还要再让开底部对话框，所以它比 `viewport.visibleV0/V1` 更窄。
   * "角色走到最前排也不会被对话框盖住"这条不变式就是靠它验证的。
   */
  get groundRange(): readonly [number, number] {
    return this.runtime?.groundRange ?? [0, 1]
  }

  get currentSceneId(): string | null {
    return this.runtime?.scene.id ?? null
  }

  /**
   * 指定场景对对话布局的覆盖。null 表示完全继承内容包默认。
   *
   * 收 sceneId 而不是直接读当前 runtime：这样调用方（React）的依赖关系
   * 是**显式可见**的。`game` 的引用不会因为切场景而变，只写 `[game]`
   * 做依赖的话布局不会跟着场景更新 —— 而 lint 看不出这层关系，
   * 反而会把正确的依赖标成"多余"。
   *
   * 引擎只负责把声明交出来 —— 合不合并、怎么求值，是 UI 的事。
   * 引擎不该知道"现在该用底部还是右侧"。
   */
  dialogueOverrideFor(sceneId: string | null | undefined): DialogueLayoutOverride | null {
    if (!sceneId) return null
    return this.content.scenes.get(sceneId)?.dialogue ?? this.runtime?.scene.dialogue ?? null
  }

  /** 项目清单。UI 用它决定横竖屏策略、对话区形态等。 */
  get project(): Project {
    return this.content.project
  }

  /**
   * 剧情推进的状态探针。
   *
   * 剧情推进是本项目里异步最密的一段（锁、代次、挂起跳转、排队跳转），
   * 出问题时的表现往往只是"点了没反应"—— 没有这个探针就只能靠猜。
   * 调试面板和压力测试都读它。
   */
  get storyState(): {
    busy: boolean
    phase: string
    awaitingAdvance: boolean
    choiceCount: number
    queuedKnot: string | null
    pendingSceneId: string | null
  } {
    return {
      busy: this.storyBusy,
      phase: this.storyPhase,
      awaitingAdvance: this.waitingForAdvance,
      choiceCount: this.ink.choices.length,
      queuedKnot: this.queuedKnot,
      pendingSceneId: this.pendingSceneId,
    }
  }

  get awaitingAdvance(): boolean {
    return this.waitingForAdvance
  }

  /** 交互层的当前状态，供调试面板与自动化测试观察。 */
  get interactionState(): {
    hoverId: string | null
    dragArmed: string | null
    dragging: boolean
    dropTargetId: string | null
    pressedId: string | null
    owner: InputOwner
  } {
    return {
      hoverId: this.hoverId,
      dragArmed: this.dragArmed?.hotspotId ?? null,
      dragging: this.dragArmed !== null,
      dropTargetId: this.dropTargetId,
      pressedId: this.pressedId,
      owner: this.inputOwner(),
    }
  }

  /**
   * 还原呈现检查点。
   *
   * 把"台词正等着被点掉"这个状态重新摆出来 —— 否则读档会停在一句话都没有的
   * 空画面上，玩家得再点一下才继续，而 ink 其实已经在等他了。
   */
  private restoreCheckpoint(): void {
    const checkpoint = this.engine.checkpoint
    this.storyPhase = checkpoint.storyPhase
    if (checkpoint.pendingSceneId) {
      if (this.content.scenes.has(checkpoint.pendingSceneId)) this.pendingSceneId = checkpoint.pendingSceneId
      else this.hooks.onError(`存档待切换的场景 "${checkpoint.pendingSceneId}" 已不存在`)
    }
    const line = checkpoint.line
    if (line) {
      this.currentSpeaker = line.speaker
      this.currentPortrait = line.portrait
      this.waitingForAdvance = true
      this.emitLine(line)
      return
    }
    // 选项由 Ink 保存，恢复后必须重新发布到呈现层。
    this.hooks.onChoices(this.ink.choices)
  }

  /** 统一出口：记住当前台词，再转发给 UI。 */
  private emitLine(line: DialogueLine | null): void {
    this.currentLine = line
    this.hooks.onLine(line)
  }

  // ── 生命周期 ─────────────────────────────────────────────

  async start(save: Save | null = null): Promise<void> {
    // 作废所有在飞的推进，并清掉上一局残留的挂起状态
    if (this.disposed) return
    this.storyGeneration += 1
    const generation = this.storyGeneration
    this.storyBusy = false
    this.lastStoryError = -1
    this.pendingSceneId = null
    this.queuedKnot = null
    this.waitingForAdvance = false
    this.storyPhase = 'idle'
    this.pauseReasons.delete('minigame')
    this.currentSpeaker = null
    this.currentPortrait = null
    this.selectedItem = null
    this.emitLine(null)
    this.hooks.onChoices([])
    this.playMs = 0
    this.elapsed = 0
    this.autosaveDirty = false
    this.stableSave = null
    this.autosaveCooldown = 0
    this.bridge.clear()
    this.lastEvent = null
    Object.assign(this.fx, createFxState())

    /*
     * 新会话。
     *
     * 两件事必须一起做：
     *   1. 重启会话作用域 —— 所有在飞的异步任务（等待、加载、小游戏）立刻作废
     *   2. **丢掉旧 runtime** —— 否则 enterScene 里的 syncRuntimeState 会把
     *      上一局的场景状态同步进新会话，读档后看到的是旧进度
     */
    this.scope.restart()
    this.assets.release(this.retainedScenePaths)
    if (this.retainedBackgroundPath) this.assets.release([this.retainedBackgroundPath])
    this.retainedScenePaths = []
    this.retainedBackgroundPath = null
    this.assets.clear()
    this.activeMiniGame = null
    this.miniGameSnapshot = null
    if (this.uiOwner === 'minigame') this.uiOwner = 'none'
    this.runtime = null
    this.resources.clear()
    this.hoverId = null
    this.clearPress()
    this.clearDrag()

    /*
     * 应用项目清单里的画质上限。
     *
     * 这一句是必需的：内容（含 project.json）是异步加载的，构造 CanvasStage
     * 时还拿不到它。少了这一句，mobile.maxDpr 就是个**改了没反应的死配置**
     * —— 文档写了、schema 校验了，但引擎从头到尾没读过它。
     */
    this.stage.setMaxDpr(this.content.project.mobile.maxDpr)
    /*
     * 把引擎侧标记接给剧本。
     *
     * `# flag:` / `# unlock:` 一直在写 `engine.flags`，但剧本读不到 ——
     * 内容写了标记却没法据此分支。接上 `hb_flag(key)` 外部函数之后，
     * 剧本里 `EXTERNAL hb_flag(key)` + `~ return hb_flag("x")` 就能当条件用了。
     */
    this.ink.readFlag = (key) => truthyFlag(this.engine.flags[key])
    /*
     * 场景适配策略同样来自内容声明：`contain` 整张画面都在但可能有黑边，
     * `cover` 铺满不留黑边但会裁掉画面的一部分。
     * 这里只是把它接到渲染层 —— 该用哪个是内容的事。
     */
    this.stage.setSceneFit(this.content.project.mobile.sceneFit)

    if (this.content.storyJson) this.ink.load(this.content.storyJson)
    for (const warning of this.content.warnings) this.hooks.onError(warning)

    if (this.editorOnly) {
      const sceneId = save?.engine.sceneId ?? this.content.startSceneId
      if (sceneId) await this.enterScene(sceneId, false)
      return
    }

    if (save) {
      // 内容改过了就给一句提示，而不是静默继续。
      // 存档结构能迁移，但剧情位置可能已经失去意义 ——
      // "读档后剧情错乱"是最难查的一类问题，宁可先说清楚。
      if (save.contentVersion && save.contentVersion !== this.content.contentVersion) {
        this.hooks.onError('内容已更新，这份存档可能与当前剧情对不上')
      }
      /*
       * `saveCompatibility` 终于参与判断了。
       *
       * 它以前是"声明了、校验了、归一化了、README 也承诺了，但全仓无人读" ——
       * 改成任何值都零行为差异。分工是这样的：`contentVersion` 是自动算出来的
       * 指纹，任何改动都会变，只能给一句软提示；这个是作者**手写**的意图声明
       * （"这次改剧情没破坏存档结构"），不一致说明作者自己认为存档不可复用。
       * 两者都查，不是重复。
       *
       * 老存档没有这个字段 → 读出来是空串 → 不报警告：
       * 不能拿"未知"当"不匹配"。
       */
      if (
        save.saveCompatibility &&
        save.saveCompatibility !== this.content.project.saveCompatibility
      ) {
        this.hooks.onError(
          `存档是按 saveCompatibility "${save.saveCompatibility}" 写的，` +
            `当前内容是 "${this.content.project.saveCompatibility}"，剧情位置可能对不上`,
        )
      }

      this.engine = structuredClone(save.engine)
      this.playMs = save.engine.playMs
      const restored = !this.content.storyJson || (this.ink.ready && this.ink.loadState(save.inkState))
      if (!restored) {
        this.hooks.onError('存档中的剧情状态无法恢复，已从头开始')
        this.engine = createEmptyEngineState(this.content.startSceneId)
        this.playMs = 0
        const freshScene = this.content.startSceneId
        if (freshScene) {
          this.engine.visitedScenes = [freshScene]
          await this.enterScene(freshScene, true)
          await this.drainStory(0)
        } else {
          this.hooks.onError('没有可用的场景，检查 content/scenes 下有没有 start.json')
        }
        return
      }

      /*
       * 存档里的场景可能已经不存在了 —— 你改剧情时删掉或改名一个场景，
       * 旧存档就指向一个空 id。这时**必须退回起始场景**：
       * enterScene 失败会直接 return，runtime 保持 null，而 render() 又是
       * `if (!this.runtime) return`，结果是一块永远的黑屏。
       */
      const savedScene = save.engine.sceneId
      const exists = savedScene !== null && this.content.scenes.has(savedScene)
      if (savedScene && !exists) {
        this.hooks.onError(`存档里的场景 "${savedScene}" 已不存在，改从起始场景继续`)
      }
      const sceneId = exists ? savedScene : this.content.startSceneId

      if (sceneId) await this.enterScene(sceneId, false)
      else this.hooks.onError('没有可用的场景，检查 content/scenes 下有没有 start.json')

      if (generation !== this.storyGeneration || this.disposed) return
      this.restoreCheckpoint()
      this.emitInventory()
      if (!this.waitingForAdvance && this.ink.choices.length === 0 && this.ink.hasContent) await this.drainStory(0)
      return
    }

    this.engine = createEmptyEngineState(this.content.startSceneId)
    const startScene = this.content.startSceneId
    if (startScene) {
      this.engine.visitedScenes = [startScene]
      await this.enterScene(startScene, true)
      if (generation !== this.storyGeneration || this.disposed) return
      this.emitInventory()
      await this.drainStory(0)
    } else {
      this.hooks.onError('没有可用的起始场景')
    }
  }

  /** 幂等：重复调用不会把存活计数减成负数，也不会重复卸载音频。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    Game.liveInstances -= 1
    this.scope.dispose()
    this.audio.dispose()
    this.assets.release(this.retainedScenePaths)
    if (this.retainedBackgroundPath) this.assets.release([this.retainedBackgroundPath])
    this.retainedScenePaths = []
    this.retainedBackgroundPath = null
    this.runtime = null
    this.resources.clear()
    this.stableSave = null
    // 释放图片缓存：一张 1920×1080 的背景解码后约 8 MB，不释放就白占着
    this.assets.clear()
  }

  /** 调试/自动化用：直接跳到某个场景，不经过出口条件。 */
  async debugGotoScene(sceneId: string): Promise<void> {
    await this.enterScene(sceneId, true)
    await this.drainStory(0)
  }

  /** 调试/自动化用：直接运行一个 ink knot。 */
  debugRunKnot(knot: string): void {
    this.runKnot(knot)
  }

  // ── 场景 ─────────────────────────────────────────────────

  /**
   * 切场景：**准备后提交**。
   *
   * 顺序是刻意的 —— 所有 await 都在替换状态**之前**完成：
   *
   *   1. 校验目标场景
   *   2. 加载素材、准备角色资源
   *   3. 确认这次切换仍然有效（会话没被重启、没被更新的请求顶掉）
   *   4. 把旧场景的稳定状态并回引擎
   *   5. 一次性替换 runtime / 资源 / 视口
   *   6. 运行入口逻辑
   *
   * 反过来的话（先换一半再 await），中间会存在一个"runtime 是新的、
   * 资源还是旧的"的窗口，此时玩家点击或存档都会读到半截状态。
   */
  private async enterScene(sceneId: string, runEntry: boolean): Promise<void> {
    const scene = this.content.scenes.get(sceneId)
    if (!scene) {
      this.hooks.onError(`找不到场景 "${sceneId}"`)
      return
    }

    const request = ++this.sceneRequest
    const ctx = this.scope.task(sceneId)
    const paths = SceneRuntime.assetPaths(scene)
    this.assets.retain(paths)
    let committed = false
    try {

    // ── 2. 准备：素材与角色资源都在替换之前完成 ──
    const runtime = await SceneRuntime.create(scene, this.assets, this.engine.scenes)
    if (!this.scope.isCurrent(ctx)) return

    const resources = new Map<string, unknown>()
    for (const actor of runtime.actors) {
      resources.set(actor.spec.id, await prepareActorRenderer(actor.spec, this.assets))
    }

    // ── 3. 提交前再确认一次：await 期间可能已经读档或又切了一次场景 ──
    if (!this.scope.isCurrent(ctx) || request !== this.sceneRequest) return
    if (this.pendingSceneId !== null && this.pendingSceneId !== sceneId) return

    // ── 4. 保存旧场景的稳定状态 ──
    this.syncRuntimeState()

    this.assets.release(this.retainedScenePaths)
    if (this.retainedBackgroundPath) this.assets.release([this.retainedBackgroundPath])
    this.retainedBackgroundPath = null
    this.retainedScenePaths = paths
    committed = true

    // ── 5. 一次性替换 ──
    this.runtime = runtime
    this.resources.clear()
    for (const [id, prepared] of resources) this.resources.set(id, prepared)
    // 换场景时把悬停/按压/拖拽状态清掉，否则会留着一个指向旧场景物件的 id
    this.hoverId = null
    this.clearPress()
    this.clearDrag()

    this.stage.aspect = scene.aspect
    /*
     * 换场景后必须**立刻按当前视口重算一次走动深度**。
     *
     * `setVisibleRange` 只在 `resize()` 里调，而 resize 由 UI 的
     * ResizeObserver / window resize 触发。两个场景用同一套布局声明时
     * 这些都不会响 —— 于是新场景的 `visibleV` 停在初始的 [0,1]，
     * 收窄丢失，角色直接走到画布下缘之外（实测脚底 y=430 > 画布 390）。
     *
     * 把上一次 resize 的参数原样重放，复用同一条代码路径。
     */
    // 恢复角色位置之后统一重放 resize，避免可见约束被读档坐标覆盖。
    this.engine.sceneId = sceneId
    if (!this.engine.visitedScenes.includes(sceneId)) this.engine.visitedScenes.push(sceneId)

    if (scene.bgm) {
      this.ensureCapability('audio', 'scene.bgm')
      this.audio.playBgm(scene.bgm, 1.2)
    } else {
      this.audio.stopBgm(0.8)
    }
    // 上一幕的语音不该压到新场景上
    this.audio.stopVo()

    // 恢复角色位置（读档时用）。键带上场景 id，避免同名角色跨场景串位。
    for (const actor of runtime.actors) {
      const key = sceneObjectKey(sceneId, actor.spec.id)
      const saved = this.engine.actorPositions[key]
      if (saved) {
        actor.u = saved[0]
        actor.v = saved[1]
      }
      const facing = this.engine.actorFacing[key]
      if (facing === 1 || facing === -1) {
        actor.facing = facing
        actor.facingTarget = facing
      }
    }

    if (this.lastResize) {
      const last = this.lastResize
      this.resize(last.w, last.h, last.bottom, last.right, last.groundBottom)
    }
    this.hooks.onScene(sceneId, scene.title, scene.aspect)

    // 沿"明确的出口"预取下一幕的素材（低优先级，失败静默降级）
    this.prefetchNeighbourAssets(sceneId)

    // 这里只负责跳转，**不推进**。
    // 调用方（drainStory 或 start）此刻可能正持有推进锁，在这里再调一次
    // drainStory 会被锁挡掉，入口剧情就永远播不出来。
    if (runEntry && !this.editorOnly && scene.entry && this.ink.hasKnot(scene.entry)) {
      this.storyPhase = 'entry'
      this.ink.jumpTo(scene.entry)
    }
    this.markAutosave()
    } finally {
      if (!committed) this.assets.release(paths)
    }
  }

  /**
   * 预取相邻场景的素材。
   *
   * 只沿**明确的出口**取（scene.exits 指向的场景），而不是把所有场景都
   * 拉一遍 —— 后者会在低端设备上把内存和带宽一起吃掉。
   *
   * 失败静默降级：预取本来就只是"有空就做"的优化，素材缺失时有占位兜底。
   * 不 await，也不参与任何生命周期 —— 它回来时场景可能早换了，而缓存本身
   * 是幂等的，重复写没有副作用。
   */
  private prefetchNeighbourAssets(sceneId: string): void {
    const scene = this.content.scenes.get(sceneId)
    if (!scene) return
    /*
     * 用 `SceneRuntime.assetPaths` 收全，而不是自己挑三样。
     *
     * 那个静态方法把图层/物件的 `visualStates`、互动音效、角色部件图集
     * 都算进去了 —— 它一直存在、也一直是"预取邻场景"该有的口径，
     * 但**零调用**；真正在跑的是这里，而这里以前只挑背景图和主图，
     * 于是"预取"对自己的承诺只兑现了一小半（状态图、音效、部件全没预取到）。
     *
     * 但**不能把音频路径直接丢给 `assets.preload`**：那个方法一律走
     * `image()`，音频会被当成图片加载失败、记进 `missingAssets` ——
     * 调试面板里会平白多出一堆"缺失素材"，作者要去追一个不存在的 bug。
     * 所以按扩展名分流：图片走 image，JSON（部件图集）走 json，音频不预取
     * （Howler 自己管，提前拉一份反而占内存）。
     */
    const IMAGE_EXT = /\.(png|jpe?g|webp|avif|gif|svg)$/i
    const JSON_EXT = /\.json$/i
    const images = new Set<string>()
    const jsons = new Set<string>()

    for (const exit of scene.exits) {
      const next = this.content.scenes.get(exit.to)
      if (!next) continue
      for (const path of SceneRuntime.assetPaths(next)) {
        if (IMAGE_EXT.test(path)) images.add(path)
        else if (JSON_EXT.test(path)) jsons.add(path)
      }
    }

    if (images.size > 0) void this.assets.preload([...images]).catch(() => undefined)
    for (const path of jsons) void this.assets.json(path).catch(() => undefined)
  }

  // ── 剧情推进 ─────────────────────────────────────────────

  /**
   * 把 ink 推进到下一次需要玩家输入为止。
   *
   * 空文本行只承载演出指令，不显示对话框 —— 这是"标签可以单独占一行"
   * 这个写法的支撑点。
   *
   * 场景切换必须**挂起**而不是就地执行：本方法持锁期间再调 drainStory
   * 会被锁挡掉，剧情就会卡住。所以 # scene: 只记一个 pendingSceneId，
   * 由 applyPendingScene 在锁内完成切换。
   */
  private async drainStory(depth: number): Promise<void> {
    if (this.storyBusy || this.disposed) return
    const generation = this.storyGeneration
    this.storyBusy = true
    /** 本次推进是不是停在"等玩家选"上。 */
    let awaitingChoice = false

    try {
      // 上一行留下的场景切换必须**在读下一行之前**生效，
      // 否则会拿着旧场景继续把剧情推下去。
      await this.applyPendingScene()

      let guard = 0
      for (;;) {
        // 读档/重开会让代次变化，这时必须立刻收手
        if (generation !== this.storyGeneration) return
        if (guard++ > 2000) {
          this.hooks.onError('剧情推进超过 2000 步，可能存在死循环')
          break
        }

        this.stableSave = { inkState: this.ink.saveState(), engine: this.snapshotEngine() }
        const line = this.ink.next()
        if (!line) break

        if (line.tags.length > 0) {
          await applyDirectives(line.tags, this.directiveContext())
        }
        if (generation !== this.storyGeneration || this.disposed) return

        // 有文本就先显示。场景切换留到玩家推进之后再执行 ——
        // 先切场景会把同一行上的文字整句吞掉。
        if (line.text.length > 0) {
          this.waitingForAdvance = true
          this.emitLine({
            text: line.text,
            speaker: this.currentSpeaker,
            portrait: this.currentPortrait,
          })
          this.markAutosave()
          return
        }

        if (this.pendingSceneId) await this.applyPendingScene()
      }

      // 故事让出控制权：要么在等选项，要么一段交互演完了
      this.waitingForAdvance = false
      const choices = this.ink.choices
      this.hooks.onChoices(choices)
      awaitingChoice = choices.length > 0
      if (!awaitingChoice) this.emitLine(null)
    } catch (error) {
      /*
       * 取消（重开 / 读档 / 切场景）不是故障：静静地收手，
       * finally 会释放推进锁，调用方继续做它自己的事。
       */
      if (isTaskCancelled(error)) return
      /*
       * 其它异常**不能往外抛**。
       *
       * drainStory 的调用方全是 `void this.drainStory(0)`，抛出去就变成
       * unhandled rejection：错误完全隐身，剧情停在半路，而玩家看到的
       * 只是"点了没反应"。这里报出来，让它在调试面板上可见；
       * finally 仍会释放锁，所以游戏不会卡死。
       */
      this.lastStoryError = generation
      this.hooks.onError(`剧情推进出错：${(error as Error).message}`)
    } finally {
      if (generation === this.storyGeneration) this.storyBusy = false
    }

    if (generation !== this.storyGeneration) return
    // 出错后不再往下走：回 hub 会把半截状态又推进一次
    if (this.lastStoryError === generation) return

    // 推进中被打断的跳转优先补上
    if (this.queuedKnot) {
      const knot = this.queuedKnot
      this.queuedKnot = null
      this.runKnot(knot)
      return
    }

    /*
     * 玩家正在选的时候**绝不能**回 hub。
     *
     * returnToHub 会 jumpTo(hub)，而 ink 一旦跳走，currentChoices 立刻清空 ——
     * 刚发给 UI 的选项就成了永远点不到的幽灵。表现是"选项一闪而过/根本不出现"，
     * 剧情却被拽回了锚点。
     *
     * 这个坑一直没暴露，是因为占位剧本里一个选项都没有；
     * 而 hub 恰恰是 README 推荐的标准配置，所以它影响的是**每一个正常配置的场景**。
     */
    if (awaitingChoice) return

    await this.returnToHub(depth)
  }

  /**
   * 执行挂起的场景切换。
   *
   * 调用方**必须已持有推进锁**；切换后由调用方继续推进，
   * 因为 enterScene 只跳转、不推进。
   */
  private async applyPendingScene(): Promise<void> {
    const sceneId = this.pendingSceneId
    if (!sceneId) return
    this.pendingSceneId = null
    await this.enterScene(sceneId, true)
  }

  /** 交互 knot 演完后回到场景 hub，等待下一次点击。 */
  private async returnToHub(depth: number): Promise<void> {
    if (depth > 4 || this.editorOnly) return
    if (this.storyPhase !== 'interaction' && this.storyPhase !== 'entry') return
    this.storyPhase = 'idle'

    const hub = this.runtime?.scene.hub
    if (!hub || !this.ink.hasKnot(hub)) return
    if (!this.ink.jumpTo(hub)) return
    await this.drainStory(depth + 1)
  }

  /** 玩家点击对话区：推进一行。 */
  advanceStory(): void {
    if (this.paused || this.disposed || !this.waitingForAdvance) return
    this.waitingForAdvance = false
    this.emitLine(null)
    void this.drainStory(0)
  }

  choose(index: number): void {
    // 推进中（例如 # wait: 挂起时）不接受选项，否则 ink 指针会被挪走，
    // 而正在跑的循环还从新位置继续读。
    if (this.storyBusy || this.paused || this.disposed) return
    if (!this.ink.choose(index)) return
    this.hooks.onChoices([])
    void this.drainStory(0)
  }

  /** 执行一个 ink knot，例如点击热点。 */
  runKnot(knot: string): void {
    if (this.editorOnly) return

    // 同理：推进中改道会把正在跑的循环搞乱，先排队，等锁释放后立刻执行。
    if (this.storyBusy) {
      this.queuedKnot = knot
      return
    }

    this.storyPhase = 'interaction'
    if (!this.ink.jumpTo(knot)) {
      this.storyPhase = 'idle'
      this.hooks.onError(`无法跳转到 ink knot "${knot}"`)
      return
    }
    void this.drainStory(0)
  }

  /** 出口或指令要求的场景/剧情跳转。 */
  private jumpToTarget(target: string): void {
    if (this.content.scenes.has(target)) {
      // enterScene 只跳转不推进，所以这里要自己接着推
      void this.enterScene(target, true).then(() => this.drainStory(0))
      return
    }
    this.runKnot(target)
  }

  // ── 演出指令上下文 ───────────────────────────────────────

  private directiveContext(): DirectiveContext {
    const task = this.scope.task(this.engine.sceneId)
    const context: DirectiveContext = {
      // 普通属性而不是 getter：指令是在处理同一行时同步执行的，
      // 期间场景不会变（# scene: 只挂起，等 drainStory 释放锁后才真正切），
      // 所以取一次快照就是正确的，也省掉了 this 别名。
      sceneId: this.runtime?.scene.id ?? null,
      setScene: (id) => {
        // 挂起，等 drainStory 释放锁后再真正切换，避免重入被挡掉
        this.pendingSceneId = id
      },
      setBackground: (path) => {
        void this.applyBackground(path)
      },
      setPortrait: (id) => {
        this.currentPortrait = id
      },
      setSpeaker: (name) => {
        this.currentSpeaker = name
      },
      playBgm: (path, fade) => {
        this.ensureCapability('audio', '# bgm:')
        this.audio.playBgm(path, fade)
      },
      stopBgm: (fade) => this.audio.stopBgm(fade),
      playSfx: (value) => {
        this.ensureCapability('audio', '# sfx:')
        this.audio.playSfx(resolveAudio('sfx', value))
      },
      playVo: (value) => {
        this.ensureCapability('audio', '# vo:')
        this.audio.playVo(resolveAudio('vo', value))
      },
      runFx: (name, args) => triggerFx(this.fx, name, args),
      wait: (seconds) => this.storyClock.delay(Math.max(0, seconds) * 1000, task.signal),
      actorCommand: (actorId, command, args) => this.actorCommand(actorId, command, args),
      runMiniGame: (id, args) => this.runMiniGame(id, args),
      setFlag: (key, value) => {
        this.engine.flags[key] = value
        this.markAutosave()
      },
      award: (itemId) => {
        if (!this.ensureCapability('inventory', '# award:')) return
        if (!this.engine.inventory.includes(itemId)) this.engine.inventory.push(itemId)
        this.emitInventory()
        this.markAutosave()
      },
      unlock: (id) => {
        this.engine.flags[id] = true
        this.markAutosave()
      },
      log: (message) => {
        if (import.meta.env.DEV) console.warn(`[story] ${message}`)
      },
    }
    return new Proxy(context, {
      get: (target, property, receiver) => {
        const value: unknown = Reflect.get(target, property, receiver)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          if (!this.scope.isCurrent(task)) throw new TaskCancelled('演出会话已过期')
          return Reflect.apply(value, target, args)
        }
      },
    })
  }

  private async applyBackground(path: string | null): Promise<void> {
    const runtime = this.runtime
    if (!runtime) return
    const ctx = this.scope.task(runtime.scene.id)
    const request = ++this.backgroundRequest
    if (path) this.assets.retain([path])
    let committed = false
    try {
      const image = path ? await this.assets.image(path) : null
      if (!this.scope.isCurrent(ctx) || this.runtime !== runtime || request !== this.backgroundRequest) return
      if (this.retainedBackgroundPath) this.assets.release([this.retainedBackgroundPath])
      this.retainedBackgroundPath = path
      runtime.backgroundOverride = image
      committed = true
    } finally {
      if (!committed && path) this.assets.release([path])
    }
  }

  /**
   * 运行一个小游戏并把结果写回 ink。
   *
   * 这是引擎里唯一直接碰 DOM 的地方 —— 小游戏界面本身由实现方负责，
   * 引擎只提供宿主节点、统一的失败/跳过策略，以及结果回收。
   * 结果是写进 ink 变量，逻辑判断仍然留在剧本里。
   */
  private async runMiniGame(id: string, args: string[]): Promise<unknown> {
    if (typeof document === 'undefined') return null

    /*
     * 按声明加载。
     *
     * 项目清单没声明 minigame 就不加载 —— 这才叫"用时调用"，而不是
     * 注册表里躺着一堆永远用不上的能力。内容里写了 # minigame: 却没声明，
     * content:check 会直接报 error 挡住构建；这里再兜一层，
     * 免得手改产物或跳过构建时静默失效。
     */
    if (!this.ensureCapability('minigame', `# minigame: ${id}`)) {
      this.hooks.onError(`项目没有声明 minigame 能力，无法运行小游戏 "${id}"`)
      return null
    }

    const game = getMiniGame(id)
    if (!game) {
      this.hooks.onError(`没有注册名为 "${id}" 的小游戏`)
      return null
    }

    /*
     * 参数解释属于玩法，不属于引擎。
     *
     * 早期版本在这里写死了解析 length/speed —— 那等于把某个具体玩法的约定
     * 焊进了通用容器。现在只把指令原文交过去，玩法自己声明 Schema。
     */
    let params: unknown = { args }
    if (game.params) {
      const parsed = game.params.parse(args)
      if (parsed === null) {
        this.hooks.onError(`小游戏 "${id}" 的参数不合法：${args.join(', ') || '（空）'}`)
        return null
      }
      params = parsed
    }

    /*
     * `??` 会把**显式的 null** 当成"没写"。
     *
     * 而 `skip: { skipAfter: null }` 的语义是"本次不允许跳过"（见
     * MiniGameSkipPolicy 的注释）—— 关键剧情不该给出跳过入口。用 `??`
     * 的话它会静默回落成项目默认值，玩家照样能跳过。
     *
     * 只有 `undefined`（真的没写）才该继承项目默认。
     */
    const skipAfter =
      game.skip === undefined
        ? this.content.project.minigame.skipAfter
        : game.skip.skipAfter

    const ctx = this.scope.task(this.engine.sceneId)
    const host = document.createElement('div')
    document.body.appendChild(host)
    this.setUiOwner('minigame')
    this.setPaused('minigame', true)
    let handle: MiniGameHandle | null = null
    let failures = 0
    let settled = false
    let removeAbort = (): void => {}
    let result: unknown
    try {
      result = await new Promise<unknown>((resolve, reject) => {
        const finish = (value: unknown): void => {
          if (settled) return
          settled = true
          removeAbort()
          resolve(value)
        }
        const onAbort = (): void => {
          if (settled) return
          settled = true
          reject(new TaskCancelled('小游戏会话已取消'))
        }
        removeAbort = () => ctx.signal.removeEventListener('abort', onAbort)
        ctx.signal.addEventListener('abort', onAbort, { once: true })
        if (ctx.signal.aborted) { onAbort(); return }
        handle = game.mount(host, params as never, {
          resolve: finish,
          reportFailure: () => { if (!settled) failures += 1 },
          requestSkip: () => {
            if (skipAfter !== null && failures >= skipAfter) finish({ success: false, skipped: true, failures })
          },
          get failures() { return failures },
          skipAfter,
        })
        this.activeMiniGame = handle
        // minigame 只暂停世界模拟，外部暂停才暂停玩法自身。
        if ([...this.pauseReasons].some((reason) => reason !== 'minigame')) handle.pause?.()
      })
    } finally {
      removeAbort()
      try { (handle as MiniGameHandle | null)?.destroy() }
      finally {
        host.remove()
        if (this.scope.isCurrent(ctx)) {
          this.activeMiniGame = null
          this.miniGameSnapshot = null
          this.setPaused('minigame', false)
          this.setUiOwner('none')
        }
      }
    }
    if (!this.scope.isCurrent(ctx)) throw new TaskCancelled('小游戏结果已过期')
    const success = game.result
      ? game.result.isSuccess(result as never)
      : (result as { success?: boolean } | null)?.success === true
    const skipped = (result as { skipped?: boolean } | null)?.skipped === true
    if (this.ink.variable('minigame_success') !== undefined) this.ink.setVariable('minigame_success', success)
    if (this.ink.variable('minigame_skipped') !== undefined) this.ink.setVariable('minigame_skipped', skipped)
    this.markAutosave()
    return result
  }

  /**
   * 用到某个能力时，确认内容声明过它。
   *
   * `project.rules.ts` 里写的是"引擎支持的能力，**未列出的不会被加载**"，
   * 但运行时此前只对 `minigame` 真的做了拦截 —— 另外 7 项未声明也照跑，
   * 文档和行为对不上。
   *
   * 这里刻意**只报警、不改行为**。补硬门禁是行为变更：现在能跑的内容会开始
   * 降级，而"要不要降级"是设计决定。何况构建期的 `content:check` 已经对硬能力
   * （story.ink / interaction.tap / hold / drag / minigame）报 error 了，
   * 运行期这道闸主要是给手改产物兜底的。
   *
   * 每种能力只报一次 —— 音频一次几十个调用，刷屏等于没报。
   */
  private ensureCapability(id: CapabilityId, where: string): boolean {
    const message = capabilityWarning(this.content.project, id, where)
    if (!message) return true
    if (!this.capabilityWarned.has(id)) {
      this.capabilityWarned.add(id)
      this.hooks.onError(message)
    }
    return false
  }

  private actorCommand(actorId: string, command: string, args: string[]): void {
    const actor = this.runtime?.actorById(actorId)
    if (!actor || !this.runtime) return

    switch (command) {
      case 'walkTo': {
        this.ensureCapability('actor.walk', '# actor: walkTo')
        const u = Number.parseFloat(args[0] ?? '')
        const v = Number.parseFloat(args[1] ?? '')
        if (Number.isFinite(u) && Number.isFinite(v)) this.runtime.moveActor(actorId, [u, v])
        break
      }
      case 'face': {
        const sign = Number.parseFloat(args[0] ?? '')
        if (sign > 0) {
          actor.facingTarget = 1
          actor.faceDirX = 1
          actor.faceDirY = 0
        } else if (sign < 0) {
          actor.facingTarget = -1
          actor.faceDirX = -1
          actor.faceDirY = 0
        }
        break
      }
      case 'stop':
        /*
         * 用 `stopActor` 而不是手写三行。
         *
         * 手写版漏了 `pendingKnot`：`# actor: hero stop` 之后那个"走到目的地
         * 就跳转"的约定还挂着，等角色**下一次**因为别的原因走完一段路时
         * 会突然触发一个早就该作废的跳转。
         */
        stopActor(actor)
        break
      default:
        if (import.meta.env.DEV) console.warn(`[actor] 未知命令 "${command}"`)
    }
  }

  // ── 输入 ─────────────────────────────────────────────────

  /**
   * 处理一次手势事件。
   *
   * 所有世界交互都从这里进 —— 引擎不再自己解析指针，而是消费 InputRouter
   * 归约好的结果。这样"一次手势只产生一个结果"由状态机保证，
   * 而不是靠每个入口各写一遍判断。
   */
  handleGesture(event: GestureEvent): void {
    if (this.disposed) return
    if (this.paused && event.type !== 'cancel') return
    switch (event.type) {
      case 'press':
        this.onPress(event.point)
        return
      case 'hold':
        this.onHold(event.point)
        return
      case 'dragStart':
        this.onDragStart(event.point)
        return
      case 'dragMove':
        this.onDragMove(event.point)
        return
      case 'dragEnd':
        this.onDragEnd(event.to)
        return
      case 'tap':
        this.onTap(event.point)
        return
      case 'cancel':
        this.clearPress()
        this.clearDrag()
        return
    }
  }

  /**
   * 谁拥有这次输入。
   *
   * 高优先级在场时，低优先级一律收不到 —— 否则"点一下推进对话"会顺带把
   * 背后的场景热点也点了。UI 侧（面板 / 小游戏）通过 setUiOwner 声明占用。
   */
  private inputOwner(): InputOwner {
    if (this.uiOwner !== 'none') return this.uiOwner
    if (this.waitingForAdvance || this.ink.choices.length > 0) return 'dialogue'
    // 对话层可见但没有待推进内容：世界输入整体关掉，点击不再穿透到场景
    if (this.dialogueBlocksInput) return 'dialogue'
    return 'scene'
  }

  /**
   * 对话层是否停掉世界输入。
   *
   * 引擎只执行这个开关 —— 什么时候算"对话层可见"由 UI 判断，
   * 因为那取决于主题怎么排布，核心不该知道。
   */
  setDialogueBlocksInput(blocked: boolean): void {
    if (this.dialogueBlocksInput === blocked) return
    this.dialogueBlocksInput = blocked
    // 半截手势不能留到开关变化之后
    if (blocked) {
      this.clearPress()
      this.clearDrag()
    }
  }

  /** UI 侧声明占用输入（打开面板、运行小游戏时）。 */
  setUiOwner(owner: 'none' | 'panel' | 'minigame'): void {
    if (this.uiOwner === owner) return
    this.uiOwner = owner
    // 占用权变化时必须清掉半截手势：拖到一半弹出面板，拖拽要作废。
    if (owner !== 'none') {
      this.clearPress()
      this.clearDrag()
    }
  }

  /** CSS 像素坐标 → 场景空间坐标。落在黑边上返回 null。 */
  private toScenePoint(point: Pt): Pt | null {
    return this.stage.toScene(point[0], point[1])
  }

  private onPress(clientPoint: Pt): void {
    const owner = this.inputOwner()
    if (owner !== 'scene') return
    const point = this.toScenePoint(clientPoint)
    if (!point) return
    const runtime = this.runtime
    if (!runtime || this.editorOnly) return
    this.pressedId = runtime.hotspotAt(point[0], point[1], (h) => this.isHotspotVisible(h))?.id ?? null
  }

  /** 长按：解析 hold 触发器。 */
  private onHold(clientPoint: Pt): void {
    if (this.inputOwner() !== 'scene') return
    const point = this.toScenePoint(clientPoint)
    if (!point) return
    this.activateHotspot(point[0], point[1], 'hold')
  }

  private onTap(clientPoint: Pt): void {
    const owner = this.inputOwner()
    // 对话与选项优先：点一下推进剧情，不去碰背后的场景
    if (owner === 'dialogue') {
      this.advanceStory()
      return
    }
    if (owner !== 'scene') return

    const point = this.toScenePoint(clientPoint)
    if (!point) return
    this.activateHotspot(point[0], point[1], 'tap')
  }

  private onDragStart(clientPoint: Pt): void {
    if (this.inputOwner() !== 'scene') return
    const point = this.toScenePoint(clientPoint)
    if (!point) return
    const runtime = this.runtime
    if (!runtime) return

    // 只有"手上拿着东西、且目标接受它"才进入拖放。
    // 其余拖动在手机上什么也不做 —— 总比误触发一次交互好。
    if (!this.selectedItem) return
    const hotspot = runtime.hotspotAt(point[0], point[1], (h) => this.isHotspotVisible(h))
    if (!hotspot || !this.acceptsDrop(hotspot, this.selectedItem)) return

    this.dragArmed = { hotspotId: hotspot.id, itemId: this.selectedItem, origin: point }
    this.dragPoint = point
  }

  private onDragMove(clientPoint: Pt): void {
    if (!this.dragArmed) return
    const runtime = this.runtime
    if (!runtime) return
    const point = this.toScenePoint(clientPoint)
    if (!point) return
    this.dragPoint = point

    const under = runtime.hotspotAt(point[0], point[1], (h) => this.isHotspotVisible(h))
    const canDrop = under !== null && this.acceptsDrop(under, this.dragArmed.itemId)
    this.hoverId = canDrop ? under.id : null
    this.dropTargetId = canDrop ? under.id : null
  }

  private onDragEnd(to: Pt): void {
    const armed = this.dragArmed
    this.clearDrag()
    if (!armed) return

    const runtime = this.runtime
    if (!runtime) return
    const end = this.toScenePoint(to)
    if (!end) return

    const target = runtime.hotspotAt(end[0], end[1], (h) => this.isHotspotVisible(h))
    if (!target) return

    const resolution = resolveDrop(target, armed.itemId, this.interactionContext())
    if (resolution.intent) {
      this.runIntent(resolution.intent)
      return
    }
    if (resolution.failure === 'condition-failed') this.hooks.onError('现在还不能这么做')
  }

  private clearPress(): void {
    this.pressedId = null
  }

  private clearDrag(): void {
    this.dragArmed = null
    this.dragPoint = null
    this.dropTargetId = null
  }

  /** 指针离开画面 / 页面隐藏 / 转屏：清掉悬停与半截手势。 */
  pointerCancel(): void {
    this.hoverId = null
    this.clearPress()
    this.clearDrag()
  }

  /**
   * 指针移动（不在手势中）：更新悬停高亮。
   *
   * 手机上没有 hover，所以这不是主要反馈 —— 但桌面上调场景、以及
   * 自动化测试仍然依赖它。**不要**把它当成发现交互的唯一线索。
   */
  hoverAt(clientPoint: Pt): void {
    const runtime = this.runtime
    if (!runtime || this.editorOnly) return
    const point = this.toScenePoint(clientPoint)
    if (!point) {
      this.hoverId = null
      return
    }
    const hotspot = runtime.hotspotAt(point[0], point[1], (h) => this.isHotspotVisible(h))
    this.hoverId = hotspot?.id ?? null
  }

  /** 悬停：返回光标类型，用于 UI。 */
  cursorFor(x: number, y: number): string {
    const runtime = this.runtime
    if (!runtime) return 'default'
    if (this.waitingForAdvance) return 'advance'
    if (this.dragArmed) return 'grab'
    return runtime.cursorAt(x, y, (h) => this.isHotspotVisible(h))
  }

  /** 解析器需要的上下文。 */
  private interactionContext(): InteractionContext {
    return {
      selectedItem: this.selectedItem,
      evaluate: (name) => (this.ink.ready ? this.ink.evaluate(name) : false),
      // 同一个告警只说一次：解析器在 press / hold / hover 里都会被调用，
      // 不去重的话一条"动词未实现"会刷屏成好几个 toast。
      warn: (message) => {
        if (this.warnedInteractions.has(message)) return
        this.warnedInteractions.add(message)
        this.hooks.onError(message)
      },
    }
  }

  private acceptsDrop(hotspot: Hotspot, itemId: string): boolean {
    return acceptsDrop(hotspot, itemId, this.interactionContext())
  }

  /**
   * 执行一条交互意图。
   *
   * 顺序是刻意的：**先改场景状态，再发事件，最后推进剧情**。
   * 这样剧情读到的永远是交互之后的世界 —— 否则台词会描述一个已经不存在
   * 的画面（说"抽屉开了"但抽屉还关着）。
   */
  private runIntent(intent: InteractionIntent): void {
    const runtime = this.runtime
    if (!runtime) return
    const { target, interaction } = intent

    /*
     * 按动作列表执行。
     *
     * 顺序是刻意的：**先改场景状态，再发事件，最后推进剧情**。
     * 这样剧情读到的永远是交互之后的世界 —— 否则台词会描述一个已经不存在
     * 的画面（说"抽屉开了"但抽屉还关着）。
     */
    let knot: string | null = null
    const awarded: string[] = []
    const consumed: string[] = []

    for (const effect of interaction.effects) {
      switch (effect.type) {
        case 'object.patch': {
          // '@self' 表示"这条交互所属的物件"，作者不用把 id 再抄一遍
          const objectId = effect.target === '@self' || effect.target === '' ? target.id : effect.target
          const patch: { state?: string; visible?: boolean; progress?: number } = {}
          if (typeof effect.patch.state === 'string') patch.state = effect.patch.state
          if (typeof effect.patch.visible === 'boolean') patch.visible = effect.patch.visible
          if (typeof effect.patch.progress === 'number') patch.progress = effect.patch.progress
          if (Object.keys(patch).length > 0) {
            runtime.patchObjectState(objectId, patch)
            this.autosaveDirty = true
          }
          break
        }
        case 'audio.sfx':
          if (effect.path) {
            this.ensureCapability('audio', 'audio.sfx 效果')
            this.audio.playSfx(effect.path)
          }
          break
        case 'story.knot':
          if (effect.knot) knot = effect.knot
          break
        case 'item.award':
          if (effect.item) {
            this.ensureCapability('inventory', 'item.award 效果')
            awarded.push(effect.item)
          }
          break
        case 'item.consume':
          if (effect.item) consumed.push(effect.item)
          break
        case 'story.event':
          // 事件名统一由 eventNameFor 决定，这里不额外发一次
          break
      }
    }

    for (const itemId of awarded) {
      if (!this.engine.inventory.includes(itemId)) this.engine.inventory.push(itemId)
    }
    for (const itemId of consumed) {
      const at = this.engine.inventory.indexOf(itemId)
      if (at >= 0) this.engine.inventory.splice(at, 1)
    }
    if (awarded.length > 0 || consumed.length > 0) {
      if (this.selectedItem && !this.engine.inventory.includes(this.selectedItem)) this.selectedItem = null
      this.emitInventory()
      this.autosaveDirty = true
    }

    // 事件桥：记进存档 + 同步给 ink。每条交互**只发一个**事件。
    this.bridge.emit({
      name: eventNameFor(target, interaction),
      sceneId: runtime.scene.id,
      objectId: target.id,
      verb: interaction.verb,
      item: intent.kind === 'use' ? interaction.item : null,
      at: this.playMs,
    })

    // 用过的物品从手上拿走。
    // 注意这和"从背包消耗"是两回事 —— 消耗与否由 item.consume 动作单独决定。
    if (intent.kind === 'use' || intent.kind === 'drag') this.setSelectedItem(null)

    /*
     * 没有 story.knot 就到此为止。
     *
     * 纯物件操作（开抽屉、点灯、切状态）因此**完全不碰 ink** ——
     * 通用引擎不该要求每条交互都必须跳转 knot，也不该要求有剧情。
     */
    if (!knot) return

    // 能走过去就先走过去，走到位再触发
    const primary = runtime.primaryActor
    if (target.approach && primary) {
      const moving = runtime.moveActor(primary.spec.id, target.approach, knot)
      if (moving) return
    }
    this.runKnot(knot)
  }

  /**
   * 在场景坐标上激活物件。
   *
   * `gesture` 决定用哪种触发器：点击走 inspect/use，长按走 hold。
   */
  private activateHotspot(x: number, y: number, gesture: 'tap' | 'hold'): void {
    if (this.storyBusy) return
    const runtime = this.runtime
    if (!runtime || this.editorOnly) return

    const hotspot = runtime.hotspotAt(x, y, (h) => this.isHotspotVisible(h))
    if (!hotspot) {
      this.onEmptyTap(x, y, gesture)
      return
    }

    const resolution = resolveClick(hotspot, this.interactionContext(), gesture)
    if (resolution.intent) {
      this.runIntent(resolution.intent)
      return
    }
    // 手上有物品但用不上：先放下，再按普通点击走一遍，
    // 免得玩家以为"点了没反应"。
    if (gesture === 'tap' && this.selectedItem && resolution.failure === 'no-interaction') {
      this.setSelectedItem(null)
      const retry = resolveClick(hotspot, this.interactionContext(), gesture)
      if (retry.intent) this.runIntent(retry.intent)
    }
  }

  /** 点在空白处：出口优先，其次走过去。 */
  private onEmptyTap(x: number, y: number, gesture: 'tap' | 'hold'): void {
    if (gesture === 'hold') return
    const runtime = this.runtime
    if (!runtime) return

    const exit = runtime.exitAt(x, y, (e) => this.isExitEnabled(e))
    if (exit) {
      this.jumpToTarget(exit.to)
      return
    }

    // 点空白地面：走过去。focus 模式没有地面，这里会直接返回。
    const plane = runtime.unprojectScene(x, y)
    if (!plane) return
    const primary = runtime.primaryActor
    if (primary) runtime.moveActor(primary.spec.id, plane)
  }

  private isHotspotVisible(hotspot: Hotspot): boolean {
    return this.isConditionVisible(hotspot.visibleWhen)
  }

  /**
   * 求值一个 visibleWhen 条件。
   *
   * 绘制与命中走同一个函数，否则会出现"画出来了但点不到"这种最让人困惑的状态。
   */
  private isConditionVisible(condition: string | null): boolean {
    if (!condition) return true
    if (!this.ink.ready) return false
    return this.ink.evaluate(condition)
  }

  private isExitEnabled(exit: Exit): boolean {
    if (!exit.when) return true
    if (!this.ink.ready) return false
    return this.ink.evaluate(exit.when)
  }

  // ── 物品栏 ───────────────────────────────────────────────

  private emitInventory(): void {
    this.hooks.onInventory([...this.engine.inventory], this.selectedItem)
  }

  setSelectedItem(itemId: string | null): void {
    this.selectedItem = itemId
    this.emitInventory()
  }

  // ── 主循环 ───────────────────────────────────────────────

  /**
   * 暂停 / 恢复。
   *
   * 按**原因集合**管理：只有所有原因都解除才真的继续。这样"关掉设置面板"
   * 不会错误地恢复一个仍然在后台的游戏。
   */
  setPaused(reason: PauseReason, paused: boolean): void {
    const wasExternallyPaused = [...this.pauseReasons].some((r) => r !== 'minigame')
    if (paused) this.pauseReasons.add(reason)
    else this.pauseReasons.delete(reason)
    const nowExternallyPaused = [...this.pauseReasons].some((r) => r !== 'minigame')
    this.storyClock.setPaused(nowExternallyPaused)
    if (this.pauseReasons.size > 0) {
      this.clearPress()
      this.clearDrag()
    }
    if (nowExternallyPaused && !wasExternallyPaused) {
      this.miniGameSnapshot = this.activeMiniGame?.snapshot?.() ?? null
      this.activeMiniGame?.pause?.()
      this.audio.setPaused(true)
    } else if (!nowExternallyPaused && wasExternallyPaused) {
      const game = this.activeMiniGame
      if (game?.restore && this.miniGameSnapshot !== null) game.restore(this.miniGameSnapshot)
      game?.resume?.()
      this.miniGameSnapshot = null
      this.audio.setPaused(false)
    }
  }

  get paused(): boolean {
    return this.pauseReasons.size > 0
  }

  /** 当前暂停原因，供调试面板显示。 */
  get pauseState(): PauseReason[] {
    return [...this.pauseReasons]
  }

  update(dt: number): void {
    if (this.disposed) return
    // 暂停时冻结模拟。渲染不冻结 —— 画面仍要响应尺寸与方向变化。
    if (this.pauseReasons.size > 0) return
    this.elapsed += dt
    this.playMs += dt * 1000
    this.engine.playMs = this.playMs

    updateFx(this.fx, dt)
    this.runtime?.update(dt, {
      onFootstep: () => this.onFootstep(),
      onArrive: (actor, knot) => this.onArrive(actor, knot),
    })

    this.fpsAccum += dt
    this.frameCount += 1
    if (this.fpsAccum >= 0.5) {
      this.fps = this.frameCount / this.fpsAccum
      this.fpsAccum = 0
      this.frameCount = 0
    }

    this.autosaveCooldown -= dt
    if (this.autosaveDirty && this.autosaveCooldown <= 0) {
      this.autosaveDirty = false
      this.autosaveCooldown = 1.5
      // 指纹必须和 flushAutosave 那条路径一致 —— 否则页面被系统杀掉时，
      // 最后落盘的是一份没有指纹的存档，读档时的"内容已更新"提示会静默失效
      const snapshot = this.captureSave()
      this.saves.autosave(snapshot.inkState, snapshot.engine, this.content.contentVersion, this.content.project.saveCompatibility)
    }

    this.debugAccum += dt
    if (this.debugAccum >= 0.25) {
      this.debugAccum = 0
      this.emitDebug()
    }
  }

  render(): void {
    if (this.disposed || !this.runtime) return
    renderScene({
      runtime: this.runtime,
      stage: this.stage,
      resources: this.resources,
      debug: this.debug,
      fx: this.fx,
      elapsed: this.elapsed,
      hoverId: this.hoverId,
      // 按下高亮：手机上没有 hover，按压反馈才是「这里能点」的主要线索
      pressedId: this.pressedId,
      // 渲染层不该知道 ink 的存在，所以 visibleWhen 由这里求值后传进去。
      // 漏传的话带条件的物件会在条件为假时照样被画出来（看得见却点不到）。
      isVisible: (owner) => this.isConditionVisible(owner.visibleWhen),
      drag:
        this.dragArmed && this.dragPoint
          ? {
              itemId: this.dragArmed.itemId,
              label: this.content.itemLabels[this.dragArmed.itemId] ?? this.dragArmed.itemId,
              point: this.dragPoint,
              // 只有指针真的落在"接受这个物品"的物件上才算可放置
              overTarget: this.dropTargetId !== null,
            }
          : null,
    })
  }

  /**
   * @param bottomInset 底部为对话框预留的高度（CSS 像素）。
   *   场景只在剩余区域里 letterbox，避免角色走到最前排被对话框盖住。
   */
  /**
   * @param bottomInset 画面底部要让开的像素（对话框占用）
   * @param rightInset  画面右侧要让开的像素（侧栏占用）
   * @param groundBottomInset
   *   走动深度要让开的像素。默认跟 `bottomInset` 一样。
   *
   *   **画面让不让开是可选的，走动深度不是。** 对话浮在画面上时（overlay）
   *   画面铺满整屏，但角色仍然不能走到文本框后面去 —— 那看起来就是人走进
   *   墙里。所以这两个值分开传。
   */
  resize(
    cssWidth: number,
    cssHeight: number,
    bottomInset = 0,
    rightInset = 0,
    groundBottomInset = bottomInset,
  ): void {
    // 先同步宽高比再算视口。原来这里 resize 了两次，第一次纯属浪费。
    this.lastResize = {
      w: cssWidth,
      h: cssHeight,
      bottom: Math.max(0, bottomInset),
      right: Math.max(0, rightInset),
      groundBottom: Math.max(0, groundBottomInset),
    }
    this.stage.aspect = this.runtime?.aspect ?? this.stage.aspect
    this.stage.bottomInset = Math.max(0, bottomInset)
    this.stage.rightInset = Math.max(0, rightInset)
    this.stage.resize(cssWidth, cssHeight)

    /*
     * 场景坐标本身不变，但两件事会让画面上的纵深变得不可用：
     *   · `cover` 裁掉了画面上下两端
     *   · 对话框盖住了底部一条
     * 地面角点是按整张画面标的，player 走到那一段就等于走出屏幕。
     * 这里把走动深度夹到"既在画面内、又在对话框上方"的那一段。
     */
    const viewport = this.stage.viewport
    const groundLimit = Math.max(0, groundBottomInset)
    const v1 =
      groundLimit > 0 && viewport.h > 0
        ? Math.min(viewport.visibleV1, (cssHeight - groundLimit - viewport.y) / viewport.h)
        : viewport.visibleV1
    this.runtime?.setVisibleBounds(viewport.visibleU0, viewport.visibleV0, viewport.visibleU1, v1)
  }

  toScene(clientX: number, clientY: number): [number, number] | null {
    return this.stage.toScene(clientX, clientY)
  }

  setDebug(flags: Partial<DebugFlags>): void {
    this.debug = { ...this.debug, ...flags }
  }

  get debugFlags(): DebugFlags {
    return { ...this.debug }
  }

  // ── 存档 ─────────────────────────────────────────────────

  /**
   * 把当前运行时的空间状态并回引擎状态。
   *
   * **换场景之前必须调**，否则上一个场景的物件状态会随着 runtime 被丢弃 ——
   * 表现就是"抽屉打开、走出去再回来，抽屉又关上了"。
   * 存档前也要调，让内存里的 engine 和写出去的内容一致。
   */
  private syncRuntimeState(): void {
    const runtime = this.runtime
    if (!runtime) return

    this.engine.scenes = { ...this.engine.scenes, ...runtime.snapshotObjectStates() }

    // 角色位置按 `${场景}:${角色}` 存。只按角色 id 存会让不同场景里同名的
    // 角色互相串位 —— 走廊里的 hero 会用房间里的 hero 上次站的位置出生。
    const positions: EngineState['actorPositions'] = {}
    const facings: EngineState['actorFacing'] = {}
    for (const actor of runtime.actors) {
      const key = sceneObjectKey(runtime.scene.id, actor.spec.id)
      positions[key] = [actor.u, actor.v]
      facings[key] = actor.facingTarget
    }
    this.engine.actorPositions = { ...this.engine.actorPositions, ...positions }
    this.engine.actorFacing = { ...this.engine.actorFacing, ...facings }
    this.engine.playMs = this.playMs
  }

  private snapshotEngine(): EngineState {
    this.syncRuntimeState()
    /*
     * 呈现检查点。
     *
     * 只存 ink 指针是不够的 —— ink 的状态里没有"这句话已经显示、但玩家还没点掉"，
     * 因为 Continue() 已经把那一行消费掉了。少了它，读档回来会跳过一整句台词。
     * 选项不用存：待选项本来就在 ink 的 currentChoices 里。
     */
    this.engine.checkpoint = {
      line: this.waitingForAdvance && this.currentLine ? { ...this.currentLine } : null,
      pendingSceneId: this.pendingSceneId,
      storyPhase: this.storyPhase,
    }
    return structuredClone(this.engine)
  }

  markAutosave(): void {
    this.autosaveDirty = true
  }

  /*
   * ── 能力状态 ───────────────────────────────────────────────
   *
   * 引擎只负责**保存和还原**，不解释内容。好感度、相册、日历、聊天记录
   * 这些概念不进核心：引擎不知道 `affection` 里放的是数字还是对象，
   * 也不知道它代表什么。
   *
   * 好处很实际：加一个新能力不用动存档结构，也就不用再加一次版本迁移。
   * 代价是引擎没法替能力做语义校验 —— 那本来就该由能力模块自己负责。
   */

  /** 读某个命名空间的状态。没有时返回 null（不是 undefined，避免和"存了 undefined"混淆）。 */
  getCapabilityState<T = unknown>(namespace: string): T | null {
    const value = this.engine.capabilities[namespace]
    return value === undefined ? null : (value as T)
  }

  /**
   * 写某个命名空间的状态。传 null 删除该命名空间。
   *
   * 只接受能安全往返 JSON 的值：函数、NaN、循环引用会让整份存档写不出去，
   * 而且失败发生在存档那一刻 —— 离出错的地方很远，最难查。
   * 这里宁可当场拒绝。
   */
  setCapabilityState(namespace: string, value: unknown): boolean {
    if (!namespace) return false
    if (value === null) {
      delete this.engine.capabilities[namespace]
      this.autosaveDirty = true
      return true
    }
    const { state, dropped } = sanitizeCapabilityState({ [namespace]: value })
    if (dropped.includes(namespace)) return false
    this.engine.capabilities[namespace] = state[namespace]
    this.autosaveDirty = true
    return true
  }

  /** 当前有哪些命名空间。调试与测试用。 */
  get capabilityNamespaces(): string[] {
    return Object.keys(this.engine.capabilities).sort()
  }

  private captureSave(): { inkState: string; engine: EngineState } {
    if (this.storyBusy && this.stableSave) return structuredClone(this.stableSave)
    return { inkState: this.ink.saveState(), engine: this.snapshotEngine() }
  }

  saveTo(slot: string, label: string): boolean {
    const snapshot = this.captureSave()
    return this.saves.save(slot, label, snapshot.inkState, snapshot.engine, this.content.contentVersion, this.content.project.saveCompatibility)
  }

  /** 强制立即写一次自动存档，用于"离开页面前"。 */
  flushAutosave(): void {
    this.autosaveDirty = false
    const snapshot = this.captureSave()
    this.saves.autosave(snapshot.inkState, snapshot.engine, this.content.contentVersion, this.content.project.saveCompatibility)
  }

  // ── 内部回调 ─────────────────────────────────────────────

  private onFootstep(): void {
    // 脚步音效由内容提供；没有对应素材时 AudioBus 会静默降级
    void 0
  }

  private onArrive(actor: Actor, knot: string | null): void {
    if (!knot) return
    void actor
    this.runKnot(knot)
  }

  /**
   * 当前调试信息。
   *
   * 抽成 getter 是为了自动化测试能直接读 —— 内存与缓存这类问题，
   * 看不见就管不住。
   */
  get debugInfo(): DebugInfo {
    const actor = this.runtime?.primaryActor
    return {
      fps: this.fps,
      sceneId: this.runtime?.scene.id ?? null,
      actorU: actor?.u ?? 0,
      actorV: actor?.v ?? 0,
      phase: actor?.phase ?? 0,
      walkBlend: actor?.walkBlend ?? 0,
      speed: actor?.speed ?? 0,
      facing: actor?.facing ?? 1,
      missingAssets: this.assets.missingAssets,
      // 图片缓存占用：内存问题只有看得见才管得住
      imageCache: this.assets.cacheStats,
      warnings: this.content.warnings,
      editorOnly: this.editorOnly,
      sceneMode: this.runtime?.mode ?? null,
      lastEvent: this.lastEvent ? `${this.lastEvent.name} @ ${this.lastEvent.objectId}` : null,
      objectStates: this.snapshotObjectLabels(),
      flags: { ...this.engine.flags },
    }
  }

  /** 最近发生的交互事件（有上限，见 EventBridge）。 */
  get eventHistory(): readonly InteractionEvent[] {
    return this.bridge.history
  }

  private emitDebug(): void {
    this.hooks.onDebug(this.debugInfo)
  }

  /** 调试面板用：物件 id → 当前状态名（不可见则显示 hidden）。 */
  private snapshotObjectLabels(): Record<string, string> {
    const runtime = this.runtime
    if (!runtime) return {}
    const out: Record<string, string> = {}
    const scene = runtime.scene
    for (const item of [...scene.hotspots, ...scene.layers]) {
      const state = runtime.objectState(item.id)
      if (!state) continue
      out[item.id] = state.visible ? (state.state ?? '—') : 'hidden'
    }
    return out
  }

  getFlag(key: string): FlagValue | undefined {
    return this.engine.flags[key]
  }

  get audioSettings(): AudioSettings {
    return this.audio.getSettings()
  }
}