/**
 * 素材加载与降级。
 *
 * 核心约束：**任何素材缺失都不能让游戏崩**。你还没做图、没录完音是常态，
 * 所以这里把"加载失败"当成一等公民处理：缓存成 null、记录一次、只告警一次，
 * 由渲染层决定用什么占位。
 */

export const ASSET_ROOT = `${import.meta.env.BASE_URL}assets/`

export function assetUrl(path: string): string {
  return ASSET_ROOT + path.replace(/^\/+/, '')
}

export class AssetStore {
  private readonly images = new Map<string, CanvasImageSource | null>()
  private readonly jsonCache = new Map<string, unknown>()
  private readonly pending = new Map<string, Promise<CanvasImageSource | null>>()
  private readonly missing = new Set<string>()
  private readonly warned = new Set<string>()

  /** 加载失败或未加载时返回 null；调用方需自行走降级路径。 */
  async image(path: string | null | undefined): Promise<CanvasImageSource | null> {
    if (!path) return null
    if (this.images.has(path)) return this.images.get(path) ?? null
    const inFlight = this.pending.get(path)
    if (inFlight) return inFlight

    const task = this.loadImage(path)
    this.pending.set(path, task)
    const result = await task
    this.pending.delete(path)
    this.images.set(path, result)
    return result
  }

  imageSync(path: string | null | undefined): CanvasImageSource | null {
    if (!path) return null
    return this.images.get(path) ?? null
  }

  /**
   * 加载 JSON 素材（部件图集、精灵表图集）。
   *
   * 失败同样只记一次并返回 null，由调用方走降级 —— 素材缺失不能让游戏崩。
   */
  async json<T>(path: string | null | undefined): Promise<T | null> {
    if (!path) return null
    const cached = this.jsonCache.get(path)
    if (cached !== undefined) return cached as T | null

    let result: T | null = null
    try {
      const response = await fetch(assetUrl(path))
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      result = (await response.json()) as T
    } catch {
      this.missing.add(path)
      if (!this.warned.has(path)) {
        this.warned.add(path)
        console.warn(`[assets] 缺失或格式错误，已走降级：assets/${path}`)
      }
    }
    this.jsonCache.set(path, result)
    return result
  }

  /** 已确认缺失的素材清单，供调试面板展示。 */
  get missingAssets(): string[] {
    return [...this.missing].sort()
  }

  has(path: string): boolean {
    return this.images.get(path) !== null && this.images.get(path) !== undefined
  }

  /** 预取一批素材，用于场景切换时提前加载下一幕。 */
  async preload(paths: readonly (string | null | undefined)[]): Promise<void> {
    await Promise.all(paths.map((path) => this.image(path)))
  }

  private async loadImage(path: string): Promise<CanvasImageSource | null> {
    // 没有 DOM 的环境（例如 Node 里跑引擎逻辑）直接记为缺失，
    // 否则每次调用都会重试一遍，白白创建 Promise。
    if (typeof Image === 'undefined') {
      this.missing.add(path)
      return null
    }
    return new Promise<CanvasImageSource | null>((resolve) => {
      const img = new Image()
      img.decoding = 'async'
      img.onload = () => resolve(img)
      img.onerror = () => {
        this.missing.add(path)
        if (!this.warned.has(path)) {
          this.warned.add(path)
          console.warn(`[assets] 缺失，已走降级占位：assets/${path}`)
        }
        resolve(null)
      }
      img.src = assetUrl(path)
    })
  }
}
