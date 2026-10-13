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
  draw,
}
