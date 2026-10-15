import type { Pt } from '../engine/nav/smooth.ts'
import type { AssetStore } from '../engine/assets.ts'
import type { ActorSpec } from '../schema/scene.ts'
import { PART_NAMES, type PartDef } from '../schema/rig.rules.ts'
import { safeColor, shade } from '../render/color.ts'
import {
  add,
  type ActorDrawEnv,
  type ActorRenderer,
  capsule,
  limbEnd,
  rot,
  transformLen,
  transformX,
  transformY,
} from './types.ts'

/**
 * 部件骨架渲染器。
 *
 * 两种素材模式共用同一套姿态解算：
 *
 *   1. **程序化（默认）**：不依赖任何图片，用圆头线段画胶囊体。
 *      因此它永远可用 —— 其他渲染器素材缺失时都退到它。
 *   2. **部件图集**：场景里给 actor 写 `"parts": "rig/hero.json"`，
 *      按固定部件名出图即可替换成你自己的画风。
 *      缺哪个部件就哪个部件回落程序化，可以逐个替换、不必一次做完。
 *
 * 姿态在 anim/pose.ts 里已经解算成一组标量，这里只负责"把标量画出来"。
 */

/** 骨架尺寸，单位是身高比例。hipY + thigh + shin 必须等于 0（脚踩在地面）。 */
export const RIG = {
  hipY: -0.5,
  torsoLen: 0.3,
  headOffset: 0.1,
  headR: 0.095,
  thigh: 0.245,
  shin: 0.255,
  upperArm: 0.175,
  foreArm: 0.175,
  legWidth: 0.082,
  armWidth: 0.058,
  torsoWidth: 0.2,
  neckWidth: 0.07,
  footLen: 0.075,
  shadowRX: 0.145,
  shadowRY: 0.05,
  /**
   * 四肢在躯干上的横向落点。
   * 都放在正中会导致近侧手臂盖住躯干中心，看起来像"横抱着手"；
   * 分到两侧才读得出是两条手臂、两条腿。
   */
  hipHalfWidth: 0.055,
  shoulderHalfWidth: 0.082,
} as const

export interface PartRigResources {
  parts: Record<string, PartDef>
  images: Record<string, CanvasImageSource | null>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safePair(value: unknown, fallback: Pt): Pt {
  if (!Array.isArray(value) || value.length < 2) return fallback
  const x = value[0]
  const y = value[1]
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)
    ? [x, y]
    : fallback
}

function normalizePartDef(value: unknown): PartDef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.image !== 'string' || !raw.image.trim()) return null
  return {
    image: raw.image,
    pivot: safePair(raw.pivot, [0.5, 1]) as [number, number],
    offset: safePair(raw.offset, [0, 0]) as [number, number],
    height: typeof raw.height === 'number' && Number.isFinite(raw.height) && raw.height > 0 ? raw.height : 0.2,
  }
}

/** 部件图在画布上的落点，以关节为原点。抽成纯函数以便单测。 */
export interface PartRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 由 pivot 与部件高度算出绘制矩形。
 *
 * pivot 是"关节在该图内的位置"（0..1）。pivot [0.5, 1] 表示图的底边中点
 * 贴在关节上 —— 四肢通常这么配；头部一般用 [0.5, 0.5]。
 */
export function computePartRect(
  def: PartDef,
  imageAspect: number,
  heightPx: number,
  offsetPx: Pt = [0, 0],
): PartRect {
  const safeDef = normalizePartDef(def) ?? {
    image: '',
    pivot: [0.5, 1] as [number, number],
    offset: [0, 0] as [number, number],
    height: 0.2,
  }
  const safeHeight = Number.isFinite(heightPx) ? heightPx : 0
  const width = safeHeight * (Number.isFinite(imageAspect) ? imageAspect : 1)
  return {
    // pivot 负责把图片上的关节对准原点，offset 再按身高比例把它挪一点
    x: -safeDef.pivot[0] * width + offsetPx[0],
    y: -safeDef.pivot[1] * safeHeight + offsetPx[1],
    width,
    height: safeHeight,
  }
}

function imageAspect(image: CanvasImageSource): number {
  const anyImage = image as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number }
  const w = anyImage.naturalWidth ?? anyImage.width ?? 1
  const h = anyImage.naturalHeight ?? anyImage.height ?? 1
  return w / Math.max(1, h)
}

/**
 * 用图片画一个部件。
 *
 * 变换顺序很关键：先平移到关节，再按朝向水平缩放（负值即镜像），
 * 最后按肢体角度旋转。把镜像放在旋转之前，镜像后的旋转方向才会跟着对。
 */
