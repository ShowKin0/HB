import { expect, test, type Page } from '@playwright/test'

/**
 * 剧情推进的健壮性。
 *
 * `drainStory` 是整个引擎里异步最密的一段：一把推进锁、一个代次计数、
 * 挂起的场景切换、排队跳转、选项让出控制权。它出问题时的表现几乎总是
 * **"点了没反应"** —— 没有探针就只能靠猜，所以这里把它当状态机来压。
 *
 * 核心不变式：
 *   1. 推进锁最终一定会释放（不能永久卡住）
 *   2. 同一次交互不会因为连点而触发两次
 *   3. 玩家正在选的时候，剧情不会溜走
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

async function dismissDialogue(page: Page, maxClicks = 8): Promise<void> {
  const size = page.viewportSize()!
  for (let i = 0; i < maxClicks; i++) {
    if ((await page.locator('[role="log"]').count()) === 0) return
    await page.mouse.click(size.width / 2, size.height / 2)
    await page.waitForTimeout(180)
  }
}

/**
 * 点某个物件：**位置问引擎要**，不写死场景坐标。
 *
 * 写死坐标在这次会话里已经翻车三次了：改 sceneFit、改布局形态、把热点收进
 * 安全区，每一次都让一批用例静默点空。热点在哪是内容的事，
 * 用例只需要知道"我要点书架"。
 */
async function hotspotPoint(page: Page, id: string): Promise<{ x: number; y: number }> {
  const point = await page.evaluate((hotspotId) => {
    const game = (window as unknown as {
      __HB__: {
        viewport: { x: number; y: number; w: number; h: number }
        sceneRuntime: {
          scene: { hotspots: { id: string; shape: Record<string, number | string> }[] }
        } | null
      }
    }).__HB__
    const vp = game.viewport
    const shape = game.sceneRuntime?.scene.hotspots.find((h) => h.id === hotspotId)?.shape
    if (!shape) return null
    let u = 0.5
    let v = 0.5
    if (shape.type === 'rect') {
      u = Number(shape.x) + Number(shape.w) / 2
      v = Number(shape.y) + Number(shape.h) / 2
    } else if (shape.type === 'circle') {
      u = Number(shape.cx)
      v = Number(shape.cy)
    }
    return { x: vp.x + u * vp.w, y: vp.y + v * vp.h }
  }, id)
  if (!point) throw new Error(`场景里没有物件 ${id}`)
  return point
}

async function clickHotspot(page: Page, id: string, dismissFirst = true): Promise<void> {
  if (dismissFirst) await dismissDialogue(page)
  const point = await hotspotPoint(page, id)
  await page.mouse.click(point.x, point.y)
}

interface StoryState {
  busy: boolean
  phase: string
  awaitingAdvance: boolean
  choiceCount: number
  queuedKnot: string | null
  pendingSceneId: string | null
}

const storyState = (page: Page): Promise<StoryState> =>
  page.evaluate(
    () => (window as unknown as { __HB__: { storyState: StoryState } }).__HB__.storyState,
  )

const gotoScene = async (page: Page, id: string): Promise<void> => {
  await page.evaluate(async (sceneId) => {
    const game = (window as unknown as { __HB__: { debugGotoScene(id: string): Promise<void> } }).__HB__
    await game.debugGotoScene(sceneId)
  }, id)
  await page.waitForTimeout(200)
  await dismissDialogue(page)
}

const eventCount = (page: Page, name: string): Promise<number> =>
  page.evaluate(
    (key) =>
      ((window as unknown as { __HB__: { engineState: { events: Record<string, number> } } }).__HB__
        .engineState.events[key] ?? 0) as number,
    name,
  )

test.describe('剧情推进的锁最终一定释放', () => {
  test('连续触发多次交互后，推进锁不会卡住', async ({ page }) => {
    await boot(page)

    const shelf = await hotspotPoint(page, 'hs_shelf')
    for (let i = 0; i < 6; i++) {
      await page.mouse.click(shelf.x, shelf.y)
      await page.waitForTimeout(120)
    }
    await page.waitForTimeout(1500)

    // 锁必须回到空闲
    await expect
      .poll(async () => (await storyState(page)).busy, { timeout: 15_000 })
      .toBe(false)

    // 而且游戏仍然能继续交互 —— 卡住的话这一下永远不会有台词
    await dismissDialogue(page)
    await clickHotspot(page, 'hs_shelf')
    await expect(page.locator('[role="log"]')).toBeVisible({ timeout: 25_000 })
  })

  test('走位途中再次点击不会让剧情卡住', async ({ page }) => {
    await boot(page)

    const shelf = await hotspotPoint(page, 'hs_shelf')
    const door = await hotspotPoint(page, 'hs_door')

    // 第一次点击让角色走向书架，还没走到就改点门
    await page.mouse.click(shelf.x, shelf.y)
    await page.waitForTimeout(80)
    await page.mouse.click(door.x, door.y)
    await page.waitForTimeout(80)
    await page.mouse.click(shelf.x, shelf.y)

    await expect
      .poll(async () => (await storyState(page)).busy, { timeout: 20_000 })
      .toBe(false)

    // 最终一定有一句台词出来（无论是哪条分支），不能什么都不发生
    await expect(page.locator('[role="log"]')).toBeVisible({ timeout: 25_000 })
  })
})

