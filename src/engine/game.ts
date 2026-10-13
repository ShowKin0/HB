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
import type { Actor } from './actor/actor.ts'
import { CanvasStage } from '../render/stage.ts'
import { createFxState, triggerFx, updateFx, type FxState } from '../render/fx.ts'
import { DEFAULT_DEBUG, renderScene, type DebugFlags } from '../render/sceneRenderer.ts'

export interface DialogueLine {
  text: string
  speaker: string | null
  portrait: string | null
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
  warnings: string[]
  /** 调试浮层与编辑器的退出/进入回调，由 UI 提供。 */
  editorOnly: boolean
  /** 当前场景模式：walk 可走动，focus 固定镜头。 */
  sceneMode: 'walk' | 'focus' | null
  /** 最近一次交互事件，形如 "photo_frame_inspect @ photo_frame"。 */
  lastEvent: string | null
  /** 物件 id → 当前视觉状态名（不可见显示 hidden）。 */
  objectStates: Record<string, string>
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
  debug?: DebugFlags
  /** 编辑器模式：不推进剧情，只负责场景与角色。 */
  editorOnly?: boolean
}

/** 小游戏失败几次后允许跳过。生日礼物不能卡关。 */
const MINIGAME_SKIP_AFTER = 3

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

  readonly assets = new AssetStore()
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
  private readonly resources = new Map<string, unknown>()
  private engine: EngineState = createEmptyEngineState()
  private selectedItem: string | null = null
  private currentSpeaker: string | null = null
  private currentPortrait: string | null = null
  private disposed = false
  private elapsed = 0
  private playMs = 0
  private autosaveDirty = false
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
  private dragArmed: { hotspotId: string; itemId: string; origin: [number, number] } | null = null
  private dragPoint: [number, number] | null = null
  private dragging = false
  /** 拖拽中指针下方的、确实能接收该物品的物件 id。 */
  private dropTargetId: string | null = null
  /** 最近一次交互事件，供调试面板显示。 */
  private lastEvent: InteractionEvent | null = null
  /** 已经报过的交互层告警，避免同一个问题刷屏。 */
  private readonly warnedInteractions = new Set<string>()

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
    this.audio.setSettings(DEFAULT_AUDIO_SETTINGS)
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

  /** 当前视口，供自动化测试把场景坐标换算成页面坐标。 */
  get viewport(): { x: number; y: number; w: number; h: number } {
    const v = this.stage.viewport
    return { x: v.x, y: v.y, w: v.w, h: v.h }
  }

  get engineState(): EngineState {
    return this.engine
  }

  get currentSceneId(): string | null {
    return this.runtime?.scene.id ?? null
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
  } {
    return {
      hoverId: this.hoverId,
      dragArmed: this.dragArmed?.hotspotId ?? null,
      dragging: this.dragging,
      dropTargetId: this.dropTargetId,
    }
  }

  // ── 生命周期 ─────────────────────────────────────────────

  async start(save: Save | null = null): Promise<void> {
    // 作废所有在飞的推进，并清掉上一局残留的挂起状态
    this.storyGeneration += 1
    this.pendingSceneId = null
    this.queuedKnot = null
    this.waitingForAdvance = false
    this.storyPhase = 'idle'

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

      this.engine = save.engine
      this.playMs = save.engine.playMs
      const restored = this.ink.ready && this.ink.loadState(save.inkState)
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

      this.emitInventory()
      return
    }

    this.engine = createEmptyEngineState(this.content.startSceneId)
    const startScene = this.content.startSceneId
    if (startScene) {
      this.engine.visitedScenes = [startScene]
      await this.enterScene(startScene, true)
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
    this.audio.dispose()
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

  private async enterScene(sceneId: string, runEntry: boolean): Promise<void> {
    const scene = this.content.scenes.get(sceneId)
    if (!scene) {
      this.hooks.onError(`找不到场景 "${sceneId}"`)
      return
    }

    // 先把上一个场景的空间状态并回引擎，再把它换掉 ——
    // 否则那些状态会随着旧 runtime 一起丢掉。
    this.syncRuntimeState()

    const runtime = await SceneRuntime.create(scene, this.assets, this.engine.scenes)
    this.runtime = runtime
    this.resources.clear()
    // 换场景时把悬停/拖拽状态清掉，否则会留着一个指向旧场景物件的 id
    this.hoverId = null
    this.dragArmed = null
    this.dragPoint = null
    this.dragging = false
    for (const actor of runtime.actors) {
      this.resources.set(actor.spec.id, await prepareActorRenderer(actor.spec, this.assets))
    }

    this.stage.aspect = scene.aspect
    this.engine.sceneId = sceneId
    if (!this.engine.visitedScenes.includes(sceneId)) this.engine.visitedScenes.push(sceneId)

    if (scene.bgm) this.audio.playBgm(scene.bgm, 1.2)
    else this.audio.stopBgm(0.8)

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

    this.hooks.onScene(sceneId, scene.title, scene.aspect)

    // 这里只负责跳转，**不推进**。
    // 调用方（drainStory 或 start）此刻可能正持有推进锁，在这里再调一次
    // drainStory 会被锁挡掉，入口剧情就永远播不出来。
    if (runEntry && !this.editorOnly && scene.entry && this.ink.hasKnot(scene.entry)) {
      this.storyPhase = 'entry'
      this.ink.jumpTo(scene.entry)
    }
    this.markAutosave()
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

        const line = this.ink.next()
        if (!line) break

        if (line.tags.length > 0) {
          await applyDirectives(line.tags, this.directiveContext())
        }

        // 有文本就先显示。场景切换留到玩家推进之后再执行 ——
        // 先切场景会把同一行上的文字整句吞掉。
        if (line.text.length > 0) {
          this.waitingForAdvance = true
          this.hooks.onLine({
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
      if (!awaitingChoice) this.hooks.onLine(null)
    } finally {
      this.storyBusy = false
    }

    if (generation !== this.storyGeneration) return

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
    if (!this.waitingForAdvance) return
    this.waitingForAdvance = false
    this.hooks.onLine(null)
    void this.drainStory(0)
  }

  choose(index: number): void {
    // 推进中（例如 # wait: 挂起时）不接受选项，否则 ink 指针会被挪走，
    // 而正在跑的循环还从新位置继续读。
    if (this.storyBusy) return
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
    return {
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
      playBgm: (path, fade) => this.audio.playBgm(path, fade),
      stopBgm: (fade) => this.audio.stopBgm(fade),
      playSfx: (value) => this.audio.playSfx(resolveAudio('sfx', value)),
      playVo: (value) => this.audio.playVo(resolveAudio('vo', value)),
      runFx: (name, args) => triggerFx(this.fx, name, args),
      wait: (seconds) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000)),
      actorCommand: (actorId, command, args) => this.actorCommand(actorId, command, args),
      runMiniGame: (id, args) => this.runMiniGame(id, args),
      setFlag: (key, value) => {
        this.engine.flags[key] = value
        this.markAutosave()
      },
      award: (itemId) => {
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
  }

  private async applyBackground(path: string | null): Promise<void> {
    if (!this.runtime) return
    this.runtime.backgroundOverride = path ? await this.assets.image(path) : null
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

    const game = getMiniGame(id)
    if (!game) {
      this.hooks.onError(`没有注册名为 "${id}" 的小游戏`)
      return null
    }

    const params: Record<string, unknown> = {}
    const length = Number.parseFloat(args[0] ?? '')
    if (Number.isFinite(length)) params.length = length
    const speed = Number.parseFloat(args[1] ?? '')
    if (Number.isFinite(speed)) params.speed = speed

    const host = document.createElement('div')
    document.body.appendChild(host)

    // 用容器对象而不是裸变量：句柄是在 Promise 执行器里赋值的，
    // 直接读裸变量会被控制流分析窄化成 never。
    const holder: { current: MiniGameHandle | null } = { current: null }
    let failures = 0
    let settled = false

    const result = await new Promise<unknown>((resolve) => {
      const finish = (value: unknown): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      holder.current = game.mount(host, params as never, {
        resolve: finish,
        reportFailure: () => {
          failures += 1
        },
        requestSkip: () => finish({ success: false, skipped: true, failures }),
        get failures() {
          return failures
        },
        skipAfter: MINIGAME_SKIP_AFTER,
      })
    })

    holder.current?.destroy()
    host.remove()

    const payload = result as { success?: boolean; skipped?: boolean } | null
    this.ink.setVariable('minigame_success', payload?.success === true)
    this.ink.setVariable('minigame_skipped', payload?.skipped === true)
    this.markAutosave()
    return result
  }

  private actorCommand(actorId: string, command: string, args: string[]): void {
    const actor = this.runtime?.actorById(actorId)
    if (!actor || !this.runtime) return

    switch (command) {
      case 'walkTo': {
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
        actor.path = null
        actor.speed = 0
        break
      default:
        if (import.meta.env.DEV) console.warn(`[actor] 未知命令 "${command}"`)
    }
  }

  // ── 输入 ─────────────────────────────────────────────────

  /** 场景空间坐标上的点击。 */
  pointerDown(x: number, y: number): void {
    if (this.waitingForAdvance) {
      this.advanceStory()
      return
    }
    if (this.ink.choices.length > 0) return
    // 剧情正在推进（例如 # wait: 或小游戏挂起中）时不接受世界交互，
    // 否则会中途改道，把正在跑的推进循环搞乱。
    if (this.storyBusy) return

    const runtime = this.runtime
    if (!runtime || this.editorOnly) return

    const hotspot = runtime.hotspotAt(x, y, (h) => this.isHotspotVisible(h))
    if (hotspot) {
      // 手上拿着东西、而目标正好接受它 —— 先别急着触发，可能是要拖过去。
      // 等指针移开阈值再判定，这样"点一下用"和"拖过去用"不会打架。
      if (this.selectedItem && this.acceptsDrop(hotspot, this.selectedItem)) {
        this.dragArmed = { hotspotId: hotspot.id, itemId: this.selectedItem, origin: [x, y] }
        this.dragPoint = [x, y]
        return
      }
      this.activateHotspot(hotspot)
      return
    }

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

  /** 指针移动：更新悬停高亮，以及拖拽进度。 */
  pointerMove(x: number, y: number): void {
    const runtime = this.runtime
    if (!runtime || this.editorOnly) return

    // 指针离开画面时上层会传 (-1, -1)，此时只清悬停
    if (x < 0 || y < 0) {
      this.hoverId = null
      return
    }

    if (this.dragArmed) {
      this.dragPoint = [x, y]
      if (!this.dragging) {
        const dx = (x - this.dragArmed.origin[0]) * runtime.aspect
        const dy = y - this.dragArmed.origin[1]
        // 阈值按场景比例算，避免不同屏幕尺寸下手感不一致
        if (Math.hypot(dx, dy) > 0.02) this.dragging = true
      }
      if (this.dragging) {
        /*
         * 拖拽期间高亮必须跟着指针走。
         * 原来这里直接 return，高亮一直停在**起点**那个物件上，
         * 而"可以放这里"的提示又恒为真 —— 玩家会以为放到哪里都行。
         */
        const under = runtime.hotspotAt(x, y, (h) => this.isHotspotVisible(h))
        const canDrop = under !== null && this.acceptsDrop(under, this.dragArmed.itemId)
        this.hoverId = canDrop ? under.id : null
        this.dropTargetId = canDrop ? under.id : null
      }
      return
    }

    const hotspot = runtime.hotspotAt(x, y, (h) => this.isHotspotVisible(h))
    this.hoverId = hotspot?.id ?? null
  }

  /** 指针离开画面：清掉悬停高亮，并取消未完成的拖拽。 */
  pointerCancel(): void {
    this.hoverId = null
    // 指针在窗口外抬起时收不到 pointerup，不在这里取消的话，
    // dragArmed 会一直挂着，之后每次移动都被当成在拖东西。
    this.dragArmed = null
    this.dragPoint = null
    this.dragging = false
    this.dropTargetId = null
  }

  /** 指针抬起：结算拖拽。没拖动就按普通点击处理。 */
  pointerUp(x: number, y: number): void {
    const runtime = this.runtime
    const armed = this.dragArmed
    this.dragArmed = null
    this.dragPoint = null
    if (!runtime || this.editorOnly) return
    if (!armed) return

    if (!this.dragging) {
      // 只是点了一下 —— 按普通点击结算（use 或 inspect）
      const hotspot = runtime.hotspotAt(x, y, (h) => this.isHotspotVisible(h))
      if (hotspot) this.activateHotspot(hotspot)
      this.dragging = false
      return
    }

    this.dragging = false
    const target = runtime.hotspotAt(x, y, (h) => this.isHotspotVisible(h))
    if (!target) return

    const resolution = resolveDrop(target, armed.itemId, this.interactionContext())
    if (resolution.intent) {
      this.runIntent(resolution.intent)
      return
    }
    if (resolution.failure === 'condition-failed') {
      this.hooks.onError?.(`现在还不能这么做`)
    }
  }

  /** 悬停：返回光标类型，用于 UI。 */
  cursorFor(x: number, y: number): string {
    const runtime = this.runtime
    if (!runtime) return 'default'
    if (this.waitingForAdvance) return 'advance'
    if (this.dragArmed) return this.dragging ? 'grabbing' : 'grab'
    return runtime.cursorAt(x, y, (h) => this.isHotspotVisible(h))
  }

  /** 解析器需要的上下文。 */
  private interactionContext(): InteractionContext {
    return {
      selectedItem: this.selectedItem,
      evaluate: (name) => (this.ink.ready ? this.ink.evaluate(name) : false),
      // 同一个告警只说一次：解析器在 pointerDown / pointerUp / hover 里都会被调用，
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

    // 1. 空间状态变更
    if (interaction.setState !== null) runtime.patchObjectState(target.id, { state: interaction.setState })
    if (interaction.setVisible !== null) runtime.patchObjectState(target.id, { visible: interaction.setVisible })
    if (interaction.setState !== null || interaction.setVisible !== null) this.autosaveDirty = true

    // 2. 音效
    if (interaction.sfx) this.audio.playSfx(interaction.sfx)

    // 3. 事件桥：记进存档 + 同步给 ink
    this.bridge.emit({
      name: eventNameFor(target, interaction),
      sceneId: runtime.scene.id,
      objectId: target.id,
      verb: interaction.verb,
      item: intent.kind === 'use' ? interaction.item : null,
      at: this.playMs,
    })

    // 4. 用掉的物品从手上拿走
    if (intent.kind === 'use' || intent.kind === 'drag') this.setSelectedItem(null)

    // 5. 推进剧情：能走过去就先走过去，走到位再触发
    const primary = runtime.primaryActor
    if (target.approach && primary) {
      const moving = runtime.moveActor(primary.spec.id, target.approach, interaction.action)
      if (moving) return
    }
    this.runKnot(interaction.action)
  }

  private activateHotspot(hotspot: Hotspot): void {
    const resolution = resolveClick(hotspot, this.interactionContext())
    if (resolution.intent) {
      this.runIntent(resolution.intent)
      return
    }
    // 手上有物品但用不上：先放下，再按普通点击走一遍，
    // 免得玩家以为"点了没反应"。
    if (this.selectedItem && resolution.failure === 'no-interaction') {
      this.setSelectedItem(null)
      const retry = resolveClick(hotspot, this.interactionContext())
      if (retry.intent) this.runIntent(retry.intent)
    }
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

  update(dt: number): void {
    if (this.disposed) return
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
      this.saves.autosave(this.ink.saveState(), this.snapshotEngine())
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
  resize(cssWidth: number, cssHeight: number, bottomInset = 0): void {
    // 先同步宽高比再算视口。原来这里 resize 了两次，第一次纯属浪费。
    this.stage.aspect = this.runtime?.aspect ?? this.stage.aspect
    this.stage.bottomInset = Math.max(0, bottomInset)
    this.stage.resize(cssWidth, cssHeight)
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
    this.engine.actorPositions = positions
    this.engine.actorFacing = facings
    this.engine.playMs = this.playMs
  }

  private snapshotEngine(): EngineState {
    this.syncRuntimeState()
    return { ...this.engine }
  }

  markAutosave(): void {
    this.autosaveDirty = true
  }

  saveTo(slot: string, label: string): boolean {
    return this.saves.save(slot, label, this.ink.saveState(), this.snapshotEngine(), this.content.contentVersion)
  }

  /** 强制立即写一次自动存档，用于"离开页面前"。 */
  flushAutosave(): void {
    this.autosaveDirty = false
    this.saves.autosave(this.ink.saveState(), this.snapshotEngine(), this.content.contentVersion)
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

  private emitDebug(): void {
    const actor = this.runtime?.primaryActor
    this.hooks.onDebug({
      fps: this.fps,
      sceneId: this.runtime?.scene.id ?? null,
      actorU: actor?.u ?? 0,
      actorV: actor?.v ?? 0,
      phase: actor?.phase ?? 0,
      walkBlend: actor?.walkBlend ?? 0,
      speed: actor?.speed ?? 0,
      facing: actor?.facing ?? 1,
      missingAssets: this.assets.missingAssets,
      warnings: this.content.warnings,
      editorOnly: this.editorOnly,
      sceneMode: this.runtime?.mode ?? null,
      lastEvent: this.lastEvent ? `${this.lastEvent.name} @ ${this.lastEvent.objectId}` : null,
      objectStates: this.snapshotObjectLabels(),
    })
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
