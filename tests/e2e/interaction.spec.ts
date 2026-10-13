import { expect, test, type Page } from '@playwright/test'

/**
 * 交互层端到端验证。
 *
 * 对应这次架构升级的几件事：
 *   - 场景模式（walk / focus）
 *   - 物件空间状态（抽屉开着没有、相框切没切状态）
 *   - 事件桥（交互 → 事件 → ink 的 last_event）
 *   - 拖放（把物品拖到目标上）
 *
 * 这些测试只验证**引擎能力**，不绑定任何具体剧情 ——
 * 剧情是你会不断替换的东西。
 */

interface ObjectStateView {
  visible: boolean
  state: string | null
  progress: number
}

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

/** 场景空间坐标 → 页面坐标。 */
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

/** 读场景与物件状态。 */
async function sceneState(
  page: Page,
  objectIds: string[],
): Promise<{ sceneId: string; mode: string; actorCount: number; objects: Record<string, ObjectStateView | null> }> {
  return page.evaluate((ids) => {
    const game = (window as unknown as {
      __HB__: {
        sceneRuntime: {
          scene: { id: string }
          mode: string
          actors: unknown[]
          objectState(id: string): ObjectStateView | null
        }
      }
    }).__HB__
    const objects: Record<string, ObjectStateView | null> = {}
    for (const id of ids) objects[id] = game.sceneRuntime.objectState(id)
    return {
      sceneId: game.sceneRuntime.scene.id,
      mode: game.sceneRuntime.mode,
      actorCount: game.sceneRuntime.actors.length,
      objects,
    }
  }, objectIds)
}

/** 读 ink 变量。事件桥会把 last_event 写进去。 */
async function inkVariable(page: Page, name: string): Promise<unknown> {
  return page.evaluate((key) => {
    const game = (window as unknown as { __HB__: { ink: { variable(n: string): unknown } } }).__HB__
    return game.ink.variable(key)
  }, name)
}

/** 点一个物件并推进掉它触发的台词。 */
async function clickObject(page: Page, x: number, y: number): Promise<void> {
  const point = await screenOfScene(page, x, y)
  await page.mouse.click(point.x, point.y)
  await page.waitForTimeout(300)
  await dismissDialogue(page)
}

test.describe('场景模式', () => {
  test('walk 场景有地面和角色，focus 场景两者都没有', async ({ page }) => {
    await boot(page)

    const walk = await sceneState(page, [])
    expect(walk.sceneId).toBe('start')
    expect(walk.mode).toBe('walk')
    expect(walk.actorCount).toBe(1)

    await gotoScene(page, 'memory_table')
    const focus = await sceneState(page, [])
    expect(focus.sceneId).toBe('memory_table')
    expect(focus.mode).toBe('focus')
    // focus 模式不做寻路，所以没有角色 —— 这是 schema 强制的，不是巧合
    expect(focus.actorCount).toBe(0)
  })

  test('focus 场景里点空白处不会走路，也不会报错', async ({ page }) => {
    await boot(page)
    await gotoScene(page, 'memory_table')

    const point = await screenOfScene(page, 0.5, 0.9)
    await page.mouse.click(point.x, point.y)
    await page.waitForTimeout(300)

    // 没有角色可走，画面应当保持原状
    const state = await sceneState(page, [])
    expect(state.actorCount).toBe(0)
  })
})

