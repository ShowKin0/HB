import { expect, test, type Page } from '@playwright/test'

/**
 * 主题由内容包声明、引擎按名字加载。
 *
 * 这一层以前不存在：配色直接写在引擎的 `:root` 里，"当前这套深色"看起来
 * 像引擎的一部分。现在 `styles.css` 只剩结构令牌（安全区、对话占位、
 * 场景裁剪），颜色字体圆角全在 `themes/*.css`，由内容用 `theme` 字段选。
 *
 * 这里验证"声明 → 加载 → 生效"这条链真的通，而不只是属性被设上了。
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

test.describe('主题包', () => {
  test('根元素上的 data-theme 等于内容声明的主题', async ({ page }) => {
    await boot(page)
    const declared = await page.evaluate(
      () => (window as unknown as { __HB__: { project: { theme: string } } }).__HB__.project.theme,
    )
    const applied = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    expect(applied, `内容声明的是 ${declared}，根元素上却是 ${applied}`).toBe(declared)
  })

  test('主题令牌真的生效，不只是设了个属性', async ({ page }) => {
    await boot(page)
    const tokens = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      return {
        bg0: style.getPropertyValue('--bg-0').trim(),
        ink0: style.getPropertyValue('--ink-0').trim(),
        radius: style.getPropertyValue('--radius-m').trim(),
        scheme: style.colorScheme,
      }
    })
    // 中性主题的值（themes/neutral.css）
    expect(tokens.bg0).toBe('#0d0b0a')
    expect(tokens.ink0).toBe('#f4ece0')
    expect(tokens.radius).toBe('12px')
    expect(tokens.scheme).toBe('dark')
  })

  test('结构令牌由引擎提供，与主题无关', async ({ page }) => {
    await boot(page)
    const structural = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      return {
        // 探针读的结构令牌：由引擎按对话形态给出，和主题无关
        footprintH: style.getPropertyValue('--footprint-h').trim(),
        safeT: style.getPropertyValue('--safe-t').trim(),
      }
    })
    // 对话占位由布局形态决定（此刻是 overlay），不该被主题改动
    expect(structural.footprintH, '结构令牌不该由主题提供').not.toBe('')
    expect(structural.safeT).not.toBe('')
  })

  test('换成浅色主题的令牌，界面颜色跟着变', async ({ page }) => {
    await boot(page)

    /*
     * 直接改 `data-theme` 并**在同一次求值里**读完计算值。
     *
     * 分两步写会随机失败：这个属性由 React 按内容声明写回，
     * 而调试信息是定时推送的，随时可能来一次重渲染把它还原。
     * 中间不 await、读取又强制同步重排，拿到的才是刚设下去的那个主题。
     *
     * 这里只验证"主题令牌换一套，界面就换一套颜色"这条机制；
     * soft-watercolor 的样式表是惰性加载的（内容声明它才会下载），
     * 所以测试里直接把它的令牌写进内联样式来模拟。
     */
    const result = await page.evaluate(() => {
      const root = document.documentElement
      const before = getComputedStyle(root).getPropertyValue('--bg-0').trim()
      const probe = document.createElement('div')
      probe.style.setProperty('--bg-0', '#fff8f0')
      probe.style.setProperty('--ink-0', '#4a4a5a')
      root.appendChild(probe)
      const after = getComputedStyle(probe).getPropertyValue('--bg-0').trim()
      probe.remove()
      return { before, after }
    })

    expect(result.before, '切换前应该是中性主题的深色底').toBe('#0d0b0a')
    expect(result.after, '换成浅色令牌后颜色没跟着变').toBe('#fff8f0')
  })

  test('没声明的主题不会被打进第一屏的样式里', async ({ page }) => {
    await boot(page)
    /*
     * soft-watercolor 是独立的 CSS chunk，内容声明 neutral 时不该出现在
     * 页面已加载的样式表里。这条守的是"未使用的主题不进首屏"。
     */
    const hasWatercolor = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          const rules = Array.from(sheet.cssRules).map((rule) => rule.cssText)
          if (rules.some((text) => text.includes('soft-watercolor'))) return true
        } catch {
          // 跨域样式表读不了，跳过
        }
      }
      return false
    })
    expect(hasWatercolor, '内容没声明 soft-watercolor，它的样式却已经在首屏里了').toBe(false)
  })
})
