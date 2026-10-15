import { expect, test, type Page } from '@playwright/test'

/**
 * 端到端验证。
 *
 * 这些测试只验证**引擎能力**，不验证任何剧情内容 ——
 * 剧情是你会不断替换的东西，测试不该跟着剧情改。
 */

interface Probe {
  u: number
  v: number
  phase: number
  travelled: number
  speed: number
  walkBlend: number
  facing: number
  hasPath: boolean
  sceneId: string | null
}

async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(
    () => Boolean((window as unknown as { __HB__?: { sceneRuntime?: unknown } }).__HB__?.sceneRuntime),
    null,
    { timeout: 30_000 },
  )
  // 等首屏加载遮罩消失
  await page.locator('text=正在准备').waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => undefined)
  // 起始场景的入口旁白会留在屏幕上等玩家推进。把它点掉，
  // 让 boot() 结束时游戏处于"等输入"状态 —— 否则后续第一次点击
  // 会被"推进对话"吃掉，而不是触发热点或走路。
  await dismissDialogue(page)
}

async function probe(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const game = (window as unknown as {
      __HB__: { sceneRuntime: { actors: unknown[]; scene: { id: string } } }
    }).__HB__
    const actor = game.sceneRuntime.actors[0] as {
      u: number
      v: number
      phase: number
      travelled: number
      speed: number
      walkBlend: number
      facing: number
      path: unknown
    }
    return {
      u: actor.u,
      v: actor.v,
      phase: actor.phase,
      travelled: actor.travelled,
      speed: actor.speed,
      walkBlend: actor.walkBlend,
      facing: actor.facing,
      hasPath: actor.path !== null,
      sceneId: game.sceneRuntime.scene.id,
    }
  })
}

/** 地面平面坐标 → 页面坐标。 */
async function screenOf(page: Page, u: number, v: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([pu, pv]) => {
      const game = (window as unknown as {
        __HB__: {
          viewport: { x: number; y: number; w: number; h: number }
          sceneRuntime: { projectPlane: (u: number, v: number) => [number, number] }
        }
      }).__HB__
      const [sx, sy] = game.sceneRuntime.projectPlane(pu as number, pv as number)
      return { x: game.viewport.x + sx * game.viewport.w, y: game.viewport.y + sy * game.viewport.h }
    },
    [u, v],
  )
}

/** 场景空间坐标 → 页面坐标，用于点热点。 */
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
          scene: {
            hotspots: { id: string; shape: Record<string, number | string> }[]
            exits: { to: string; shape: Record<string, number | string> }[]
          }
        } | null
      }
    }).__HB__
    const vp = game.viewport
    const scene = game.sceneRuntime?.scene
    // 先找热点，再找出口（出口按目标场景 id 指代）
    const shape =
      scene?.hotspots.find((h) => h.id === hotspotId)?.shape ??
      scene?.exits.find((e) => e.to === hotspotId)?.shape
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

/** 反复点击直到对话框收起。注意：有台词待推进时，点击优先推进而不是触发热点。 */
async function dismissDialogue(page: Page, maxClicks = 8): Promise<void> {
  const viewport = page.viewportSize()!
  for (let i = 0; i < maxClicks; i++) {
    if ((await page.locator('[role="log"]').count()) === 0) return
    await page.mouse.click(viewport.width / 2, viewport.height / 2)
    await page.waitForTimeout(250)
  }
}

async function clickGround(page: Page, u: number, v: number): Promise<void> {
  const point = await screenOf(page, u, v)
  await page.mouse.click(point.x, point.y)
}

test.describe('启动', () => {
  test('场景与角色就绪，且无控制台报错', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    page.on('pageerror', (error) => errors.push(error.message))

    await boot(page)
    const state = await probe(page)

    expect(state.sceneId).toBe('start')
    expect(state.speed).toBe(0)
    expect(errors).toEqual([])
  })

  test('地面标定解出的是透视变换而非仿射', async ({ page }) => {
    await boot(page)
    const terms = await page.evaluate(() => {
      const game = (window as unknown as {
        __HB__: { sceneRuntime: { homography: { m: number[] } } }
      }).__HB__
      const m = game.sceneRuntime.homography.m
      return [m[6], m[7]]
    })
    expect(Math.abs(terms[0]) + Math.abs(terms[1])).toBeGreaterThan(1e-6)
  })
})

