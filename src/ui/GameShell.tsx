import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Game, type DebugInfo, type DialogueLine } from '../engine/game.ts'
import type { ChoiceView } from '../engine/ink/inkBridge.ts'
import { loadContent } from '../content/load.ts'
import { applyTheme } from '../theme/applyTheme.ts'
import { AUTO_SLOT, SaveManager } from '../engine/save.ts'
import { InputRouter, type GestureEvent, type PointerSample } from '../engine/input/router.ts'
import { OrientationGate } from './OrientationGate.tsx'
import { useOrientation, useOrientationBlocked, useViewportSize } from './useOrientation.ts'
import {
  DEFAULT_DIALOGUE_LAYOUT,
  mergeDialogueLayout,
  resolveDialoguePlacement,
  shouldBlockWorldInput,
} from '../schema/layout.rules.ts'
import { useAudioSettings, useUi, type PanelKind } from '../state/store.ts'
import { DialogueBox } from './DialogueBox.tsx'
import { ChoiceList } from './ChoiceList.tsx'
import { Hud } from './Hud.tsx'
import { Panels } from './Panels.tsx'
import { Toasts } from './Toasts.tsx'
import styles from './ui.module.css'

/** 固定时间步长：60Hz 与 120Hz 手机上速度与手感完全一致。 */
const FIXED_DT = 1 / 60
const MAX_STEPS_PER_FRAME = 5

/**
 * 引擎给出的光标语义 → 实际 CSS 光标。
 *
 * 之前只映射了 advance，其余一律落回 default —— 等于热点光标提示
 * 完全没生效（hover 时光标纹丝不动）。
 */
const CURSOR_STYLES: Record<string, string> = {
  default: 'default',
  advance: 'pointer',
  look: 'help',
  take: 'grab',
  use: 'pointer',
  talk: 'pointer',
  walk: 'crosshair',
  // 拖拽态：抓起物品 / 拖着物品移动
  grab: 'grab',
  grabbing: 'grabbing',
}

