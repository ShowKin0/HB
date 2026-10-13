import { getActorRenderer } from '../actorRenderers/registry.ts'
import { DEFAULT_PALETTE, type ActorPalette, type ActorTransform } from '../actorRenderers/types.ts'
import type { Actor } from '../engine/actor/actor.ts'
import type { DrawableObject, SceneRuntime } from '../engine/scene/runtime.ts'
import type { Hotspot, SceneLayer } from '../schema/scene.ts'
import type { Shape } from '../schema/common.ts'
import { isWalkable } from '../engine/nav/mask.ts'
import type { FxState } from './fx.ts'
import { shakeOffset } from './fx.ts'
import type { CanvasStage } from './stage.ts'

export interface DebugFlags {
  ground: boolean
  mask: boolean
  paths: boolean
  anchors: boolean
}

export const DEFAULT_DEBUG: DebugFlags = {
  ground: false,
  mask: false,
  paths: false,
  anchors: false,
}

export interface RenderSceneOptions {
  runtime: SceneRuntime
  stage: CanvasStage
  resources: Map<string, unknown>
  debug?: DebugFlags
  fx?: FxState
  elapsed?: number
  /** 当前悬停的物件 id，用于高亮反馈。 */
  hoverId?: string | null
  /** 拖拽中的物品 id 与当前指针位置（场景空间），用于画"手上的东西"。 */
  drag?: { itemId: string; label: string; point: [number, number]; overTarget: boolean } | null
  /**
   * 求值物件的 visibleWhen。必须由上层提供（渲染层不该知道 ink 的存在）。
   *
   * 传的是**物件本身**而不是 id：按 id 反查会让每帧每个可绘制物件都做一次
   * 线性查找，n 个物件就是 O(n²)。直接给对象既更快，也少一层间接。
   */
  isVisible?: (owner: Hotspot | SceneLayer) => boolean
}

type DrawEntry =
  | { v: number; kind: 'actor'; actor: Actor }
  | { v: number; kind: 'object'; item: DrawableObject }

/**
 * 场景绘制。
 *
 * 绘制顺序：背景 → 按深度排序的物件 / 图层 / 角色 → 调试叠加 → 交互反馈。
 *
 * 物件、图层、角色共用同一个 `v` 深度轴，所以"走到桌子后面"只靠一个数字
 * 就能表达，不需要给每类东西各写一套排序规则。
 */
export function renderScene(options: RenderSceneOptions): void {
  const { runtime, stage } = options
  const { ctx, viewport } = stage
  const debug = options.debug ?? DEFAULT_DEBUG
  const elapsed = options.elapsed ?? 0

  stage.beginFrame(null)

  ctx.save()
  if (options.fx) {
    const [dx, dy] = shakeOffset(options.fx, elapsed)
    if (dx !== 0 || dy !== 0) ctx.translate(dx * viewport.w, dy * viewport.h)
  }

  drawBackground(runtime, stage)

  const entries: DrawEntry[] = []
  for (const actor of runtime.actors) entries.push({ v: actor.v, kind: 'actor', actor })
  for (const item of runtime.collectDrawables(elapsed, options.isVisible)) {
    entries.push({ v: item.v, kind: 'object', item })
  }

  // 深度排序：v 越大越靠前
  entries.sort((a, b) => a.v - b.v)
  for (const entry of entries) {
    if (entry.kind === 'actor') drawActor(entry.actor, options)
    else drawObject(entry.item, stage)
  }

  if (debug.ground || debug.mask || debug.paths || debug.anchors) {
    drawDebug(runtime, stage, debug)
  }

  // 交互反馈画在最上面：它必须永远可见，否则玩家不知道哪里能点
  drawInteractionFeedback(options, elapsed)

  ctx.restore()

  // 淡入淡出遮罩覆盖整个画布，不受抖动影响
  if (options.fx && options.fx.fadeAlpha < 1) {
    ctx.save()
    ctx.globalAlpha = 1 - options.fx.fadeAlpha
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, viewport.width, viewport.height)
    ctx.restore()
  }
}