test.describe('点哪走哪', () => {
  test('点击地面后走过去并停在目标点', async ({ page }) => {
    await boot(page)
    const before = await probe(page)

    const target = await page.evaluate(() => {
      const game = (window as unknown as { __HB__: { sceneRuntime: {
        actors: { u: number; v: number }[]
        mask: { cols: number; rows: number; cells: Uint8Array }
        projectPlane(u: number, v: number): [number, number]
        canWalkAt(x: number, y: number): boolean
        hotspotAt(x: number, y: number): unknown
        exitAt(x: number, y: number): unknown
      } } }).__HB__
      const runtime = game.sceneRuntime
      const actor = runtime.actors[0]
      for (let row = 0; row < runtime.mask.rows; row++) {
        for (let col = 0; col < runtime.mask.cols; col++) {
          const u = (col + 0.5) / runtime.mask.cols
          const v = (row + 0.5) / runtime.mask.rows
          const point = runtime.projectPlane(u, v)
          if (Math.hypot(u - actor.u, v - actor.v) < 0.15) continue
          if (runtime.canWalkAt(...point) && !runtime.hotspotAt(...point) && !runtime.exitAt(...point)) return { u, v }
        }
      }
      throw new Error('场景没有可见可走且不被热点覆盖的测试目标')
    })
    await clickGround(page, target.u, target.v)

    await expect.poll(async () => (await probe(page)).speed, { timeout: 5000 }).toBeGreaterThan(0.05)

    // 等路径真正结束（而不是"路过目标点附近"）
    await expect.poll(async () => (await probe(page)).hasPath, { timeout: 25_000 }).toBe(false)

    const after = await probe(page)
    expect(Math.hypot(after.u - target.u, after.v - target.v)).toBeLessThan(0.02)
    expect(Math.hypot(after.u - before.u, after.v - before.v)).toBeGreaterThan(0.1)
  })

  test('相位由位移驱动：移动时推进，停下即冻结（不滑步的判据）', async ({ page }) => {
    await boot(page)
    await clickGround(page, 0.15, 0.4)

    // 移动中：位移与相位同时增长
    const first = await probe(page)
    await page.waitForTimeout(400)
    const second = await probe(page)
    expect(second.travelled).toBeGreaterThan(first.travelled + 1e-4)
    expect(second.phase).toBeGreaterThan(first.phase)

    // 等它彻底停下
    await expect.poll(async () => (await probe(page)).hasPath, { timeout: 25_000 }).toBe(false)
    const parked = await probe(page)
    await page.waitForTimeout(1200)
    const later = await probe(page)

    // 站立不动时相位与位移都必须完全不变 —— 这正是"脚不会在地上滑"的量化形式
    expect(later.travelled).toBeCloseTo(parked.travelled, 9)
    expect(later.phase).toBeCloseTo(parked.phase, 9)
    expect(later.speed).toBe(0)
  })

  test('行走姿态随速度平滑进出，不跳变', async ({ page }) => {
    await boot(page)
    expect((await probe(page)).walkBlend).toBeCloseTo(0, 1)

    await clickGround(page, 0.2, 0.35)
    await expect.poll(async () => (await probe(page)).walkBlend, { timeout: 5000 }).toBeGreaterThan(0.9)

    // 停下来后混合权重必须回到 0，而不是卡在 1
    await expect.poll(async () => (await probe(page)).walkBlend, { timeout: 25_000 }).toBeLessThan(0.05)
  })

  test('转身：向左走时朝向插值到 -1', async ({ page }) => {
    await boot(page)
    expect((await probe(page)).facing).toBe(1)
    await clickGround(page, 0.15, 0.5)
    await expect.poll(async () => (await probe(page)).facing, { timeout: 8000 }).toBeLessThan(-0.5)
  })

  test('点到障碍里自动吸附到最近可走点，绝不没反应', async ({ page }) => {
    await boot(page)
    const before = await probe(page)

    // 掩码里的障碍块位于平面 u∈[0.375,0.625]、v∈[0.31,0.56]
    await clickGround(page, 0.5, 0.45)

    await expect
      .poll(async () => (await probe(page)).travelled, { timeout: 10_000 })
      .toBeGreaterThan(before.travelled + 0.02)

    const after = await probe(page)
    // 终点必须落在障碍之外
    const insideBlock = after.u > 0.375 && after.u < 0.625 && after.v > 0.31 && after.v < 0.56
    expect(insideBlock).toBe(false)
  })
})

