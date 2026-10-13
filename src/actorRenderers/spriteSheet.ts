import { type ActorDrawEnv, type ActorRenderer, transformLen, transformX, transformY } from './types.ts'
import { partRigRenderer } from './partRig.ts'

/**
 * 逐帧精灵表渲染器。
 *
 * 适用于你已经有现成行走动画素材的情况。注意它的固有局限：
 * 帧序列是按相位取整的，所以步频只能靠 fps 近似，**无法像部件骨架
 * 那样严格不滑步** —— 这也是为什么默认渲染器不是它。
 *
 * 素材缺失时自动退到部件骨架，不会画出空白。
 */

/** 8 方向命名，索引由屏幕空间角度决定。 */
export const DIR8 = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'] as const
export type Dir8 = (typeof DIR8)[number]

export interface SpriteAtlas {
  /** 帧在图像上的排列：行优先，每行 columns 帧。 */
  columns: number
  frameWidth: number
  frameHeight: number
  /** 脚底在单帧内的位置，0..1。默认水平居中、贴底。 */
  anchorX?: number
  anchorY?: number
  /** 键形如 "walk:E"、"idle:S"。 */
  clips: Record<string, number[]>
}

export interface SpriteSheetResources {
  image: CanvasImageSource | null
  atlas: SpriteAtlas | null
}

/** 屏幕空间方向向量 → 8 方向名。 */
export function directionOf(dx: number, dy: number): Dir8 {
  const angle = Math.atan2(dy, dx)
  const idx = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8
  return DIR8[idx]
}

function imageSize(image: CanvasImageSource): [number, number] {
  const anyImage = image as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number }
  return [anyImage.naturalWidth ?? anyImage.width ?? 1, anyImage.naturalHeight ?? anyImage.height ?? 1]
}

/** 依据朝向与相位挑帧。找不到对应方向的片段时退回任意可用片段。 */
export function pickFrame(
  atlas: SpriteAtlas,
  dir: Dir8,
  phase: number,
  walking: boolean,
): number | null {
  const kind = walking ? 'walk' : 'idle'
  const clip =
    atlas.clips[`${kind}:${dir}`] ??
    atlas.clips[`${kind}:S`] ??
    atlas.clips[`${kind}:E`] ??
    (walking ? atlas.clips[`idle:${dir}`] : undefined) ??
    Object.values(atlas.clips)[0]
  if (!clip || clip.length === 0) return null
  if (clip.length === 1 || !walking) return clip[0]

  const t = (phase / (Math.PI * 2)) % 1
  const index = Math.floor(t * clip.length) % clip.length
  return clip[index < 0 ? index + clip.length : index]
}

function draw(env: ActorDrawEnv, resources?: unknown): void {
  const res = resources as SpriteSheetResources | undefined
  if (!res?.image || !res.atlas) {
    partRigRenderer.draw(env)
    return
  }

  const { ctx, transform: t, actor, palette } = env
  const atlas = res.atlas
  const walking = actor.pose.walk > 0.5
  const dir = directionOf(actor.faceDirX, actor.faceDirY)
  const frame = pickFrame(atlas, dir, actor.phase, walking)
  if (frame === null) {
    partRigRenderer.draw(env)
    return
  }

  ctx.beginPath()
  ctx.ellipse(transformX(t, 0), transformY(t, 0), transformLen(t, 0.14), transformLen(t, 0.045), 0, 0, Math.PI * 2)
  ctx.fillStyle = palette.shadow
  ctx.fill()

  const cols = Math.max(1, atlas.columns)
  const sx = (frame % cols) * atlas.frameWidth
  const sy = Math.floor(frame / cols) * atlas.frameHeight
  const [, ih] = imageSize(res.image)
  void ih

  // 高度对齐到 1 个身高单位，锚点贴在脚底
  const h = transformLen(t, 1 / Math.max(1e-6, atlas.anchorY ?? 1))
  const w = h * (atlas.frameWidth / Math.max(1, atlas.frameHeight))
  const ax = (atlas.anchorX ?? 0.5) * w
  const ay = (atlas.anchorY ?? 1) * h

  ctx.save()
  ctx.translate(transformX(t, actor.pose.swayX), transformY(t, actor.pose.bobY))
  ctx.scale(actor.facing < 0 ? -1 : 1, 1)
  ctx.drawImage(
    res.image,
    sx,
    sy,
    atlas.frameWidth,
    atlas.frameHeight,
    -ax,
    -ay,
    w,
    h,
  )
  ctx.restore()
}

export const spriteSheetRenderer: ActorRenderer = {
  id: 'spriteSheet',
  draw,
}
