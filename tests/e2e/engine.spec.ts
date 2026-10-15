import { expect, test, type Page } from '@playwright/test'

/**
 * P0 / P1 底座验证。
 *
 *   P0 运行时可靠性：会话隔离、任务取消、检查点还原、暂停原因
 *   P1 手机交互：长按、一次手势一个结果、手势取消
 *
 * 这些是"通用引擎"的地基 —— 剧情、画风、玩法都还没定，但地基必须先可靠。
 */

async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(
    () => Boolean((window as unknown as { __HB__?: { sceneRuntime?: unknown } }).__HB__?.sceneRuntime),
    null,
    { timeout: 30_000 },
  )
  await page.locator('text=正在准备').waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => undefined)
  await dismissDialogue(page)
}

async function dismissDialogue(page: Page, maxClicks = 8): Promise<void> {
  const viewport = page.viewportSize()!
  for (let i = 0; i < maxClicks; i++) {
    if ((await page.locator('[role="log"]').count()) === 0) return
    await page.mouse.click(viewport.width / 2, viewport.height / 2)
    await page.waitForTimeout(220)
  }
}

/**
 * 点某个物件：**位置问引擎要**，不写死场景坐标。
 *
 * 写死坐标这件事在这次会话里已经翻车三次了：改 sceneFit、改布局形态、
 * 把热点收进安全区，每一次都让一批用例静默点空。热点在哪是内容的事，
 * 用例只需要知道"我要点书架"。
 */
async function clickHotspot(page: Page, id: string, dismissFirst = true): Promise<void> {
  if (dismissFirst) await dismissDialogue(page)
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
  await page.mouse.click(point.x, point.y)
}

async function screenOfScene(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([sx, sy]) => {
      const game = (window as unknown as {
        __HB__: { viewport: { x: number; y: number; w: number; h: number } }
      }).__HB__
      return {
        x: game.viewport.x + (sx as number) * game.viewport.w,
        y: game.viewport.y + (sy as number) * game.viewport.h,
      }
    },
    [x, y],
  )
}

async function gotoScene(page: Page, sceneId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const game = (window as unknown as { __HB__: { debugGotoScene(id: string): Promise<void> } }).__HB__
    await game.debugGotoScene(id)
  }, sceneId)
  await page.waitForTimeout(150)
  await dismissDialogue(page)
}

test.describe('P1 长按', () => {
  test('按住不放触发 hold 分支，而不是 inspect 分支', async ({ page }) => {
    await boot(page)
    await gotoScene(page, 'hall')

    const mark = await screenOfScene(page, 0.5, 0.42)
    await page.mouse.move(mark.x, mark.y)
    await page.mouse.down()
    // 超过默认 500ms 的长按阈值
    await page.waitForTimeout(750)
    await page.mouse.up()

    await expect(page.locator('[role="log"]')).toContainText('量着长高', { timeout: 25_000 })
  })

  test('点一下仍然走 inspect 分支', async ({ page }) => {
    await boot(page)
    await gotoScene(page, 'hall')

    await clickHotspot(page, 'hs_mark')

    await expect(page.locator('[role="log"]')).toContainText('量过身高', { timeout: 25_000 })
    // 不能同时触发长按分支
    await expect(page.locator('[role="log"]')).not.toContainText('量着长高')
  })

  test('按住不到阈值就松开，仍然是点击', async ({ page }) => {
    await boot(page)
    await gotoScene(page, 'hall')

    const mark = await screenOfScene(page, 0.5, 0.42)
    await page.mouse.move(mark.x, mark.y)
    await page.mouse.down()
    await page.waitForTimeout(120)
    await page.mouse.up()

    await expect(page.locator('[role="log"]')).toContainText('量过身高', { timeout: 25_000 })
  })

  test('按住后移开阈值不会降级成拖动（一次手势只有一个结果）', async ({ page }) => {
    await boot(page)
    await gotoScene(page, 'hall')

    const mark = await screenOfScene(page, 0.5, 0.42)
    await page.mouse.move(mark.x, mark.y)
    await page.mouse.down()
    await page.waitForTimeout(750)
    // 长按已经触发，此时再拖动不该产生拖放结果
    await page.mouse.move(mark.x + 120, mark.y + 80, { steps: 6 })
    await page.mouse.up()

    await expect(page.locator('[role="log"]')).toContainText('量着长高', { timeout: 25_000 })
  })
})

