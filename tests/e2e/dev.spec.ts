import { expect, test, type Page } from '@playwright/test'

/**
 * 开发模式（dev server）专属的检查。
 *
 * 这些问题是开发期才存在的 —— 生产构建里 StrictMode 不会双挂载 effect，
 * 所以主 E2E 套件（跑生产产物）根本照不到。
 */

async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(
    () => Boolean((window as unknown as { __HB__?: { sceneRuntime?: unknown } }).__HB__?.sceneRuntime),
    null,
    { timeout: 30_000 },
  )
  // 等双挂载那一轮彻底结束
  await page.waitForTimeout(600)
}

test('StrictMode 双挂载不会泄漏引擎实例', async ({ page }) => {
  await boot(page)

  const live = await page.evaluate(
    () => (window as unknown as { __HB__: { liveInstanceCount: number } }).__HB__.liveInstanceCount,
  )

  // mount → cleanup → mount 之后必须只剩一个活着的引擎。
  // 修复前这里是 2：第一个实例的 cleanupRef 还没赋值就被 cleanup 查过了，
  // 于是它的 rAF 循环、ResizeObserver、音频缓存全部泄漏，两个实例同时绘制同一块画布。
  expect(live).toBe(1)
})

test('调试句柄指向的是存活实例', async ({ page }) => {
  await boot(page)
  const state = await page.evaluate(() => {
    const game = (window as unknown as { __HB__: { sceneRuntime: unknown; liveInstanceCount: number } }).__HB__
    return { hasRuntime: Boolean(game.sceneRuntime), live: game.liveInstanceCount }
  })
  expect(state.hasRuntime).toBe(true)
  expect(state.live).toBe(1)
})

