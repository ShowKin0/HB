import { expect, test, type Page } from '@playwright/test'

/**
 * 五种 placement 的**外观契约**。
 *
 * 布局抽象把"对话排在哪"交给内容声明，但声明要真的兑现才行：
 * 光在 `DialogueLayoutConfig` 里写个 `none` 而对话层照常渲染，
 * 抽象就只是纸面上的。
 *
 * 这里直接在根元素上改属性来逐个验证 —— 测的是 CSS 契约本身。
 * "内容声明 → 根属性"那一段由 layout.spec.ts 覆盖，两段接起来才是完整链路。
 */

async function boot(page: Page): Promise<void> {
  await page.setViewportSize({ width: 844, height: 390 })
  await page.goto('/')
  await page.waitForFunction(
    () => Boolean((window as unknown as { __HB__?: { sceneRuntime?: unknown } }).__HB__?.sceneRuntime),
    null,
    { timeout: 30_000 },
  )
}

/**
 * 设置布局形态并**同一次求值里**读完尺寸。
 *
 * 关键在"同一次求值"：`data-dialogue` 是 React 管的属性，GameShell 每次
 * 重渲染都会按解析结果把它写回去；而调试信息是定时推送的，也就是说
 * 随时可能来一次重渲染。分两步写（先 set、再 await 读）会随机读到
 * React 还原后的旧值 —— 这条一开始就是间歇性失败。
 *
 * 中间不 await，读取又会强制同步重排，所以拿到的一定是刚设下去的那个形态。
 */
interface PlacementSnapshot {
  layer: Box | null
  layerVisible: boolean
  probe: { w: number; h: number }
  scene: { w: number; h: number }
  /** 场景矩形是否完全盖住画布（没有黑边）。 */
  covers: boolean
}

async function snapshot(
  page: Page,
  placement: string,
  reserve = 'true',
): Promise<PlacementSnapshot> {
  return page.evaluate(
    ({ value, reserveValue }) => {
      const root = document.querySelector('[data-dialogue]') as HTMLElement
      root.setAttribute('data-dialogue', value)
      root.setAttribute('data-dialogue-reserve', reserveValue)

      const layer = document.querySelector('[data-dialogue-band]') as HTMLElement
      const rect = layer.getBoundingClientRect()
      const probe = document.querySelector('[data-inset-probe]') as HTMLElement
      const game = (window as unknown as { __HB__: { viewport: { w: number; h: number } } }).__HB__

      return {
        layer: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
        layerVisible: rect.width > 0 && rect.height > 0,
        probe: { w: probe.offsetWidth, h: probe.offsetHeight },
        scene: { w: game.viewport.w, h: game.viewport.h },
        covers:
          game.viewport.x <= 0.5 &&
          game.viewport.y <= 0.5 &&
          game.viewport.x + game.viewport.w >= window.innerWidth - 0.5 &&
          game.viewport.y + game.viewport.h >= window.innerHeight - 0.5,
      }
    },
    { value: placement, reserveValue: reserve },
  )
}