test.describe('P0 会话隔离', () => {
  test('重开会作废在飞的推进，不会被旧任务写回来', async ({ page }) => {
    await boot(page)

    // 起一个 # wait: 挂起的推进（小游戏演示里有，这里直接用 wait 指令的内容路径）
    await page.evaluate(() => {
      const game = (window as unknown as { __HB__: { debugRunKnot(k: string): void } }).__HB__
      game.debugRunKnot('demo_minigame')
    })
    await page.waitForTimeout(300)

    // 不等它跑完，直接重开
    const restarted = await page.evaluate(async () => {
      const game = (window as unknown as {
        __HB__: {
          start(save: null): Promise<void>
          sceneRuntime: { scene: { id: string } }
          engineState: { sceneId: string | null }
        }
      }).__HB__
      await game.start(null)
      return { sceneId: game.sceneRuntime.scene.id }
    })
    expect(restarted.sceneId).toBe('start')

    // 旧的小游戏/等待不该在重开之后把状态改回去
    await page.waitForTimeout(1500)
    const after = await page.evaluate(
      () => (window as unknown as { __HB__: { sceneRuntime: { scene: { id: string } } } }).__HB__.sceneRuntime.scene.id,
    )
    expect(after).toBe('start')
  })

  test('重开清掉上一局的场景状态，不会串进新会话', async ({ page }) => {
    await boot(page)

    await page.evaluate(() => {
      const game = (window as unknown as {
        __HB__: { sceneRuntime: { patchObjectState(id: string, p: unknown): void } }
      }).__HB__
      game.sceneRuntime.patchObjectState('hs_door', { state: 'unlocked' })
    })

    await page.evaluate(async () => {
      const game = (window as unknown as { __HB__: { start(save: null): Promise<void> } }).__HB__
      await game.start(null)
    })
    await page.waitForTimeout(300)

    const state = await page.evaluate(() => {
      const game = (window as unknown as {
        __HB__: { sceneRuntime: { objectState(id: string): { state: string | null } | null } }
      }).__HB__
      return game.sceneRuntime.objectState('hs_door')
    })
    expect(state?.state).toBe('locked')
  })
})

test.describe('P0 呈现检查点', () => {
  test('存档时台词还挂着，读档回来台词仍在等玩家点', async ({ page }) => {
    await boot(page)

    // 触发一句台词，但**不点掉它**，直接存档
    await clickHotspot(page, 'hs_shelf')
    await expect(page.locator('[role="log"]')).toBeVisible({ timeout: 25_000 })
    const textBefore = await page.locator('[role="log"]').textContent()

    await page.evaluate(() => {
      const game = (window as unknown as { __HB__: { flushAutosave(): void } }).__HB__
      game.flushAutosave()
    })

    await page.reload()
    await page.waitForFunction(
      () => Boolean((window as unknown as { __HB__?: { sceneRuntime?: unknown } }).__HB__?.sceneRuntime),
      null,
      { timeout: 30_000 },
    )

    // 关键：台词必须原样回来，而不是停在一句都没有的空画面
    const log = page.locator('[role="log"]')
    await expect(log).toBeVisible({ timeout: 15_000 })
    expect(await log.textContent()).toBe(textBefore)

    // 而且它确实在等玩家推进
    const awaiting = await page.evaluate(
      () => (window as unknown as { __HB__: { awaitingAdvance: boolean } }).__HB__.awaitingAdvance,
    )
    expect(awaiting).toBe(true)
  })

  test('台词被点掉之后存档，读档不该再冒出来', async ({ page }) => {
    await boot(page)

    await clickHotspot(page, 'hs_shelf')
    await expect(page.locator('[role="log"]')).toBeVisible({ timeout: 25_000 })
    await dismissDialogue(page)

    await page.evaluate(() => {
      const game = (window as unknown as { __HB__: { flushAutosave(): void } }).__HB__
      game.flushAutosave()
    })
    await page.reload()
    await page.waitForFunction(
      () => Boolean((window as unknown as { __HB__?: { sceneRuntime?: unknown } }).__HB__?.sceneRuntime),
      null,
      { timeout: 30_000 },
    )

    await expect(page.locator('[role="log"]')).toHaveCount(0)
  })
})

