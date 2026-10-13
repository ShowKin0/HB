import type { Actor } from '../engine/actor/actor.ts'
import type { AssetStore } from '../engine/assets.ts'
import type { Pt } from '../engine/nav/smooth.ts'

/**
 * 角色渲染的坐标变换。
 *
 * 局部空间约定：原点是脚底中心，y 轴向下，1 个单位 = 角色身高。
 * 因此骨架尺寸可以直接写成"身高比例"，换素材换尺寸都不用改数值。
 */
export interface ActorTransform {
  /** 脚底在 canvas 上的像素坐标。 */
  px: number
  py: number
  /** 角色身高对应的像素数。 */
  hpx: number
  /**
   * 水平朝向，-1..1。
   * 绝对值小于 1 表示正在转身 —— 画笔整体被压扁，形成"侧过身"的观感。
   */
  sx: number
}

export const transformX = (t: ActorTransform, lx: number): number => t.px + lx * t.hpx * t.sx
export const transformY = (t: ActorTransform, ly: number): number => t.py + ly * t.hpx
/** 把局部长度换算成像素。 */
export const transformLen = (t: ActorTransform, l: number): number => l * t.hpx
/** 把局部线宽换算成像素，并随转身一起压扁。 */
export const transformWidth = (t: ActorTransform, w: number): number =>
  Math.max(0.6, w * t.hpx * Math.abs(t.sx))

/** 角色配色。可由 spec.tint 覆盖主色。 */
export interface ActorPalette {
  skin: string
  hair: string
  torso: string
  legs: string
  shoes: string
  shadow: string
}

export const DEFAULT_PALETTE: ActorPalette = {
  skin: '#f0c6a3',
  hair: '#3b3230',
  torso: '#6b8fb5',
  legs: '#3f4855',
  shoes: '#2a2e35',
  shadow: 'rgba(0, 0, 0, 0.22)',
}

export interface ActorDrawEnv {
  ctx: CanvasRenderingContext2D
  actor: Actor
  transform: ActorTransform
  palette: ActorPalette
  /** 该角色是否处在被前景遮挡的位置，用于整体压暗。 */
  dimmed: boolean
}

export interface ActorRenderer {
  readonly id: string
  /**
   * 预加载该渲染器需要的素材（可选）。
   * 素材缺失时应返回 undefined 而不是抛错 —— 降级是渲染器自己的责任。
   */
  prepare?(spec: Actor['spec'], assets: AssetStore): Promise<unknown>
  draw(env: ActorDrawEnv, resources?: unknown): void
}

// ── 几何小工具，渲染器共用 ─────────────────────────────────

export function add(a: Pt, b: Pt): Pt {
  return [a[0] + b[0], a[1] + b[1]]
}

/** 绕原点旋转。 */
export function rot(x: number, y: number, angle: number): Pt {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [x * c - y * s, x * s + y * c]
}

/**
 * 从关节沿肢体方向伸出。
 *
 * 角度约定：0 = 竖直向下，正值向局部 +x 方向（即角色面朝的方向）摆。
 */
export function limbEnd(from: Pt, angle: number, length: number): Pt {
  return add(from, rot(0, length, -angle))
}

/** 画一条圆头线段，作为肢体的胶囊体。 */
export function capsule(
  env: ActorDrawEnv,
  a: Pt,
  b: Pt,
  width: number,
  color: string,
): void {
  const { ctx, transform } = env
  ctx.beginPath()
  ctx.moveTo(transformX(transform, a[0]), transformY(transform, a[1]))
  ctx.lineTo(transformX(transform, b[0]), transformY(transform, b[1]))
  ctx.lineWidth = transformWidth(transform, width)
  ctx.strokeStyle = color
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.stroke()
}
