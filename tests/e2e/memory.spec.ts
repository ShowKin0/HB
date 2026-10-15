import { expect, test, type Page } from '@playwright/test'

/**
 * 内存不随操作次数持续增长。
 *
 * 前几轮修了两处"只进不出"的缓存（素材、音量设置），但那是靠读代码找到的。
 * 这类问题更适合**用测量去证伪**：反复切场景 + 反复交互之后，强制回收再量堆，
 * 如果还在一路涨，就说明有东西没被释放。
 *
 * 只在 Chromium 上跑（`performance.memory` 是它的私有接口）。
 * 桌面项目已经带了 `--js-flags=--expose-gc`，所以能先把垃圾收干净再量 ——
 * 否则测到的只是"垃圾还没来得及回收"的噪声。
 */

async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(
    () => Boolean((window as unknown as { __HB__?: { sceneRuntime?: unknown } }).__HB__?.sceneRuntime),
    null,
    { timeout: 30_000 },
  )
}

/** 强制 GC 后读取已用堆大小（字节）。不支持时返回 null。 */
async function heapBytes(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const gc = (window as unknown as { gc?: () => void }).gc
    gc?.()
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    return memory ? memory.usedJSHeapSize : null
  })
}

const supportsHeap = async (page: Page): Promise<boolean> =>
  page.evaluate(() => Boolean((performance as unknown as { memory?: unknown }).memory))

test.describe('内存不持续增长', () => {
  test('反复切场景 + 反复交互之后，堆占用回到同一量级', async ({ page }) => {
    test.skip(
      !(await (async () => {
        await boot(page)
        return supportsHeap(page)
      })()),
      '这个浏览器不暴露 performance.memory',
    )

    // 轮数要够多，漏一点点也能被放大出来
    const cycles = 40
    const bake = async (): Promise<void> => {
      for (let i = 0; i < cycles; i++) {
        await page.evaluate(async (index) => {
          const game = (window as unknown as {
            __HB__: { debugGotoScene(id: string): Promise<void> }
          }).__HB__
          await game.debugGotoScene(index % 2 === 0 ? 'hall' : 'start')
        }, i)
        // 顺手点点东西，让交互链路也走一遍
        const point = await page.evaluate(() => {
          const game = (window as unknown as {
            __HB__: { viewport: { x: number; y: number; w: number; h: number } }
          }).__HB__
          return {
            x: game.viewport.x + 0.5 * game.viewport.w,
            y: game.viewport.y + 0.5 * game.viewport.h,
          }
        })
        await page.mouse.click(point.x, point.y)
      }
    }

    // 先跑一小段把一次性分配（模块、缓存、首次渲染的位图）都摊掉
    await bake()
    const settled = await heapBytes(page)
    expect(settled).not.toBeNull()

    // 再跑同样的量，这次不该再涨
    await bake()
    const after = await heapBytes(page)

    const growth = (after as number) - (settled as number)
    const growthMb = growth / 1024 / 1024
    /*
     * 阈值定在 1.5 MB：实测这个负载下堆是**完全不涨**的（0.0 MB），
     * 所以这点余量够吸收测量噪声，同时每轮哪怕只漏 40 KB 也会被抓到。
     * 定 4 MB 的话什么都测不出来 —— 一条永远不会失败的测试等于没有测试。
     */
    const budgetMb = 1.5

    expect(
      growthMb,
      `又跑了 ${cycles} 轮之后堆涨了 ${growthMb.toFixed(1)} MB（${(settled as number) / 1048576} → ${(
        (after as number) / 1048576
      ).toFixed(1)} MB）`,
    ).toBeLessThan(budgetMb)
  })

  test('图片缓存占用始终在预算之内', async ({ page }) => {
    await boot(page)

    const stats = await page.evaluate(() => {
      const game = (window as unknown as {
        __HB__: { debugInfo: { imageCache: { bytes: number; budgetBytes: number; entries: number } } }
      }).__HB__
      return game.debugInfo.imageCache
    })

    expect(stats.budgetBytes).toBeGreaterThan(0)
    expect(stats.bytes).toBeLessThanOrEqual(stats.budgetBytes)
    expect(stats.entries).toBeGreaterThanOrEqual(0)
  })

  test('交互事件历史有上限，不会被无限记录', async ({ page }) => {
    await boot(page)

    // 反复触发同一个交互
    for (let i = 0; i < 60; i++) {
      await page.evaluate(() => {
        const game = (window as unknown as {
          __HB__: { debugRunKnot(knot: string): void }
        }).__HB__
        game.debugRunKnot('look_window')
      })
    }
    await page.waitForTimeout(500)

    const history = await page.evaluate(
      () => (window as unknown as { __HB__: { eventHistory: unknown[] } }).__HB__.eventHistory.length,
    )
    expect(history, '事件历史必须封顶，否则长时间游玩会一路涨').toBeLessThanOrEqual(64)
  })
})
