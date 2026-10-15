import type { AssetStore } from '../engine/assets.ts'
import type { ActorSpec } from '../schema/scene.ts'
import { type ActorDrawEnv, type ActorRenderer, transformLen, transformX, transformY } from './types.ts'
import { partRigRenderer } from './partRig.ts'

/**
 * 兜底渲染器：只有一张静态立绘时使用。
 *
 * 做法是"伪行走"—— 沿路径滑行，同时叠加上下起伏与倾斜，
 * 配合影子一起看是成立的。
 *
 * 连立绘都没有时直接退到部件骨架，所以这条路径**永远不会画出空白**。
 */
export interface GlideResources {
  image: CanvasImageSource | null
}

/**
 * 加载那张立绘。
 *
 * **这个函数以前根本不存在** —— `prepareActorRenderer` 对没有 `prepare` 的
 * 渲染器一律返回 `undefined`，于是 glide 永远拿不到 `resources`、每次都静默
 * 回落 `partRigRenderer.draw`。作者在场景 JSON 里把 `renderer` 写成 `"glide"`
 * **完全无效**，画出来和 `partRig` 一模一样，而且没有任何提示 —— 三个渲染器
 * 里有两个是这样。
 *
 * 素材引用走 `spec.parts`：它就是"该渲染器自己的素材"，各家自己解释 ——
 * 部件骨架是部件图集 JSON，精灵表是精灵图集 JSON，glide 是单张立绘。
 */
async function prepare(spec: ActorSpec, assets: AssetStore): Promise<GlideResources | undefined> {
  if (!spec.parts) return undefined
  return { image: await assets.image(spec.parts) }
}

function imageSize(image: CanvasImageSource): [number, number] {
  const anyImage = image as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number }
  return [anyImage.naturalWidth ?? anyImage.width ?? 1, anyImage.naturalHeight ?? anyImage.height ?? 1]
}

function draw(env: ActorDrawEnv, resources?: unknown): void {
  const image = (resources as GlideResources | undefined)?.image ?? null
  if (!image) {
    partRigRenderer.draw(env)
    return
  }

  const { ctx, transform: t, actor, palette } = env
  const pose = actor.pose

  ctx.beginPath()
  ctx.ellipse(
    transformX(t, 0),
    transformY(t, 0),
    transformLen(t, 0.15),
    transformLen(t, 0.05),
    0,
    0,
    Math.PI * 2,
  )
  ctx.fillStyle = palette.shadow
  ctx.fill()

  ctx.save()
  ctx.translate(transformX(t, pose.swayX), transformY(t, pose.bobY))
  ctx.scale(t.sx, 1)

  const h = transformLen(t, 1)
  const [iw, ih] = imageSize(image)
  const w = h * (iw / Math.max(1, ih))
  ctx.drawImage(image, -w / 2, -h, w, h)
  ctx.restore()
}

export const glideRenderer: ActorRenderer = {
  id: 'glide',
  prepare,
  draw,
}
