import { expect, test, type Page } from '@playwright/test'

/**
 * 编辑器里"看不见的丢失"。
 *
 * 这一组的共同点：**不报错、不崩溃，改动就是没了**。前两条尤其隐蔽 ——
 * 下拉切换那条路径会先存草稿，所以只有别的入口中招，现有用例全绿。
 */

async function openEditor(page: Page): Promise<void> {
  await page.goto('/edit')
  await expect(page.getByText('场景编辑器')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('svg').first()).toBeVisible()
  // 等地面多边形**非退化**：编辑器会先渲染一版 "0,0 0,0 0,0 0,0"
  await expect
    .poll(
      async () => {
        const points = (await page.locator('polygon').first().getAttribute('points')) ?? ''
        const coords = points.trim().split(/\s+/)
        return coords.length >= 4 && coords.some((pair) => pair !== '0,0')
      },
      { timeout: 20_000 },
    )
    .toBe(true)
}

const draftId = (page: Page): Promise<string> =>
  page.evaluate(
    () => (window as unknown as { __EDITOR_DRAFT__?: { id: string } }).__EDITOR_DRAFT__?.id ?? '',
  )

/** 把第一个地面角点拖走。调用前先自己读 `before`。 */
async function nudgeGroundCorner(page: Page): Promise<void> {
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
}

const polygon = (page: Page): Promise<string | null> =>
  page.locator('polygon').first().getAttribute('points')

test.describe('编辑不会被悄悄丢掉', () => {
  test('新建空场景不会丢掉当前场景未导出的编辑', async ({ page }) => {
    await openEditor(page)
    const before = await polygon(page)
    await nudgeGroundCorner(page)
    const edited = await polygon(page)
    expect(edited, '拖动本身没生效，后面的断言就没意义了').not.toBe(before)

    await page.getByRole('button', { name: '新建空场景' }).click()
    await page.waitForTimeout(300)
    expect(await draftId(page), '没有切到新场景').not.toBe('start')

    /*
     * 关键：切回 start 时编辑必须还在。
     *
     * 这个按钮以前直接 `setDraft(新场景)`，绕过了草稿暂存 ——
     * 当前场景未导出的改动当场丢失，而且没有任何提示。
     * 下拉切换那条路径会先 setDrafts，所以只有这个按钮中招。
     */
    await page.getByLabel('当前场景').selectOption('start')
    await page.waitForTimeout(300)

    expect(await polygon(page), '点一下"新建空场景"就把之前的编辑弄丢了').toBe(edited)
  })

  test('新建的场景会进下拉列表，切走还能切回来', async ({ page }) => {
    await openEditor(page)
    await page.getByRole('button', { name: '新建空场景' }).click()
    await page.waitForTimeout(300)
    const created = await draftId(page)
    expect(created).not.toBe('')

    const select = page.getByLabel('当前场景')
    await select.selectOption('start')
    await page.waitForTimeout(250)

    const values = await select
      .locator('option')
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLOptionElement).value))
    expect(values, '新建的场景不在下拉里 —— 切走就再也回不去了').toContain(created)

    await select.selectOption(created)
    await page.waitForTimeout(250)
    expect(await draftId(page)).toBe(created)
  })

  test('场景改名后下拉身份不变，切换和新建都保留草稿', async ({ page }) => {
    await openEditor(page)
    const select = page.getByLabel('当前场景')
    const stableKey = await select.inputValue()
    const optionCount = await select.locator('option').count()
    const sceneId = page.locator('input').first()
    await sceneId.fill('start_renamed')
    await expect.poll(() => draftId(page)).toBe('start_renamed')
    await expect(select).toHaveValue(stableKey)
    await expect(select.locator('option:checked')).toHaveText('start_renamed（已改）')
    await expect(select.locator('option')).toHaveCount(optionCount)

    await select.selectOption('hall')
    await select.selectOption(stableKey)
    await expect.poll(() => draftId(page)).toBe('start_renamed')

    await page.getByRole('button', { name: '新建空场景' }).click()
    const newKey = await select.inputValue()
    await sceneId.fill('new_renamed')
    await select.selectOption(stableKey)
    await expect.poll(() => draftId(page)).toBe('start_renamed')
    await select.selectOption(newKey)
    await expect.poll(() => draftId(page)).toBe('new_renamed')
    await expect(select.locator('option')).toHaveCount(optionCount + 1)
  })

  test('改物件 id 之后交互面板不会消失', async ({ page }) => {
    await openEditor(page)

    // 从侧栏的物件列表选中；画布上的标签文字同名，会撞 strict mode
    await page.locator('[class*="hotspotItem"]').filter({ hasText: 'hs_room' }).click()
    await expect(page.getByRole('button', { name: '加交互' })).toBeVisible()

    /*
     * 改名之后 `HotspotEditor` 按旧 id 在场景里找物件，找不到就整个返回 null
     * —— 面板连同画布高亮一起消失，看起来像编辑器坏了，
     * 其实只是选中了一个已经不存在的 id。选中态必须跟着迁到新 id。
     */
    const idInput = page.locator('input[value="hs_room"]')
    await expect(idInput).toHaveCount(1)
    await idInput.fill('hs_room_renamed')
    await page.waitForTimeout(300)

    await expect(
      page.getByRole('button', { name: '加交互' }),
      '改名后交互面板消失了 —— 选中态没跟着迁走',
    ).toBeVisible()
    await expect(page.locator('[class*="hotspotItem"]').filter({ hasText: 'hs_room_renamed' })).toBeVisible()
  })
})
