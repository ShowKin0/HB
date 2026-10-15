import { expect, test, type Page } from '@playwright/test'

/**
 * 出错时**不能白屏，也不能一声不吭**。
 *
 * 在这之前项目里一个错误边界都没有：React 19 遇到渲染期抛错会卸载整棵树，
 * 玩家看到的是全白页面，整局丢失，屏幕上没有任何解释。
 *
 * 异步错误走的是另一条路（`unhandledrejection`），边界接不住 ——
 * 那些只写进控制台，而手机上没人看控制台，表现就是"点了没反应"。
 */

async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(
    () => Boolean((window as unknown as { __HB__?: { sceneRuntime?: unknown } }).__HB__?.sceneRuntime),
    null,
    { timeout: 30_000 },
  )
}

test.describe('错误不会白屏', () => {
  test('正常情况下不会误报崩溃', async ({ page }) => {
    await boot(page)
    await expect(page.locator('[data-crash]')).toHaveCount(0)
  })

  test('未处理的异步错误会变成屏幕上的提示', async ({ page }) => {
    await boot(page)

    // 制造一次真实的未处理 rejection（引擎里 `void drainStory()` 就是这个形态）
    await page.evaluate(() => {
      void Promise.reject(new Error('模拟的异步故障'))
    })

    const toast = page.locator('[data-toast]').first()
    await expect(toast, '异步错误必须显示出来，不能只进控制台').toBeVisible({ timeout: 5000 })
    await expect(toast).toContainText('模拟的异步故障')
  })

  test('同一条错误刷屏时只提示一次', async ({ page }) => {
    await boot(page)

    await page.evaluate(() => {
      for (let i = 0; i < 20; i++) void Promise.reject(new Error('重复故障'))
    })
    await page.waitForTimeout(600)

    const count = await page.locator('[data-toast]').filter({ hasText: '重复故障' }).count()
    expect(count, '同一条错误不该刷 20 条提示').toBe(1)
  })

  test('运行时的同步错误也会被接住', async ({ page }) => {
    await boot(page)

    await page.evaluate(() => {
      // 模拟一个事件回调里的同步抛错
      setTimeout(() => {
        throw new Error('模拟的同步故障')
      }, 0)
    })

    const toast = page.locator('[data-toast]').filter({ hasText: '模拟的同步故障' })
    await expect(toast).toBeVisible({ timeout: 5000 })
  })

  test('上报本身出错也不会把游戏搞挂', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await boot(page)

    // 抛一个连 message 都没有的东西
    await page.evaluate(() => {
      void Promise.reject(undefined)
    })
    await page.waitForTimeout(400)

    // 游戏仍然可用
    const alive = await page.evaluate(
      () => Boolean((window as unknown as { __HB__?: { sceneRuntime?: unknown } }).__HB__?.sceneRuntime),
    )
    expect(alive).toBe(true)

    /*
     * 抛出的东西本身会被浏览器记一条 pageerror（就是那条 "undefined"），
     * 那不是上报器的问题。真正要保证的是**上报器自己没有二次抛错** ——
     * 它之前正好在这里炸过：describe(undefined) 返回了 undefined，
     * 调用方紧接着 .slice() 抛 TypeError。
     */
    const reporterCrashed = errors.filter(
      (message) =>
        message.includes('slice') || message.includes('reportError') || message.includes('describe'),
    )
    expect(reporterCrashed, `上报器自己抛错了：${reporterCrashed.join(' / ')}`).toHaveLength(0)
  })
})
