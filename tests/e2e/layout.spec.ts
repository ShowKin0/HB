import { expect, test, type Page } from '@playwright/test'

/**
 * 布局形态由**内容声明**决定。
 *
 * 以前"横屏用右侧面板"是写死在 CSS 媒体查询里的：屏幕比例一满足条件就切，
 * 跟内容说了什么无关。现在引擎只按内容声明的 placement 求值，CSS 也只认
 * `[data-dialogue]` 属性。
 *
 * 当前内容声明的是：横屏 overlay（对话框浮在画面上）、不避让场景、cover 适配。
 * 换主题/换内容改 JSON 就够了，这份用例跟着改 —— 它测的是"声明生效了"，
 * 不是"某种布局好看"。
 */

interface Snapshot {
  placement: string | null
  reserve: string | null
  /** 场景矩形是否完全盖住画布（四周没有黑边）。 */
  covers: boolean
  /** 对话框占据的矩形，相对视口。 */
  panel: { top: number; left: number; width: number; height: number }
  /** 角色实际能走到的纵向范围（归一化场景坐标）。 */
  groundV1: number
  scene: { x: number; y: number; w: number; h: number }
  innerW: number
  innerH: number
}

async function boot(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height })
  await page.goto('/')
  await page.waitForFunction(
    () => Boolean((window as unknown as { __HB__?: { sceneRuntime?: unknown } }).__HB__?.sceneRuntime),
    null,
    { timeout: 30_000 },
  )
  // 入场旁白会挡住布局断言，先推掉
  for (let i = 0; i < 8; i++) {
    if ((await page.locator('[role="log"]').count()) === 0) break
    await page.mouse.click(width / 2, height / 2)
    await page.waitForTimeout(150)
  }
}

async function probe(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const root = document.querySelector('[data-dialogue]') as HTMLElement
    const layer = document.querySelector('[data-dialogue-band]') as HTMLElement
    const rect = layer.getBoundingClientRect()
    const game = (window as unknown as {
      __HB__: {
        viewport: { x: number; y: number; w: number; h: number }
        groundRange: readonly [number, number]
      }
    }).__HB__
    const vp = game.viewport
    return {
      placement: root.getAttribute('data-dialogue'),
      reserve: root.getAttribute('data-dialogue-reserve'),
      covers:
        vp.x <= 0.5 &&
        vp.y <= 0.5 &&
        vp.x + vp.w >= window.innerWidth - 0.5 &&
        vp.y + vp.h >= window.innerHeight - 0.5,
      panel: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      groundV1: game.groundRange[1],
      scene: { x: vp.x, y: vp.y, w: vp.w, h: vp.h },
      innerW: window.innerWidth,
      innerH: window.innerHeight,
    }
  })
}

const SIZES = [
  { name: '手机横屏 844×346', width: 844, height: 346 },
  { name: '手机横屏 844×390', width: 844, height: 390 },
  { name: '桌面 1280×800', width: 1280, height: 800 },
  { name: '笔记本 1440×900', width: 1440, height: 900 },
  { name: '超宽 1600×700', width: 1600, height: 700 },
] as const