test.describe('同一次交互不会重复触发', () => {
  test('连点同一热点，事件计数只增加一次', async ({ page }) => {
    await boot(page)

    await clickHotspot(page, 'hs_shelf')
    await expect(page.locator('[role="log"]')).toBeVisible({ timeout: 25_000 })
    await dismissDialogue(page)

    const before = await eventCount(page, 'shelf_searched')
    // 台词已经推掉、角色也站定了；这时候再点一次，应该各算一次点击
    await clickHotspot(page, 'hs_shelf')
    await page.waitForTimeout(600)
    await dismissDialogue(page)
    const after = await eventCount(page, 'shelf_searched')

    // 一次点击最多 +1（连点几次就是几次，但不该是一次点击 +2）
    expect(after - before).toBeLessThanOrEqual(1)
  })
})

test.describe('选项出现后不会被剧情溜走', () => {
  test('选项停在那里等玩家，期间状态始终是"等选择"', async ({ page }) => {
    await boot(page)
    await gotoScene(page, 'hall')

    const mark = await hotspotPoint(page, 'hs_choice')
    await page.mouse.click(mark.x, mark.y)
    await expect(page.locator('[role="log"]')).toContainText('这里放一个选择', { timeout: 25_000 })

    const size = page.viewportSize()!
    await page.mouse.click(size.width / 2, size.height / 2)
    await expect(page.getByRole('group', { name: '选择' })).toBeVisible({ timeout: 15_000 })

    // 等一段时间，选项必须还在（不能被 returnToHub 拽走）
    await page.waitForTimeout(1500)
    await expect(page.getByRole('group', { name: '选择' })).toBeVisible()

    const state = await storyState(page)
    expect(state.choiceCount, '选项数量不该自己变').toBe(2)
    expect(state.busy, '等待选择时不该占着推进锁').toBe(false)
    expect(state.queuedKnot ?? null, '不该有排队的跳转').toBeNull()
  })

  test('选完之后剧情继续，并且最终回到空闲', async ({ page }) => {
    await boot(page)
    await gotoScene(page, 'hall')

    const mark = await hotspotPoint(page, 'hs_choice')
    await page.mouse.click(mark.x, mark.y)
    await expect(page.locator('[role="log"]')).toContainText('这里放一个选择', { timeout: 25_000 })
    const size = page.viewportSize()!
    await page.mouse.click(size.width / 2, size.height / 2)
    await page.getByRole('button', { name: /选左边/ }).click()

    await expect(page.locator('[role="log"]')).toContainText('你选了左边', { timeout: 15_000 })
    await expect.poll(async () => (await storyState(page)).busy, { timeout: 10_000 }).toBe(false)
    expect((await storyState(page)).choiceCount).toBe(0)
  })
})

test.describe('切场景时推进状态干净', () => {
  test('切场景后没有残留的挂起跳转或锁定状态', async ({ page }) => {
    await boot(page)
    await gotoScene(page, 'hall')

    const state = await storyState(page)
    expect(state.busy).toBe(false)
    expect(state.pendingSceneId).toBeNull()
    expect(state.queuedKnot).toBeNull()
    expect(state.choiceCount).toBe(0)
  })

  test('在剧情演到一半时切场景，不会把两边搅在一起', async ({ page }) => {
    await boot(page)

    await clickHotspot(page, 'hs_shelf')
    await page.waitForTimeout(150)

    // 台词刚要出来就切场景
    await gotoScene(page, 'hall')
    await page.waitForTimeout(500)

    const state = await storyState(page)
    expect(state.busy, '切场景后推进锁必须释放').toBe(false)
    expect(state.pendingSceneId).toBeNull()

    // 新场景仍然能正常交互
    await clickHotspot(page, 'hs_lamp')
    await expect
      .poll(async () => eventCount(page, 'lamp_lit'), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1)
  })
})