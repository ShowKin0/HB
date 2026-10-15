import { expect, test, type Page } from '@playwright/test'

/**
 * 编辑器验证。
 *
 * 重点验证"改动能落到草稿上"以及"导出的 JSON 合法" ——
 * 一个只能看不能改的编辑器等于没有。
 */

async function openEditor(page: Page): Promise<void> {
  await page.goto('/edit')
  await expect(page.getByText('场景编辑器')).toBeVisible({ timeout: 30_000 })
  // 等场景草稿与画布就绪
  await expect(page.locator('svg.overlay, svg')).toBeVisible()
  await page.waitForFunction(() => document.querySelectorAll('circle').length > 0, null, { timeout: 20_000 })

  /*
   * 等画布真的量好尺寸再交还控制权。
   *
   * 光等 circle 出现是不够的：句柄可以先渲染出来，而 overlay 的
   * getBoundingClientRect 还是 0 —— 此时指针坐标会被算成垃圾值，
   * 拖拽表现为"完全没效果"。这个 flake 只在整套跑时冒出来
   * （前一个用例刚加载过编辑器，模块图正在热更新），单跑反而是过的。
   */
  await page.waitForFunction(
    () => {
      const svg = document.querySelector('svg')
      const polygon = document.querySelector('polygon')
      if (!svg || !polygon) return false
      const box = svg.getBoundingClientRect()
      const points = polygon.getAttribute('points') ?? ''
      const coords = points.trim().split(/\s+/)
      if (box.width <= 50 || box.height <= 50) return false
      if (coords.length < 4) return false
      /*
       * 必须等**非退化**的多边形。
       *
       * 编辑器会先渲染一版 "0,0 0,0 0,0 0,0"（还没量到尺寸），
       * 只数点的个数会把它当成就绪 —— 之后的拖动就落在一个零尺寸的
       * 坐标空间里，表现为"拖了没反应"。这条之前一直是 flaky 的来源。
       */
      return coords.some((pair) => pair !== '0,0')
    },
    null,
    { timeout: 20_000 },
  )
}

async function exportJson(page: Page): Promise<{ walkable: string[] } & Record<string, unknown>> {
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出场景 JSON' }).click()
  const file = await download
  const stream = await file.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as { walkable: string[] } & Record<string, unknown>
}

const blockedCount = (walkable: string[]): number =>
  walkable.join('').split('').filter((char) => char === '#').length

test('编辑器加载场景并画出地面四角与热点', async ({ page }) => {
  await openEditor(page)

  // 地面四角：4 个可拖拽圆点
  const groundHandles = page.locator('circle[r="7"]')
  await expect(groundHandles).toHaveCount(4)

  // 热点的矩形框
  await expect(page.locator('rect[stroke="rgba(217,165,102,0.5)"], rect[stroke="#d9a566"]').first()).toBeVisible()

  await page.screenshot({ path: 'screenshots/05-editor.png' })
})

test('拖动地面角点会改变地面标定', async ({ page }) => {
  await openEditor(page)

  const polygonBefore = await page.locator('polygon').first().getAttribute('points')
  const handle = page.locator('circle[r="7"]').first()
  const box = await handle.boundingBox()
  expect(box).not.toBeNull()

  /*
   * 直接派发指针事件，而不是用 page.mouse 走命中测试。
   *
   * 这条用例只在**整套跑**时失败、单跑必过：前一个用例刚加载过编辑器，
   * 开发服务器随之推一次 HMR 更新，画布重新挂载 —— 此时按坐标落下的
   * 指针可能谁也命不中（handle.hover() 会直接超时，就是这个原因）。
   *
   * 直接派发绕开合成器与 hit-test，验证的仍然是**编辑器自己的拖拽数学**：
   * 句柄按下设置 dragRef，画布上的移动把对应角点写到新位置。
   */
  const cx = box!.x + box!.width / 2
  const cy = box!.y + box!.height / 2
  await handle.dispatchEvent('pointerdown', {
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    bubbles: true,
    clientX: cx,
    clientY: cy,
  })

  const svg = page.locator('svg').first()
  for (const at of [
    { x: cx + 30, y: cy - 20 },
    { x: cx + 60, y: cy - 40 },
    { x: cx + 90, y: cy - 60 },
  ]) {
    await svg.dispatchEvent('pointermove', {
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      bubbles: true,
      clientX: at.x,
      clientY: at.y,
    })
  }
  await svg.dispatchEvent('pointerup', {
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    bubbles: true,
    clientX: cx + 90,
    clientY: cy - 60,
  })

  const polygonAfter = await page.locator('polygon').first().getAttribute('points')
  expect(polygonAfter).not.toBe(polygonBefore)
})

test('涂阻挡会写进可行走掩码', async ({ page }) => {
  await openEditor(page)

  const before = blockedCount((await exportJson(page)).walkable)

  await page.getByRole('button', { name: '涂阻挡' }).click()
  // 在场景中部按住拖动，涂出一条阻挡带
  await page.mouse.move(800, 500)
  await page.mouse.down()
  await page.mouse.move(900, 520, { steps: 8 })
  await page.mouse.up()

  const after = blockedCount((await exportJson(page)).walkable)
  expect(after).toBeGreaterThan(before)
})

