import { describe, expect, it } from 'vitest'
import { SceneSchema, type Scene } from '../src/schema/scene.ts'
import { AssetStore } from '../src/engine/assets.ts'
import { SceneRuntime, animOffset } from '../src/engine/scene/runtime.ts'

/**
 * 场景运行时。
 *
 * 这里能直接在 Node 里跑，是因为 AssetStore 在无 DOM 环境下会把素材记为缺失
 * 并返回 null —— 于是"没有素材时引擎是否还讲道理"这件事可以被完整测到，
 * 而这恰恰是最容易出问题、也最难靠肉眼发现的路径。
 */

function makeScene(partial: Record<string, unknown>): Scene {
  return SceneSchema.parse({
    id: 'test',
    mode: 'focus',
    ...partial,
  })
}

const rect = { type: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }

describe('collectDrawables 的可见性', () => {
  it('没有 visibleWhen 的物件永远在绘制列表里', async () => {
    const scene = makeScene({
      hotspots: [{ id: 'h', shape: rect, image: 'x.avif', onClick: 'k' }],
    })
    const runtime = await SceneRuntime.create(scene, new AssetStore())
    expect(runtime.collectDrawables(0, () => true)).toHaveLength(1)
    expect(runtime.collectDrawables(0, () => false)).toHaveLength(1)
  })

  it('visibleWhen 为假时物件不该被画出来', async () => {
    // 这一条曾经漏过：hotspotAt 会正确地拒绝点击，但 collectDrawables 完全不看
    // visibleWhen —— 结果是物件"看得见却点不到"，玩家只会以为是 bug。
    const scene = makeScene({
      hotspots: [{ id: 'h', shape: rect, image: 'x.avif', visibleWhen: 'can_see', onClick: 'k' }],
    })
    const runtime = await SceneRuntime.create(scene, new AssetStore())

    expect(runtime.collectDrawables(0, () => true)).toHaveLength(1)
    expect(runtime.collectDrawables(0, () => false)).toHaveLength(0)
  })

  it('visibleWhen 为假时图层不该被画出来', async () => {
    // 图层这一侧曾经更严重：visibleWhen 在 schema 里有、编辑器能编、
    // content:check 会校验，但引擎**从头到尾没读过它**。
    const scene = makeScene({
      layers: [{ id: 'l', image: 'fg/x.avif', visibleWhen: 'can_see' }],
    })
    const runtime = await SceneRuntime.create(scene, new AssetStore())

    expect(runtime.collectDrawables(0, () => true)).toHaveLength(1)
    expect(runtime.collectDrawables(0, () => false)).toHaveLength(0)
  })

  it('空间状态隐藏与条件隐藏是两回事，都生效', async () => {
    const scene = makeScene({
      hotspots: [{ id: 'h', shape: rect, image: 'x.avif', visibleWhen: 'can_see', onClick: 'k' }],
    })
    const runtime = await SceneRuntime.create(scene, new AssetStore())

    runtime.patchObjectState('h', { visible: false })
    // 条件为真，但空间状态说隐藏
    expect(runtime.collectDrawables(0, () => true)).toHaveLength(0)
    // 两者都为真才画
    runtime.patchObjectState('h', { visible: true })
    expect(runtime.collectDrawables(0, () => true)).toHaveLength(1)
  })

  it('不传条件求值器时退化为"只看空间状态"', async () => {
    const scene = makeScene({
      hotspots: [{ id: 'h', shape: rect, image: 'x.avif', visibleWhen: 'can_see', onClick: 'k' }],
    })
    const runtime = await SceneRuntime.create(scene, new AssetStore())
    expect(runtime.collectDrawables(0)).toHaveLength(1)
  })
})

describe('物件空间状态快照', () => {
  it('快照用 sceneId:objectId 作键，且只写非默认值', async () => {
    const scene = makeScene({
      hotspots: [
        { id: 'a', shape: rect, onClick: 'k' },
        { id: 'b', shape: rect, onClick: 'k' },
      ],
    })
    const runtime = await SceneRuntime.create(scene, new AssetStore())
    runtime.patchObjectState('a', { state: 'open', visible: false })
    runtime.patchObjectState('b', { progress: 0.5 })

    const snapshot = runtime.snapshotObjectStates()
    expect(snapshot['test:a']).toEqual({ visible: false, state: 'open' })
    expect(snapshot['test:b']).toEqual({ visible: true, progress: 0.5 })
  })

  it('存档里的状态会在重建运行时被还原', async () => {
    const scene = makeScene({ hotspots: [{ id: 'a', shape: rect, initialState: 'closed', onClick: 'k' }] })
    const runtime = await SceneRuntime.create(scene, new AssetStore(), {
      'test:a': { state: 'opened', visible: false },
    })
    const state = runtime.objectState('a')
    expect(state?.state).toBe('opened')
    expect(state?.visible).toBe(false)
  })

  it('patchObjectState 在状态没变时返回 false（避免无谓的自动存档）', async () => {
    const scene = makeScene({ hotspots: [{ id: 'a', shape: rect, onClick: 'k' }] })
    const runtime = await SceneRuntime.create(scene, new AssetStore())
    expect(runtime.patchObjectState('a', { visible: true })).toBe(false)
    expect(runtime.patchObjectState('a', { visible: false })).toBe(true)
    expect(runtime.patchObjectState('a', { visible: false })).toBe(false)
  })

  it('对不存在的物件 patch 不会凭空创建状态', async () => {
    const scene = makeScene({ hotspots: [{ id: 'a', shape: rect, onClick: 'k' }] })
    const runtime = await SceneRuntime.create(scene, new AssetStore())
    expect(runtime.patchObjectState('nope', { visible: false })).toBe(false)
    expect(runtime.objectState('nope')).toBeNull()
  })
})

