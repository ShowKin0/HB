/**
 * 角色姿态求解。
 *
 * 设计要点：**相位由位移驱动，而不是由时间驱动**。
 *
 *   phase += 2π · 走过距离 / 步幅
 *
 * 于是走得快腿摆得快、走得慢自然变慢，永远不会出现"脚在地上滑"。
 * 这是逐帧精灵表做不到的，也是这个方案比精灵表更灵活的根本原因。
 *
 * 另一个要点是 idle 与 walk 都在同一组标量上求值，然后线性混合。
 * 起步与停步因此完全没有跳变 —— "流畅"有一半来自这里。
 */

export interface Pose {
  /** 根节点垂直偏移（负值向上），单位是身高比例。 */
  bobY: number
  /** 根节点水平偏移，单位是身高比例。 */
  swayX: number
  /** 躯干前倾（弧度，正值向朝向方向倾）。 */
  lean: number
  /** 头部相对躯干的偏转。 */
  headTilt: number
  thighL: number
  kneeL: number
  thighR: number
  kneeR: number
  armL: number
  elbowL: number
  armR: number
  elbowR: number
  /** 呼吸胀缩系数，0 正常、正值略膨胀。 */
  breathe: number
  /** 当前选用的混合权重，0 站立、1 行走。渲染器可用于微调。 */
  walk: number
  /** 眨眼，0 睁开、1 闭合。 */
  blink: number
}

export function createPose(): Pose {
  return {
    bobY: 0,
    swayX: 0,
    lean: 0,
    headTilt: 0,
    thighL: 0,
    kneeL: 0,
    thighR: 0,
    kneeR: 0,
    armL: 0,
    elbowL: 0,
    armR: 0,
    elbowR: 0,
    breathe: 0,
    walk: 0,
    blink: 0,
  }
}

// 走路循环的幅度常量。单位是弧度 / 身高比例。
const A_THIGH = 0.62
const K_MAX = 1.25
const A_ARM = 0.5
const BOB = 0.03
const SWAY = 0.018
/** 膝盖相对大腿的滞后相位，让摆动腿自然折叠。 */
const KNEE_LAG = 0.9

export interface PoseInput {
  /** 累计时间（秒），驱动呼吸等与位移无关的动作。 */
  time: number
  /** 走路循环相位（弧度）。 */
  phase: number
  /** 0..1，静止与行走的混合权重。 */
  walkBlend: number
  /** 0..1，当前速度占最大速度的比例，用于缩放步幅与摆动幅度。 */
  speedRatio: number
  /** 额外前倾（弧度），来自加速度。 */
  extraLean: number
  /** 眨眼，0..1。 */
  blink: number
}

const IDLE: Pose = createPose()
const WALK: Pose = createPose()

/**
 * 求值姿态。写入 out 以避免每帧分配。
 *
 * 先分别求 idle 与 walk 两套姿态，再按 walkBlend 混合。
 */
export function solvePose(out: Pose, input: PoseInput): Pose {
  const { time, phase, walkBlend, speedRatio, extraLean, blink } = input
  const stride = 0.72 + 0.28 * speedRatio

  // ── 站立：呼吸、轻微重心转移 ─────────────────────────────
  IDLE.bobY = -0.009 * Math.sin(time * 1.35)
  IDLE.swayX = 0.005 * Math.sin(time * 0.8)
  IDLE.lean = extraLean
  IDLE.headTilt = 0.045 * Math.sin(time * 0.95)
  IDLE.thighL = 0.05
  IDLE.thighR = -0.05
  IDLE.kneeL = 0.07
  IDLE.kneeR = 0.07
  IDLE.armL = 0.08
  IDLE.armR = -0.08
  IDLE.elbowL = 0.2
  IDLE.elbowR = 0.2
  IDLE.breathe = 0.5 + 0.5 * Math.sin(time * 1.35)
  IDLE.walk = 0
  IDLE.blink = blink

  // ── 行走：双腿反相摆动，手臂与对侧腿同相 ─────────────────
  const s = Math.sin(phase)
  const c = Math.cos(phase)
  const swing = A_THIGH * stride

  WALK.thighR = swing * s
  WALK.kneeR = K_MAX * Math.max(0, -Math.sin(phase + KNEE_LAG))
  WALK.thighL = -swing * s
  WALK.kneeL = K_MAX * Math.max(0, -Math.sin(phase + Math.PI + KNEE_LAG))

  const armSwing = A_ARM * stride
  WALK.armR = -armSwing * s
  WALK.armL = armSwing * s
  WALK.elbowR = 0.22 + 0.42 * Math.max(0, -s)
  WALK.elbowL = 0.22 + 0.42 * Math.max(0, s)

  // 双腿并拢时（相位为 0 / π）身体最高，跨步最大时最低
  WALK.bobY = -BOB * (Math.abs(c) - 0.5)
  WALK.swayX = SWAY * s
  WALK.headTilt = -0.06 * s
  WALK.lean = extraLean + 0.06 * speedRatio
  WALK.breathe = 0.5
  WALK.walk = 1
  WALK.blink = blink

  const t = walkBlend < 0 ? 0 : walkBlend > 1 ? 1 : walkBlend
  blendPose(IDLE, WALK, t, out)
  return out
}

/** 逐字段线性混合两套姿态。 */
export function blendPose(a: Pose, b: Pose, t: number, out: Pose): void {
  out.bobY = a.bobY + (b.bobY - a.bobY) * t
  out.swayX = a.swayX + (b.swayX - a.swayX) * t
  out.lean = a.lean + (b.lean - a.lean) * t
  out.headTilt = a.headTilt + (b.headTilt - a.headTilt) * t
  out.thighL = a.thighL + (b.thighL - a.thighL) * t
  out.kneeL = a.kneeL + (b.kneeL - a.kneeL) * t
  out.thighR = a.thighR + (b.thighR - a.thighR) * t
  out.kneeR = a.kneeR + (b.kneeR - a.kneeR) * t
  out.armL = a.armL + (b.armL - a.armL) * t
  out.elbowL = a.elbowL + (b.elbowL - a.elbowL) * t
  out.armR = a.armR + (b.armR - a.armR) * t
  out.elbowR = a.elbowR + (b.elbowR - a.elbowR) * t
  out.breathe = a.breathe + (b.breathe - a.breathe) * t
  out.walk = a.walk + (b.walk - a.walk) * t
  out.blink = a.blink + (b.blink - a.blink) * t
}
