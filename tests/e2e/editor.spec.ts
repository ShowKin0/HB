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

  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(box!.x + 90, box!.y - 60, { steps: 10 })
  await page.mouse.up()

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