test.describe('P1 视口变化', () => {
  test('转屏会取消未完成的手势，且不产生成功结果', async ({ page }) => {
    await boot(page)
    await gotoScene(page, 'hall')

    const mark = await screenOfScene(page, 0.5, 0.42)
    await page.mouse.move(mark.x, mark.y)
    await page.mouse.down()

    // 手指还按着时转屏
    await page.evaluate(() => {
      window.dispatchEvent(new Event('orientationchange'))
    })

    const state = await page.evaluate(() => {
      const game = (window as unknown as {
        __HB__: { interactionState: { pressedId: string | null; dragArmed: string | null } }
      }).__HB__
      return game.interactionState
    })
    expect(state.pressedId).toBeNull()
    expect(state.dragArmed).toBeNull()

    // 抬起不该触发任何剧情 —— 转屏已经把这次手势作废了
    await page.mouse.up()
    await page.waitForTimeout(500)
    await expect(page.locator('[role="log"]')).toHaveCount(0)
  })

  test('视口变化后场景仍然可交互（已提交状态保留）', async ({ page }) => {
    await boot(page)
    await gotoScene(page, 'hall')

    await page.evaluate(() => {
      window.dispatchEvent(new Event('orientationchange'))
    })
    await page.waitForTimeout(300)

    await clickHotspot(page, 'hs_mark')
    await expect(page.locator('[role="log"]')).toContainText('量过身高', { timeout: 25_000 })
  })
})

test.describe('P2 纯物件交互（不写 Ink）', () => {
  test('点壁灯直接改物件状态，不跳剧情、不出对话框', async ({ page }) => {
    await boot(page)
    await gotoScene(page, 'hall')

    const before = await page.evaluate(() => {
      const game = (window as unknown as {
        __HB__: { sceneRuntime: { objectState(id: string): { state: string | null } | null } }
      }).__HB__
      return game.sceneRuntime.objectState('hs_lamp')?.state ?? null
    })
    expect(before).toBe('off')

    // 位置问引擎要：热点在哪是内容的事，写死坐标会被安全区调整打空
    await clickHotspot(page, 'hs_lamp')
    await page.waitForTimeout(400)

    // 状态变了 —— 这条交互有实际效果
    const after = await page.evaluate(() => {
      const game = (window as unknown as {
        __HB__: { sceneRuntime: { objectState(id: string): { state: string | null } | null } }
      }).__HB__
      return game.sceneRuntime.objectState('hs_lamp')?.state ?? null
    })
    expect(after).toBe('on')

    // 而且**完全没有碰剧情**：没有对话框，ink 也没被跳转
    await expect(page.locator('[role="log"]')).toHaveCount(0)

    // 事件桥照常工作，事件名来自 story.event 动作
    const lastEvent = await page.evaluate(
      () => (window as unknown as { __HB__: { ink: { variable(n: string): unknown } } }).__HB__.ink.variable('last_event'),
    )
    expect(lastEvent).toBe('lamp_lit')
  })

  test('纯物件交互的状态进存档，读档后保持', async ({ page }) => {
    await boot(page)
    await gotoScene(page, 'hall')

    // 位置问引擎要：热点在哪是内容的事，写死坐标会被安全区调整打空
    await clickHotspot(page, 'hs_lamp')
    await page.waitForTimeout(400)

    await page.evaluate(() => {
      const game = (window as unknown as { __HB__: { flushAutosave(): void } }).__HB__
      game.flushAutosave()
    })
    await page.reload()
    await page.waitForFunction(
      () => Boolean((window as unknown as { __HB__?: { sceneRuntime?: unknown } }).__HB__?.sceneRuntime),
      null,
      { timeout: 30_000 },
    )

    const state = await page.evaluate(() => {
      const game = (window as unknown as {
        __HB__: { sceneRuntime: { objectState(id: string): { state: string | null } | null } }
      }).__HB__
      return game.sceneRuntime.objectState('hs_lamp')?.state ?? null
    })
    expect(state).toBe('on')
  })
})