test.describe('热点与剧情', () => {
  test('点热点：角色走到位后触发文本，点击推进', async ({ page }) => {
    await boot(page)

    // 书架热点 rect(0.04, 0.26, 0.19, 0.30) 的中心
    await clickHotspot(page, 'hs_shelf')

    await expect(page.locator('[role="log"]')).toBeVisible({ timeout: 25_000 })
    await expect(page.locator('[role="log"]')).toContainText('书架')

    /*
     * 位置断言必须按方向分支 —— 两种形态的契约本来就不同。
     * 光断言"可见"会漏掉它掉进 flex 流被顶到页面左上角这类布局事故，
     * 所以两种形态都得钉一个明确的位置。
     */
    const box = await page.locator('[role="log"]').boundingBox()
    const viewport = page.viewportSize()!
    expect(box).not.toBeNull()
    const sideLayout = (await page.locator('[data-dialogue]').getAttribute('data-dialogue')) === 'side'
    if (sideLayout) {
      /*
       * 侧栏形态：对话是右侧通栏面板。
       * 量的是**面板** [data-dialogue-band]，不是里面的文字块 ——
       * 横屏下面板才是有背景、有边界的那个定位元素，文字块只裹着文字。
       */
      const panel = (await page.locator('[data-dialogue-band]').boundingBox())!
      expect(panel.x).toBeGreaterThan(viewport.width * 0.5)
      expect(panel.y).toBeLessThan(4)
      expect(panel.height).toBeGreaterThan(viewport.height * 0.9)
      // 文字落在面板里，没跑到场景那边去
      expect(box!.x).toBeGreaterThanOrEqual(panel.x - 1)
      expect(box!.y).toBeLessThan(panel.y + panel.height * 0.5)
    } else {
      // 竖屏：贴底居中
      expect(box!.y + box!.height).toBeGreaterThan(viewport.height * 0.8)
      const centerOffset = Math.abs(box!.x + box!.width / 2 - viewport.width / 2)
      expect(centerOffset).toBeLessThan(4)
    }

    await page.mouse.click(viewport.width / 2, viewport.height / 2)
    await expect(page.locator('[role="log"]')).toBeHidden({ timeout: 10_000 })
  })

  test('条件驱动热点：查看书架前钥匙不存在，查看后才出现', async ({ page }) => {
    await boot(page)

    const keyVisible = async (): Promise<boolean> =>
      page.evaluate(() => {
        const game = (window as unknown as {
          __HB__: {
            ink: { evaluate(name: string): boolean }
            sceneRuntime: {
              hotspotAt: (x: number, y: number, visible: (h: { id: string }) => boolean) => { id?: string } | null
              scene: {
                hotspots: {
                  id: string
                  visibleWhen: string | null
                  shape: Record<string, number | string>
                }[]
              }
            }
          }
        }).__HB__
        const runtime = game.sceneRuntime
        /*
         * 探测点用**热点自己的中心**，不写死坐标 —— 热点位置是内容的事，
         * 会随安全区调整、素材替换而变。这里只关心"钥匙现在在不在"。
         */
        const shape = runtime.scene.hotspots.find((item) => item.id === 'hs_key')?.shape
        if (!shape) return false
        const u = shape.type === 'circle' ? Number(shape.cx) : Number(shape.x) + Number(shape.w) / 2
        const v = shape.type === 'circle' ? Number(shape.cy) : Number(shape.y) + Number(shape.h) / 2
        const hit = runtime.hotspotAt(u, v, (h) => {
          const spec = runtime.scene.hotspots.find((item) => item.id === h.id)
          return spec?.visibleWhen ? game.ink.evaluate(spec.visibleWhen) : true
        })
        return hit?.id === 'hs_key'
      })

    expect(await keyVisible()).toBe(false)

    // 查看书架
    await clickHotspot(page, 'hs_shelf')
    await expect(page.locator('[role="log"]')).toBeVisible({ timeout: 25_000 })

    const viewport = page.viewportSize()!
    await page.mouse.click(viewport.width / 2, viewport.height / 2)
    await expect(page.locator('[role="log"]')).toBeHidden({ timeout: 10_000 })

    expect(await keyVisible()).toBe(true)
  })
})