test.describe('placement 的外观契约', () => {
  test('none：场景没有对话 —— 对话层不该出现', async ({ page }) => {
    await boot(page)

    /*
     * `none` 的语义是"这个场景没有对话"（纯物件解谜、纯观察场景）。
     * 之前它只把 inset 归零，对话层照常渲染 —— 内容说了不要对话，
     * 屏幕上还是挂着一条对话框。
     */
    const g = await snapshot(page, 'none')
    expect(g.layerVisible, 'none 形态下对话层还显示着').toBe(false)
    expect(g.probe).toEqual({ w: 0, h: 0 })
  })

  test('fullscreen：铺满整屏', async ({ page }) => {
    await boot(page)
    const g = await snapshot(page, 'fullscreen')
    const viewport = page.viewportSize()!

    expect(g.layer!.w, '全屏形态没有铺满宽度').toBeGreaterThan(viewport.width * 0.98)
    expect(g.layer!.h, '全屏形态没有铺满高度').toBeGreaterThan(viewport.height * 0.98)
  })

  test('side：贴右、铺满高度，并让场景避开', async ({ page }) => {
    await boot(page)
    const g = await snapshot(page, 'side')
    const viewport = page.viewportSize()!

    expect(g.layer!.x + g.layer!.w).toBeGreaterThan(viewport.width - 2)
    expect(g.layer!.h).toBeGreaterThan(viewport.height * 0.9)
    expect(g.probe.w, '侧栏没有把占用反馈给探针').toBeGreaterThan(120)
    expect(g.probe.h).toBe(0)
  })

  test('bottom：贴底、铺满宽度，并让场景避开下方', async ({ page }) => {
    await boot(page)
    const g = await snapshot(page, 'bottom')
    const viewport = page.viewportSize()!

    expect(g.layer!.y + g.layer!.h).toBeGreaterThan(viewport.height - 2)
    expect(g.layer!.w).toBeGreaterThan(viewport.width * 0.9)
    expect(g.probe.h, '底部对话框没有把占用反馈给探针').toBeGreaterThan(40)
    expect(g.probe.w).toBe(0)
  })

  /*
   * 探针报告的是**对话自己占多大地方**（footprint），不是"场景要不要让开"。
   *
   * 这两件事被刻意分开了：画面让不让开由 `reserveSceneSpace` 决定，
   * 而**走动深度永远要让开** —— 否则角色会走到文本框后面去。
   * 所以"不避让"要看的是场景有没有铺满画布，不是探针是不是 0。
   */
  test('overlay：对话浮在画面上，场景铺满整块画布', async ({ page }) => {
    await boot(page)
    const g = await snapshot(page, 'overlay')

    expect(g.layerVisible, 'overlay 应该照常显示对话').toBe(true)
    expect(g.probe.h, 'overlay 的文本框仍然占着底部一条（走动深度要让开它）').toBeGreaterThan(40)
    /*
     * 不断言 covers：手改属性不会触发引擎重量视口，拿 game.viewport
     * 断言会时灵时不灵。场景铺满与否由 layout.spec.ts 用**启动状态**验证。
     */
  })

  test('内容声明不避让时，场景铺满、对话浮在上面', async ({ page }) => {
    await boot(page)

    /*
     * 这条**不改属性**，直接读启动状态 —— 当前内容声明的就是
     * `reserveSceneSpace: false` + 横屏 overlay。
     *
     * 手改 `data-dialogue` 只能验证 CSS 契约；引擎的视口是 React 驱动
     * 重算的，手动改属性不会触发它重量，拿 `game.viewport` 断言就会
     * 变成一条时灵时不灵的用例（这条已经踩过一次）。
     */
    const read = (): Promise<{ reserve: string | null; placement: string | null; covers: boolean; layerVisible: boolean }> =>
      page.evaluate(() => {
        const game = (window as unknown as {
          __HB__: { viewport: { x: number; y: number; w: number; h: number } }
        }).__HB__
        const vp = game.viewport
        const layer = document.querySelector('[data-dialogue-band]') as HTMLElement
        return {
          reserve: document.querySelector('[data-dialogue]')!.getAttribute('data-dialogue-reserve'),
          placement: document.querySelector('[data-dialogue]')!.getAttribute('data-dialogue'),
          covers:
            vp.x <= 0.5 &&
            vp.y <= 0.5 &&
            vp.x + vp.w >= window.innerWidth - 0.5 &&
            vp.y + vp.h >= window.innerHeight - 0.5,
          layerVisible: layer.getBoundingClientRect().height > 0,
        }
      })

    /*
     * 用轮询而不是读一次：启动后引擎还会再量一次视口（主题/布局就位之后），
     * 第一帧读到的可能还是旧 inset。这条用例早先就是这么间歇性失败的。
     */
    await expect
      .poll(async () => (await read()).covers, { timeout: 5_000, message: '声明不避让时场景必须铺满画布' })
      .toBe(true)

    const g = await read()
    expect(g.reserve).toBe('false')
    expect(g.placement).toBe('overlay')
    expect(g.layerVisible, '只是不占位，不该把对话也藏起来').toBe(true)
  })

  test('每种形态都不会把场景压成 0', async ({ page }) => {
    await boot(page)
    for (const placement of ['none', 'fullscreen', 'overlay', 'side', 'bottom']) {
      const g = await snapshot(page, placement)
      expect(g.scene.w, `${placement} 形态下场景宽度变成了 0`).toBeGreaterThan(0)
      expect(g.scene.h, `${placement} 形态下场景高度变成了 0`).toBeGreaterThan(0)
    }
  })
})

