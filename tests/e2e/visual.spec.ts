import { test, type Page } from '@playwright/test'

/**
 * 视觉留档。
 *
 * 这不是断言测试，而是把画面截下来供人工确认 ——
 * 角色是否画出来了、走路姿态是否自然、letterbox 是否正确，
 * 这些用数值断言既脆弱又表达不清，看一眼最快。
 */
async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(
    () => Boolean((window as unknown as { __HB__?: { sceneRuntime?: unknown } }).__HB__?.sceneRuntime),
    null,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(400)

  // 入口旁白会一直等玩家推进；截图里留一张，然后点掉，
  // 否则后面第一次点击会被"推进对话"吃掉而不是让角色走路。
  await page.screenshot({ path: 'screenshots/00-opening.png' })
  const viewport = page.viewportSize()!
  for (let i = 0; i < 6; i++) {
    if ((await page.locator('[role="log"]').count()) === 0) break
    await page.mouse.click(viewport.width / 2, viewport.height / 2)
    await page.waitForTimeout(250)
  }
}

async function groundClick(page: Page, u: number, v: number): Promise<void> {
  const point = await page.evaluate(
    ([pu, pv]) => {
      const game = (window as unknown as {
        __HB__: {
          viewport: { x: number; y: number; w: number; h: number }
          sceneRuntime: { projectPlane: (u: number, v: number) => [number, number] }
        }
      }).__HB__
      const [sx, sy] = game.sceneRuntime.projectPlane(pu as number, pv as number)
      return { x: game.viewport.x + sx * game.viewport.w, y: game.viewport.y + sy * game.viewport.h }
    },
    [u, v],
  )
  await page.mouse.click(point.x, point.y)
}

test('截图：站立、行走中、调试叠加、对话框', async ({ page }) => {
  await boot(page)
  await page.screenshot({ path: 'screenshots/01-idle.png' })

  // 开调试叠加，截一张能看到可行走网格与路径的
  await page.evaluate(() => {
    const game = (window as unknown as { __HB__: { setDebug: (flags: Record<string, boolean>) => void } }).__HB__
    game.setDebug({ ground: true, mask: true, paths: true, anchors: true })
  })

  await groundClick(page, 0.2, 0.35)
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'screenshots/02-walking-debug.png' })

  // 关掉叠加，等走到位，截一张干净的行走姿态
  await page.evaluate(() => {
    const game = (window as unknown as { __HB__: { setDebug: (flags: Record<string, boolean>) => void } }).__HB__
    game.setDebug({ ground: false, mask: false, paths: false, anchors: false })
  })
  await page.waitForTimeout(200)
  await groundClick(page, 0.8, 0.6)
  await page.waitForTimeout(700)
  await page.screenshot({ path: 'screenshots/03-walking-clean.png' })

  // 点热点触发剧情，截对话框
  const point = await page.evaluate(() => {
    const game = (window as unknown as { __HB__: { viewport: { x: number; y: number; w: number; h: number } } }).__HB__
    return {
      x: game.viewport.x + 0.135 * game.viewport.w,
      y: game.viewport.y + 0.41 * game.viewport.h,
    }
  })
  await page.mouse.click(point.x, point.y)
  await page.waitForTimeout(2200)
  await page.screenshot({ path: 'screenshots/04-dialogue.png' })
})
