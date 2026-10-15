import { expect, test, type Page } from '@playwright/test'

/**
 * 多种屏幕尺寸下的布局不变式。
 *
 * 横屏是这个项目的主要形态，而"横屏"本身跨度很大 —— 从 iPhone SE 的
 * 667×375 到 iPad 的 1194×820，还有各种比例的安卓机。逐个手测不现实，
 * 所以把必须成立的事情写成不变式，让它们在所有尺寸上自动跑一遍。
 *
 * 这类测试的价值在于**抓量变引起的质变**：某个尺寸下面板宽度刚好超过
 * 可用宽度、场景被压成负值、HUD 挤出屏幕 —— 这些在单一机型上都测不出来。
 */

interface Size {
  name: string
  width: number
  height: number
}

const SIZES: Size[] = [
  { name: 'iPhone 14 Playwright 保守视口', width: 750, height: 340 },
  { name: 'iPhone SE 横屏', width: 667, height: 375 },
  { name: 'iPhone 13 mini 横屏', width: 812, height: 375 },
  { name: 'iPhone 14 横屏（工具栏展开）', width: 844, height: 346 },
  { name: 'iPhone 14 横屏（全屏）', width: 844, height: 390 },
  { name: 'iPhone 14 Plus 横屏', width: 926, height: 390 },
  { name: 'iPhone 14 Pro Max 横屏', width: 932, height: 430 },
  { name: 'iPad mini 横屏', width: 1024, height: 744 },
  { name: 'iPad Pro 11 横屏', width: 1194, height: 820 },
  { name: '超宽手机（折叠屏展开）', width: 1200, height: 400 },
  { name: '极矮窗口', width: 800, height: 300 },
  { name: '临界：面板刚好占满', width: 640, height: 360 },
]

async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(
    () => Boolean((window as unknown as { __HB__?: { sceneRuntime?: unknown } }).__HB__?.sceneRuntime),
    null,
    { timeout: 30_000 },
  )
  await dismissDialogue(page)
}

/**
 * 推掉正在显示的旁白。
 *
 * 入场旁白会**吃掉第一下点击**（那时输入归属是"对话"，点击只推进）。
 * 不推掉就直接点热点，表现是"点了没反应"——已经在两个 spec 里各踩一次了。
 */
async function dismissDialogue(page: Page, maxClicks = 8): Promise<void> {
  const size = page.viewportSize()!
  for (let i = 0; i < maxClicks; i++) {
    if ((await page.locator('[role="log"]').count()) === 0) return
    await page.mouse.click(size.width / 2, size.height / 2)
    await page.waitForTimeout(200)
  }
}

interface Geometry {
  sceneX: number
  sceneY: number
  sceneW: number
  sceneH: number
  panelLeft: number
  panelTop: number
  panelW: number
  panelH: number
  hudLeft: number
  hudRight: number
  hudTop: number
  hudBottom: number
  innerW: number
  innerH: number
  scrollW: number
  scrollH: number
}

async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const game = (window as unknown as {
      __HB__: {
        viewport: { x: number; y: number; w: number; h: number }
        groundRange: readonly [number, number]
      }
    }).__HB__
    const ground1 = game.groundRange[1]
    const panel = document.querySelector('[data-dialogue-band]')!.getBoundingClientRect()
    const hud = document.querySelector('[data-hud]')!.getBoundingClientRect()
    return {
      sceneX: game.viewport.x,
      sceneY: game.viewport.y,
      sceneW: game.viewport.w,
      sceneH: game.viewport.h,
      panelLeft: panel.left,
      panelTop: panel.top,
      panelW: panel.width,
      panelH: panel.height,
      hudLeft: hud.left,
      hudRight: hud.right,
      groundV1: ground1,
      hudTop: hud.top,
      hudBottom: hud.bottom,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      scrollW: document.documentElement.scrollWidth,
      scrollH: document.documentElement.scrollHeight,
    }
  })
}

