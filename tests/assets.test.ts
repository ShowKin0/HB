import { describe, expect, it } from 'vitest'
import { AssetStore, DEFAULT_IMAGE_BUDGET_BYTES } from '../src/engine/assets.ts'

/**
 * 素材缓存：既要"缺失不能崩"，也要**内存有上限**。
 *
 * 一张 1920×1080 的 RGBA 背景解码后约 8 MB。手机上随手切十几个场景，
 * 只进不出的缓存就是上百 MB —— 低内存设备会被系统直接杀掉。
 *
 * 这里用注入的假 Image 在 Node 里把缓存与淘汰策略完整跑一遍。
 */

interface FakeImage {
  src: string
  decoding: string
  naturalWidth: number
  naturalHeight: number
  width: number
  height: number
  onload: (() => void) | null
  onerror: (() => void) | null
}

/** 造一个"立刻加载成功"的假图片工厂，尺寸由路径里的 `WxH` 决定。 */
function succeedWithSize(width: number, height: number): () => HTMLImageElement {
  return () => {
    const img: Partial<FakeImage> = {
      naturalWidth: width,
      naturalHeight: height,
      width,
      height,
      onload: null,
      onerror: null,
    }
    // 赋 src 时同步触发 onload，模拟"已经在缓存里、立刻可用"
    Object.defineProperty(img, 'src', {
      set() {
        queueMicrotask(() => img.onload?.())
      },
      get() {
        return ''
      },
    })
    return img as unknown as HTMLImageElement
  }
}

function failAlways(): () => HTMLImageElement {
  return () => {
    const img: Partial<FakeImage> = { onload: null, onerror: null }
    Object.defineProperty(img, 'src', {
      set() {
        queueMicrotask(() => img.onerror?.())
      },
      get() {
        return ''
      },
    })
    return img as unknown as HTMLImageElement
  }
}

describe('缺失素材静默降级', () => {
  it('加载失败返回 null，并记进缺失清单', async () => {
    const store = new AssetStore({ createImage: failAlways() })
    expect(await store.image('bg/nope.png')).toBeNull()
    expect(store.missingAssets).toEqual(['bg/nope.png'])
    expect(store.has('bg/nope.png')).toBe(false)
  })

  it('失败结果被缓存，不会每次都重试', async () => {
    let created = 0
    const factory = failAlways()
    const store = new AssetStore({
      createImage: () => {
        created += 1
        return factory()
      },
    })
    await store.image('bg/nope.png')
    await store.image('bg/nope.png')
    await store.image('bg/nope.png')
    expect(created, '失败的图只该尝试加载一次').toBe(1)
  })

  it('并发请求同一张图只会加载一次', async () => {
    let created = 0
    const factory = succeedWithSize(100, 100)
    const store = new AssetStore({
      createImage: () => {
        created += 1
        return factory()
      },
    })
    const results = await Promise.all([
      store.image('bg/a.png'),
      store.image('bg/a.png'),
      store.image('bg/a.png'),
    ])
    expect(created).toBe(1)
    expect(results.every((r) => r !== null)).toBe(true)
  })

  it('空路径直接返回 null，不做任何加载', async () => {
    const store = new AssetStore({ createImage: succeedWithSize(10, 10) })
    expect(await store.image(null)).toBeNull()
    expect(await store.image(undefined)).toBeNull()
    expect(await store.image('')).toBeNull()
  })

  it('没有 DOM 时记缺失而不是反复重试', async () => {
    const store = new AssetStore({ createImage: undefined })
    expect(await store.image('bg/a.png')).toBeNull()
    expect(store.missingAssets).toContain('bg/a.png')
  })
})

describe('图片缓存有上限', () => {
  it('默认预算是个有限值', () => {
    const store = new AssetStore({ createImage: succeedWithSize(10, 10) })
    expect(store.cacheStats.budgetBytes).toBe(DEFAULT_IMAGE_BUDGET_BYTES)
    expect(Number.isFinite(store.cacheStats.budgetBytes)).toBe(true)
  })

  it('按解码尺寸计费，而不是按文件大小', async () => {
    // 100×100×4 = 40,000 字节
    const store = new AssetStore({ createImage: succeedWithSize(100, 100) })
    await store.image('bg/a.png')
    expect(store.cacheStats.bytes).toBe(40_000)
  })

  it('超出预算时淘汰最久未用的那张', async () => {
    // 每张 100×100×4 = 40 KB，预算只够放两张
    const store = new AssetStore({ createImage: succeedWithSize(100, 100), maxBytes: 90_000 })
    await store.image('bg/a.png')
    await store.image('bg/b.png')
    await store.image('bg/c.png')

    expect(store.cacheStats.bytes).toBeLessThanOrEqual(90_000)
    expect(store.cacheStats.evictions).toBeGreaterThan(0)
    // 最早那张被淘汰，最近那张一定还在
    expect(store.imageSync('bg/a.png')).toBeNull()
    expect(store.imageSync('bg/c.png')).not.toBeNull()
  })

  it('刚用过的图不会被当成最久未用淘汰掉', async () => {
    const store = new AssetStore({ createImage: succeedWithSize(100, 100), maxBytes: 130_000 })
    await store.image('bg/a.png')
    await store.image('bg/b.png')
    await store.image('bg/c.png') // 触发一次淘汰
    // a 已经没了；这时重新用 b，再用 d —— b 不该被淘汰
    await store.image('bg/b.png')
    await store.image('bg/d.png')
    expect(store.imageSync('bg/b.png'), '刚命中的图被误淘汰了').not.toBeNull()
  })

  it('预算为 0 时也只保留最后一张，不会把缓存清空到无法渲染', async () => {
    const store = new AssetStore({ createImage: succeedWithSize(100, 100), maxBytes: 0 })
    await store.image('bg/a.png')
    await store.image('bg/b.png')
    expect(store.cacheStats.entries).toBeGreaterThan(0)
    expect(store.imageSync('bg/b.png'), '至少得留住最近这张').not.toBeNull()
  })

  it('累计占用不会算重（同一张图重复加载）', async () => {
    const store = new AssetStore({ createImage: succeedWithSize(50, 50), maxBytes: 1_000_000 })
    await store.image('bg/a.png')
    await store.image('bg/a.png')
    await store.image('bg/a.png')
    expect(store.cacheStats.bytes).toBe(50 * 50 * 4)
  })

  it('clear() 把占用归零', async () => {
    const store = new AssetStore({ createImage: succeedWithSize(100, 100) })
    await store.image('bg/a.png')
    expect(store.cacheStats.bytes).toBeGreaterThan(0)
    store.clear()
    expect(store.cacheStats.bytes).toBe(0)
    expect(store.cacheStats.entries).toBe(0)
  })
})
