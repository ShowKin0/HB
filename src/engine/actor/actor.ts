import type { ActorSpec } from '../../schema/scene.ts'
import { buildPath, type PlanePath, type Pt } from '../nav/smooth.ts'
import type { WalkMask } from '../nav/mask.ts'
import { clamp, damp, moveTowards } from '../math.ts'
import { createPose, solvePose, type Pose } from '../anim/pose.ts'

export interface Actor {
  readonly spec: ActorSpec
  /** 当前地面平面坐标。 */
  u: number
  v: number
  /** 剩余路径折线；null 表示静止。 */
  path: PlanePath | null
  /** 当前所在段的起点索引。 */
  segIndex: number
  /** 当前段内已走过的距离。 */
  segPos: number
  /** 当前速度，平面单位/秒。 */
  speed: number
  readonly maxSpeed: number
  /** 连续朝向，-1 面向左、1 面向右，过 0 表示正在转身。 */
  facing: number
  facingTarget: 1 | -1
  /** 屏幕空间上的移动方向（单位向量），供 8 方向精灵表选帧。 */
  faceDirX: number
  faceDirY: number
  /** 走路循环相位，由位移驱动。 */
  phase: number
  /** 累计走过的平面距离。 */
  travelled: number
  /** 0..1，站立与行走姿态的混合权重。 */
  walkBlend: number
  /** 加减速前倾。 */
  lean: number
  /** 到达目标后要执行的 ink knot（热点 approach 用）。 */
  pendingKnot: string | null
  readonly pose: Pose
  time: number
  blink: number
  blinkT: number
  blinkTimer: number
  lastStepIndex: number
  prevSpeed: number
}

export interface ActorContext {
  mask: WalkMask
  /** 地面平面 → 场景空间，用于推导屏幕上的朝向。 */
  project(u: number, v: number): Pt
  /** 该点的局部缩放，用于把身高换算成平面步幅。 */
  localScale(u: number, v: number): number
  /** 场景坐标 x/y 投影到屏幕时的宽高比。 */
  aspect?: number
  onFootstep?(actor: Actor): void
  /** 走完全程时触发一次，knot 来自 moveActorTo。 */
  onArrive?(actor: Actor, knot: string | null): void
}

export function createActor(spec: ActorSpec): Actor {
  return {
    spec,
    u: spec.spawn[0],
    v: spec.spawn[1],
    path: null,
    segIndex: 0,
    segPos: 0,
    speed: 0,
    maxSpeed: spec.speed,
    facing: spec.facing,
    facingTarget: spec.facing,
    faceDirX: spec.facing,
    faceDirY: 0,
    phase: 0,
    travelled: 0,
    walkBlend: 0,
    lean: 0,
    pendingKnot: null,
    pose: createPose(),
    // 每个角色错开相位，避免多个角色像机器人一样同步
    time: Math.random() * 10,
    blink: 0,
    blinkT: -1,
    blinkTimer: 1.5 + Math.random() * 4,
    lastStepIndex: -1,
    prevSpeed: 0,
  }
}

/**
 * 让角色走到目标点。行走中再次调用会平滑改道，不会瞬移。
 *
 * 返回是否真的产生了移动。返回 false 时调用方应立即执行 knot（例如
 * 玩家点击了角色脚下的热点），避免出现"点了没反应"。
 */
export function moveActorTo(
  actor: Actor,
  mask: WalkMask,
  target: Pt,
  knot: string | null = null,
): boolean {
  if (Math.hypot(target[0] - actor.u, target[1] - actor.v) < 1e-3) {
    actor.pendingKnot = null
    return false
  }

  const path = buildPath(mask, [actor.u, actor.v], target)
  if (!path || path.length < 2) {
    actor.pendingKnot = null
    return false
  }

  actor.path = path
  actor.segIndex = 0
  actor.segPos = 0
  actor.pendingKnot = knot
  return true
}