test.describe('完整链路', () => {
  test('查看书架 → 拿钥匙 → 用钥匙开门 → 出口切场景（含 # scene: 指令）', async ({ page }) => {
    await boot(page)
    const viewport = page.viewportSize()!

    const sceneId = async (): Promise<string> =>
      page.evaluate(
        () => (window as unknown as { __HB__: { sceneRuntime: { scene: { id: string } } } }).__HB__.sceneRuntime.scene.id,
      )

    // 1. 查看书架 → 钥匙条件变为可见
    await clickHotspot(page, 'hs_shelf')
    await expect(page.locator('[role="log"]')).toContainText('钥匙', { timeout: 25_000 })
    await dismissDialogue(page)

    // 2. 拿钥匙
    await clickHotspot(page, 'hs_key')
    await expect(page.locator('[role="log"]')).toBeVisible({ timeout: 25_000 })
    await dismissDialogue(page)
    await expect(page.getByRole('listitem')).toHaveCount(1, { timeout: 10_000 })

    // 3. 选中钥匙，再点门 → 走"用物品"分支
    await page.getByRole('listitem').click()
    await clickHotspot(page, 'hs_door')
    await expect(page.locator('[role="log"]')).toContainText('锁开了', { timeout: 25_000 })
    await dismissDialogue(page)

    // 4. 点出口 → go_hall 的旁白先出现，场景尚未切换
    await clickHotspot(page, 'go_hall')
    await expect(page.locator('[role="log"]')).toContainText('走廊', { timeout: 25_000 })
    expect(await sceneId()).toBe('start')

    // 5. 推进之后才真正切场景 —— 这一条正是 # scene: 与文字同行时的行为
    await page.mouse.click(viewport.width / 2, viewport.height / 2)
    await expect.poll(sceneId, { timeout: 15_000 }).toBe('hall')
  })
})

test.describe('性能', () => {
  test('每帧 update+render 的耗时留有充足余量', async ({ page }) => {
    await boot(page)

    const timing = await page.evaluate(() => {
      const game = (window as unknown as {
        __HB__: { update(dt: number): void; render(): void }
      }).__HB__
      const frames = 600
      // 先跑一段热身，避开首次绘制与 JIT 的干扰
      for (let i = 0; i < 120; i++) {
        game.update(1 / 60)
        game.render()
      }
      const start = performance.now()
      for (let i = 0; i < frames; i++) {
        game.update(1 / 60)
        game.render()
      }
      return { perFrame: (performance.now() - start) / frames }
    })

    // 60fps 的预算是 16.7ms/帧。这里卡在 8ms，留一倍余量，
    // 既能抓住数量级级别的性能回归，又不会因为无头浏览器的抖动而误报。
    console.log(`[perf] update+render 平均 ${timing.perFrame.toFixed(3)} ms/帧`)
    expect(timing.perFrame).toBeLessThan(8)
  })
})

test.describe('布局', () => {
  test('角色走到房间最前排也不会被对话框盖住', async ({ page }) => {
    await boot(page)

    // 走到地面最前排（v 接近 1）—— 这是最容易被对话框吃掉的位置
    await clickGround(page, 0.5, 0.97)
    await expect.poll(async () => (await probe(page)).hasPath, { timeout: 25_000 }).toBe(false)

    const geometry = await page.evaluate(() => {
      const game = (window as unknown as {
        __HB__: {
          viewport: { x: number; y: number; w: number; h: number }
          sceneRuntime: {
            actors: unknown[]
            actorPlacement: (actor: unknown) => { y: number; height: number }
          }
        }
      }).__HB__
      const placement = game.sceneRuntime.actorPlacement(game.sceneRuntime.actors[0])
      const band = document.querySelector('[data-dialogue-band]')?.getBoundingClientRect()
      return {
        feetY: game.viewport.y + placement.y * game.viewport.h,
        sceneRight: game.viewport.x + game.viewport.w,
        sceneBottom: game.viewport.y + game.viewport.h,
        bandTop: band ? band.top : null,
        bandLeft: band ? band.left : null,
      }
    })

    if (geometry.bandLeft !== null && geometry.bandLeft >= geometry.sceneRight - 2) {
      /*
       * 横屏：对话在右侧面板。
       * 契约不是"脚在对话框上面"，而是**场景区整体不伸到面板底下** ——
       * 那样角色无论站在场景哪里都不可能被盖住，比逐点比较更强。
       */
      expect(geometry.sceneRight).toBeLessThanOrEqual(geometry.bandLeft + 1)
      expect(geometry.feetY).toBeLessThanOrEqual(geometry.sceneBottom + 1)
    } else {
      // 竖屏：场景只在对话框之上的区域里 letterbox，脚必然落在预留区之上
      expect(geometry.bandTop).not.toBeNull()
      expect(geometry.feetY).toBeLessThanOrEqual((geometry.bandTop as number) + 1)
    }
  })

  test('对话框贴底居中，且长台词不被裁掉', async ({ page }) => {
    await boot(page)

    await clickHotspot(page, 'hs_shelf')
    const log = page.locator('[role="log"]')
    await expect(log).toBeVisible({ timeout: 25_000 })

    const viewport = page.viewportSize()!
    const box = (await log.boundingBox())!
    const sideLayout = (await page.locator('[data-dialogue]').getAttribute('data-dialogue')) === 'side'
    if (sideLayout) {
      // 侧栏形态：面板纵向铺满；文字块本身只裹文字，位置靠上
      const panel = (await page.locator('[data-dialogue-band]').boundingBox())!
      expect(panel.x).toBeGreaterThan(viewport.width * 0.5)
      expect(panel.height).toBeGreaterThan(viewport.height * 0.9)
      expect(box.y).toBeLessThan(panel.y + panel.height * 0.5)
      expect(box.x).toBeGreaterThanOrEqual(panel.x - 1)
    } else {
      expect(box.y + box.height).toBeGreaterThan(viewport.height * 0.8)
      expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(4)
    }

    // 文本没有被裁：内容高度不能超过盒子可视高度
    const clipped = await log.evaluate((el) => el.scrollHeight > el.clientHeight + 1)
    expect(clipped).toBe(false)
  })
})

