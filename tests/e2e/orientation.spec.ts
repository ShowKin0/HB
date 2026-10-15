import { expect, test, type Page } from '@playwright/test'

/**
 * 横屏优先的验收。
 *
 * 这个游戏以**手机横屏**为主要形态，所以有两类事情必须钉住：
 *
 *   1. 竖屏时给出明确引导并**暂停**，而不是让人对着被压扁的布局猜
 *   2. 横屏时四边安全区真的生效，且场景不会伸到对话面板底下
 *
 * 安全区是这里唯一需要"造"的东西：Playwright 的 WebKit 不会模拟
 * `env(safe-area-inset-*)`（真机才有刘海）。所以用 CSS 变量覆盖来验证
 * ——布局读的是这几个变量，覆盖它们等价于模拟一台有刘海的手机。
 */

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
 * 入场旁白会**吃掉第一下点击**（那时输入归属是"对话"，点击只会推进）。
 * 不推掉就直接点热点的话，表现为"点了没反应"—— 这个坑花了一轮才定位到。
 */
async function dismissDialogue(page: Page, maxClicks = 8): Promise<void> {
  const size = page.viewportSize()!
  for (let i = 0; i < maxClicks; i++) {
    if ((await page.locator('[role="log"]').count()) === 0) return
    await page.mouse.click(size.width / 2, size.height / 2)
    await page.waitForTimeout(200)
  }
}

const isLandscape = (page: Page): boolean => {
  const size = page.viewportSize()!
  return size.width > size.height
}

/**
 * 当前是侧栏形态还是底部形态。
 *
 * **不要**按 viewport 方向猜：横屏有两种形态，宽高比 ≥ 1.9 才用侧栏
 * （iPad 横屏和桌面都用底部对话框，那样场景占比高一倍）。判据以引擎
 * 实际选择的为准，否则布局规则一改测试就跟着错。
 */
const isSideLayout = async (page: Page): Promise<boolean> =>
  (await page.locator('[data-dialogue]').getAttribute('data-dialogue')) === 'side'

test.describe('方向引导', () => {
  test('竖屏：给出引导，并且暂停模拟', async ({ page }) => {
    test.skip(isLandscape(page), '这条只在竖屏有意义')

    await boot(page)

    const gate = page.locator('[data-orientation-gate]')
    await expect(gate).toBeVisible()
    await expect(gate).toContainText('请把手机横过来')

    // 关键：不只是盖一层，游戏必须真的停下来
    const paused = await page.evaluate(
      () => (window as unknown as { __HB__: { paused: boolean; pauseState: string[] } }).__HB__.paused,
    )
    expect(paused).toBe(true)
    const reasons = await page.evaluate(
      () => (window as unknown as { __HB__: { pauseState: string[] } }).__HB__.pauseState,
    )
    expect(reasons).toContain('orientation')
  })

  test('横屏：没有引导，模拟正常运行', async ({ page }) => {
    test.skip(!isLandscape(page), '这条只在横屏有意义')

    await boot(page)

    // 遮罩元素在 DOM 里（由 CSS 决定显示），但必须是隐藏的
    await expect(page.locator('[data-orientation-gate]')).toBeHidden()
    const paused = await page.evaluate(
      () => (window as unknown as { __HB__: { paused: boolean } }).__HB__.paused,
    )
    expect(paused).toBe(false)
  })
})

test.describe('横屏布局', () => {
  test('场景区不伸到对话面板底下', async ({ page }) => {
    test.skip(!isLandscape(page), '只在横屏有意义')
    await boot(page)
    test.skip(!(await isSideLayout(page)), '底部对话框形态下场景本来就铺满整宽')

    const geometry = await page.evaluate(() => {
      const game = (window as unknown as {
        __HB__: { viewport: { x: number; y: number; w: number; h: number } }
      }).__HB__
      const panel = document.querySelector('[data-dialogue-band]')!.getBoundingClientRect()
      return {
        sceneRight: game.viewport.x + game.viewport.w,
        sceneBottom: game.viewport.y + game.viewport.h,
        panelLeft: panel.left,
        panelTop: panel.top,
        panelWidth: panel.width,
        panelHeight: panel.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }
    })

    // 场景整体在面板左侧 —— 这样角色站在场景任何位置都不会被盖住
    expect(geometry.sceneRight).toBeLessThanOrEqual(geometry.panelLeft + 1)
    expect(geometry.sceneBottom).toBeLessThanOrEqual(geometry.viewportHeight + 1)

    // 面板是右侧通栏，不是底部一条
    expect(geometry.panelTop).toBeLessThan(4)
    expect(geometry.panelHeight).toBeGreaterThan(geometry.viewportHeight * 0.9)
    expect(geometry.panelLeft).toBeGreaterThan(geometry.viewportWidth * 0.5)

    // 场景确实用上了大部分屏宽，而不是缩在中间一小块
    expect(geometry.sceneRight / geometry.viewportWidth).toBeGreaterThan(0.5)
  })

  test('侧栏形态下场景占比不低于 55%（否则等于白瞎了一块屏）', async ({ page }) => {
    test.skip(!isLandscape(page), '只在横屏有意义')
    // 这条阈值是照手机横屏定的。桌面 1280×800 也满足"宽>高"，
    // 但面板占 340px、场景 16:9 上下还要留黑，占比天然低一些 —— 不是同一回事。
    test.skip(page.viewportSize()!.width > 1000, '只对手机横屏有意义')
    await boot(page)

    const ratio = await page.evaluate(() => {
      const game = (window as unknown as {
        __HB__: { viewport: { x: number; y: number; w: number; h: number } }
      }).__HB__
      return (game.viewport.w * game.viewport.h) / (window.innerWidth * window.innerHeight)
    })
    expect(ratio).toBeGreaterThan(0.55)
  })
})

