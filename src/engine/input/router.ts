import type { Pt } from '../math.ts'

/**
 * 移动端输入仲裁。
 *
 * 这一层只做一件事：把一串指针事件**归约成一次手势的一个结果**。
 * 它不认识场景、不认识热点，只认坐标和时间 —— 所以能脱离浏览器完整单测。
 *
 * 为什么不能"按下即执行"：一旦加入长按和拖动，按下就触发会和它们直接冲突
 * （想长按却先触发了点击）。所以状态机是必需的：
 *
 *   idle → pressed → tap / holding / dragging → idle
 *
 * 阈值一律用 **CSS 像素**。按场景比例算的话，同一段手指移动在不同屏幕上
 * 会得到不同的结果 —— 手机上手感会飘。
 */

export type GesturePhase = 'idle' | 'pressed' | 'holding' | 'dragging'

export type GestureCancelReason =
  | 'pointercancel'
  | 'lostcapture'
  | 'visibility'
  | 'orientation'
  | 'scene-change'
  | 'panel-opened'
  | 'dialogue'
  | 'destroyed'

export interface GestureConfig {
  /**
   * 手势是否还"停在原地"的容差（CSS px）。
   *
   * 真正决定点击还是拖动的是 `dragStartPx` —— 两个阈值一起用作判据会留出
   * 死区（`tapSlopPx < dragStartPx` 时中间那段谁也不管），详见 `up()`。
   * 这个值保留给"按住时的轻微抖动"这类判断用。
   */
  tapSlopPx: number
  /** 进入拖动所需的移动距离（CSS px）。这是唯一的拖动判据。 */
  dragStartPx: number
  /** 长按判定时间（ms）。 */
  holdMs: number
}

export const DEFAULT_GESTURE_CONFIG: GestureConfig = {
  tapSlopPx: 10,
  dragStartPx: 10,
  holdMs: 500,
}

export interface PointerSample {
  pointerId: number
  /** CSS 像素，相对游戏交互面。 */
  x: number
  y: number
  /** 时间戳（ms），与 tick 用同一个时基。 */
  t: number
}

export type GestureEvent =
  | { type: 'press'; point: Pt; pointerId: number }
  | { type: 'hold'; point: Pt }
  | { type: 'dragStart'; point: Pt }
  | { type: 'dragMove'; point: Pt }
  | { type: 'tap'; point: Pt }
  | { type: 'dragEnd'; from: Pt; to: Pt; durationMs: number; distancePx: number }
  | { type: 'cancel'; reason: GestureCancelReason }

export interface GestureState {
  phase: GesturePhase
  pointerId: number | null
  origin: Pt
  point: Pt
  elapsedMs: number
}

/**
 * 手势状态机。
 *
 * 用法：`down / move / up / cancel` 由指针事件驱动，`tick(now)` 由游戏循环驱动
 * （长按必须由时间推进，不能靠 setTimeout —— 那样暂停和销毁都不好处理）。
 */
export class InputRouter {
  private config: GestureConfig
  private phase: GesturePhase = 'idle'
  private primaryId: number | null = null
  private origin: Pt = [0, 0]
  private point: Pt = [0, 0]
  private startedAt = 0
  /** 长按已经触发过。触发后这次手势就"用掉了"，不再降级成拖动或点击。 */
  private holdFired = false

  constructor(config: Partial<GestureConfig> = {}) {
    this.config = { ...DEFAULT_GESTURE_CONFIG, ...config }
  }

  setConfig(config: Partial<GestureConfig>): void {
    this.config = { ...this.config, ...config }
  }

  get gestureConfig(): GestureConfig {
    return { ...this.config }
  }

  get state(): GestureState {
    return {
      phase: this.phase,
      pointerId: this.primaryId,
      origin: this.origin,
      point: this.point,
      elapsedMs: this.lastElapsed,
    }
  }

  private lastElapsed = 0

  /** 是否正处于一次手势中。 */
  get active(): boolean {
    return this.phase !== 'idle'
  }

  /**
   * 按下。
   *
   * 只记录并给出按压反馈，**不执行任何交互** —— 执行要等到 up 或 hold。
   * 已经有主指针时不响应第二根手指：多指不改变当前操作。
   */
  down(sample: PointerSample): GestureEvent[] {
    if (this.primaryId !== null) return []
    this.primaryId = sample.pointerId
    this.phase = 'pressed'
    this.origin = [sample.x, sample.y]
    this.point = [sample.x, sample.y]
    this.startedAt = sample.t
    this.holdFired = false
    this.lastElapsed = 0
    return [{ type: 'press', point: this.origin, pointerId: sample.pointerId }]
  }