test('导出的是通过校验的合法场景 JSON', async ({ page }) => {
  await openEditor(page)

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出场景 JSON' }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe('start.json')

  const stream = await file.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  const json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    id: string
    mode: string | null
    aspect: number
    ground: unknown
    actors: unknown[]
    hotspots: { interactions?: unknown[] }[]
  }

  // 导出的必须是填满默认值的完整对象，而不是残缺的片段
  expect(json.id).toBe('start')
  expect(json.mode).toBe('walk')
  expect(json.ground).toBeTruthy()
  expect(typeof json.aspect).toBe('number')
  expect(json.actors).toHaveLength(1)
  expect(json.hotspots.length).toBeGreaterThan(0)
  // 新契约：物件走 interactions，旧字段不该再出现在导出结果里
  expect(json.hotspots[0].interactions?.length).toBeGreaterThan(0)
})

test('切到 focus 模式会清掉地面与角色', async ({ page }) => {
  await openEditor(page)

  // 用 aria-label 定位，别用 .first()：场景选择器排在模式选择器前面
  await page.getByLabel('场景模式').selectOption('focus')

  const json = await exportJson(page)
  expect(json.mode).toBe('focus')
  expect(json.ground).toBeNull()
  expect(json.actors).toHaveLength(0)
})

test('选中物件后能看到交互列表并新增一条', async ({ page }) => {
  await openEditor(page)

  // 从侧栏的物件列表选中，比点 SVG 上的矩形稳定。
  // 注意不能用 getByText('hs_room')：画布上的标签文字也叫这个名字，会撞 strict mode。
  await page.locator('[class*="hotspotItem"]').filter({ hasText: 'hs_room' }).click()

  await expect(page.getByText('交互', { exact: false }).first()).toBeVisible()
  const before = await page.locator('select').filter({ hasText: 'inspect 点击' }).count()

  await page.getByRole('button', { name: '加交互' }).click()
  const after = await page.locator('select').filter({ hasText: 'inspect 点击' }).count()
  expect(after).toBeGreaterThan(before)
})

test.describe('切场景不丢编辑', () => {
  /** 把第一个地面角点拖走，返回拖动前的多边形。 */
  async function nudgeGroundCorner(page: Page): Promise<string | null> {
    const before = await page.locator('polygon').first().getAttribute('points')
    const handle = page.locator('circle[r="7"]').first()
    const box = (await handle.boundingBox())!
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await handle.dispatchEvent('pointerdown', {
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      bubbles: true,
      clientX: cx,
      clientY: cy,
    })
    const svg = page.locator('svg').first()
    for (const at of [
      { x: cx + 20, y: cy - 14 },
      { x: cx + 44, y: cy - 30 },
    ]) {
      await svg.dispatchEvent('pointermove', {
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        bubbles: true,
        clientX: at.x,
        clientY: at.y,
      })
    }
    return before
  }

  test('切走再切回来，之前的编辑还在', async ({ page }) => {
    await openEditor(page)
    const before = await nudgeGroundCorner(page)
    const edited = await page.locator('polygon').first().getAttribute('points')
    expect(edited, '拖动本身没生效，后面的断言就没意义了').not.toBe(before)

    const select = page.getByLabel('当前场景')
    await select.selectOption('hall')
    await page.waitForTimeout(250)
    await select.selectOption('start')
    await page.waitForTimeout(250)

    /*
     * 切回来必须还是改过的样子。
     *
     * 之前这里是直接 setDraft(原始场景)，未导出的编辑在切换时**静默丢失**
     * —— 拖了半天地面、涂了阻挡，去隔壁看一眼回来就全没了，而且没有任何提示。
     */
    expect(
      await page.locator('polygon').first().getAttribute('points'),
      '切回场景后编辑丢了',
    ).toBe(edited)
  })

  test('改过的场景在列表里标出来，切走再切回标记还在', async ({ page }) => {
    await openEditor(page)

    // 改一笔
    await nudgeGroundCorner(page)
    const optionText = (): Promise<string> =>
      page
        .getByLabel('当前场景')
        .locator('option[value="start"]')
        .evaluate((node) => node.textContent ?? '')
    /*
     * 改完立刻就标出来 —— 而不是等切走才发现没导出。
     * 用 textContent 而不是 toContainText：option 元素的可见性语义在
     * Playwright 里不可靠，直接读文本更稳。
     */
    expect(await optionText(), '改过的场景应该标出来').toContain('已改')

    const select = page.getByLabel('当前场景')
    await select.selectOption('hall')
    await page.waitForTimeout(250)
    await select.selectOption('start')
    await page.waitForTimeout(250)

    expect(await optionText(), '切回来标记还在').toContain('已改')
  })
})