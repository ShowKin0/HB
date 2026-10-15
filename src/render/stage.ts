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
  /** 场景矩形在画布中的位置与尺寸。cover 时会超出画布（负的 x/y、更大的 w/h）。 */
  x: number
  y: number
  w: number
  h: number
  /**
   * 场景**可见部分**在归一化场景坐标里的纵向范围。
   *
   * contain 时恒为 [0, 1] —— 整张画面都在。
   * cover 时画面被裁掉上下两端，这个区间就是剩下那一段。
   *
   * 地面角点是按**整张画面**标的，前端往往压在最底下；cover 下如果不管它，
   * 角色会直接走到屏幕外面去。运行时用这个区间把走动深度收进可见范围。
   */
  /** 当前可见归一化场景坐标矩形。 */
  visibleU0: number
  visibleU1: number
  visibleV0: number
  visibleV1: number
}

export type SceneFit = 'contain' | 'cover'

/**
 * 场景按固定宽高比适配进画布。
 *
 * `contain`（默认）整张画面都在，四周可能有留白 —— 内容最安全，但宽高比
 * 对不上时会看到黑边。
 *
 * `cover` 铺满可用区域，多出来的部分裁掉 —— 没有黑边，但**画面会缺一块**：
 * 关键内容要放在中间（见 ART-GUIDE 的安全区），走动深度由
 * `visibleV0/V1` 收窄兜住。
 *
 * 两个 inset 圈出**可用区域**，场景只在里面适配：
 *   · bottomInset：底部对话框
 *   · rightInset ：右侧对话面板
 */
export function fitViewport(
  width: number,
  height: number,
  aspect: number,
  bottomInset = 0,
  rightInset = 0,
  fit: SceneFit = 'contain',
): Viewport {
  if (width <= 0 || height <= 0 || aspect <= 0) {
    return { width, height, x: 0, y: 0, w: width, h: height, visibleU0: 0, visibleU1: 1, visibleV0: 0, visibleV1: 1 }
  }
  const availableWidth = Math.max(1, width - Math.max(0, rightInset))
  const availableHeight = Math.max(1, height - Math.max(0, bottomInset))
  const areaAspect = availableWidth / availableHeight

  let w: number
  let h: number
  if (fit === 'cover') {
    /*
     * cover 的分支和 contain **刚好相反**：contain 挑"装得下的那个方向"，
     * cover 挑"盖得住的那个方向"。
     */
    if (areaAspect > aspect) {
      w = availableWidth
      h = availableWidth / aspect
    } else {
      h = availableHeight
      w = availableHeight * aspect
    }
  } else if (areaAspect > aspect) {
    h = availableHeight
    w = availableHeight * aspect
  } else {
    w = availableWidth
    h = availableWidth / aspect
  }

  // 在可用区域内居中（不是在整个画布里居中）
  const x = (availableWidth - w) / 2
  const y = (availableHeight - h) / 2

  /*
   * 画面被裁掉之后，剩下的是哪一段。
   *
   * 场景纵坐标 v 落到画布上的位置是 `y + v*h`，可见范围就是把它夹在可用
   * 区域 [0, availableHeight] 里解出来的 v 区间。contain 时 y ≥ 0 且
   * y + h ≤ availableHeight，解出来正好是 [0, 1]。
   */
  const u0 = Math.min(1, Math.max(0, -x / w))
  const u1 = Math.min(1, Math.max(0, (availableWidth - x) / w))
  const v0 = Math.min(1, Math.max(0, -y / h))
  const v1 = Math.min(1, Math.max(0, (availableHeight - y) / h))

  return {
    width,
    height,
    x,
    y,
    w,
    h,
    visibleU0: u0 <= u1 ? u0 : 0,
    visibleU1: u0 <= u1 ? u1 : 1,
    visibleV0: v0 <= v1 ? v0 : 0,
    visibleV1: v0 <= v1 ? v1 : 1,
  }
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
  /** 右侧为界面（横屏对话面板）预留的宽度，单位 CSS 像素。 */
  rightInset?: number
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
  rightInset: number
  /**
   * 设备像素比上限。
   *
   * 可改：项目清单里的 mobile.maxDpr 在内容加载完成之后才生效，
   * 而内容是异步加载的，构造时还拿不到。
   */
  private maxDpr: number
  /**
   * 场景适配策略。和 maxDpr 一样由项目清单在内容加载后写入 ——
   * 构造时还读不到 project.json。
   */
  private sceneFit: SceneFit = 'contain'
  private dpr = 1

  constructor(canvas: HTMLCanvasElement, options: CanvasStageOptions) {
    this.canvas = canvas
    this.aspect = options.aspect
    this.bottomInset = options.bottomInset ?? 0
    this.rightInset = options.rightInset ?? 0
    this.maxDpr = options.maxDpr ?? 2
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('无法获取 2D 画布上下文')
    this.ctx = ctx
    this.viewport = fitViewport(0, 0, options.aspect, this.bottomInset, this.rightInset)
  }

  /**
   * 设置 DPR 上限。返回是否真的变了（变了就需要重新 resize 一次）。
   *
   * 夹在 1..4：低于 1 会让画布比 CSS 尺寸还小（糊成一片），
   * 高于 4 在手机上只是白白吃内存。
   */
  setMaxDpr(value: number): boolean {
    const next = Number.isFinite(value) ? Math.min(4, Math.max(1, value)) : 2
    if (next === this.maxDpr) return false
    this.maxDpr = next
    return true
  }

  /**
   * 设置场景适配策略。返回是否真的变了（变了就需要重新 resize 一次）。
   *
   * `contain` 整张画面都在、可能有黑边；`cover` 铺满不留黑边、但会裁掉
   * 画面的一部分。和 maxDpr 一样，内容加载完才知道该用哪个。
   */
  setSceneFit(value: SceneFit): boolean {
    if (value === this.sceneFit) return false
    this.sceneFit = value
    return true
  }

  get fit(): SceneFit {
    return this.sceneFit
  }

  get dprLimit(): number {
    return this.maxDpr
  }

  /** 由 CSS 尺寸驱动。返回视口是否发生变化。 */
  resize(cssWidth: number, cssHeight: number): boolean {
    const dpr = Math.min(this.maxDpr, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)
    const pixelWidth = Math.max(1, Math.round(cssWidth * dpr))
    const pixelHeight = Math.max(1, Math.round(cssHeight * dpr))
    const next = fitViewport(
      cssWidth,
      cssHeight,
      this.aspect,
      this.bottomInset,
      this.rightInset,
      this.sceneFit,
    )

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
