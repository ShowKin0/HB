/**
 * 画布与视口。
 *
 * 三层坐标，必须分清：
 *   1. 地面平面 (u,v)  —— 游戏逻辑在这里，见 render/homography.ts
 *   2. 场景空间 (x,y)  —— 归一化到 [0,1]，背景图与热点在这里
 *   3. 画布像素 (px,py)—— 最终落笔的位置
 *
 * 场景按固定宽高比 letterbox 进画布，因此换屏幕尺寸不需要改任何内容坐标。
 */

export interface Viewport {
  /** 画布 CSS 像素尺寸。 */
  width: number
  height: number
  /** 场景矩形在画布中的位置与尺寸。 */
  x: number
  y: number
  w: number
  h: number
}

/**
 * 场景按固定宽高比 letterbox 进画布。
 *
 * bottomInset 是底部为对话框预留的高度：场景只在**可用区域**里居中，
 * 绝不会延伸到对话框底下 —— 否则角色走到房间最前排就会被对话框整个盖住，
 * 而这个游戏的看点恰恰是看角色走动。
 * 竖屏手机上场景本来就受宽度限制，预留这块几乎不损失画面。
 */
export function fitViewport(width: number, height: number, aspect: number, bottomInset = 0): Viewport {
  if (width <= 0 || height <= 0 || aspect <= 0) {
    return { width, height, x: 0, y: 0, w: width, h: height }
  }
  const availableHeight = Math.max(1, height - Math.max(0, bottomInset))
  const areaAspect = width / availableHeight

  let w: number
  let h: number
  if (areaAspect > aspect) {
    h = availableHeight
    w = availableHeight * aspect
  } else {
    w = width
    h = width / aspect
  }

  return { width, height, x: (width - w) / 2, y: (availableHeight - h) / 2, w, h }
}

/** 画布像素 → 场景空间。落在 letterbox 黑边内时返回 null。 */
export function screenToScene(viewport: Viewport, px: number, py: number): [number, number] | null {
  const x = (px - viewport.x) / viewport.w
  const y = (py - viewport.y) / viewport.h
  if (x < -1e-6 || y < -1e-6 || x > 1 + 1e-6 || y > 1 + 1e-6) return null
  return [x, y]
}

export interface CanvasStageOptions {
  /** 画布元素的 CSS 尺寸变化时重新计算视口。 */
  aspect: number
  /** 底部为界面（对话框）预留的高度，单位 CSS 像素。 */
  bottomInset?: number
  /** 设备像素比上限，防止 4K 手机上过度绘制。 */
  maxDpr?: number
}

/**
 * 画布宿主：负责尺寸、设备像素比与视口，不负责画什么。
 */
export class CanvasStage {
  readonly canvas: HTMLCanvasElement
  readonly ctx: CanvasRenderingContext2D
  viewport: Viewport
  aspect: number
  bottomInset: number
  private readonly maxDpr: number
  private dpr = 1

  constructor(canvas: HTMLCanvasElement, options: CanvasStageOptions) {
    this.canvas = canvas
    this.aspect = options.aspect
    this.bottomInset = options.bottomInset ?? 0
    this.maxDpr = options.maxDpr ?? 2
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('无法获取 2D 画布上下文')
    this.ctx = ctx
    this.viewport = fitViewport(0, 0, options.aspect, this.bottomInset)
  }

  /** 由 CSS 尺寸驱动。返回视口是否发生变化。 */
  resize(cssWidth: number, cssHeight: number): boolean {
    const dpr = Math.min(this.maxDpr, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)
    const pixelWidth = Math.max(1, Math.round(cssWidth * dpr))
    const pixelHeight = Math.max(1, Math.round(cssHeight * dpr))
    const next = fitViewport(cssWidth, cssHeight, this.aspect, this.bottomInset)

    const changed =
      this.canvas.width !== pixelWidth ||
      this.canvas.height !== pixelHeight ||
      Math.abs(this.viewport.w - next.w) > 0.5 ||
      Math.abs(this.viewport.h - next.h) > 0.5 ||
      Math.abs(this.viewport.x - next.x) > 0.5 ||
      Math.abs(this.viewport.y - next.y) > 0.5

    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight
    this.dpr = dpr
    this.viewport = next
    return changed
  }

  /** 每帧开始：重置变换并清屏。之后所有绘制都用 CSS 像素坐标。 */
  beginFrame(clear: string | null = '#0b0d12'): void {
    const { ctx } = this
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    if (clear) {
      ctx.fillStyle = clear
      ctx.fillRect(0, 0, this.viewport.width, this.viewport.height)
    } else {
      ctx.clearRect(0, 0, this.viewport.width, this.viewport.height)
    }
  }

  /** 只清场景矩形区域。 */
  clearScene(color: string): void {
    const { ctx, viewport: v } = this
    ctx.fillStyle = color
    ctx.fillRect(v.x, v.y, v.w, v.h)
  }

  /** 画布像素坐标（如指针事件）→ 场景空间。 */
  toScene(clientX: number, clientY: number): [number, number] | null {
    const rect = this.canvas.getBoundingClientRect()
    return screenToScene(this.viewport, clientX - rect.left, clientY - rect.top)
  }
}
