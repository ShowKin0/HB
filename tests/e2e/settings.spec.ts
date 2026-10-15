import { expect, test, type Page } from '@playwright/test'

/**
 * 持久化的设置也必须当成**不可信的外部数据**。
 *
 * 存档那边做得很严谨（逐字段校验、坏条目只丢自己），但 zustand 的
 * `persist` 默认是把 localStorage 里的东西**浅合并**进初始状态 ——
 * 没有任何校验。localStorage 会被旧版本的应用、别的标签页、
 * 或者手动改过的东西污染。
 *
 * 一个 `master: null` 就足够让音量滑杆变成受控/非受控混用，
 * 或者让 `Howler.volume(NaN)` 把整条音频链路搞哑。
 */

async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(
    () => Boolean((window as unknown as { __HB__?: { sceneRuntime?: unknown } }).__HB__?.sceneRuntime),
    null,
    { timeout: 30_000 },
  )
}

const readAudio = (page: Page): Promise<Record<string, unknown>> =>
  page.evaluate(
    () => (window as unknown as { __HB__: { audioSettings: Record<string, unknown> } }).__HB__.audioSettings,
  )

/** 预置一份被污染的 hb.audio，再启动。 */
async function bootWithStoredAudio(page: Page, stored: unknown): Promise<string[]> {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript((value) => {
    localStorage.setItem('hb.audio', JSON.stringify(value))
  }, stored)
  await boot(page)
  return errors
}

test.describe('被污染的音量设置', () => {
  test('master 是字符串时被纠正成数字，而不是原样透传', async ({ page }) => {
    await bootWithStoredAudio(page, { state: { audio: { master: 'loud', bgm: 0.5, sfx: 0.5 } }, version: 0 })
    const audio = await readAudio(page)
    expect(typeof audio.master, 'master 必须是数字').toBe('number')
    expect(Number.isFinite(audio.master as number)).toBe(true)
    // 非法值回落到默认，而不是被原样透传
    expect(audio.master).toBe(0.9)
  })

  test('字段缺失时按默认值补齐', async ({ page }) => {
    await bootWithStoredAudio(page, { state: { audio: { master: 0.3 } }, version: 0 })
    const audio = await readAudio(page)
    expect(audio.master).toBe(0.3)
    expect(typeof audio.bgm).toBe('number')
    expect(typeof audio.sfx).toBe('number')
    expect(typeof audio.muted).toBe('boolean')
  })

  test('数值越界会被夹回 0..1', async ({ page }) => {
    await bootWithStoredAudio(page, { state: { audio: { master: 99, bgm: -5, sfx: 0.5 } }, version: 0 })
    const audio = await readAudio(page)
    expect(audio.master).toBeLessThanOrEqual(1)
    expect(audio.bgm).toBeGreaterThanOrEqual(0)
  })

  test('整份数据是垃圾时不崩，且回落到默认值', async ({ page }) => {
    const errors = await bootWithStoredAudio(page, { state: { audio: 'not an object' }, version: 0 })
    const audio = await readAudio(page)
    expect(typeof audio.master).toBe('number')
    expect(errors, `启动时报错了：${errors.join(' / ')}`).toHaveLength(0)
  })

  test('localStorage 里根本不是合法 JSON 时也不崩', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(() => {
      localStorage.setItem('hb.audio', '{ 这不是 JSON')
    })
    await boot(page)

    const audio = await readAudio(page)
    expect(typeof audio.master).toBe('number')
    expect(errors, `启动时报错了：${errors.join(' / ')}`).toHaveLength(0)
  })

  test('带着污染设置也能正常打开设置面板', async ({ page }) => {
    await bootWithStoredAudio(page, { state: { audio: { master: null, bgm: 'x', sfx: [] } }, version: 0 })

    await page.getByRole('button', { name: '设置' }).click()
    const panel = page.getByRole('dialog').or(page.locator('[class*="panel"]').first())
    await expect(panel).toBeVisible({ timeout: 10_000 })

    // 滑杆必须拿到合法数值
    const values = await page.locator('input[type="range"]').evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLInputElement).value),
    )
    for (const value of values) {
      expect(Number.isFinite(Number(value)), `滑杆拿到了非法值 "${value}"`).toBe(true)
    }
  })
})
