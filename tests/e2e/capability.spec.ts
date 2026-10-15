import { expect, test, type Page } from '@playwright/test'

/**
 * 能力状态的**完整往返**：写 → 存档 → 重新打开 → 读回来。
 *
 * 单元测试只能验证净化与迁移；"真的进了 localStorage、真的能读回来"
 * 必须跑一遍真浏览器。而且这一类字段最容易出的问题就是"写了但没进存档"——
 * 单测完全看不出来。
 */

async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(
    () => Boolean((window as unknown as { __HB__?: { sceneRuntime?: unknown } }).__HB__?.sceneRuntime),
    null,
    { timeout: 30_000 },
  )
}

interface Handle {
  getCapabilityState<T = unknown>(ns: string): T | null
  setCapabilityState(ns: string, value: unknown): boolean
  capabilityNamespaces: string[]
  flushAutosave(): void
}

test.describe('能力状态往返', () => {
  test('写进去的状态经过一次重新打开还在', async ({ page }) => {
    await boot(page)

    const ok = await page.evaluate(() => {
      const game = (window as unknown as { __HB__: Handle }).__HB__
      return game.setCapabilityState('affection', { score: 7, seen: ['a', 'b'] })
    })
    expect(ok, '写法本身被拒了').toBe(true)

    // 立即落盘（正常流程里由 pagehide / 定时自动存档触发）
    await page.evaluate(() => (window as unknown as { __HB__: Handle }).__HB__.flushAutosave())

    await boot(page)
    const restored = await page.evaluate(() =>
      (window as unknown as { __HB__: Handle }).__HB__.getCapabilityState('affection'),
    )
    expect(restored, '重新打开之后扩展状态没了 —— 说明它根本没进存档').toEqual({
      score: 7,
      seen: ['a', 'b'],
    })
  })

  test('引擎不解释内容：形状完全由能力自己决定', async ({ page }) => {
    await boot(page)

    // 三种完全不同的形状，引擎都该原样保存
    await page.evaluate(() => {
      const game = (window as unknown as { __HB__: Handle }).__HB__
      game.setCapabilityState('affection', 12)
      game.setCapabilityState('album', ['photo1', 'photo2'])
      game.setCapabilityState('calendar', { days: { '10-14': '生日' } })
    })
    await page.evaluate(() => (window as unknown as { __HB__: Handle }).__HB__.flushAutosave())
    await boot(page)

    const all = await page.evaluate(() => {
      const game = (window as unknown as { __HB__: Handle }).__HB__
      return {
        affection: game.getCapabilityState('affection'),
        album: game.getCapabilityState('album'),
        calendar: game.getCapabilityState('calendar'),
        namespaces: game.capabilityNamespaces,
      }
    })
    expect(all.affection).toBe(12)
    expect(all.album).toEqual(['photo1', 'photo2'])
    expect(all.calendar).toEqual({ days: { '10-14': '生日' } })
    expect(all.namespaces).toEqual(['affection', 'album', 'calendar'])
  })

  test('没写过的命名空间返回 null，不抛错', async ({ page }) => {
    await boot(page)
    const missing = await page.evaluate(() =>
      (window as unknown as { __HB__: Handle }).__HB__.getCapabilityState('never-used'),
    )
    expect(missing).toBeNull()
  })

  test('函数之类不能序列化的值当场被拒，而不是等到存档那一刻才炸', async ({ page }) => {
    await boot(page)
    const result = await page.evaluate(() => {
      const game = (window as unknown as { __HB__: Handle }).__HB__
      return {
        fn: game.setCapabilityState('bad', () => undefined),
        nan: game.setCapabilityState('nan', Number.NaN),
        empty: game.setCapabilityState('', { v: 1 }),
        stored: game.getCapabilityState('bad'),
      }
    })
    expect(result.fn).toBe(false)
    expect(result.nan).toBe(false)
    expect(result.empty).toBe(false)
    expect(result.stored).toBeNull()
  })

  test('传 null 删掉命名空间', async ({ page }) => {
    await boot(page)
    const after = await page.evaluate(() => {
      const game = (window as unknown as { __HB__: Handle }).__HB__
      game.setCapabilityState('temp', { v: 1 })
      const before = game.capabilityNamespaces
      game.setCapabilityState('temp', null)
      return { before, after: game.capabilityNamespaces }
    })
    expect(after.before).toContain('temp')
    expect(after.after).not.toContain('temp')
  })

  test('扩展状态坏掉时，存档主体照样能读回来', async ({ page }) => {
    await boot(page)
    await page.evaluate(() => (window as unknown as { __HB__: Handle }).__HB__.flushAutosave())

    /*
     * 必须用 addInitScript 在**新页面启动之前**改存档。
     *
     * 直接改完再 goto 是不行的：离开旧页面时 pagehide 会先把一份正确的
     * 自动存档写回去，把刚改坏的内容覆盖掉 —— 这个坑前面在 contentVersion
     * 的用例上已经踩过一次。
     */
    await page.addInitScript(() => {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith('hb.')) continue
        try {
          const raw = JSON.parse(localStorage.getItem(key)!)
          if (raw?.state?.engine) {
            raw.state.engine.capabilities = 'nonsense'
            localStorage.setItem(key, JSON.stringify(raw))
          }
        } catch {
          // 不是 JSON 就跳过
        }
      }
    })

    await page.reload()
    await page.waitForFunction(
      () => Boolean((window as unknown as { __HB__?: { sceneRuntime?: unknown } }).__HB__?.sceneRuntime),
      null,
      { timeout: 30_000 },
    )

    const game = await page.evaluate(() =>
      (window as unknown as { __HB__: Handle }).__HB__.capabilityNamespaces,
    )
    expect(game, '坏掉的扩展状态应该被降级成空，而不是让读档失败').toEqual([])
  })
})
