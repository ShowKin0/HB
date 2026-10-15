import type { AssetStore } from '../engine/assets.ts'
import type { ActorSpec } from '../schema/scene.ts'
import type { SpriteAtlas, SpriteAtlasFile } from '../schema/rig.rules.ts'
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

// SpriteAtlas 的运行时契约住在 schema/rig.rules.ts，和 SpriteAtlasSchema 一一对应。
// 这里再导出一次只是为了兼容既有 import。
export type { SpriteAtlas } from '../schema/rig.rules.ts'

export interface SpriteSheetResources {
  image: CanvasImageSource | null
  atlas: SpriteAtlas | null
}

/**
 * 加载精灵表图集与它引用的那张图。
 *
 * **这个函数以前不存在**，所以 `resources` 恒为 `undefined`，`draw` 每次都
 * 走"素材缺失"分支静默回落 `partRigRenderer.draw` —— 作者把 `renderer`
 * 写成 `"spriteSheet"` 完全无效，画出来和默认渲染器一模一样。
 *
 * 图集文件是原样读进来的，运行时没有校验，所以这里必须自己把格式兜住：
 * 缺字段或字段非法一律当作"素材不可用"，让 `draw` 走回落，而不是让
 * 半截数据进渲染循环（`anchorY` 为 0 会算出 1e6 倍尺寸那种）。
 */
async function prepare(
  spec: ActorSpec,
  assets: AssetStore,
): Promise<SpriteSheetResources | undefined> {
  if (!spec.parts) return undefined
  const raw = await assets.json<SpriteAtlasFile>(spec.parts)
  if (!raw || typeof raw !== 'object' || typeof raw.image !== 'string' || !raw.image) {
    return undefined
  }
  const columns = Math.floor(Number(raw.columns))
  const frameWidth = Math.floor(Number(raw.frameWidth))
  const frameHeight = Math.floor(Number(raw.frameHeight))
  if (!(columns > 0) || !(frameWidth > 0) || !(frameHeight > 0)) return undefined

  const clips: Record<string, number[]> = {}
  for (const [key, frames] of Object.entries(raw.clips ?? {})) {
    if (Array.isArray(frames) && frames.length > 0) clips[key] = frames.map((f) => Number(f) || 0)
  }
  if (Object.keys(clips).length === 0) return undefined

  const anchorY = Number(raw.anchorY ?? 1)
  return {
    image: await assets.image(raw.image),
    atlas: {
      columns,
      frameWidth,
      frameHeight,
      anchorX: Number(raw.anchorX ?? 0.5),
      // 下限 0.05：它同时充当缩放系数，0 或负数会算出天文尺寸
      anchorY: Number.isFinite(anchorY) ? Math.min(1, Math.max(0.05, anchorY)) : 1,
      clips,
    },
  }
}

/** 屏幕空间方向向量 → 8 方向名。 */
export function directionOf(dx: number, dy: number): Dir8 {
  const angle = Math.atan2(dy, dx)
  const idx = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8
  return DIR8[idx]
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

  /*
   * **只在图集缺少这个方向的帧时才镜像。**
   *
   * 这两件事以前是无条件叠加的：`directionOf` 会给出 W/NW/SW，而后面
   * 又按 `facing < 0` 整体镜像 —— 真八向图集里朝西的帧于是被镜像成朝东，
   * 角色往左走、画面里朝右。只有"图集里只有 E 系帧、靠翻转凑出西向"的
   * 写法才该翻转，那正是 `pickFrame` 会回落到别的方向的情形。
   */
  const hasOwnDirection = atlas.clips[`${walking ? 'walk' : 'idle'}:${dir}`] !== undefined

  ctx.beginPath()
  ctx.ellipse(transformX(t, 0), transformY(t, 0), transformLen(t, 0.14), transformLen(t, 0.045), 0, 0, Math.PI * 2)
  ctx.fillStyle = palette.shadow
  ctx.fill()

  const cols = Math.max(1, atlas.columns)
  const sx = (frame % cols) * atlas.frameWidth
  const sy = Math.floor(frame / cols) * atlas.frameHeight

  /*
   * 高度对齐到 1 个身高单位，锚点贴在脚底。
   *
   * `anchorY` 同时是"脚底以上占帧高多少"和缩放系数，所以它**必须大于 0**：
   * 取 0 时这里会算出 1e6 倍身高。schema 那边现在要求正数，运行时再夹一道
   * 下限（图集文件是原样读进来的，没有校验）。
   */
  const anchorY = Math.min(1, Math.max(0.05, atlas.anchorY ?? 1))
  const h = transformLen(t, 1 / anchorY)
  const w = h * (atlas.frameWidth / Math.max(1, atlas.frameHeight))
  const ax = (atlas.anchorX ?? 0.5) * w
  const ay = anchorY * h

  ctx.save()
  ctx.translate(transformX(t, actor.pose.swayX), transformY(t, actor.pose.bobY))
  ctx.scale(!hasOwnDirection && actor.facing < 0 ? -1 : 1, 1)
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
  prepare,
  draw,
}