export function stopActor(actor: Actor): void {
  actor.path = null
  actor.pendingKnot = null
  actor.speed = 0
}

export function isMoving(actor: Actor): boolean {
  return actor.path !== null
}

/** 从当前位置到路径终点的剩余平面距离。 */
function remainingDistance(actor: Actor): number {
  const path = actor.path
  if (!path) return 0
  let total = -actor.segPos
  for (let i = actor.segIndex; i < path.length - 1; i++) {
    total += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1])
  }
  return total > 0 ? total : 0
}

/** 沿折线前进，返回实际移动的平面距离。 */
function advance(actor: Actor, distance: number): number {
  const path = actor.path
  if (!path) return 0
  let remaining = distance

  while (remaining > 0 && actor.segIndex < path.length - 1) {
    const a = path[actor.segIndex]
    const b = path[actor.segIndex + 1]
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1])
    const left = segLen - actor.segPos
    if (remaining < left) {
      actor.segPos += remaining
      remaining = 0
    } else {
      remaining -= left
      actor.segIndex += 1
      actor.segPos = 0
    }
  }

  const idx = actor.segIndex
  if (idx >= path.length - 1) {
    actor.u = path[path.length - 1][0]
    actor.v = path[path.length - 1][1]
  } else {
    const a = path[idx]
    const b = path[idx + 1]
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1])
    const t = segLen > 1e-9 ? clamp(actor.segPos / segLen, 0, 1) : 1
    actor.u = a[0] + (b[0] - a[0]) * t
    actor.v = a[1] + (b[1] - a[1]) * t
  }

  return distance - remaining
}

/** 当前所在段的方向。用整段方向而非瞬时切线，避免抖动。 */
function segmentDirection(actor: Actor): Pt | null {
  const path = actor.path
  if (!path || actor.segIndex >= path.length - 1) return null
  const a = path[actor.segIndex]
  const b = path[actor.segIndex + 1]
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return null
  return [dx / len, dy / len]
}

/** 由投影后的屏幕方向决定朝向；接近垂直的移动保持当前朝向。 */
function updateFacing(actor: Actor, dt: number, ctx: ActorContext): void {
  const dir = segmentDirection(actor)
  if (dir) {
    const [x0, y0] = ctx.project(actor.u, actor.v)
    const [x1, y1] = ctx.project(actor.u + dir[0] * 0.02, actor.v + dir[1] * 0.02)
    const dx = x1 - x0
    const dy = y1 - y0
    const aspect = Number.isFinite(ctx.aspect) && (ctx.aspect ?? 0) > 0 ? (ctx.aspect as number) : 1
    // `project` returns normalized scene coordinates. Convert x to the same
    // pixel scale as y before selecting an octant; otherwise a 16:9 scene
    // makes diagonal movement appear too vertical/horizontal.
    const screenDx = dx * aspect
    const screenDy = dy
    const len = Math.hypot(screenDx, screenDy)
    if (len > 1e-6) {
      actor.faceDirX = screenDx / len
      actor.faceDirY = screenDy / len
      // 仅当水平分量足够大时才换向，避免"直上直下"时角色左右乱翻
      if (Math.abs(screenDx) > 1e-5) actor.facingTarget = screenDx > 0 ? 1 : -1
    }
  }
  actor.facing = damp(actor.facing, actor.facingTarget, 13, dt)
}

/** 相位推进 + 脚步事件。相位由位移驱动，这是"不滑步"的根本。 */
function updatePhase(actor: Actor, moved: number, ctx: ActorContext): void {
  if (moved <= 0) return
  const scale = Math.max(1e-4, ctx.localScale(actor.u, actor.v))
  const stridePlane = clamp((actor.spec.heightRatio / scale) * 0.9, 0.02, 0.6)
  actor.travelled += moved
  actor.phase = (actor.phase + (moved / stridePlane) * Math.PI * 2) % (Math.PI * 2)

  const step = Math.floor(actor.phase / Math.PI)
  if (step !== actor.lastStepIndex) {
    actor.lastStepIndex = step
    ctx.onFootstep?.(actor)
  }
}