test.describe('物件空间状态', () => {
  test('用物品点门会把门切到 unlocked', async ({ page }) => {
    await boot(page)

    const before = await sceneState(page, ['hs_door'])
    expect(before.objects.hs_door?.state).toBe('locked')

    // 先拿到钥匙
    await page.evaluate(() => {
      const game = (window as unknown as { __HB__: { debugRunKnot(k: string): void } }).__HB__
      game.debugRunKnot('take_key')
    })
    await page.waitForTimeout(300)
    await dismissDialogue(page)

    // 传统点击式冒险的流程：先在物品栏里选中，再点目标
    await page.evaluate(() => {
      const game = (window as unknown as { __HB__: { setSelectedItem(id: string | null): void } }).__HB__
      game.setSelectedItem('item_key')
    })

    const door = await screenOfScene(page, 0.83, 0.4)
    await page.mouse.click(door.x, door.y)

    // 门有走位点，角色要先走过去才触发，所以用轮询而不是固定等待
    await expect
      .poll(async () => (await sceneState(page, ['hs_door'])).objects.hs_door?.state, { timeout: 20_000 })
      .toBe('unlocked')
    await dismissDialogue(page)
  })

  test('物件状态会被存档带走（刷新后还原）', async ({ page }) => {
    await boot(page)

    // 直接改状态再强制存档，避免依赖剧情顺序
    await page.evaluate(() => {
      const game = (window as unknown as {
        __HB__: { sceneRuntime: { patchObjectState(id: string, p: unknown): void }; flushAutosave(): void }
      }).__HB__
      game.sceneRuntime.patchObjectState('hs_door', { state: 'unlocked' })
      game.flushAutosave()
    })

    await page.reload()
    await page.waitForFunction(
      () => Boolean((window as unknown as { __HB__?: { sceneRuntime?: unknown } }).__HB__?.sceneRuntime),
      null,
      { timeout: 30_000 },
    )
    await dismissDialogue(page)

    const state = await sceneState(page, ['hs_door'])
    expect(state.objects.hs_door?.state).toBe('unlocked')
  })

  test('物件可以被隐藏，隐藏后点不到', async ({ page }) => {
    await boot(page)

    await page.evaluate(() => {
      const game = (window as unknown as {
        __HB__: { sceneRuntime: { patchObjectState(id: string, p: unknown): void } }
      }).__HB__
      game.sceneRuntime.patchObjectState('hs_window', { visible: false })
    })

    const hidden = await sceneState(page, ['hs_window'])
    expect(hidden.objects.hs_window?.visible).toBe(false)

    // 点它原来的位置：应当落到地面走路，而不是触发窗户的剧情
    const point = await screenOfScene(page, 0.5, 0.19)
    await page.mouse.click(point.x, point.y)
    await page.waitForTimeout(300)

    const hasDialogue = (await page.locator('[role="log"]').count()) > 0
    expect(hasDialogue).toBe(false)
  })

  test('离开场景再回来，物件状态还在', async ({ page }) => {
    await boot(page)

    await page.evaluate(() => {
      const game = (window as unknown as {
        __HB__: { sceneRuntime: { patchObjectState(id: string, p: unknown): void } }
      }).__HB__
      game.sceneRuntime.patchObjectState('hs_door', { state: 'unlocked' })
    })

    // 曾经漏过：snapshotEngine 合并出 scenes 却从不写回 engine，
    // 于是换场景时旧 runtime 一丢，状态就没了（只有刷新页面才靠存档恢复）。
    await gotoScene(page, 'hall')
    await gotoScene(page, 'start')

    const state = await sceneState(page, ['hs_door'])
    expect(state.objects.hs_door?.state).toBe('unlocked')
  })

  test('同名角色在不同场景里不会互相串位', async ({ page }) => {
    await boot(page)

    // 把 start 的 hero 挪到一个明显的位置
    await page.evaluate(() => {
      const game = (window as unknown as {
        __HB__: {
          sceneRuntime: { actors: { u: number; v: number }[] }
          flushAutosave(): void
        }
      }).__HB__
      game.sceneRuntime.actors[0].u = 0.2
      game.sceneRuntime.actors[0].v = 0.95
      game.flushAutosave()
    })

    await gotoScene(page, 'hall')
    const position = await page.evaluate(() => {
      const game = (window as unknown as { __HB__: { sceneRuntime: { actors: { u: number; v: number }[] } } }).__HB__
      return { u: game.sceneRuntime.actors[0].u, v: game.sceneRuntime.actors[0].v }
    })

    // hall 的 hero 出生点是 [0.5, 0.8]，不该被 start 里那个 hero 的位置顶掉
    expect(position.u).toBeCloseTo(0.5, 1)
    expect(position.v).toBeCloseTo(0.8, 1)
  })
})

test.describe('事件桥', () => {
  test('交互会更新 ink 的 last_event', async ({ page }) => {
    await boot(page)

    const initial = await inkVariable(page, 'last_event')
    expect(initial).toBe('')

    // hs_shelf 的交互声明了 emit: shelf_searched
    await clickObject(page, 0.135, 0.41)

    const after = await inkVariable(page, 'last_event')
    expect(after).toBe('shelf_searched')
  })

  test('没写 emit 的交互用 id_verb 推导事件名', async ({ page }) => {
    await boot(page)
    // hs_window 的交互没有 emit，事件名应当是 hs_window_inspect
    await clickObject(page, 0.5, 0.19)
    expect(await inkVariable(page, 'last_event')).toBe('hs_window_inspect')
  })
})