  /** 移动。按距离决定是否升级成拖动。 */
  move(sample: PointerSample): GestureEvent[] {
    if (sample.pointerId !== this.primaryId) return []
    this.point = [sample.x, sample.y]
    this.lastElapsed = sample.t - this.startedAt

    const distance = Math.hypot(sample.x - this.origin[0], sample.y - this.origin[1])

    // 长按一旦触发，这次手势就归属长按了，不再降级成拖动。
    if (this.holdFired) return []

    const events: GestureEvent[] = []
    if (this.phase === 'pressed' && distance > this.config.dragStartPx) {
      this.phase = 'dragging'
      events.push({ type: 'dragStart', point: this.origin })
    }
    if (this.phase === 'dragging') events.push({ type: 'dragMove', point: this.point })
    return events
  }

  /**
   * 抬起。结算成点击或拖放，**一次手势一定产生一个结果**。
   *
   * 注意这里只看 `phase`，不再看"有没有超出点击阈值"。
   * 那两套判据凑在一起会留出一个死区：当 `tapSlopPx < dragStartPx` 时
   * （两个都是项目可配的），移动距离落在两者之间的手势既不满足拖动，
   * 又被点击阈值否掉 —— up 返回空数组，玩家按下去、手指动了、什么也没发生。
   *
   * 拖动阈值本身就是唯一的判据：没到拖动就是点击。
   */
  up(sample: PointerSample): GestureEvent[] {
    if (sample.pointerId !== this.primaryId) return []
    const phase = this.phase
    const from = this.origin
    const to: Pt = [sample.x, sample.y]
    const durationMs = sample.t - this.startedAt
    const distancePx = Math.hypot(sample.x - from[0], sample.y - from[1])
    this.reset()

    if (phase === 'pressed') {
      if (distancePx > this.config.dragStartPx) return [{ type: 'cancel', reason: 'pointercancel' }]
      return [{ type: 'tap', point: to }]
    }
    if (phase === 'dragging') {
      return [{ type: 'dragEnd', from, to, durationMs, distancePx }]
    }
    // holding：长按已经在 tick 里出过结果了，抬起不再产生第二个结果。
    return []
  }

  /**
   * 时间推进。到点就把 pressed 升级成 holding 并发一次 hold。
   *
   * 由游戏循环调用而不是 setTimeout：暂停时循环不走，长按自然也不会误触发；
   * 销毁时也不需要清理定时器。
   */
  tick(now: number): GestureEvent[] {
    if (this.phase !== 'pressed' || this.holdFired) return []
    this.lastElapsed = now - this.startedAt
    if (this.lastElapsed < this.config.holdMs) return []
    this.holdFired = true
    this.phase = 'holding'
    return [{ type: 'hold', point: this.point }]
  }

  /**
   * 取消。**不产生任何成功结果**。
   *
   * 指针取消、捕获丢失、页面隐藏、转屏、切场景、弹出面板都要走这里 ——
   * 否则会出现"手指还按着，场景已经换了"这种半截状态。
   */
  cancel(reason: GestureCancelReason): GestureEvent[] {
    if (this.phase === 'idle') return []
    this.reset()
    return [{ type: 'cancel', reason }]
  }

  private reset(): void {
    this.phase = 'idle'
    this.primaryId = null
    this.holdFired = false
    this.lastElapsed = 0
  }
}

/**
 * 输入归属。
 *
 * 同一次触摸只能有一个消费者。优先级高的在场时，低的一律收不到输入 ——
 * 否则"点一下推进对话"会顺带把背后的场景热点也点了。
 */
export type InputOwner = 'none' | 'panel' | 'minigame' | 'dialogue' | 'scene'

const OWNER_RANK: Record<InputOwner, number> = {
  none: 0,
  scene: 1,
  dialogue: 2,
  minigame: 3,
  panel: 4,
}

/** 谁应该拿到这次输入。传进来的候选里取优先级最高的。 */
export function resolveInputOwner(...candidates: InputOwner[]): InputOwner {
  let best: InputOwner = 'none'
  for (const candidate of candidates) {
    if (OWNER_RANK[candidate] > OWNER_RANK[best]) best = candidate
  }
  return best
}
