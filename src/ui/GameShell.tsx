import { useCallback, useEffect, useRef, useState } from 'react'
import { Game, type DebugInfo, type DialogueLine } from '../engine/game.ts'
import type { ChoiceView } from '../engine/ink/inkBridge.ts'
import { loadContent } from '../content/load.ts'
import { AUTO_SLOT, SaveManager } from '../engine/save.ts'
import { useUi, type PanelKind } from '../state/store.ts'
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

  const start = useCallback(async (isCancelled: () => boolean): Promise<void> => {
    const ui = useUi.getState()
    const canvas = canvasRef.current
    const root = rootRef.current
    if (!canvas || !root) return

    ui.setBoot('loading', '正在准备……')

    const content = await loadContent()
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

    const game = new Game({ canvas, content, hooks, saves, debug: { ...useUi.getState().debugFlags } })
    gameRef.current = game
    // 自动化测试与编辑器共用的调试句柄。游戏是私人用途的单页应用，
    // 暴露一个句柄换来的可测性远比这点"泄漏"有价值。
    const debugHandle = window as unknown as { __HB__?: Game }
    debugHandle.__HB__ = game

    // 有进度就直接续上 —— 生日礼物不该先让人做选择题
    const save = content.startSceneId ? saves.load(AUTO_SLOT) : null
    await game.start(save)

    // 到这里如果已经被取消，必须自己把 game 收干净，因为 cleanup 已经跑过了
    if (isCancelled()) {
      if (debugHandle.__HB__ === game) delete debugHandle.__HB__
      if (gameRef.current === game) gameRef.current = null
      game.dispose()
      return
    }

    setGame(game)

    /**
     * 底部对话框**预留**的高度，场景会避开这块区域 ——
     * 否则角色走到房间最前排就会被对话框整个盖住，而这个游戏的看点就是看角色走动。
     *
     * 读的是 min-height 而不是实际高度：长台词会让对话框向上生长，
     * 如果拿实际高度当留白，每换一句台词场景就跳一下。
     *
     * 上限取视口高度的 42%：极端窄屏上如果让对话框无限占高，场景会被压得没法看。
     */
    const bandInset = (): number => {
      const band = root.querySelector<HTMLElement>('[data-dialogue-band]')
      if (!band) return 0
      const rect = root.getBoundingClientRect()
      const reserved = Number.parseFloat(getComputedStyle(band).minHeight) || 0
      return Math.min(reserved, rect.height * 0.42)
    }

    const resize = (): void => {
      const rect = root.getBoundingClientRect()
      game.resize(rect.width, rect.height, bandInset())
    }
    resize()

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
      if (document.visibilityState === 'hidden') game.flushAutosave()
    }
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', onHidden)

    cleanupRef.current = () => {
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

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const game = gameRef.current
    if (!game) return
    game.audio.unlock()

    const scene = game.toScene(event.clientX, event.clientY)
    const ui = useUi.getState()
    if (ui.panel !== 'none') return

    if (!scene) {
      // 点在 letterbox 黑边上：只有"等待推进对话"时有意义
      if (game.awaitingAdvance) game.pointerDown(event.clientX, event.clientY)
      return
    }
    game.pointerDown(scene[0], scene[1])
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const game = gameRef.current
    if (!game) return
    const scene = game.toScene(event.clientX, event.clientY)
    if (!scene) {
      game.pointerMove(-1, -1)
      if (useUi.getState().cursor !== 'default') useUi.getState().setCursor('default')
      return
    }
    // 悬停高亮与拖拽进度都靠这一句驱动
    game.pointerMove(scene[0], scene[1])
    const next = game.cursorFor(scene[0], scene[1])
    if (next !== useUi.getState().cursor) useUi.getState().setCursor(next)
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const game = gameRef.current
    if (!game) return
    const scene = game.toScene(event.clientX, event.clientY)
    if (!scene) {
      game.pointerCancel()
      if (useUi.getState().cursor !== 'default') useUi.getState().setCursor('default')
      return
    }
    game.pointerUp(scene[0], scene[1])
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
      style={{ cursor: CURSOR_STYLES[cursor] ?? 'default' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
    >
      <canvas ref={canvasRef} className={styles.canvas} />

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