test.describe('拖放', () => {
  test('把钥匙拖到门上也能开门（不只是点击）', async ({ page }) => {
    await boot(page)

    // 先拿到钥匙
    await page.evaluate(() => {
      const game = (window as unknown as { __HB__: { debugRunKnot(k: string): void } }).__HB__
      game.debugRunKnot('take_key')
    })
    await page.waitForTimeout(300)
    await dismissDialogue(page)

    // 选中钥匙
    await page.evaluate(() => {
      const game = (window as unknown as { __HB__: { setSelectedItem(id: string | null): void } }).__HB__
      game.setSelectedItem('item_key')
    })

    const from = await screenOfScene(page, 0.83, 0.45)
    const to = await screenOfScene(page, 0.83, 0.4)

    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    // 拖拽要靠 pointermove 越过阈值才成立，所以分几步移动
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 })
    await page.mouse.move(to.x, to.y, { steps: 5 })
    await page.mouse.up()
    await page.waitForTimeout(400)
    await dismissDialogue(page)

    const state = await sceneState(page, ['hs_door'])
    expect(state.objects.hs_door?.state).toBe('unlocked')
  })

  test('拖到不接受该物品的目标上不会触发', async ({ page }) => {
    await boot(page)

    await page.evaluate(() => {
      const game = (window as unknown as {
        __HB__: { debugRunKnot(k: string): void; setSelectedItem(id: string | null): void }
      }).__HB__
      game.debugRunKnot('take_key')
    })
    await page.waitForTimeout(300)
    await dismissDialogue(page)

    await page.evaluate(() => {
      const game = (window as unknown as { __HB__: { setSelectedItem(id: string | null): void } }).__HB__
      game.setSelectedItem('item_key')
    })

    // 窗户不接受钥匙
    const from = await screenOfScene(page, 0.5, 0.28)
    const to = await screenOfScene(page, 0.5, 0.19)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 })
    await page.mouse.move(to.x, to.y, { steps: 5 })
    await page.mouse.up()
    await page.waitForTimeout(400)
    await dismissDialogue(page)

    // 窗户没有状态，且不应当因此被"用"掉
    const window_ = await sceneState(page, ['hs_window'])
    expect(window_.objects.hs_window?.state).toBeNull()
  })
})

test.describe('存档与内容版本', () => {
  test('内容版本对不上时给出提示，而不是静默继续', async ({ page }) => {
    await boot(page)
    await page.evaluate(() => {
      const game = (window as unknown as { __HB__: { flushAutosave(): void } }).__HB__
      game.flushAutosave()
    })

    // 必须用 addInitScript：直接改完再 reload 是没用的，
    // 因为 pagehide 会先 flush 一次自动存档，把正确的版本号写回去。
    // initScript 在新页面的应用代码之前跑，才能真的模拟"存档来自旧内容"。
    await page.addInitScript(() => {
      const raw = localStorage.getItem('hb.save.auto')
      if (!raw) return
      const parsed = JSON.parse(raw) as { contentVersion?: string }
      parsed.contentVersion = 'stale-version'
      localStorage.setItem('hb.save.auto', JSON.stringify(parsed))
    })

    await page.reload()
    await page.waitForFunction(
      () => Boolean((window as unknown as { __HB__?: { sceneRuntime?: unknown } }).__HB__?.sceneRuntime),
      null,
      { timeout: 30_000 },
    )

    await expect(page.getByText('内容已更新', { exact: false })).toBeVisible({ timeout: 15_000 })
  })

  test('内容版本一致时不打扰玩家', async ({ page }) => {
    await boot(page)
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
    await expect(page.getByText('内容已更新', { exact: false })).toHaveCount(0)
  })
})

/** 让 React 合成一次 pointerleave。直接派发 pointerleave 是没用的 —— React 靠 pointerout 合成。 */
async function dispatchPointerLeave(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = document.querySelector('#root > div')
    root?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }))
  })
}

test.describe('存档容错', () => {
  test('存档指向的场景已不存在时，退回起始场景而不是黑屏', async ({ page }) => {
    await boot(page)
    await page.evaluate(() => {
      const game = (window as unknown as { __HB__: { flushAutosave(): void } }).__HB__
      game.flushAutosave()
    })

    // 模拟"你改剧情时把那个场景删了/改名了"—— 存档里还记着旧 id
    await page.addInitScript(() => {
      const raw = localStorage.getItem('hb.save.auto')
      if (!raw) return
      const parsed = JSON.parse(raw) as { engine?: { sceneId?: string } }
      if (parsed.engine) parsed.engine.sceneId = 'scene_that_no_longer_exists'
      localStorage.setItem('hb.save.auto', JSON.stringify(parsed))
    })

    await page.reload()
    await page.waitForFunction(
      () => Boolean((window as unknown as { __HB__?: { sceneRuntime?: unknown } }).__HB__?.sceneRuntime),
      null,
      { timeout: 30_000 },
    )

    // 关键：必须真的进到一个场景里，而不是留一块黑屏
    const state = await sceneState(page, [])
    expect(state.sceneId).toBe('start')
    // 而且要说清楚发生了什么
    await expect(page.getByText('已不存在', { exact: false })).toBeVisible({ timeout: 15_000 })
  })

  test('存档损坏时退回重开，而不是崩掉', async ({ page }) => {
    await boot(page)
    await page.evaluate(() => {
      localStorage.setItem('hb.save.auto', '{ this is not json')
    })

    await page.reload()
    await page.waitForFunction(
      () => Boolean((window as unknown as { __HB__?: { sceneRuntime?: unknown } }).__HB__?.sceneRuntime),
      null,
      { timeout: 30_000 },
    )

    const state = await sceneState(page, [])
    expect(state.sceneId).toBe('start')
  })
})