describe('visualStates 取图', () => {
  it('状态名取不到图时回落到基础图', async () => {
    const scene = makeScene({
      hotspots: [
        {
          id: 'a',
          shape: rect,
          image: 'base.avif',
          visualStates: { opened: 'open.avif' },
          initialState: 'opened',
          onClick: 'k',
        },
      ],
    })
    const runtime = await SceneRuntime.create(scene, new AssetStore())
    // 无 DOM 环境下所有图都是 null，这里只验证不抛错、且结构正确
    const drawn = runtime.collectDrawables(0)
    expect(drawn).toHaveLength(1)
    expect(drawn[0].image).toBeNull()
  })
})

describe('focus 模式', () => {
  it('没有地面时 canWalkAt 永远为假', async () => {
    const scene = makeScene({ hotspots: [{ id: 'a', shape: rect, onClick: 'k' }] })
    const runtime = await SceneRuntime.create(scene, new AssetStore())
    expect(runtime.mode).toBe('focus')
    expect(runtime.canWalkAt(0.5, 0.5)).toBe(false)
    expect(runtime.cursorAt(0.5, 0.5)).toBe('default')
  })

  it('focus 模式不会创建角色', async () => {
    const scene = makeScene({ hotspots: [{ id: 'a', shape: rect, onClick: 'k' }] })
    const runtime = await SceneRuntime.create(scene, new AssetStore())
    expect(runtime.actors).toHaveLength(0)
    expect(runtime.primaryActor).toBeUndefined()
  })
})

describe('walk 模式', () => {
  const walkScene = () =>
    makeScene({
      mode: 'walk',
      ground: { corners: [[0.1, 0.5], [0.9, 0.5], [1, 1], [0, 1]] },
      walkable: ['....', '....', '....'],
      actors: [{ id: 'hero', spawn: [0.5, 0.8] }],
      hotspots: [{ id: 'a', shape: rect, onClick: 'k' }],
    })

  it('有地面时创建角色', async () => {
    const runtime = await SceneRuntime.create(walkScene(), new AssetStore())
    expect(runtime.mode).toBe('walk')
    expect(runtime.actors).toHaveLength(1)
  })

  it('地面上的点可以走，地面外的点不行', async () => {
    const runtime = await SceneRuntime.create(walkScene(), new AssetStore())
    expect(runtime.canWalkAt(0.5, 0.75)).toBe(true)
    // 画面顶部在消失线以上，反投影不回地面
    expect(runtime.canWalkAt(0.5, 0.05)).toBe(false)
  })

  it('障碍掩码里的点不可走，光标也不会提示可走', async () => {
    const scene = makeScene({
      mode: 'walk',
      ground: { corners: [[0.1, 0.5], [0.9, 0.5], [1, 1], [0, 1]] },
      walkable: ['..##', '..##', '....'],
      actors: [{ id: 'hero', spawn: [0.1, 0.8] }],
      hotspots: [],
    })
    const runtime = await SceneRuntime.create(scene, new AssetStore())
    const blocked = runtime.projectPlane(0.625, 0.2)
    expect(runtime.canWalkAt(blocked[0], blocked[1])).toBe(false)
    expect(runtime.cursorAt(blocked[0], blocked[1])).toBe('default')
  })

  it('角色位置会被存档还原', async () => {
    const runtime = await SceneRuntime.create(walkScene(), new AssetStore(), {})
    expect(runtime.actors[0].u).toBeCloseTo(0.5, 6)
  })
})

describe('animOffset 与运行时配合', () => {
  it('浮动动效会改变绘制位置', async () => {
    const scene = makeScene({
      hotspots: [
        {
          id: 'a',
          shape: rect,
          image: 'x.avif',
          position: [0.5, 0.5],
          anim: { type: 'float', amplitude: 0.02, speed: 1, phase: 0 },
          onClick: 'k',
        },
      ],
    })
    const runtime = await SceneRuntime.create(scene, new AssetStore())
    const at0 = runtime.collectDrawables(0)[0].position
    const atQuarter = runtime.collectDrawables(0.25)[0].position
    expect(at0[0]).toBeCloseTo(0.5, 6)
    expect(atQuarter[1]).not.toBeCloseTo(at0[1], 4)
  })

  it('静止物件的位置就是它声明的 position', async () => {
    const scene = makeScene({
      hotspots: [{ id: 'a', shape: rect, image: 'x.avif', position: [0.3, 0.7], onClick: 'k' }],
    })
    const runtime = await SceneRuntime.create(scene, new AssetStore())
    const [x, y] = runtime.collectDrawables(3.7)[0].position
    expect(x).toBeCloseTo(0.3, 6)
    expect(y).toBeCloseTo(0.7, 6)
    expect(animOffset({ type: 'none', amplitude: 1, speed: 1, phase: 0 }, 1)).toEqual({
      dx: 0,
      dy: 0,
      scale: 1,
      rotation: 0,
    })
  })
})
