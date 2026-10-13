import { clamp } from '../engine/math.ts'

/**
 * 画面效果。
 *
 * 指令 `# fx: shake(0.3)` 会走到这里。效果在渲染前作用于画布变换，
 * 因此不需要每个绘制函数都感知它。
 */
export interface FxState {
  /** 抖动剩余时间（秒）。 */
  shakeRemaining: number
  shakeDuration: number
  shakeAmplitude: number
  /** 全局淡入淡出，1 表示完全不透明。 */
  fadeAlpha: number
  fadeTarget: number
  fadeSpeed: number
}

export function createFxState(): FxState {
  return {
    shakeRemaining: 0,
    shakeDuration: 1,
    shakeAmplitude: 0,
    fadeAlpha: 1,
    fadeTarget: 1,
    fadeSpeed: 2,
  }
}

export function triggerFx(state: FxState, name: string, args: string[]): void {
  const first = Number.parseFloat(args[0] ?? '')
  switch (name) {
    case 'shake': {
      const duration = Number.isFinite(first) ? clamp(first, 0.05, 3) : 0.3
      state.shakeDuration = duration
      state.shakeRemaining = duration
      state.shakeAmplitude = clamp(Number.parseFloat(args[1] ?? '') || 0.012, 0, 0.08)
      break
    }
    case 'fadeout':
      state.fadeTarget = 0
      state.fadeSpeed = 1 / (Number.isFinite(first) ? Math.max(0.05, first) : 0.5)
      break
    case 'fadein':
      state.fadeTarget = 1
      state.fadeSpeed = 1 / (Number.isFinite(first) ? Math.max(0.05, first) : 0.5)
      break
    case 'flash':
      state.fadeAlpha = 0
      state.fadeTarget = 1
      state.fadeSpeed = 4
      break
    default:
      break
  }
}

export function updateFx(state: FxState, dt: number): void {
  if (state.shakeRemaining > 0) state.shakeRemaining = Math.max(0, state.shakeRemaining - dt)
  if (state.fadeAlpha !== state.fadeTarget) {
    const step = state.fadeSpeed * dt
    if (state.fadeAlpha < state.fadeTarget) {
      state.fadeAlpha = Math.min(state.fadeTarget, state.fadeAlpha + step)
    } else {
      state.fadeAlpha = Math.max(state.fadeTarget, state.fadeAlpha - step)
    }
  }
}

/** 当前抖动的像素偏移。用两个不同频率的正弦代替随机数，避免高频闪烁。 */
export function shakeOffset(state: FxState, elapsed: number): [number, number] {
  if (state.shakeRemaining <= 0) return [0, 0]
  const progress = state.shakeRemaining / state.shakeDuration
  const amp = state.shakeAmplitude * progress * progress
  const w = elapsed * 42
  return [Math.sin(w * 1.7) * amp, Math.sin(w * 2.3 + 1.1) * amp * 0.7]
}