test.describe('小游戏容器', () => {
  test('挂载 → 失败计数 → 跳过 → 结果写回 ink 并继续剧情', async ({ page }) => {
    await boot(page)

    // 直接跳到第二个场景，避免为了走到这里先跑一遍拿钥匙的流程
    await page.evaluate(() => {
      const game = (window as unknown as { __HB__: { debugGotoScene(id: string): Promise<void> } }).__HB__
      return game.debugGotoScene('hall')
    })
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => (window as unknown as { __HB__: { sceneRuntime: { scene: { id: string } } } }).__HB__.sceneRuntime.scene.id,
          ),
        { timeout: 10_000 },
      )
      .toBe('hall')

    // 进入场景时那一句台词要先点掉，否则点击会被"推进对话"抢先
    await dismissDialogue(page)

    // 点"小游戏演示"热点
    const point = await page.evaluate(() => {
      const game = (window as unknown as {
        __HB__: { viewport: { x: number; y: number; w: number; h: number } }
      }).__HB__
      return { x: game.viewport.x + 0.185 * game.viewport.w, y: game.viewport.y + 0.44 * game.viewport.h }
    })
    await page.mouse.click(point.x, point.y)

    // 先出引导台词，点掉它才会挂起剧情运行小游戏
    await expect(page.locator('[role="log"]')).toBeVisible({ timeout: 25_000 })
    await dismissDialogue(page)

    // 容器挂载
    await expect(page.getByText('记住顺序')).toBeVisible({ timeout: 15_000 })
    const pads = page.locator('button[data-index]')
    await expect(pads).toHaveCount(4)

    // 反复点同一个格子，直到小游戏结束（失败满 3 次会出现跳过按钮）
    const overlayGone = async (): Promise<boolean> =>
      (await page.getByText('记住顺序').count()) === 0

    for (let i = 0; i < 24 && !(await overlayGone()); i++) {
      const skipVisible = await page.getByRole('button', { name: '跳过这个小游戏' }).isVisible().catch(() => false)
      if (skipVisible) {
        await page.getByRole('button', { name: '跳过这个小游戏' }).click()
        break
      }
      await pads.first().click({ timeout: 3000 }).catch(() => undefined)
      await page.waitForTimeout(700)
    }

    await expect(page.getByText('记住顺序')).toBeHidden({ timeout: 15_000 })

    // 结果写回 ink，剧本据此分支继续
    await expect(page.locator('[role="log"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[role="log"]')).toContainText(/跳过了|记住了顺序|差了一点/)

    const written = await page.evaluate(() => {
      const game = (window as unknown as {
        __HB__: { ink: { variable(name: string): unknown } }
      }).__HB__
      return { success: game.ink.variable('minigame_success'), skipped: game.ink.variable('minigame_skipped') }
    })
    // 两者必有一个为真，说明结果确实回灌进了 ink
    expect(written.success === true || written.skipped === true).toBe(true)
  })
})

test.describe('存档', () => {
  test('刷新页面后自动接上进度（位置被还原）', async ({ page }) => {
    await boot(page)
    await clickGround(page, 0.2, 0.35)
    // 等到确实走完，位置稳定下来
    await expect.poll(async () => (await probe(page)).hasPath, { timeout: 25_000 }).toBe(false)
    const before = await probe(page)
    expect(Math.hypot(before.u - 0.5, before.v - 0.85)).toBeGreaterThan(0.1)

    // 等自动存档的节流窗口过去
    await page.waitForTimeout(2500)
    await page.reload()
    await boot(page)

    // travelled 是本次会话的累计量，不参与存档；被还原的是位置
    const after = await probe(page)
    expect(after.u).toBeCloseTo(before.u, 4)
    expect(after.v).toBeCloseTo(before.v, 4)
  })
})