test.describe('拖拽状态', () => {
  test('指针离开画面会取消未完成的拖拽', async ({ page }) => {
    await boot(page)

    await page.evaluate(() => {
      const game = (window as unknown as {
        __HB__: { debugRunKnot(k: string): void; setSelectedItem(id: string | null): void }
      }).__HB__
      game.debugRunKnot('take_key')
    })
    await page.waitForTimeout(300)
    await dismissDialogue(page)

    await page.evaluate(() => {
      const game = (window as unknown as { __HB__: { setSelectedItem(id: string | null): void } }).__HB__
      game.setSelectedItem('item_key')
    })

    // 在门上按下：目标接受钥匙，所以进入"预备拖拽"
    const door = await screenOfScene(page, 0.83, 0.4)
    await page.mouse.move(door.x, door.y)
    await page.mouse.down()

    const armed = await page.evaluate(
      () =>
        (window as unknown as { __HB__: { interactionState: { dragArmed: string | null } } }).__HB__.interactionState
          .dragArmed,
    )
    expect(armed).toBe('hs_door')

    // 指针离开画面（窗口外抬起时收不到 pointerup，必须在这里取消）
    await dispatchPointerLeave(page)

    const after = await page.evaluate(
      () =>
        (window as unknown as { __HB__: { interactionState: { dragArmed: string | null } } }).__HB__.interactionState
          .dragArmed,
    )
    expect(after).toBeNull()

    await page.mouse.up()
  })

  test('拖拽时高亮跟随指针，只在该目标接受时才提示可放置', async ({ page }) => {
    await boot(page)

    await page.evaluate(() => {
      const game = (window as unknown as {
        __HB__: { debugRunKnot(k: string): void; setSelectedItem(id: string | null): void }
      }).__HB__
      game.debugRunKnot('take_key')
    })
    await page.waitForTimeout(300)
    await dismissDialogue(page)
    await page.evaluate(() => {
      const game = (window as unknown as { __HB__: { setSelectedItem(id: string | null): void } }).__HB__
      game.setSelectedItem('item_key')
    })

    const readDrop = (): Promise<{ dropTargetId: string | null; hoverId: string | null }> =>
      page.evaluate(() => {
        const state = (
          window as unknown as {
            __HB__: { interactionState: { dropTargetId: string | null; hoverId: string | null } }
          }
        ).__HB__.interactionState
        return { dropTargetId: state.dropTargetId, hoverId: state.hoverId }
      })

    const door = await screenOfScene(page, 0.83, 0.4)
    const window_ = await screenOfScene(page, 0.5, 0.19)

    await page.mouse.move(door.x, door.y)
    await page.mouse.down()
    // 越过拖拽阈值
    await page.mouse.move(door.x + 30, door.y + 20, { steps: 5 })

    // 门上：接受钥匙
    await page.mouse.move(door.x, door.y, { steps: 5 })
    expect((await readDrop()).dropTargetId).toBe('hs_door')

    // 窗户：不接受钥匙 —— 高亮必须跟着消失，而不是停在起点物件上
    await page.mouse.move(window_.x, window_.y, { steps: 6 })
    const overWindow = await readDrop()
    expect(overWindow.dropTargetId).toBeNull()
    expect(overWindow.hoverId).toBeNull()

    // 移回门上又亮起来
    await page.mouse.move(door.x, door.y, { steps: 6 })
    expect((await readDrop()).dropTargetId).toBe('hs_door')

    await page.mouse.up()
  })

  test('悬停会记录物件 id，移开后清空', async ({ page }) => {
    await boot(page)

    const shelf = await screenOfScene(page, 0.135, 0.41)
    await page.mouse.move(shelf.x, shelf.y)
    await page.waitForTimeout(150)

    const hovered = await page.evaluate(
      () =>
        (window as unknown as { __HB__: { interactionState: { hoverId: string | null } } }).__HB__.interactionState
          .hoverId,
    )
    expect(hovered).toBe('hs_shelf')

    await dispatchPointerLeave(page)
    const cleared = await page.evaluate(
      () =>
        (window as unknown as { __HB__: { interactionState: { hoverId: string | null } } }).__HB__.interactionState
          .hoverId,
    )
    expect(cleared).toBeNull()
  })
})