test.describe('布局由内容声明决定', () => {
  for (const size of SIZES) {
    test(`${size.name}：画面铺满，没有黑框`, async ({ page }) => {
      await boot(page, size.width, size.height)
      const g = await probe(page)

      expect(g.placement, '横屏应该按内容声明走 overlay').toBe('overlay')
      /*
       * 这一条就是用户提的"四周有黑框，请覆盖"。
       *
       * 以前 viewports 用例写的是反的（"边界不能为负、不能超出画布"），
       * 那是 contain 的判据 —— 整张画面都在、四周留黑边。改成 cover 之后，
       * 留边才是要避免的东西，所以判据反过来：场景必须**盖住**画布。
       */
      expect(g.covers, `${size.name} 四周留了黑边`).toBe(true)
      // 对话框确实存在且贴着底部
      expect(g.panel.height).toBeGreaterThan(40)
      expect(g.panel.top + g.panel.height).toBeGreaterThan(g.innerH - 2)
    })
  }

  test('对话框浮在画面上，但仍不会盖住角色', async ({ page }) => {
    await boot(page, 844, 346)
    const g = await probe(page)

    /*
     * 这两件事看起来矛盾，其实是分开处理的：
     *   · 画面让不让开 —— 内容说了算（这里声明不让，所以铺满整屏）
     *   · 走动深度让不让开 —— **永远让**，否则角色会走进文本框里
     */
    expect(g.reserve).toBe('false')
    expect(g.covers).toBe(true)

    const groundFrontY = g.scene.y + g.groundV1 * g.scene.h
    expect(
      groundFrontY,
      `角色能走到的最低处（y=${groundFrontY.toFixed(0)}）伸到对话框（上沿 y=${g.panel.top.toFixed(0)}）底下了`,
    ).toBeLessThanOrEqual(g.panel.top + 1.5)
  })

  test('改变视口（不刷新）会重新求值', async ({ page }) => {
    await boot(page, 1280, 800)
    const before = await probe(page)
    expect(before.covers, '初始就该铺满').toBe(true)

    // 从 16:10 换到 2.44 宽屏，裁切方向会从上下变成左右 —— 必须重算
    await page.setViewportSize({ width: 844, height: 346 })
    await page.waitForTimeout(400)

    const after = await probe(page)
    expect(after.covers, '视口变了之后没有重新适配，出现了黑边').toBe(true)
    expect(after.groundV1, '走动深度没有跟着新视口重算').toBeLessThan(before.groundV1 + 1)
  })
})

test.describe('长台词不会消失', () => {
  test('文案比文本框高时，剩下的部分滚得到', async ({ page }) => {
    /*
     * 不走 boot()：它会 click 到旁白消失，而这条用例**需要**那条正在显示的
     * 旁白当作台词卡。直接 goto 然后等引擎起来就行。
     */
    await page.setViewportSize({ width: 844, height: 346 })
    await page.goto('/')
    await page.waitForFunction(
      () => Boolean((window as unknown as { __HB__?: { sceneRuntime?: unknown } }).__HB__?.sceneRuntime),
      null,
      { timeout: 30_000 },
    )
    await page.waitForTimeout(400)

    /*
     * 文本框是**固定高度**的（走动深度按标称高度收窄，框一长就会盖住角色）。
     * 那么长台词必须能在框内滚动读到 —— 这一条一开始是坏的：
     *
     * 容器用 `align-items: flex-end` 做底部对齐，内容超高时溢出被推到**顶部**，
     * 而滚动容器里"溢出到起始侧"的部分多数浏览器**滚不到**。实测
     * 卡片 394px / 容器 96px 时 `scrollHeight === clientHeight`、`maxScroll === 0`，
     * 也就是长台词凭空消失，玩家毫无办法。
     *
     * 这类问题不会报错、不会崩，只是字没了 —— 必须有用例盯着。
     */
    const result = await page.evaluate(() => {
      const layer = document.querySelector('[data-dialogue-band]') as HTMLElement
      const card = layer.querySelector('[role="log"]') as HTMLElement
      if (!card) return null
      const target = card.querySelector('p') ?? card
      // 塞一段远超一屏的台词
      target.textContent = '这是一句很长的台词。'.repeat(40)

      const layerRect = layer.getBoundingClientRect()
      const cardRect = card.getBoundingClientRect()
      layer.scrollTop = 99999
      return {
        cardH: Math.round(cardRect.height),
        layerH: Math.round(layerRect.height),
        cardTopInside: cardRect.top >= layerRect.top - 1,
        maxScroll: Math.round(layer.scrollTop),
      }
    })

    expect(result, '找不到台词卡').not.toBeNull()
    expect(result!.cardH, '台词没有被撑长，后面的断言就没意义了').toBeGreaterThan(result!.layerH)
    expect(result!.cardTopInside, '台词溢到框外顶部去了，那部分滚不到').toBe(true)
    expect(result!.maxScroll, '框内滚不动 —— 长台词等于被吞掉了').toBeGreaterThan(0)
  })
})