test.describe('安全区', () => {
  /**
   * 造一台"有刘海的横屏手机"。
   *
   * 真机上这些值来自 env(safe-area-inset-*)；Playwright 不会模拟它们，
   * 所以直接覆盖那几个 CSS 变量 —— 布局读的就是它们，等价。
   * 数值取 iPhone 14 横屏的实测：刘海侧 47px、底部 Home 指示条 21px。
   */
  async function applyNotch(page: Page): Promise<void> {
    await page.addStyleTag({
      content: `:root {
        --safe-l: 47px;
        --safe-r: 47px;
        --safe-t: 0px;
        --safe-b: 21px;
        --safe-x: 47px;
      }`,
    })
    // 让引擎按新的安全区重算视口
    await page.setViewportSize({ width: 844, height: 347 })
    await page.setViewportSize({ width: 844, height: 346 })
    await page.waitForTimeout(250)
  }

  test('HUD 不压在刘海下面', async ({ page }) => {
    test.skip(!isLandscape(page), '只在横屏有意义')
    await boot(page)
    await applyNotch(page)

    const box = await page.locator('[data-hud]').boundingBox()
    expect(box).not.toBeNull()
    // 右边缘必须让开 47px 的刘海
    expect(box!.x + box!.width).toBeLessThanOrEqual(844 - 47 + 1)
  })

  test('对话面板内容让开右刘海与底部指示条', async ({ page }) => {
    test.skip(!isLandscape(page), '只在横屏有意义')
    await boot(page)

    // 先改安全区，再算坐标 —— 顺序反了的话拿到的是旧视口里的点，
    // 点下去落空（这条第一次就是这么挂的）
    await applyNotch(page)
    const shelf = await page.evaluate(() => {
      const game = (window as unknown as {
        __HB__: { viewport: { x: number; y: number; w: number; h: number } }
      }).__HB__
      return {
        x: game.viewport.x + 0.135 * game.viewport.w,
        y: game.viewport.y + 0.41 * game.viewport.h,
      }
    })
    // 先确认这个点真的落在书架上 —— 否则失败会以"台词没出现"的形式报出来，
    // 白白查半天。hoverId 是引擎自己算的，用它当落点校验最直接。
    await page.mouse.move(shelf.x, shelf.y)
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __HB__: { interactionState: { hoverId: string | null } } }).__HB__
                .interactionState.hoverId,
          ),
        { timeout: 5000 },
      )
      .toBe('hs_shelf')

    await page.mouse.click(shelf.x, shelf.y)
    await expect(page.locator('[role="log"]')).toBeVisible({ timeout: 25_000 })

    const inner = await page.evaluate(() => {
      const panel = document.querySelector('[data-dialogue-band]')!
      const style = getComputedStyle(panel)
      const rect = panel.getBoundingClientRect()
      return {
        paddingRight: Number.parseFloat(style.paddingRight),
        paddingBottom: Number.parseFloat(style.paddingBottom),
        right: rect.right,
        bottom: rect.bottom,
      }
    })
    // padding 必须把 47px 刘海和 21px 指示条算进去
    expect(inner.paddingRight).toBeGreaterThanOrEqual(47)
    expect(inner.paddingBottom).toBeGreaterThanOrEqual(21)
  })

  test('带刘海时场景仍然铺满，且角色不会走到对话框后面', async ({ page }) => {
    test.skip(!isLandscape(page), '只在横屏有意义')
    await boot(page)
    await applyNotch(page)

    const geometry = await page.evaluate(() => {
      const game = (window as unknown as {
        __HB__: {
          viewport: { x: number; y: number; w: number; h: number }
          groundRange: readonly [number, number]
        }
      }).__HB__
      const vp = game.viewport
      const panel = document.querySelector('[data-dialogue-band]')!.getBoundingClientRect()
      return {
        coversLeft: vp.x <= 0.5,
        coversRight: vp.x + vp.w >= window.innerWidth - 0.5,
        groundFrontY: vp.y + game.groundRange[1] * vp.h,
        panelTop: panel.top,
      }
    })

    /*
     * 这条以前写的是"场景右边界 ≤ 面板左边界" —— 那是 side 形态的判据。
     * 改成 overlay 之后对话框**故意**浮在画面上，那条恒不成立。
     * 真正要保证的是两件事：画面铺满（没有黑边），以及角色不会被盖住。
     */
    expect(geometry.coversLeft && geometry.coversRight, '安全区生效后场景没盖住画布').toBe(true)
    expect(geometry.groundFrontY, '角色能走到的最低处伸到对话框底下了').toBeLessThanOrEqual(
      geometry.panelTop + 1.5,
    )
  })
})
