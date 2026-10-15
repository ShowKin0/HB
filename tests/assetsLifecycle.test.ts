import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssetStore } from '../src/engine/assets.ts'

interface ControlledImage {
  src: string
  decoding: string
  naturalWidth: number
  naturalHeight: number
  width: number
  height: number
  onload: (() => void) | null
  onerror: (() => void) | null
}

function controlledImageFactory(images: ControlledImage[]): () => HTMLImageElement {
  return () => {
    const image: ControlledImage = {
      src: '',
      decoding: '',
      naturalWidth: 20,
      naturalHeight: 10,
      width: 20,
      height: 10,
      onload: null,
      onerror: null,
    }
    images.push(image)
    return image as unknown as HTMLImageElement
  }
}

function automaticImageFactory(
  width: number,
  height: number,
  onCreate?: (image: ControlledImage) => void,
): () => HTMLImageElement {
  return () => {
    const image: ControlledImage = {
      src: '',
      decoding: '',
      naturalWidth: width,
      naturalHeight: height,
      width,
      height,
      onload: null,
      onerror: null,
    }
    onCreate?.(image)
    Object.defineProperty(image, 'src', {
      set() {
        queueMicrotask(() => image.onload?.())
      },
      get() {
        return ''
      },
    })
    return image as unknown as HTMLImageElement
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('AssetStore lifecycle', () => {
  it('clear aborts an in-flight image and stale completion cannot erase a replacement request', async () => {
    const images: ControlledImage[] = []
    const store = new AssetStore({ createImage: controlledImageFactory(images) })
    const staleResult = store.image('scene/bg.png')
    const staleLoad = images[0].onload

    store.clear()
    expect(await staleResult).toBeNull()

    const currentResult = store.image('scene/bg.png')
    expect(images).toHaveLength(2)
    images[0].onload = staleLoad
    images[0].onload?.()
    expect(store.cacheStats.pending).toBe(1)

    images[1].onload?.()
    expect(await currentResult).not.toBeNull()
    expect(store.imageSync('scene/bg.png')).not.toBeNull()
    expect(store.cacheStats.pending).toBe(0)
  })

  it('deduplicates JSON requests and clear aborts without allowing stale refills', async () => {
    const requests: Array<{ signal: AbortSignal; resolve: (response: Response) => void }> = []
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => {
      requests.push({ signal: init?.signal as AbortSignal, resolve })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const store = new AssetStore()

    const staleFirst = store.json<{ version: string }>('atlas.json')
    const staleSecond = store.json<{ version: string }>('atlas.json')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(store.cacheStats.pending).toBe(1)

    store.clear()
    expect(requests[0].signal.aborted).toBe(true)
    await expect(staleFirst).resolves.toBeNull()
    await expect(staleSecond).resolves.toBeNull()

    const current = store.json<{ version: string }>('atlas.json')
    requests[0].resolve({ ok: true, json: async () => ({ version: 'stale' }) } as Response)
    requests[1].resolve({ ok: true, json: async () => ({ version: 'current' }) } as Response)
    await expect(current).resolves.toEqual({ version: 'current' })
    await expect(store.json('atlas.json')).resolves.toEqual({ version: 'current' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(store.cacheStats.pending).toBe(0)
  })

  it('pins active paths, reports over-budget active bytes, and evicts after release', async () => {
    const store = new AssetStore({ createImage: automaticImageFactory(100, 100), maxBytes: 40_000 })
    await store.image('active.png')
    store.retain(['active.png', 'next.png'])
    await store.image('next.png')

    expect(store.imageSync('active.png')).not.toBeNull()
    expect(store.imageSync('next.png')).not.toBeNull()
    expect(store.cacheStats.bytes).toBe(80_000)
    expect(store.cacheStats.activeBytes).toBe(80_000)
    expect(store.cacheStats.overBudget).toBe(true)

    store.release(['active.png'])
    expect(store.imageSync('active.png')).toBeNull()
    expect(store.imageSync('next.png')).not.toBeNull()
    expect(store.cacheStats.bytes).toBe(40_000)
    expect(store.cacheStats.activeBytes).toBe(40_000)
    expect(store.cacheStats.overBudget).toBe(false)
  })

  it('retaining a JSON atlas pins dependencies collected after JSON succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ images: ['sheet.png', 'sheet-2.png'] }),
    } as Response)))
    const store = new AssetStore({
      createImage: automaticImageFactory(100, 100),
      maxBytes: 40_000,
      collectImageDependencies: (_path, json) => (json as { images: string[] }).images,
    })
    store.retain(['atlas.json'])
    await store.json('atlas.json')
    await store.image('sheet.png')
    await store.image('sheet-2.png')

    expect(store.imageSync('sheet.png')).not.toBeNull()
    expect(store.imageSync('sheet-2.png')).not.toBeNull()
    expect(store.cacheStats.activeBytes).toBe(80_000)
    expect(store.cacheStats.overBudget).toBe(true)
    store.release(['atlas.json'])
    expect(store.imageSync('sheet.png')).toBeNull()
  })

  it('preload does not re-decode cached images and respects concurrency and free budget', async () => {
    const images: ControlledImage[] = []
    const store = new AssetStore({
      createImage: controlledImageFactory(images),
      maxBytes: 3_200,
      estimatedPreloadBytes: 800,
      maxPreloadConcurrency: 2,
    })
    const cached = store.image('cached.png')
    images[0].onload?.()
    await cached

    const preload = store.preload(['cached.png', 'a.png', 'b.png', 'c.png', 'd.png'])
    const queuedPreload = store.preload(['e.png'])
    await Promise.resolve()
    await Promise.resolve()
    expect(images.map((image) => image.src)).toHaveLength(3)
    images[1].onload?.()
    await Promise.resolve()
    expect(images.map((image) => image.src)).toHaveLength(4)
    images[2].onload?.()
    await Promise.resolve()
    expect(images.map((image) => image.src)).toHaveLength(4)
    images[3].onload?.()
    await Promise.all([preload, queuedPreload])
    expect(store.cacheStats.entries).toBe(4)

    const fullStoreImages: ControlledImage[] = []
    const fullStore = new AssetStore({
      createImage: controlledImageFactory(fullStoreImages),
      maxBytes: 800,
      estimatedPreloadBytes: 800,
    })
    const onlyCached = fullStore.image('only.png')
    fullStoreImages[0].onload?.()
    await onlyCached
    await fullStore.preload(['skipped.png'])
    expect(fullStoreImages).toHaveLength(1)
  })
})