function drawBackground(runtime: SceneRuntime, stage: CanvasStage): void {
  const { ctx, viewport } = stage
  const image = runtime.background
  if (image) {
    // cover 填满场景矩形，保持宽高比不失真
    const iw = imageWidth(image)
    const ih = imageHeight(image)
    const scale = Math.max(viewport.w / iw, viewport.h / ih)
    const dw = iw * scale
    const dh = ih * scale
    ctx.save()
    ctx.beginPath()
    ctx.rect(viewport.x, viewport.y, viewport.w, viewport.h)
    ctx.clip()
    ctx.drawImage(image, viewport.x + (viewport.w - dw) / 2, viewport.y + (viewport.h - dh) / 2, dw, dh)
    ctx.restore()
    return
  }

  // 降级：没有背景图时画渐变占位 + 场景 id 水印，而不是留白
  const [from, to] = runtime.placeholderColors
  const gradient = ctx.createLinearGradient(viewport.x, viewport.y, viewport.x, viewport.y + viewport.h)
  gradient.addColorStop(0, from)
  gradient.addColorStop(1, to)
  ctx.fillStyle = gradient
  ctx.fillRect(viewport.x, viewport.y, viewport.w, viewport.h)

  ctx.save()
  ctx.globalAlpha = 0.18
  ctx.fillStyle = '#ffffff'
  ctx.font = `${Math.round(viewport.h * 0.04)}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(`缺少背景图：${runtime.scene.id}`, viewport.x + viewport.w / 2, viewport.y + viewport.h / 2)
  ctx.restore()
}

function paletteFor(actor: Actor): ActorPalette {
  const tint = actor.spec.tint
  return tint ? { ...DEFAULT_PALETTE, torso: tint } : DEFAULT_PALETTE
}

function drawActor(actor: Actor, options: RenderSceneOptions): void {
  const { runtime, stage, resources } = options
  const { ctx, viewport } = stage
  const placement = runtime.actorPlacement(actor)

  const px = viewport.x + placement.x * viewport.w
  const py = viewport.y + placement.y * viewport.h
  const hpx = placement.height * viewport.h

  // 转身时把水平方向压扁，过 0 的瞬间保留一点厚度避免"消失一帧"
  const magnitude = Math.max(0.12, Math.abs(actor.facing))
  const sx = actor.facing < 0 ? -magnitude : magnitude
  const transform: ActorTransform = { px, py, hpx, sx }

  const renderer = getActorRenderer(actor.spec.renderer)
  renderer.draw(
    { ctx, actor, transform, palette: paletteFor(actor), dimmed: false },
    resources.get(actor.spec.id),
  )
}

/**
 * 画一个物件或图层。
 *
 * 两种形态：
 *   - 整帧铺满（position 为 null 的旧式前景层）：直接盖住场景矩形
 *   - 定位绘制：按 position / anchor / height / scale / rotation 摆放
 */
function drawObject(item: DrawableObject, stage: CanvasStage): void {
  const { ctx, viewport } = stage
  if (!item.image) return

  if (item.fullFrame) {
    ctx.drawImage(item.image, viewport.x, viewport.y, viewport.w, viewport.h)
    return
  }

  const iw = imageWidth(item.image)
  const ih = imageHeight(item.image)
  const h = item.height * item.scale * viewport.h
  const w = h * (iw / Math.max(1, ih))
  const px = viewport.x + item.position[0] * viewport.w
  const py = viewport.y + item.position[1] * viewport.h

  // 影子画在图片底边，让悬空的物件有落点
  if (item.shadow) {
    const footY = py + (1 - item.anchor[1]) * h
    ctx.save()
    ctx.beginPath()
    ctx.ellipse(px, footY, w * 0.42, h * 0.09, 0, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)'
    ctx.fill()
    ctx.restore()
  }

  ctx.save()
  ctx.translate(px, py)
  if (item.rotation !== 0) ctx.rotate(item.rotation)
  ctx.drawImage(item.image, -item.anchor[0] * w, -item.anchor[1] * h, w, h)
  ctx.restore()
}

// ── 交互反馈 ───────────────────────────────────────────────

/** 把场景空间的形状转成画布路径。悬停高亮与调试都用它。 */
function shapePath(ctx: CanvasRenderingContext2D, stage: CanvasStage, shape: Shape): void {
  const { viewport } = stage
  const sx = (x: number): number => viewport.x + x * viewport.w
  const sy = (y: number): number => viewport.y + y * viewport.h
  ctx.beginPath()
  switch (shape.type) {
    case 'rect': {
      const left = shape.w >= 0 ? shape.x : shape.x + shape.w
      const top = shape.h >= 0 ? shape.y : shape.y + shape.h
      ctx.rect(sx(left), sy(top), Math.abs(shape.w) * viewport.w, Math.abs(shape.h) * viewport.h)
      break
    }
    case 'circle': {
      // 椭圆：场景空间是归一化的，不能直接用 arc
      ctx.ellipse(sx(shape.cx), sy(shape.cy), shape.r * viewport.w, shape.r * viewport.h, 0, 0, Math.PI * 2)
      break
    }
    case 'poly': {
      shape.points.forEach(([x, y], i) => {
        if (i === 0) ctx.moveTo(sx(x), sy(y))
        else ctx.lineTo(sx(x), sy(y))
      })
      ctx.closePath()
      break
    }
  }
}

/**
 * 交互反馈：悬停高亮 + 拖拽预览。
 *
 * 对**纯命中区**的物件（只有 shape、没有自己的图）来说，这是玩家唯一能看出
 * "这里能点"的线索，所以它不是装饰，是必需品。
 */
function drawInteractionFeedback(options: RenderSceneOptions, elapsed: number): void {
  const { runtime, stage } = options
  const { ctx } = stage
  const hoverId = options.hoverId ?? null
  const drag = options.drag ?? null

  if (hoverId) {
    const hotspot = runtime.scene.hotspots.find((h) => h.id === hoverId)
    if (hotspot && runtime.isObjectVisible(hotspot.id)) {
      const pulse = 0.5 + 0.5 * Math.sin(elapsed * 3.4)
      ctx.save()
      shapePath(ctx, stage, hotspot.shape)
      ctx.fillStyle = `rgba(255, 214, 140, ${0.06 + pulse * 0.05})`
      ctx.fill()
      ctx.strokeStyle = `rgba(255, 224, 168, ${0.55 + pulse * 0.3})`
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.restore()
    }
  }

  if (drag) {
    const { viewport } = stage
    const px = viewport.x + drag.point[0] * viewport.w
    const py = viewport.y + drag.point[1] * viewport.h
    const accent = drag.overTarget ? 'rgba(140, 235, 170, 0.95)' : 'rgba(255, 214, 140, 0.9)'

    ctx.save()
    ctx.globalAlpha = 0.92
    ctx.font = `${Math.round(viewport.h * 0.026)}px system-ui, sans-serif`
    const textWidth = ctx.measureText(drag.label).width
    const padX = viewport.h * 0.016
    const boxW = textWidth + padX * 2
    const boxH = viewport.h * 0.05
    const bx = px - boxW / 2
    const by = py - boxH - viewport.h * 0.012

    ctx.beginPath()
    ctx.roundRect(bx, by, boxW, boxH, boxH * 0.3)
    ctx.fillStyle = 'rgba(22, 18, 16, 0.92)'
    ctx.fill()
    ctx.strokeStyle = accent
    ctx.lineWidth = 2
    ctx.stroke()

    ctx.fillStyle = accent
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(drag.label, px, by + boxH / 2)
    ctx.restore()
  }
}

function drawDebug(runtime: SceneRuntime, stage: CanvasStage, debug: DebugFlags): void {
  const { ctx, viewport } = stage
  const toScreen = (u: number, v: number): [number, number] => {
    const [x, y] = runtime.projectPlane(u, v)
    return [viewport.x + x * viewport.w, viewport.y + y * viewport.h]
  }

  ctx.save()

  if (debug.mask && runtime.mask) {
    const mask = runtime.mask
    for (let r = 0; r < mask.rows; r++) {
      for (let c = 0; c < mask.cols; c++) {
        const walkable = isWalkable(mask, c, r)
        ctx.beginPath()
        const corners: [number, number][] = [
          toScreen(c / mask.cols, r / mask.rows),
          toScreen((c + 1) / mask.cols, r / mask.rows),
          toScreen((c + 1) / mask.cols, (r + 1) / mask.rows),
          toScreen(c / mask.cols, (r + 1) / mask.rows),
        ]
        ctx.moveTo(corners[0][0], corners[0][1])
        for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i][0], corners[i][1])
        ctx.closePath()
        ctx.fillStyle = walkable ? 'rgba(80, 220, 140, 0.16)' : 'rgba(220, 80, 80, 0.26)'
        ctx.fill()
      }
    }
  }

  if (debug.ground && runtime.scene.ground) {
    ctx.beginPath()
    runtime.scene.ground.corners.forEach(([u, v], i) => {
      const [x, y] = toScreen(u, v)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.closePath()
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.9)'
    ctx.lineWidth = 2
    ctx.stroke()

    ctx.strokeStyle = 'rgba(120, 200, 255, 0.35)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const u of [0, 1]) {
      const [x0, y0] = toScreen(u, 0)
      const [x1, y1] = toScreen(u, 1)
      ctx.moveTo(x0, y0)
      ctx.lineTo(x1, y1)
    }
    for (const v of [0, 1]) {
      const [x0, y0] = toScreen(0, v)
      const [x1, y1] = toScreen(1, v)
      ctx.moveTo(x0, y0)
      ctx.lineTo(x1, y1)
    }
    ctx.stroke()
  }

  if (debug.paths) {
    for (const actor of runtime.actors) {
      if (!actor.path) continue
      ctx.beginPath()
      actor.path.forEach(([u, v], i) => {
        const [x, y] = toScreen(u, v)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.strokeStyle = 'rgba(255, 210, 90, 0.95)'
      ctx.lineWidth = 2
      ctx.stroke()
      for (const [u, v] of actor.path) {
        const [x, y] = toScreen(u, v)
        ctx.beginPath()
        ctx.arc(x, y, 3, 0, Math.PI * 2)
        ctx.fillStyle = '#ffd25a'
        ctx.fill()
      }
    }
  }

  if (debug.anchors) {
    for (const actor of runtime.actors) {
      const [x, y] = toScreen(actor.u, actor.v)
      ctx.beginPath()
      ctx.moveTo(x - 8, y)
      ctx.lineTo(x + 8, y)
      ctx.moveTo(x, y - 8)
      ctx.lineTo(x, y + 8)
      ctx.strokeStyle = '#ff5a8a'
      ctx.lineWidth = 2
      ctx.stroke()
    }
    // 物件的命中区与绘制锚点 —— 调场景时这两个对不上是最常见的问题
    for (const hotspot of runtime.scene.hotspots) {
      ctx.save()
      shapePath(ctx, stage, hotspot.shape)
      ctx.strokeStyle = 'rgba(255, 90, 138, 0.55)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.restore()
    }
  }

  ctx.restore()
}

function imageWidth(image: CanvasImageSource): number {
  const anyImage = image as { width?: number; naturalWidth?: number }
  return anyImage.naturalWidth ?? anyImage.width ?? 1
}

function imageHeight(image: CanvasImageSource): number {
  const anyImage = image as { height?: number; naturalHeight?: number }
  return anyImage.naturalHeight ?? anyImage.height ?? 1
}

/** 供外部（编辑器 / 测试）复用的形状路径工具。 */
export { shapePath }
export type { Hotspot }