test.describe('R5 画质上限真的生效', () => {
  test('project.json 的 mobile.maxDpr 被读进引擎，并决定画布后备尺寸', async ({ page }) => {
    await boot(page)

    const info = await page.evaluate(() => {
      const game = (window as unknown as { __HB__: { renderDprLimit: number } }).__HB__
      const canvas = document.querySelector('canvas')!
      const rect = canvas.getBoundingClientRect()
      return {
        limit: game.renderDprLimit,
        backingWidth: canvas.width,
        backingHeight: canvas.height,
        cssWidth: rect.width,
        cssHeight: rect.height,
        devicePixelRatio: window.devicePixelRatio,
      }
    })

    // 清单里写的是 2，引擎必须报 2（而不是构造时的默认值碰巧等于 2）
    expect(info.limit).toBe(2)

    /*
     * 后备尺寸 = CSS 尺寸 × min(maxDpr, devicePixelRatio)。
     * iPhone 14 的 DPR 是 3，被上限压到 2 —— 这正是 maxDpr 的意义：
     * 3 倍 DPR 的画面收益很小，内存代价却是 2.25 倍。
     */
    const effective = Math.min(info.limit, info.devicePixelRatio)
    expect(info.backingWidth).toBe(Math.round(info.cssWidth * effective))
    expect(info.backingHeight).toBe(Math.round(info.cssHeight * effective))
    /*
     * 只有设备的 DPR 高于上限时，maxDpr 才真的起作用。
     * iPhone 14 的 DPR 是 3、上限是 2，这里能测出压制；
     * 桌面 DPR 是 1，上限根本不参与 —— 那种情况下不该假装测到了。
     */
    if (info.devicePixelRatio > info.limit) {
      expect(effective, 'DPR 高于上限时应该被压住').toBeLessThan(info.devicePixelRatio)
      expect(effective).toBe(info.limit)
    } else {
      expect(effective).toBe(info.devicePixelRatio)
    }
  })
})

test.describe('P0 暂停原因', () => {
  test('打开面板会暂停模拟，关闭后恢复', async ({ page }) => {
    await boot(page)

    const readPause = (): Promise<{ paused: boolean; reasons: string[] }> =>
      page.evaluate(() => {
        const game = (window as unknown as {
          __HB__: { paused: boolean; pauseState: string[] }
        }).__HB__
        return { paused: game.paused, reasons: game.pauseState }
      })

    expect((await readPause()).paused).toBe(false)

    await page.getByRole('button', { name: '存档' }).click()
    await expect.poll(async () => (await readPause()).paused, { timeout: 5000 }).toBe(true)
    expect((await readPause()).reasons).toContain('panel')

    // 关掉面板
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await readPause()).paused, { timeout: 5000 }).toBe(false)
  })

  test('面板打开时点画布不会触发场景交互', async ({ page }) => {
    await boot(page)
    await page.getByRole('button', { name: '存档' }).click()
    await page.waitForTimeout(300)

    const before = await page.evaluate(
      () => (window as unknown as { __HB__: { ink: { variable(n: string): unknown } } }).__HB__.ink.variable('last_event'),
    )
    await clickHotspot(page, 'hs_shelf')
    await page.waitForTimeout(300)

    const after = await page.evaluate(
      () => (window as unknown as { __HB__: { ink: { variable(n: string): unknown } } }).__HB__.ink.variable('last_event'),
    )
    expect(after).toBe(before)
  })
})