function updateBlink(actor: Actor, dt: number): void {
  if (actor.blinkT >= 0) {
    actor.blinkT += dt
    const duration = 0.14
    if (actor.blinkT >= duration) {
      actor.blinkT = -1
      actor.blink = 0
      actor.blinkTimer = 2.4 + Math.random() * 4
    } else {
      actor.blink = Math.sin((actor.blinkT / duration) * Math.PI)
    }
    return
  }
  actor.blinkTimer -= dt
  if (actor.blinkTimer <= 0) actor.blinkT = 0
}

/**
 * 到位判定的容差，单位是地面平面比例。
 *
 * 必须有这个吸附：减速曲线是 sqrt(2·a·s)，角色会**无限趋近**终点，
 * 距离永远不会精确归零，路径索引也就永远差最后一步 ——
 * 表现为角色站在终点前几像素处永远走不完，`path` 一直挂着。
 */
const ARRIVE_EPSILON = 0.006

/** 末段最低速度，避免最后几厘米慢得像爬。 */
const MIN_APPROACH_SPEED = 0.22

/**
 * 推进一个角色的移动与动画。
 *
 * 速度曲线是梯形：起步受加速度限制，接近终点按 sqrt(2·a·s) 提前减速，
 * 末段保留一个最低速度，最后靠 ARRIVE_EPSILON 干净收尾。
 * 配合姿态混合，看到的便是自然的走—停，而不是急停急走或原地磨蹭。
 */
export function updateActor(actor: Actor, dt: number, ctx: ActorContext): void {
  if (dt <= 0) return
  actor.time += dt

  const moving = actor.path !== null && actor.segIndex < actor.path.length - 1
  const accel = actor.maxSpeed * 6
  const decel = actor.maxSpeed * 3.5

  let moved = 0
  if (moving) {
    const left = remainingDistance(actor)
    if (left <= ARRIVE_EPSILON) {
      // 走完最后一点并直接结束，保证路径一定收敛
      advance(actor, left + 1e-6)
      actor.speed = 0
    } else {
      const brakeLimit = Math.sqrt(2 * decel * left)
      const targetSpeed = Math.min(
        actor.maxSpeed,
        Math.max(brakeLimit, actor.maxSpeed * MIN_APPROACH_SPEED),
      )
      actor.speed = moveTowards(actor.speed, targetSpeed, (targetSpeed > actor.speed ? accel : decel) * dt)
      moved = advance(actor, actor.speed * dt)
    }
  } else {
    actor.speed = moveTowards(actor.speed, 0, accel * dt)
    if (actor.speed < 1e-4) actor.speed = 0
  }

  const finished = actor.path !== null && actor.segIndex >= actor.path.length - 1
  if (finished) {
    const knot = actor.pendingKnot
    actor.path = null
    actor.speed = 0
    actor.pendingKnot = null
    ctx.onArrive?.(actor, knot)
  }

  updateFacing(actor, dt, ctx)
  updatePhase(actor, moved, ctx)

  const speedRatio = actor.maxSpeed > 0 ? actor.speed / actor.maxSpeed : 0
  actor.walkBlend = damp(actor.walkBlend, clamp(speedRatio * 3, 0, 1), 9, dt)

  const accelNow = (actor.speed - actor.prevSpeed) / dt
  actor.prevSpeed = actor.speed
  actor.lean = damp(actor.lean, clamp(accelNow / (actor.maxSpeed * 6), -1, 1) * 0.2, 10, dt)

  updateBlink(actor, dt)

  solvePose(actor.pose, {
    time: actor.time,
    phase: actor.phase,
    walkBlend: actor.walkBlend,
    speedRatio,
    extraLean: actor.lean,
    blink: actor.blink,
  })
}