test.describe('选项链路', () => {
  /** 走到走廊的"选项演示"热点上，并推掉前置旁白，直到选项出现。 */
  async function openChoices(page: Page): Promise<void> {
    await boot(page)
    await gotoScene(page, 'hall')
    const point = await screenOfScene(page, 0.33, 0.44)
    await page.mouse.click(point.x, point.y)

    // 角色要先走到走位点，然后显示旁白
    await expect(page.locator('[role="log"]')).toContainText('这里放一个选择', { timeout: 25_000 })

    // 旁白要玩家推一下，选项才会出现 —— 这是有意的：先说完这句，再让人选。
    // 注意这里只能点一次：选项出现后对话框仍然在屏幕上，
    // 反复点中心会直接点到某个选项上。
    const viewport = page.viewportSize()!
    await page.mouse.click(viewport.width / 2, viewport.height / 2)
    await expect(page.getByRole('group', { name: '选择' })).toBeVisible({ timeout: 15_000 })
  }

  test('选项渲染成真正的按钮，且点得动', async ({ page }) => {
    await openChoices(page)

    const group = page.getByRole('group', { name: '选择' })
    const buttons = group.getByRole('button')
    await expect(buttons).toHaveCount(2)
    await expect(buttons.first()).toHaveText(/选左边/)
    await expect(buttons.nth(1)).toHaveText(/选右边/)

    // 光靠 toBeVisible 抓不到"渲染在屏幕外/尺寸塌成 0"这类问题 ——
    // 对话框掉进 flex 流被顶到左上角那次，就是只有截图才发现。
    const box = (await buttons.first().boundingBox())!
    const viewport = page.viewportSize()!
    expect(box.width).toBeGreaterThan(120)
    expect(box.height).toBeGreaterThan(24)
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1)

    // 两个按钮不该叠在一起
    const second = (await buttons.nth(1).boundingBox())!
    expect(second.y).toBeGreaterThan(box.y + box.height - 1)
  })

  test('点击选项后选项消失，剧情继续', async ({ page }) => {
    await openChoices(page)

    await page.getByRole('button', { name: /选左边/ }).click()

    await expect(page.getByRole('group', { name: '选择' })).toHaveCount(0, { timeout: 15_000 })
    // 选完立刻出现后续台词，不需要再点一下
    await expect(page.locator('[role="log"]')).toContainText('你选了左边', { timeout: 15_000 })
  })

  test('选项显示时点画布不会误触场景交互', async ({ page }) => {
    await openChoices(page)

    const before = await inkVariable(page, 'last_event')
    // 点左上角：那里在选项遮罩之内，不该穿透到场景
    await page.mouse.click(5, 5)
    await page.waitForTimeout(300)

    await expect(page.getByRole('group', { name: '选择' })).toBeVisible()
    expect(await inkVariable(page, 'last_event')).toBe(before)
  })
})

test.describe('悬停反馈', () => {
  /** 根元素的 cursor 由 GameShell 按引擎算出的光标类型设置。 */
  async function cursorAt(page: Page, x: number, y: number): Promise<string> {
    const point = await screenOfScene(page, x, y)
    await page.mouse.move(point.x, point.y)
    await page.waitForTimeout(180)
    return page.evaluate(() => {
      const root = document.querySelector('#root > div') ?? document.body.firstElementChild
      return root ? getComputedStyle(root as Element).cursor : 'none'
    })
  }

  test('悬停不同物件给出不同光标', async ({ page }) => {
    await boot(page)

    // hs_shelf 的 cursor 是 look → help
    expect(await cursorAt(page, 0.135, 0.41)).toBe('help')
    // hs_door 的 cursor 是 use → pointer
    expect(await cursorAt(page, 0.83, 0.4)).toBe('pointer')
    // 空白地面 → 可走 → crosshair
    expect(await cursorAt(page, 0.5, 0.9)).toBe('crosshair')
  })

  test('focus 场景里空白处不是可走光标', async ({ page }) => {
    await boot(page)
    await gotoScene(page, 'memory_table')
    // 没有地面可走，所以是默认光标而不是十字
    expect(await cursorAt(page, 0.1, 0.9)).toBe('default')
  })
})