export function GameShell(): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gameRef = useRef<Game | null>(null)
  const labelsRef = useRef<Record<string, string>>({})
  const savesRef = useRef<SaveManager | null>(null)
  /**
   * 渲染期需要读到的引擎实例单独放 state。
   * 直接读 gameRef.current 会在渲染期访问 ref —— React 明确不允许，
   * 因为并发渲染下渲染结果与 ref 的值可能对不上。
   */
  const [game, setGame] = useState<Game | null>(null)
  /** `start()` 里那个 resize 闭包。布局形态变化时要主动调一次，见下面的说明。 */
  const resizeRef = useRef<(() => void) | null>(null)

  const boot = useUi((state) => state.boot)
  const bootMessage = useUi((state) => state.bootMessage)
  const line = useUi((state) => state.line)
  const choices = useUi((state) => state.choices)
  const inventory = useUi((state) => state.inventory)
  const selectedItem = useUi((state) => state.selectedItem)
  const panel = useUi((state) => state.panel)
  const cursor = useUi((state) => state.cursor)
  const debugFlags = useUi((state) => state.debugFlags)

  /**
   * 循环、观察器与引擎的拆解动作，由 start() 填充。
   *
   * 注意 start() 里有多个 await，而 effect 的 cleanup 会在这些 await 之前
   * 就同步跑掉（StrictMode 的 mount → cleanup → mount 尤其如此）。
   * 所以除了这个 ref，还必须传一个 isCancelled 谓词进去：
   * 只靠 ref 的话，第一个实例的 ref 还没赋值就已经被 cleanup 查过了，
   * 结果就是**两个 Game 同时跑 rAF、同时往一块画布上画**，第一个永不销毁。
   */
  const cleanupRef = useRef<(() => void) | null>(null)
  /** 手势状态机。它不属于任何一局游戏，所以放在组件级。 */
  const routerRef = useRef(new InputRouter())
  /** 是否处于右侧面板形态（宽高比 ≥ 1.9 的横屏）。由 resize 实测得出。 */

  const start = useCallback(async (isCancelled: () => boolean): Promise<void> => {
    const ui = useUi.getState()
    const canvas = canvasRef.current
    const root = rootRef.current
    if (!canvas || !root) return

    ui.setBoot('loading', '正在准备……')

    const content = await loadContent()
    if (isCancelled()) return

    /*
     * 主题由内容包声明，引擎按名字惰性加载。
     *
     * 放在这里而不是模块顶层：要先读到 project.json 才知道用哪套主题，
     * 而没声明的主题不该进首屏。
     */
    await applyTheme(content.project.theme)
    if (isCancelled()) return

    labelsRef.current = content.itemLabels

    const saves = new SaveManager()
    savesRef.current = saves
    ui.setSlots(saves.list())
    ui.setHasContinue(saves.hasContinue())
    ui.setBoot(content.startSceneId ? 'ready' : 'error', content.startSceneId ? '' : '没有找到可用场景')

    const hooks = {
      onLine: (next: DialogueLine | null) => useUi.getState().setLine(next),
      onChoices: (next: ChoiceView[]) => useUi.getState().setChoices(next),
      onScene: (id: string, title: string, aspect: number) => useUi.getState().setScene(id, title, aspect),
      onInventory: (items: string[], selected: string | null) =>
        useUi.getState().setInventory(items, selected),
      onError: (message: string) => useUi.getState().toast(message, 'error'),
      onDebug: (info: DebugInfo) => useUi.getState().setDebug(info),
    }

    const game = new Game({
      canvas,
      content,
      hooks,
      saves,
      // 持久化的音量在构造时就给进去，别先起默认值再纠正
      audioSettings: useAudioSettings.getState().audio,
      debug: { ...useUi.getState().debugFlags },
    })
    gameRef.current = game
    // 自动化测试与编辑器共用的调试句柄。游戏是私人用途的单页应用，
    // 暴露一个句柄换来的可测性远比这点"泄漏"有价值。
    const debugHandle = window as unknown as { __HB__?: Game }
    debugHandle.__HB__ = game

    // 有进度就直接续上 —— 生日礼物不该先让人做选择题
    const save = content.startSceneId ? saves.load(AUTO_SLOT) : null
    try {
      await game.start(save)
    } catch (error) {
      if (debugHandle.__HB__ === game) delete debugHandle.__HB__
      if (gameRef.current === game) gameRef.current = null
      game.dispose()
      throw error
    }

    // 到这里如果已经被取消，必须自己把 game 收干净，因为 cleanup 已经跑过了
    if (isCancelled()) {
      if (debugHandle.__HB__ === game) delete debugHandle.__HB__
      if (gameRef.current === game) gameRef.current = null
      game.dispose()
      return
    }

    setGame(game)

    /*
     * 布局探针：尺寸由 CSS 按当前对话形态给出，这里只读解析后的像素。
     *
     * 不要用 getComputedStyle().getPropertyValue('--x') ——
     * 自定义属性返回的是未求值的 calc(...) 文本，parseFloat 得到 NaN。
     * （这条已经被"角色不会被对话框盖住"的 E2E 抓到过。）
     */
    const probe = root.querySelector<HTMLElement>('[data-inset-probe]')

    /**
     * 场景要避让的空间。
     *
     * 读的是**探针元素的实测尺寸**，而探针的尺寸由 CSS 按当前
     * `[data-dialogue]` 形态给出 —— JS 只知道"要避开多少"，
     * 不知道也不关心"对话在底部还是右侧"，那是内容和主题的声明。
     *
     * 用探针而不是读 `--scene-inset` 变量：`getComputedStyle().getPropertyValue('--x')`
     * 返回的是**未求值的 token 流**（形如 `calc(...)`），parseFloat 得到 NaN。
     */
    /**
     * 对话**自己占多大地方**（footprint）。
     *
     * 探针的尺寸由 CSS 按当前 `[data-dialogue]` 形态给出 —— JS 只知道
     * "占了多少"，不知道也不关心"对话在底部还是右侧"，那是内容和主题的声明。
     *
     * 用探针而不是读 `--scene-inset` 这类变量：`getComputedStyle()
     * .getPropertyValue('--x')` 返回的是**未求值的 token 流**（形如
     * `calc(...)`），parseFloat 得到 NaN，结果是 inset 悄悄变成 0。
     * （这条已经被"角色不会被对话框盖住"的 E2E 抓到过。）
     */
    const footprintBottom = (): number => {
      const rect = root.getBoundingClientRect()
      // 上限 42%：极端窄屏上如果不封顶，场景会被压得没法看
      return Math.min(probe?.offsetHeight ?? 0, rect.height * 0.42)
    }

    /** 右侧给对话面板让出的宽度。底部/浮层/无对话时是 0。 */
    const footprintRight = (): number => probe?.offsetWidth ?? 0

    const resize = (): void => {
      const rect = root.getBoundingClientRect()
      const bottom = footprintBottom()
      const right = footprintRight()
      /*
       * **画面让不让开是内容说了算，走动深度不是。**
       *
       * 内容声明 `reserveSceneSpace: false` 时画面铺满整屏、对话浮在上面
       * （galgame 那种文本框压在画上的感觉）；但角色仍然不能走到文本框
       * 后面去 —— 那看起来就是人走进墙里。所以底部占用**照传**给引擎，
       * 由它只用来收窄走动深度。
       */
      const reserve = root.getAttribute('data-dialogue-reserve') !== 'false'
      game.resize(rect.width, rect.height, reserve ? bottom : 0, reserve ? right : 0, bottom)
    }
    resize()
    /*
     * 布局形态变化时要**主动**重量一次。
     *
     * `[data-dialogue]` 一变，探针的尺寸跟着变，但 .root 自己的尺寸没变 ——
     * ResizeObserver 只在被观察元素尺寸变化时触发，所以这里它**不会响**。
     * 少了这一下，引擎会一直用切换前的 inset：场景伸到面板底下，
     * 角色被盖住。多尺寸用例在 844×390 上就是这么挂的。
     */
    resizeRef.current = resize

    const observer = new ResizeObserver(resize)
    observer.observe(root)
    // 视口高度变化时 --dialogue-band（含 vh）也会变，跟着重算一次
    window.addEventListener('resize', resize)

    let raf = 0
    let last = performance.now()
    let accumulator = 0
    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame)
      const elapsed = Math.min(0.25, (now - last) / 1000)
      last = now
      // 长按由循环推进而不是 setTimeout：暂停时循环不走，长按自然也不会误触发
      for (const gesture of routerRef.current.tick(now)) game.handleGesture(gesture)
      accumulator += elapsed
      let steps = 0
      while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
        game.update(FIXED_DT)
        accumulator -= FIXED_DT
        steps += 1
      }
      // 掉帧过久时丢弃积压，避免"追帧"导致的跳跃
      if (steps >= MAX_STEPS_PER_FRAME) accumulator = 0
      game.render()
    }
    raf = requestAnimationFrame(frame)

    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') {
        // 切后台：先取消手势（手指还按着的状态不该被保存），再存最近的稳定快照
        for (const gesture of routerRef.current.cancel('visibility')) game.handleGesture(gesture)
        game.setPaused('hidden', true)
        game.flushAutosave()
      } else {
        game.setPaused('hidden', false)
      }
    }
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', onHidden)

    cleanupRef.current = () => {
      for (const gesture of routerRef.current.cancel('destroyed')) game.handleGesture(gesture)
      resizeRef.current = null
      cancelAnimationFrame(raf)
      observer.disconnect()
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', onHidden)
      game.flushAutosave()
      game.dispose()
      if (gameRef.current === game) gameRef.current = null
      if (debugHandle.__HB__ === game) delete debugHandle.__HB__
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void start(() => cancelled).catch((error: unknown) => {
      if (!cancelled) useUi.getState().setBoot('error', (error as Error).message)
    })
    return () => {
      cancelled = true
      cleanupRef.current?.()
      cleanupRef.current = null
    }
  }, [start])

  /*
   * 音量设置必须在**启动时**就同步给引擎。
   *
   * 之前这一步只写在 SettingsPanel 的 effect 里，而那个面板只有打开时
   * 才挂载 —— 于是重开游戏后音量静默回到默认值，直到玩家手动打开一次
   * 设置面板。持久化写了却像没写。
   */
  const audioSettings = useAudioSettings((state) => state.audio)

  useEffect(() => {
    gameRef.current?.audio.setSettings(audioSettings)
  }, [audioSettings, game])

  // 内容要求横屏、设备却是竖屏 → 暂停模拟并给出引导
  const requiredOrientation = game?.project.mobile.orientation ?? 'landscape'
  const orientationBlocked = useOrientationBlocked(requiredOrientation)
  const orientation = useOrientation()
  const viewportSize = useViewportSize()
  const sceneId = useUi((state) => state.sceneId)

  /*
   * 对话布局：**内容包默认 + 当前场景覆盖**，再按方向与视口取一个确定值。
   *
   * 这一段是"核心不决定对话在哪"的落点。引擎交出两份声明，这里合成并求值；
   * CSS 只按 `[data-dialogue=...]` 出样式。想换成底部对话框、浮层或全屏聊天，
   * 改内容 JSON 就够了，不用碰引擎和样式表。
   *
   * 规则里可以带 `minAspectRatio` 这类条件，所以"宽屏才用侧栏"也由内容声明，
   * 而不是引擎内置一条关于宽高比的启发式。
   */
  useEffect(() => {
    for (const gesture of routerRef.current.cancel('scene-change')) gameRef.current?.handleGesture(gesture)
  }, [sceneId])

  const dialogueLayout = useMemo(
    () =>
      mergeDialogueLayout(
        game?.project.layout.dialogue ?? DEFAULT_DIALOGUE_LAYOUT,
        // 传 sceneId 进去，依赖关系才是**真的** —— 切场景时 game 引用不变，
        // 但这一项的返回会变
        game?.dialogueOverrideFor(sceneId),
      ),
    [game, sceneId],
  )
  const placement = resolveDialoguePlacement(dialogueLayout, orientation, viewportSize)

  /*
   * 对话期间是否接管世界输入。
   *
   * 由布局配置决定，不是核心写死的 —— 叙事冒险里玩家常常边说话边走动，
   * 纯阅读/纯聊天流程则希望点场景不触发交互。
   *
   * ⚠️ 判据是"**真的有一句台词或选项在等玩家**"，不是"对话层渲染出来了"。
   *
   * `overlay` 形态下对话层**始终**挂在 DOM 里（它就是浮在画面上的那一层）。
   * 拿 `placementVisible` 当判据的话，`pauseWorldInput: true` 会让世界输入
   * **永久关闭** —— 点场景什么都不发生，角色再也不能被指使走动，而且不会
   * 报任何错。这条路径 demo 里没开，所以只有专门去测才会发现。
   */
  useEffect(() => {
    const showing = Boolean(line) || choices.length > 0
    gameRef.current?.setDialogueBlocksInput(shouldBlockWorldInput(dialogueLayout, showing))
  }, [dialogueLayout, line, choices, game])

  /*
   * 布局形态一变就要重量。
   *
   * 探针的尺寸由 `[data-dialogue]` 决定，而那个属性写在自己的父元素上 ——
   * 属性变了探针就变了，但 .root 的尺寸**没变**，所以 ResizeObserver
   * 一声不吭。少了这一下，引擎会一直用切换前的 inset。
   */
  useEffect(() => {
    resizeRef.current?.()
  }, [placement])

  useEffect(() => {
    gameRef.current?.setPaused('orientation', orientationBlocked)
  }, [orientationBlocked, game])

  /*
   * 面板占用输入并暂停模拟。
   *
   * 拖到一半弹出面板时必须把拖拽作废 —— 否则手指抬起时会往一个
   * 已经不存在的目标上结算。暂停用原因集合，所以关掉面板不会
   * 错误地恢复一个仍在后台的游戏。
   */
  useEffect(() => {
    const game = gameRef.current
    if (!game) return
    const open = panel !== 'none'
    if (open) for (const gesture of routerRef.current.cancel('panel-opened')) game.handleGesture(gesture)
    game.setPaused('panel', open)
    game.setUiOwner(open ? 'panel' : 'none')
  }, [panel, game])

  /*
   * 转屏与视口变化。
   *
   * 方向一变，手势的起点坐标就失去意义了 —— 手指还按着，场景却已经重排。
   * 所以取消当前手势（**不产生成功结果**），已提交的场景状态原样保留。
   *
   * 用 visualViewport 而不是 window.resize：软键盘弹出、浏览器工具栏伸缩
   * 都只改 visualViewport，window.resize 抓不到，而这恰恰是手机上最常见的
   * "视口变了但布局没重排"的情况。
   */
  useEffect(() => {
    const cancelGesture = (): void => {
      for (const gesture of routerRef.current.cancel('orientation')) {
        gameRef.current?.handleGesture(gesture)
      }
    }
    window.addEventListener('orientationchange', cancelGesture)
    const viewport = window.visualViewport
    viewport?.addEventListener('resize', cancelGesture)
    return () => {
      window.removeEventListener('orientationchange', cancelGesture)
      viewport?.removeEventListener('resize', cancelGesture)
    }
  }, [])

  // 调试开关实时同步到引擎
  useEffect(() => {
    gameRef.current?.setDebug(debugFlags)
  }, [debugFlags])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const game = gameRef.current
      if (!game) return
      const ui = useUi.getState()

      if (event.key === 'Escape') {
        ui.setPanel('none')
        return
      }
      if (ui.panel !== 'none') return

      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault()
        game.advanceStory()
        return
      }
      const index = Number.parseInt(event.key, 10)
      if (Number.isInteger(index) && index >= 1 && index <= 9) {
        if (ui.choices.length >= index) game.choose(ui.choices[index - 1].index)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /**
   * 指针事件一律先交给 InputRouter。
   *
   * UI 层不再自己判断"这是点击还是拖动"——那是状态机的职责。
   * 这里只做三件事：把事件喂进去、把归约出的手势交给引擎、维护指针捕获。
   */
  const feedGesture = (events: GestureEvent[]): void => {
    const game = gameRef.current
    if (!game) return
    for (const event of events) game.handleGesture(event)
  }

  const sampleOf = (event: React.PointerEvent<HTMLDivElement>): PointerSample => ({
    pointerId: event.pointerId,
    // 阈值必须是 CSS 像素，所以直接传 clientX/clientY，不做任何缩放
    x: event.clientX,
    y: event.clientY,
    /*
     * 用 performance.now()，**不要用 event.timeStamp**。
     *
     * 长按是游戏循环调 tick(performance.now()) 推进的。如果这里用
     * event.timeStamp，两个时间基准必须一致 —— 老版 Safari 的
     * event.timeStamp 是 Unix 纪元毫秒，相减会得到巨大负数，
     * 长按永远不触发，而且完全不报错。
     *
     * 自己取一次时间，从源头保证只有一个基准。
     */
    t: performance.now(),
  })

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const game = gameRef.current
    if (!game) return
    game.audio.unlock()
    if (event.target instanceof Element && event.target.closest('button, input, select, textarea, a')) return

    /*
     * 只有**从画布上开始**的手势才捕获指针。
     *
     * 在 UI 元素（选项按钮、物品栏、面板）上捕获会把后续的鼠标事件也
     * 重定向到捕获目标，子元素的 onClick 就永远不触发了 —— 表现是
     * "选项按钮点不动、物品栏选不中"，而且完全不报错。
     *
     * 捕获的意义是"手指滑出场景也收得到结束事件"，那本来就是场景才有的问题。
     */
    if (event.target === canvasRef.current) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // 某些浏览器在元素已移除时会抛，忽略即可
      }
    }
    feedGesture(routerRef.current.down(sampleOf(event)))
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    feedGesture(routerRef.current.move(sampleOf(event)))

    // hover 只在开发调试时有用，手机上不存在；光标仍然按场景算
    const game = gameRef.current
    if (!game || routerRef.current.active) return
    const scene = game.toScene(event.clientX, event.clientY)
    if (!scene) {
      game.hoverAt([-1, -1])
      if (useUi.getState().cursor !== 'default') useUi.getState().setCursor('default')
      return
    }
    game.hoverAt([event.clientX, event.clientY])
    const next = game.cursorFor(scene[0], scene[1])
    if (next !== useUi.getState().cursor) useUi.getState().setCursor(next)
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // 没捕获成功时 release 会抛，忽略
    }
    feedGesture(routerRef.current.up(sampleOf(event)))
  }

  /** 系统级取消：浏览器接管了这次触摸（滚动、手势返回、来电…）。 */
  const handlePointerCancel = (event: React.PointerEvent<HTMLDivElement>): void => {
    void event
    feedGesture(routerRef.current.cancel('pointercancel'))
  }

  /** 捕获丢失（元素被移除、或浏览器夺走指针）。 */
  const handleLostCapture = (): void => {
    feedGesture(routerRef.current.cancel('lostcapture'))
  }

  /** 指针离开画面：清掉悬停高亮与未完成的拖拽。 */
  const handlePointerLeave = (): void => {
    gameRef.current?.pointerCancel()
  }

  const itemLabel = (itemId: string): string => labelsRef.current[itemId] ?? itemId

  return (
    <div
      ref={rootRef}
      className={styles.root}
      /*
       * 布局形态由内容/主题声明决定，样式表只认这个属性。
       * 测试也读它 —— 让测试按 viewport 猜规则的话，判据一改就跟着错。
       */
      data-dialogue={placement}
      data-dialogue-reserve={dialogueLayout.reserveSceneSpace ? 'true' : 'false'}
      style={{ cursor: CURSOR_STYLES[cursor] ?? 'default' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handleLostCapture}
      onPointerLeave={handlePointerLeave}
    >
      <canvas ref={canvasRef} className={styles.canvas} />

      <OrientationGate required={requiredOrientation} />

      {/* 布局探针：尺寸由 CSS 变量定，JS 只读解析后的像素 */}
      <div className={styles.insetProbe} data-inset-probe aria-hidden="true" />

      <Hud
        panel={panel}
        inventory={inventory}
        selectedItem={selectedItem}
        itemLabel={itemLabel}
        onTogglePanel={(next: PanelKind) => {
          const ui = useUi.getState()
          ui.setPanel(ui.panel === next ? 'none' : next)
        }}
        onSelectItem={(itemId) => gameRef.current?.setSelectedItem(itemId)}
      />

      <DialogueBox line={line} />
      <ChoiceList
        choices={choices}
        onChoose={(index) => gameRef.current?.choose(index)}
      />

      <Panels
        game={game}
        onClose={() => useUi.getState().setPanel('none')}
        onLoadSlot={(slot) => {
          const game = gameRef.current
          const saves = savesRef.current
          if (!game || !saves) return
          const save = saves.load(slot)
          if (!save) {
            useUi.getState().toast('这个存档位是空的')
            return
          }
          useUi.getState().setPanel('none')
          void game.start(save).then(() => useUi.getState().toast('已读取存档'))
        }}
        onRestart={() => {
          const game = gameRef.current
          if (!game) return
          useUi.getState().setPanel('none')
          savesRef.current?.remove(AUTO_SLOT)
          void game.start(null).then(() => useUi.getState().toast('已从头开始'))
        }}
      />

      <Toasts />

      {boot !== 'ready' ? (
        <div className={styles.boot}>
          <div className={styles.bootTitle}>正在准备</div>
          {boot === 'loading' ? (
            <div className={styles.bootBar}>
              <div className={styles.bootBarFill} />
            </div>
          ) : null}
          <div className={styles.bootMessage}>
            {boot === 'error' ? bootMessage : '第一次打开，先让画面加载一下……'}
          </div>
        </div>
      ) : null}
    </div>
  )
}