/**
 * `pauseWorldInput`：对话层可见期间，点击不再穿透到场景。
 *
 * 当前 demo 内容声明的是 false，所以这条路径**一直没被走过**。
 * 一个只在配置里存在、从没执行过的开关，和没有这个开关是一样的。
 *
 * 这里直接驱动引擎的开关来验证契约本身；"内容声明 → 调这个开关"
 * 那一段由 GameShell 的 effect 负责，属于接线，另由 typecheck 兜底。
 */
test.describe('pauseWorldInput 契约', () => {
  async function ownerOf(page: Page): Promise<string> {
    return page.evaluate(
      () => (window as unknown as { __HB__: { interactionState: { owner: string } } }).__HB__.interactionState.owner,
    )
  }

  /** 把入场旁白推干净，回到"没有台词等着推进"的状态。 */
  async function idle(page: Page, width: number, height: number): Promise<void> {
    for (let i = 0; i < 10; i++) {
      if ((await page.locator('[role="log"]').count()) === 0) return
      await page.mouse.click(width / 2, height / 2)
      await page.waitForTimeout(180)
    }
  }

  test('关掉时点击归场景，打开时归对话', async ({ page }) => {
    await boot(page)
    await idle(page, 844, 390)

    await page.evaluate(() => {
      ;(window as unknown as { __HB__: { setDialogueBlocksInput(v: boolean): void } }).__HB__.setDialogueBlocksInput(
        false,
      )
    })
    await page.waitForTimeout(80)
    expect(await ownerOf(page), '没开开关时场景输入应该是可用的').toBe('scene')

    await page.evaluate(() => {
      ;(window as unknown as { __HB__: { setDialogueBlocksInput(v: boolean): void } }).__HB__.setDialogueBlocksInput(
        true,
      )
    })
    await page.waitForTimeout(80)
    expect(await ownerOf(page), '打开开关后点击不该再穿透到场景').toBe('dialogue')
  })

  test('打开开关后点击场景不会触发任何交互', async ({ page }) => {
    await boot(page)
    await idle(page, 844, 390)

    await page.evaluate(() => {
      ;(window as unknown as { __HB__: { setDialogueBlocksInput(v: boolean): void } }).__HB__.setDialogueBlocksInput(
        true,
      )
    })
    await page.waitForTimeout(80)

    const before = await page.evaluate(
      () => (window as unknown as { __HB__: { eventHistory: unknown[] } }).__HB__.eventHistory.length,
    )
    await page.mouse.click(422, 195)
    await page.waitForTimeout(300)
    const after = await page.evaluate(
      () => (window as unknown as { __HB__: { eventHistory: unknown[] } }).__HB__.eventHistory.length,
    )

    expect(after, '世界输入关着的时候还是触发了交互').toBe(before)
  })

  test('开关打开时会清掉半截手势', async ({ page }) => {
    await boot(page)
    await idle(page, 844, 390)

    // 按下去但先不松手
    await page.mouse.move(400, 200)
    await page.mouse.down()
    await page.waitForTimeout(60)

    await page.evaluate(() => {
      ;(window as unknown as { __HB__: { setDialogueBlocksInput(v: boolean): void } }).__HB__.setDialogueBlocksInput(
        true,
      )
    })
    await page.waitForTimeout(80)

    // 松手不该补出一次点击
    const before = await page.evaluate(
      () => (window as unknown as { __HB__: { eventHistory: unknown[] } }).__HB__.eventHistory.length,
    )
    await page.mouse.up()
    await page.waitForTimeout(300)
    const after = await page.evaluate(
      () => (window as unknown as { __HB__: { eventHistory: unknown[] } }).__HB__.eventHistory.length,
    )

    expect(after, '中途改状态后，之前按下的那一下还是结算了').toBe(before)
  })
})
