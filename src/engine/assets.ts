/**
 * 素材加载与降级。
 *
 * 核心约束：**任何素材缺失都不能让游戏崩**。你还没做图、没录完音是常态，
 * 所以这里把"加载失败"当成一等公民处理：缓存成 null、记录一次、只告警一次，
 * 由渲染层决定用什么占位。
 *
 * 另一条同样重要的约束：**内存必须有上限**。
 * 一张 1920×1080 的 RGBA 背景解码后约 8 MB。手机上随手切十几个场景，
 * 如果缓存只进不出，就是上百 MB —— 低内存的机器会直接被系统杀掉。
 * 所以这里是带预算的 LRU，而不是一个只增不减的 Map。
 */

export const ASSET_ROOT = `${import.meta.env.BASE_URL}assets/`

export function assetUrl(path: string): string {
  return ASSET_ROOT + path.replace(/^\/+/, '')
}

/**
 * 默认预算 96 MB。
 *
 * 定得宽松是故意的：正常玩一组场景根本碰不到上限，只有真在内存紧张的设备上
 * 连续切很多场景时才会触发淘汰 —— 那时候淘汰总比被系统杀掉好。
 */
export const DEFAULT_IMAGE_BUDGET_BYTES = 96 * 1024 * 1024

/** 估算一张图解码后占的内存。压缩体积说明不了问题，解码尺寸才作数。 */
function decodedBytes(image: CanvasImageSource): number {
  const sized = image as {
    naturalWidth?: number
    naturalHeight?: number
    width?: number
    height?: number
  }
  const width = sized.naturalWidth || sized.width || 0
  const height = sized.naturalHeight || sized.height || 0
  return width * height * 4
}

export interface ImageCacheStats {
  /** 缓存中的条目数（含加载失败的 null 占位）。 */
  entries: number
  /** 估算的解码后占用（字节）。 */
  bytes: number
  /** 预算（字节）。 */
  budgetBytes: number
  /** 累计淘汰次数，调试用。 */
  evictions: number
  /** 当前被 retain 的缓存图片占用，不含尚未完成的请求。 */
  activeBytes: number
  /** 尚未结算的图片与 JSON 请求数。 */
  pending: number
  /** 缓存总占用超过预算时为 true。 */
  overBudget: boolean
}

export interface AssetStoreOptions {
  /** 图片缓存预算（字节）。 */
  maxBytes?: number
  /** preload 最多并发解码数。 */
  maxPreloadConcurrency?: number
  /** preload 为每张未知尺寸图片预留的估算字节数。 */
  estimatedPreloadBytes?: number
  /** 从 JSON 清单提取其引用的图片路径，不绑定具体图集 schema。 */
  collectImageDependencies?: (jsonPath: string, value: unknown) => readonly string[]
  /**
   * 图片工厂。默认 `() => new Image()`。
   *
   * 注入出来是为了能在 Node 里测缓存与淘汰策略 —— 音频那边（createHowl）
   * 已经是同一个套路，这里照抄。
   */
  createImage?: () => HTMLImageElement
}

interface PendingImageRequest {
  generation: number
  promise: Promise<CanvasImageSource | null>
  image: HTMLImageElement | null
  settled: boolean
  abort: () => void
  settle: (result: CanvasImageSource | null, failed?: boolean) => void
}

interface PendingJsonRequest {
  generation: number
  controller: AbortController
  promise: Promise<unknown | null>
  settled: boolean
  settle: (result: unknown | null, failed?: boolean) => void
}

export class AssetStore {
  /**
   * 图片缓存。**用 Map 的插入顺序当 LRU 顺序**：命中时先删再插，
   * 于是队首永远是最久没用的那个。
   */
  private readonly images = new Map<string, CanvasImageSource | null>()
  private readonly jsonCache = new Map<string, unknown>()
  private readonly jsonDependencies = new Map<string, string[]>()
  private readonly pending = new Map<string, PendingImageRequest>()
  private readonly jsonPending = new Map<string, PendingJsonRequest>()
  private readonly retained = new Map<string, number>()
  private readonly missing = new Set<string>()
  private readonly warned = new Set<string>()
  private preloadQueue: Promise<void> = Promise.resolve()
  private readonly maxBytes: number
  private readonly maxPreloadConcurrency: number
  private readonly estimatedPreloadBytes: number
  private readonly collectImageDependencies?: (jsonPath: string, value: unknown) => readonly string[]
  private readonly createImage: (() => HTMLImageElement) | null
  private generation = 0
  private bytes = 0
  private evictions = 0