test.describe('横屏布局不变式', () => {
  for (const size of SIZES) {
    test(`${size.name}（${size.width}×${size.height}）`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height })
      await boot(page)
      const g = await geometry(page)

      // ── 场景几何必须有效且落在画布内 ──
      expect(g.sceneW, '场景宽度必须是正数').toBeGreaterThan(0)
      expect(g.sceneH, '场景高度必须是正数').toBeGreaterThan(0)
      /*
       * ── 场景必须**盖住**画布，而不是落在画布里面 ──
       *
       * 这两条以前是反的（"边界不能为负 / 不能超出画布"），因为那时用
       * `contain`：整张画面都在，四周留黑边。
       *
       * 内容声明 `sceneFit: "cover"` 之后，画面刻意铺满整窗、多出来的裁掉 ——
       * 留边才是要避免的东西。所以判据反过来写：场景矩形必须**完全包含**
       * 画布。这同时也成了"四周没有黑框"的守卫。
       */
      expect(g.sceneX, '场景没盖住左边，留了黑边').toBeLessThanOrEqual(0.5)
      expect(g.sceneY, '场景没盖住上边，留了黑边').toBeLessThanOrEqual(0.5)
      expect(g.sceneX + g.sceneW, '场景没盖住右边，留了黑边').toBeGreaterThanOrEqual(g.innerW - 0.5)
      expect(g.sceneY + g.sceneH, '场景没盖住下边，留了黑边').toBeGreaterThanOrEqual(g.innerH - 0.5)

      /*
       * ── 角色能走到的最低处不能被对话区盖住 ──
       *
       * 以前这里写的是"场景矩形与对话区不能相交"。那个判据在 overlay 形态下
       * 恒不成立 —— 对话框本来就**故意**浮在画面上，这正是它和 bottom 的区别。
       *
       * 真正要保证的从来不是"两个矩形不相交"，而是**角色不会被盖住**。
       * 引擎为此把走动深度收窄到对话框上沿（见 SceneRuntime.setVisibleRange），
       * 所以这里直接验证那个量。
       */
      const groundFrontY = g.sceneY + g.groundV1 * g.sceneH
      expect(
        groundFrontY,
        `角色能走到的最低处（y=${groundFrontY.toFixed(0)}）伸到对话区（上沿 y=${g.panelTop.toFixed(0)}）底下去了`,
      ).toBeLessThanOrEqual(g.panelTop + 1.5)

      // ── 面板必须真的贴住一条边并铺满，不能塌成一小条 ──
      const sideLayout = g.panelLeft > g.innerW * 0.5
      if (sideLayout) {
        expect(g.panelH, '侧栏面板没有铺满高度').toBeGreaterThan(g.innerH * 0.9)
      } else {
        expect(g.panelW, '底部对话框没有铺满宽度').toBeGreaterThan(g.innerW * 0.9)
      }
      expect(g.panelW, '面板宽度不合理').toBeGreaterThan(120)
      expect(g.panelH, '面板高度不合理').toBeGreaterThan(40)

      // ── 屏幕不能被浪费：场景至少要占 40% ──
      const usage = (g.sceneW * g.sceneH) / (g.innerW * g.innerH)
      expect(usage, `场景只占了 ${(usage * 100).toFixed(0)}% 的屏幕`).toBeGreaterThan(0.4)

      // ── HUD 必须完整落在视口内 ──
      expect(g.hudLeft, 'HUD 左边界溢出').toBeGreaterThanOrEqual(-1)
      expect(g.hudRight, 'HUD 右边界溢出').toBeLessThanOrEqual(g.innerW + 1)
      expect(g.hudTop, 'HUD 上边界溢出').toBeGreaterThanOrEqual(-1)
      expect(g.hudBottom, 'HUD 下边界溢出').toBeLessThanOrEqual(g.innerH + 1)

      // ── 不许出现滚动条：这是个固定视口的游戏 ──
      expect(g.scrollW, '出现了横向滚动').toBeLessThanOrEqual(g.innerW + 1)
      expect(g.scrollH, '出现了纵向滚动').toBeLessThanOrEqual(g.innerH + 1)
    })
  }
})

test.describe('横屏内容不被裁', () => {
  for (const size of [SIZES[0], SIZES[2], SIZES[4], SIZES[9]]) {
    test(`${size.name}：台词与选项都在可视区内`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height })
      await boot(page)

      // 切到走廊并**推掉它自己的入场旁白** —— 那一下同样会吃掉点击
      await page.evaluate(async () => {
        const game = (window as unknown as {
          __HB__: { debugGotoScene(id: string): Promise<void> }
        }).__HB__
        await game.debugGotoScene('hall')
      })
      await page.waitForTimeout(300)
      await dismissDialogue(page)

      const mark = await page.evaluate(() => {
        const game = (window as unknown as {
          __HB__: { viewport: { x: number; y: number; w: number; h: number } }
        }).__HB__
        return {
          x: game.viewport.x + 0.5 * game.viewport.w,
          y: game.viewport.y + 0.42 * game.viewport.h,
        }
      })
      await page.mouse.click(mark.x, mark.y)
      await expect(page.locator('[role="log"]')).toContainText('量过身高', { timeout: 25_000 })

      const box = (await page.locator('[role="log"]').boundingBox())!
      expect(box.x, '台词左边界溢出').toBeGreaterThanOrEqual(-1)
      expect(box.y, '台词上边界溢出').toBeGreaterThanOrEqual(-1)
      expect(box.x + box.width, '台词右边界溢出').toBeLessThanOrEqual(size.width + 1)
      expect(box.y + box.height, '台词下边界溢出').toBeLessThanOrEqual(size.height + 1)

      // 文本没有被裁
      const clipped = await page
        .locator('[role="log"]')
        .evaluate((el) => el.scrollHeight > el.clientHeight + 1)
      expect(clipped, '台词被裁掉了').toBe(false)
    })
  }
})

test.describe('竖屏不需要横屏引导以外的适配', () => {
  const PORTRAITS: Size[] = [
    { name: 'iPhone SE 竖屏', width: 375, height: 667 },
    { name: 'iPhone 14 竖屏', width: 390, height: 664 },
    { name: '窄屏', width: 320, height: 568 },
  ]

  for (const size of PORTRAITS) {
    test(`${size.name}：引导遮罩铺满且不溢出`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height })
      await boot(page)

      const gate = page.locator('[data-orientation-gate]')
      await expect(gate).toBeVisible()

      const box = (await gate.boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(size.width - 1)
      expect(box.height).toBeGreaterThanOrEqual(size.height - 1)

      const scroll = await page.evaluate(() => ({
        w: document.documentElement.scrollWidth,
        h: document.documentElement.scrollHeight,
      }))
      expect(scroll.w).toBeLessThanOrEqual(size.width + 1)
      expect(scroll.h).toBeLessThanOrEqual(size.height + 1)
    })
  }
})
