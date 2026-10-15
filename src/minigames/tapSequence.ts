import { numberParam, parseMiniGameArgs, type MiniGame, type MiniGameHandle, type MiniGameResult } from './types.ts'

/**
 * 示例小游戏：记住并复现亮灯顺序。
 *
 * 它同时是一份**接口模板** —— 你要写自己的小游戏时，照着这个文件的结构来：
 * 1. 用纯 DOM 构建界面（不依赖 React，因此引擎不需要知道你在画什么）
 * 2. 只在 `api.resolve()` 时结束
 * 3. 每次判定失败调用 `api.reportFailure()`，让引擎统一处理"跳过"入口
 *
 * 引擎不关心这里面的规则，只回收 resolve 的结果。
 */

export interface TapSequenceParams {
  /** 序列长度，默认 3。 */
  length: number
  /** 每步亮灯毫秒数，默认 620。 */
  speed: number
}

const PAD_COUNT = 4
const PAD_COLORS = ['#d9a566', '#6b8fb5', '#7bd88f', '#d9705f']

export const tapSequence: MiniGame<TapSequenceParams, MiniGameResult> = {
  id: 'tapSequence',
  title: '记住顺序',
  hint: '看一遍亮灯顺序，然后照着点回来。',

  /*
   * 参数 Schema 属于玩法自己。
   *
   * 引擎只把指令括号里的原文交过来，怎么解释由这里决定 ——
   * 通用容器不该知道"length 是什么"。
   */
  params: {
    parse(args) {
      const parsed = parseMiniGameArgs(args)
      return {
        length: Math.round(numberParam(parsed, 'length', 3, { min: 2, max: 8 })),
        speed: numberParam(parsed, 'speed', 620, { min: 200, max: 1500 }),
      }
    },
  },

  result: {
    isSuccess: (result) => result.success === true,
  },

  // 生日礼物不能卡关：失败三次就给出跳过入口
  skip: { skipAfter: 3 },

  mount(container, params, api): MiniGameHandle {
    const length = params.length
    const speed = params.speed

    const root = document.createElement('div')
    root.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:80',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'gap:22px',
      'background:rgba(8,6,5,0.86)',
      'backdrop-filter:blur(4px)',
      "font-family:'Noto Sans SC','PingFang SC',system-ui,sans-serif",
      'color:#f4ece0',
      'padding:24px',
    ].join(';')

    const title = document.createElement('div')
    title.textContent = tapSequence.title
    title.style.cssText = "font-size:15px;letter-spacing:0.2em;color:#d9a566"

    const hint = document.createElement('div')
    hint.textContent = tapSequence.hint ?? ''
    hint.style.cssText = 'font-size:13px;color:#9d9083;line-height:1.7;text-align:center;max-width:26em'

    const board = document.createElement('div')
    board.style.cssText = 'display:grid;grid-template-columns:repeat(2,92px);gap:12px'

    const pads: HTMLButtonElement[] = []
    for (let i = 0; i < PAD_COUNT; i++) {
      const pad = document.createElement('button')
      pad.type = 'button'
      pad.dataset.index = String(i)
      pad.style.cssText = [
        'width:92px',
        'height:92px',
        'border-radius:16px',
        'border:1px solid rgba(226,208,180,0.2)',
        `background:${PAD_COLORS[i]}22`,
        'transition:background 120ms,transform 120ms,box-shadow 120ms',
        'cursor:pointer',
        'touch-action:manipulation',
      ].join(';')
      pad.addEventListener('click', () => onPad(i))
      pads.push(pad)
      board.appendChild(pad)
    }

    const status = document.createElement('div')
    status.style.cssText = 'font-size:13px;letter-spacing:0.1em;color:#9d9083;min-height:1.6em'

    const skip = document.createElement('button')
    skip.type = 'button'
    skip.textContent = '跳过这个小游戏'
    skip.style.cssText = [
      'min-height:40px',
      'padding:0 18px',
      'border-radius:10px',
      'border:1px solid rgba(226,208,180,0.24)',
      'background:none',
      'color:#d8cbb8',
      'font-size:13px',
      'cursor:pointer',
      'display:none',
    ].join(';')
    skip.addEventListener('click', () => {
      cleanup()
      api.requestSkip()
    })

    root.append(title, hint, board, status, skip)
    container.appendChild(root)

    // ── 游戏逻辑 ────────────────────────────────────────────
    const sequence: number[] = Array.from({ length }, () => Math.floor(Math.random() * PAD_COUNT))
    let inputIndex = 0
    let accepting = false
    let finished = false
    let paused = false
    const timers = new Set<{ fn: () => void; remaining: number; due: number; id: number | null }>()
    const schedule = (task: { fn: () => void; remaining: number; due: number; id: number | null }): void => {
      task.due = performance.now() + task.remaining
      task.id = window.setTimeout(() => { timers.delete(task); task.fn() }, task.remaining)
    }
    const later = (fn: () => void, ms: number): void => {
      const task = { fn, remaining: ms, due: 0, id: null as number | null }
      timers.add(task)
      if (!paused) schedule(task)
    }

    const flash = (index: number, on: boolean): void => {
      const pad = pads[index]
      pad.style.background = on ? `${PAD_COLORS[index]}cc` : `${PAD_COLORS[index]}22`
      pad.style.transform = on ? 'scale(1.06)' : 'none'
      pad.style.boxShadow = on ? `0 0 22px ${PAD_COLORS[index]}88` : 'none'
    }

    const playSequence = (): void => {
      accepting = false
      inputIndex = 0
      status.textContent = '看好顺序……'
      sequence.forEach((padIndex, step) => {
        later(() => flash(padIndex, true), 420 + step * speed)
        later(() => flash(padIndex, false), 420 + step * speed + speed * 0.55)
      })
      later(() => {
        accepting = true
        status.textContent = '轮到你了'
      }, 420 + sequence.length * speed + 120)
    }

    const onPad = (index: number): void => {
      if (!accepting || finished || paused) return
      flash(index, true)
      later(() => flash(index, false), 140)

      if (sequence[inputIndex] !== index) {
        accepting = false
        api.reportFailure()
        status.textContent = `点错了。已失败 ${api.failures} 次`
        // skipAfter 为 null 表示这次不允许跳过（例如关键剧情），此时不显示入口
        if (api.skipAfter !== null && api.failures >= api.skipAfter) skip.style.display = 'block'
        later(playSequence, 900)
        return
      }

      inputIndex += 1
      if (inputIndex < sequence.length) return

      finished = true
      accepting = false
      status.textContent = '通过了'
      later(() => {
        cleanup()
        api.resolve({ success: true, skipped: false, failures: api.failures })
      }, 620)
    }

    const cleanup = (): void => {
      finished = true
      for (const task of timers) if (task.id !== null) window.clearTimeout(task.id)
      timers.clear()
    }

    const pause = (): void => {
      if (paused || finished) return
      paused = true
      const now = performance.now()
      for (const task of timers) {
        if (task.id !== null) window.clearTimeout(task.id)
        task.remaining = Math.max(0, task.due - now)
        task.id = null
      }
    }

    const resume = (): void => {
      if (!paused || finished) return
      paused = false
      for (const task of timers) schedule(task)
    }

    playSequence()

    return {
      destroy: () => {
        cleanup()
        root.remove()
      },
      pause,
      resume,
    }
  },
}