  constructor(options: AssetStoreOptions = {}) {
    const maxBytes = options.maxBytes ?? DEFAULT_IMAGE_BUDGET_BYTES
    const maxPreloadConcurrency = options.maxPreloadConcurrency ?? 4
    const estimatedPreloadBytes = options.estimatedPreloadBytes ?? 8 * 1024 * 1024
    this.maxBytes = Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : DEFAULT_IMAGE_BUDGET_BYTES
    this.maxPreloadConcurrency = Number.isFinite(maxPreloadConcurrency)
      ? Math.max(1, Math.floor(maxPreloadConcurrency))
      : 4
    this.estimatedPreloadBytes = Number.isFinite(estimatedPreloadBytes)
      ? Math.max(0, estimatedPreloadBytes)
      : 8 * 1024 * 1024
    this.collectImageDependencies = options.collectImageDependencies
    this.createImage = options.createImage ?? (typeof Image === 'undefined' ? null : () => new Image())
  }

  get cacheStats(): ImageCacheStats {
    return {
      entries: this.images.size,
      bytes: this.bytes,
      budgetBytes: this.maxBytes,
      evictions: this.evictions,
      activeBytes: this.activeBytes,
      pending: this.pending.size + this.jsonPending.size,
      overBudget: this.bytes > this.maxBytes,
    }
  }

  private get activeBytes(): number {
    const active = this.activePaths()
    let total = 0
    for (const [path, image] of this.images) {
      if (image && active.has(path)) total += decodedBytes(image)
    }
    return total
  }

  /** 加载失败或未加载时返回 null；调用方需自行走降级路径。 */
  image(path: string | null | undefined): Promise<CanvasImageSource | null> {
    if (!path) return Promise.resolve(null)
    if (this.images.has(path)) {
      const cached = this.images.get(path) ?? null
      // 命中即"用过"：挪到队尾，免得刚渲染过的图被当成最久未用淘汰掉
      this.images.delete(path)
      this.images.set(path, cached)
      return Promise.resolve(cached)
    }
    const inFlight = this.pending.get(path)
    if (inFlight) return inFlight.promise

    let resolvePromise!: (result: CanvasImageSource | null) => void
    const request = {} as PendingImageRequest
    request.generation = this.generation
    request.image = null
    request.settled = false
    request.promise = new Promise((resolve) => {
      resolvePromise = resolve
    })
    request.settle = (result, failed = false) => {
      if (request.settled) return
      request.settled = true
      if (request.generation !== this.generation || this.pending.get(path) !== request) {
        resolvePromise(null)
        return
      }
      this.pending.delete(path)
      if (failed) this.recordMissing(path)
      this.put(path, result)
      resolvePromise(result)
    }
    request.abort = () => {
      request.settle(null)
      const image = request.image
      if (image) {
        image.onload = null
        image.onerror = null
        try {
          image.src = ''
        } catch {
          // Clearing src is best-effort; settling above is the correctness boundary.
        }
      }
      request.image = null
    }
    this.pending.set(path, request)
    this.beginImageRequest(path, request)
    return request.promise
  }

  private beginImageRequest(path: string, request: PendingImageRequest): void {
    if (!this.createImage) {
      request.settle(null, true)
      return
    }
    let image: HTMLImageElement
    try {
      image = this.createImage()
    } catch {
      request.settle(null, true)
      return
    }
    request.image = image
    image.decoding = 'async'
    image.onload = () => {
      if (request.generation === this.generation && this.pending.get(path) === request) {
        request.settle(image)
      }
    }
    image.onerror = () => {
      if (request.generation === this.generation && this.pending.get(path) === request) {
        request.settle(null, true)
      }
    }
    try {
      image.src = assetUrl(path)
    } catch {
      request.settle(null, true)
    }
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
    if (this.jsonCache.has(path)) return this.jsonCache.get(path) as T | null
    const inFlight = this.jsonPending.get(path)
    if (inFlight) return inFlight.promise as Promise<T | null>

    const controller = new AbortController()
    let resolvePromise!: (result: unknown | null) => void
    const request = {} as PendingJsonRequest
    request.generation = this.generation
    request.controller = controller
    request.settled = false
    request.promise = new Promise((resolve) => {
      resolvePromise = resolve
    })
    request.settle = (result, failed = false) => {
      if (request.settled) return
      request.settled = true
      if (request.generation !== this.generation || this.jsonPending.get(path) !== request) {
        resolvePromise(null)
        return
      }
      this.jsonPending.delete(path)
      if (failed) this.recordMissing(path)
      this.jsonCache.set(path, result)
      if (result !== null && this.collectImageDependencies) {
        let dependencies: string[] = []
        try {
          dependencies = [...new Set(this.collectImageDependencies(path, result).filter(Boolean))]
        } catch {
          // A dependency collector is optional metadata; JSON loading itself remains valid.
        }
        this.jsonDependencies.set(path, dependencies)
        if (this.retained.has(path)) this.evict()
      }
      resolvePromise(result)
    }
    this.jsonPending.set(path, request)
    void this.fetchJson(path, request)
    return request.promise as Promise<T | null>
  }