function drawPartImage(
  env: ActorDrawEnv,
  def: PartDef,
  image: CanvasImageSource,
  joint: Pt,
  angle: number,
): void {
  const { ctx, transform: t } = env
  /*
   * `offset` 终于被用上了。
   *
   * 它此前是 schema 里的**必填**字段：文档教作者写、缺了 `content:check`
   * 还会报错 —— 但全仓没有一行代码读它，写什么渲染结果都一样。
   * （顺带：zod 那边的注释说它是"关节在角色局部空间的位置"，和这里的
   * "相对关节的额外偏移"是两回事。按绘制流程，后者才对：这段变换先平移到
   * 关节，`computePartRect` 返回的就是关节局部坐标。注释已改正。）
   *
   * 单位是身高比例，所以要跟着 transform 一起换算成像素。
   */
  const rect = computePartRect(def, imageAspect(image), transformLen(t, def.height), [
    transformLen(t, def.offset[0]),
    transformLen(t, def.offset[1]),
  ])
  ctx.save()
  ctx.translate(transformX(t, joint[0]), transformY(t, joint[1]))
  ctx.scale(t.sx, 1)
  ctx.rotate(-angle)
  ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height)
  ctx.restore()
}

function drawShadow(env: ActorDrawEnv): void {
  const { ctx, transform: t, palette, actor } = env
  // 身体抬起时影子收紧，强化上下起伏的观感
  const shrink = 1 - Math.min(0.35, Math.abs(actor.pose.bobY) * 4)
  ctx.beginPath()
  ctx.ellipse(
    transformX(t, 0),
    transformY(t, 0),
    transformLen(t, RIG.shadowRX) * shrink,
    transformLen(t, RIG.shadowRY) * shrink,
    0,
    0,
    Math.PI * 2,
  )
  ctx.fillStyle = palette.shadow
  ctx.fill()
}

function drawFoot(env: ActorDrawEnv, foot: Pt, color: string): void {
  const toe: Pt = [foot[0] + RIG.footLen, foot[1] - 0.008]
  capsule(env, foot, toe, RIG.legWidth * 0.82, color)
}