  private async fetchJson(path: string, request: PendingJsonRequest): Promise<void> {
    try {
      const response = await fetch(assetUrl(path), { signal: request.controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const result = (await response.json()) as unknown
      request.settle(result)
    } catch {
      request.settle(null, !request.controller.signal.aborted)
    }
  }

  /** 已确认缺失的素材清单，供调试面板展示。 */
  get missingAssets(): string[] {
    return [...this.missing].sort()
  }

  has(path: string): boolean {
    const cached = this.images.get(path)
    return cached !== null && cached !== undefined
  }

  /** Pin paths for a scene or actor's active lifetime; each call is one reference. */
  retain(paths: readonly (string | null | undefined)[]): void {
    for (const path of new Set(paths.filter((value): value is string => Boolean(value)))) {
      this.adjustRetained(path, 1)
    }
    this.evict()
  }

  /** Release the matching retain(paths) reference. Unknown paths are ignored. */
  release(paths: readonly (string | null | undefined)[]): void {
    for (const path of new Set(paths.filter((value): value is string => Boolean(value)))) {
      this.adjustRetained(path, -1)
    }
    this.evict()
  }

  private activePaths(): Set<string> {
    const active = new Set(this.retained.keys())
    for (const path of this.retained.keys()) {
      for (const dependency of this.jsonDependencies.get(path) ?? []) active.add(dependency)
    }
    return active
  }

  private adjustRetained(path: string, amount: number): void {
    const count = (this.retained.get(path) ?? 0) + amount
    if (count > 0) this.retained.set(path, count)
    else this.retained.delete(path)
  }

  /**
   * 预取一批素材，用于场景切换时提前加载下一幕。
   *
   * 失败照旧静默降级 —— 预取本来就是"有空就做"的事，不该拖累主流程。
   */
  async preload(paths: readonly (string | null | undefined)[]): Promise<void> {
    const generation = this.generation
    const run = this.preloadQueue.then(() => this.preloadNow(paths, generation))
    this.preloadQueue = run.catch(() => undefined)
    return run
  }

  private async preloadNow(
    paths: readonly (string | null | undefined)[],
    generation: number,
  ): Promise<void> {
    const unique = [...new Set(paths.filter((path): path is string => Boolean(path)))].filter(
      (path) => !this.images.has(path),
    )

    // Join existing work first; cached/in-flight assets are never decoded a second time.
    const alreadyPending = unique.filter((path) => this.pending.has(path))
    await Promise.all(alreadyPending.map((path) => this.image(path)))
    if (generation !== this.generation) return

    const candidates = unique.filter((path) => !this.images.has(path) && !this.pending.has(path))
    const occupiedEstimate = this.pending.size * this.estimatedPreloadBytes
    const available = Math.max(0, this.maxBytes - this.bytes - occupiedEstimate)
    const slots = available === 0
      ? 0
      : this.estimatedPreloadBytes === 0
        ? candidates.length
        : Math.floor(available / this.estimatedPreloadBytes)
    const selected = candidates.slice(0, slots)
    let next = 0
    const worker = async (): Promise<void> => {
      while (generation === this.generation && next < selected.length) {
        const path = selected[next++]
        await this.image(path)
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.maxPreloadConcurrency, selected.length) }, worker))
  }

  /** 清空所有缓存并使全部未完成的回调失效。 */
  clear(): void {
    this.generation += 1
    for (const request of this.pending.values()) request.abort()
    for (const request of this.jsonPending.values()) {
      request.controller.abort()
      request.settle(null)
    }
    this.pending.clear()
    this.jsonPending.clear()
    this.images.clear()
    this.jsonCache.clear()
    this.jsonDependencies.clear()
    this.bytes = 0
  }

  private recordMissing(path: string): void {
    this.missing.add(path)
    if (this.warned.has(path)) return
    this.warned.add(path)
    console.warn(`[assets] 缺失或格式错误，已走降级：assets/${path}`)
  }

  /** 写入缓存，并在超预算时淘汰最久未用的那张。 */
  private put(path: string, image: CanvasImageSource | null): void {
    const previous = this.images.get(path)
    if (previous) this.bytes -= decodedBytes(previous)
    this.images.delete(path)
    this.images.set(path, image)
    if (image) this.bytes += decodedBytes(image)
    this.evict()
  }

  /**
   * 按 LRU 淘汰，直到回到预算之内。
   *
   * 只淘汰**队首**（最久未用）：刚渲染过的那几张在队尾，不会被误伤 ——
   * 否则画面会闪一下占位再重新加载。
   */
  private evict(): void {
    while (this.bytes > this.maxBytes && this.images.size > 1) {
      const keys = [...this.images.keys()]
      const newest = keys[keys.length - 1]
      const active = this.activePaths()
      const inactive = keys.filter((candidate) => !active.has(candidate))
      const key = inactive.find((candidate) => candidate !== newest) ?? inactive[0]
      if (key === undefined) break
      const image = this.images.get(key)
      // 加载失败的 null 占位不占内存，但也要清掉，否则它会永远堵在队首
      if (image) this.bytes -= decodedBytes(image)
      this.images.delete(key)
      this.evictions += 1
    }
  }
}