function drawHead(env: ActorDrawEnv, center: Pt, hair: string, skin: string, blink: number): void {
  const { ctx, transform: t } = env
  const r = transformLen(t, RIG.headR)

  // 头发做成整颗头的底色，再把脸"贴"在下前方，得到极简但有辨识度的剪影
  ctx.beginPath()
  ctx.arc(transformX(t, center[0]), transformY(t, center[1]), r, 0, Math.PI * 2)
  ctx.fillStyle = hair
  ctx.fill()

  const faceCenter: Pt = [center[0] + 0.012, center[1] + 0.012]
  ctx.beginPath()
  ctx.ellipse(
    transformX(t, faceCenter[0]),
    transformY(t, faceCenter[1]),
    transformLen(t, RIG.headR * 0.84),
    transformLen(t, RIG.headR * 0.78),
    0,
    0,
    Math.PI * 2,
  )
  ctx.fillStyle = skin
  ctx.fill()

  // 眼睛：面朝局部 +x 方向
  const eyeY = center[1] + 0.004
  const eyes = [center[0] + 0.02, center[0] + 0.058]
  ctx.strokeStyle = '#2c2a2a'
  ctx.fillStyle = '#2c2a2a'
  if (blink > 0.5) {
    ctx.lineWidth = Math.max(0.6, transformLen(t, 0.012))
    ctx.lineCap = 'round'
    for (const ex of eyes) {
      ctx.beginPath()
      ctx.moveTo(transformX(t, ex - 0.014), transformY(t, eyeY))
      ctx.lineTo(transformX(t, ex + 0.014), transformY(t, eyeY))
      ctx.stroke()
    }
  } else {
    for (const ex of eyes) {
      ctx.beginPath()
      ctx.arc(transformX(t, ex), transformY(t, eyeY), Math.max(0.6, transformLen(t, 0.013)), 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

function draw(env: ActorDrawEnv, resources?: unknown): void {
  const { palette: p, actor } = env
  const pose = actor.pose
  const atlas = resources as PartRigResources | undefined
  const parts = isRecord(atlas?.parts) ? (atlas.parts as Record<string, unknown>) : null
  const images = isRecord(atlas?.images) ? (atlas.images as Record<string, CanvasImageSource | null>) : null

  // 被前景遮挡时整体压暗，读起来就"走到桌子后面了"。
  // 两个分支都必须给出 canvas 认得的颜色：`tint` 走运行时路径时不校验格式，
  // 直接把 'tomato' 这种值交给 strokeStyle，canvas 会静默忽略并沿用上一个颜色
  const tone = (color: string): string => (env.dimmed ? shade(color, 0.62) : safeColor(color))

  /** 有部件图就用图，没有就回落程序化胶囊体 —— 可以逐个部件替换。 */
    const part = (name: string, joint: Pt, angle: number, fallback: () => void): void => {
    const def = normalizePartDef(parts?.[name])
    const image = images?.[name]
    if (def && image) drawPartImage(env, def, image, joint, angle)
    else fallback()
  }

  part('shadow', [0, 0], 0, () => drawShadow(env))

  const hip: Pt = [pose.swayX, RIG.hipY + pose.bobY]
  const shoulder = add(hip, rot(0, -RIG.torsoLen, pose.lean))
  // 左右肢体的根部分开，避免手臂压在躯干中央
  const hipL: Pt = [hip[0] - RIG.hipHalfWidth, hip[1]]
  const hipR: Pt = [hip[0] + RIG.hipHalfWidth, hip[1]]
  const shoulderL: Pt = [shoulder[0] - RIG.shoulderHalfWidth, shoulder[1]]
  const shoulderR: Pt = [shoulder[0] + RIG.shoulderHalfWidth, shoulder[1]]

  // ── 远侧：先画，被躯干压住 ──────────────────────────────
  const farLeg = tone(shade(p.legs, 0.76))
  const farArm = tone(shade(p.torso, 0.76))
  const farSkin = tone(shade(p.skin, 0.82))

  const kneeL = limbEnd(hipL, pose.thighL, RIG.thigh)
  const footL = limbEnd(kneeL, pose.thighL - pose.kneeL, RIG.shin)
  part('leg_upper_l', hipL, pose.thighL, () => capsule(env, hipL, kneeL, RIG.legWidth, farLeg))
  part('leg_lower_l', kneeL, pose.thighL - pose.kneeL, () =>
    capsule(env, kneeL, footL, RIG.legWidth * 0.86, farLeg),
  )
  drawFoot(env, footL, tone(shade(p.shoes, 0.78)))

  const elbowL = limbEnd(shoulderL, pose.armL, RIG.upperArm)
  const handL = limbEnd(elbowL, pose.armL + pose.elbowL, RIG.foreArm)
  part('arm_upper_l', shoulderL, pose.armL, () => capsule(env, shoulderL, elbowL, RIG.armWidth, farArm))
  part('arm_lower_l', elbowL, pose.armL + pose.elbowL, () =>
    capsule(env, elbowL, handL, RIG.armWidth * 0.86, farSkin),
  )

  // ── 躯干与头 ─────────────────────────────────────────────
  const torsoWidth = RIG.torsoWidth * (1 + pose.breathe * 0.035)
  part('torso', hip, pose.lean, () => capsule(env, hip, shoulder, torsoWidth, tone(p.torso)))

  const headCenter = add(shoulder, rot(0, -RIG.headOffset, pose.lean + pose.headTilt))
  const neck = add(shoulder, rot(0, -RIG.headOffset * 0.5, pose.lean + pose.headTilt))
  capsule(env, shoulder, neck, RIG.neckWidth, tone(shade(p.skin, 0.92)))
  part('head', headCenter, pose.lean + pose.headTilt, () =>
    drawHead(env, headCenter, tone(p.hair), tone(p.skin), pose.blink),
  )

  // ── 近侧：后画，压在躯干之上 ────────────────────────────
  const kneeR = limbEnd(hipR, pose.thighR, RIG.thigh)
  const footR = limbEnd(kneeR, pose.thighR - pose.kneeR, RIG.shin)
  part('leg_upper_r', hipR, pose.thighR, () => capsule(env, hipR, kneeR, RIG.legWidth, tone(p.legs)))
  part('leg_lower_r', kneeR, pose.thighR - pose.kneeR, () =>
    capsule(env, kneeR, footR, RIG.legWidth * 0.86, tone(p.legs)),
  )
  drawFoot(env, footR, tone(p.shoes))

  const elbowR = limbEnd(shoulderR, pose.armR, RIG.upperArm)
  const handR = limbEnd(elbowR, pose.armR + pose.elbowR, RIG.foreArm)
  part('arm_upper_r', shoulderR, pose.armR, () => capsule(env, shoulderR, elbowR, RIG.armWidth, tone(p.torso)))
  part('arm_lower_r', elbowR, pose.armR + pose.elbowR, () =>
    capsule(env, elbowR, handR, RIG.armWidth * 0.86, tone(p.skin)),
  )
}

/** 加载部件图集。没配 parts 或加载失败时返回 undefined，渲染器走程序化路径。 */
async function prepare(spec: ActorSpec, assets: AssetStore): Promise<PartRigResources | undefined> {
  if (!spec.parts) return undefined
  let atlas: unknown
  try {
    atlas = await assets.json<unknown>(spec.parts)
  } catch {
    return undefined
  }
  if (!isRecord(atlas) || !isRecord(atlas.parts)) return undefined

  const rawParts = atlas.parts
  const known = new Set<string>(PART_NAMES)
  const unknown = Object.keys(rawParts).filter((name) => !known.has(name))
  if (unknown.length > 0) {
    console.warn(`[partRig] 图集里这些部件名不被识别，会被忽略：${unknown.join(', ')}`)
  }

  const parts: Record<string, PartDef> = {}
  for (const [name, rawDef] of Object.entries(rawParts)) {
    const def = normalizePartDef(rawDef)
    if (def) parts[name] = def
  }

  const images: Record<string, CanvasImageSource | null> = {}
  await Promise.all(
    Object.entries(parts).map(async ([name, def]) => {
      try {
        images[name] = await assets.image(def.image)
      } catch {
        images[name] = null
      }
    }),
  )

  return { parts, images }
}

export const partRigRenderer: ActorRenderer = {
  id: 'partRig',
  prepare: (spec, assets) => prepare(spec, assets),
  draw,
}
