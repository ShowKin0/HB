import { describe, expect, it } from 'vitest'
import { createActor, updateActor } from '../src/engine/actor/actor.ts'
import { parseMask } from '../src/engine/nav/mask.ts'
import { AssetStore } from '../src/engine/assets.ts'
import { SceneRuntime } from '../src/engine/scene/runtime.ts'
import { ActorSpecSchema, SceneSchema, type ActorSpec, type Scene } from '../src/schema/scene.ts'
import { directionOf } from '../src/actorRenderers/spriteSheet.ts'

const ground = { corners: [[0.2, 0.25], [0.8, 0.25], [1, 0.9], [0, 0.9]] as const }

function walkScene(actors: unknown[]): Scene {
  return SceneSchema.parse({
    id: 'actor-geometry',
    mode: 'walk',
    ground,
    walkable: Array.from({ length: 20 }, () => '.'.repeat(20)),
    actors,
    hotspots: [],
  })
}

describe('角色几何', () => {
  it('每个角色以自己的 spawn 深度作为 heightRatio 参考，不依赖数组次序', async () => {
    const near: ActorSpec = { id: 'near', spawn: [0.5, 0.9], heightRatio: 0.22, speed: 0.4, facing: 1, parts: null, renderer: 'partRig', tint: null, scale: 1 }
    const far: ActorSpec = { id: 'far', spawn: [0.5, 0.1], heightRatio: 0.36, speed: 0.4, facing: 1, parts: null, renderer: 'partRig', tint: null, scale: 1.25 }
    const first = await SceneRuntime.create(walkScene([near, far]), new AssetStore())
    const reversed = await SceneRuntime.create(walkScene([far, near]), new AssetStore())
    const byId = (runtime: SceneRuntime, id: string): number => runtime.actorPlacement(runtime.actorById(id)!).height

    expect(byId(first, 'near')).toBeCloseTo(0.22, 8)
    expect(byId(first, 'far')).toBeCloseTo(0.45, 8)
    expect(byId(reversed, 'near')).toBeCloseTo(byId(first, 'near'), 8)
    expect(byId(reversed, 'far')).toBeCloseTo(byId(first, 'far'), 8)
  })

  it('八向选择使用屏幕 aspect：斜向的同一平面位移可落入不同八方向', () => {
    const spec = ActorSpecSchema.parse({ id: 'hero', spawn: [0.2, 0.2], heightRatio: 0.3, speed: 0.45 })
    const actor = createActor(spec)
    const dx = 0.1
    const dy = 0.05
    actor.u = 0.2
    actor.v = 0.2
    actor.path = [[0.2, 0.2], [0.2 + dx, 0.2 + dy]]
    const ctx = {
      mask: parseMask(Array.from({ length: 20 }, () => '.'.repeat(20))),
      project: (u: number, v: number) => [u, v] as [number, number],
      localScale: () => 1,
      aspect: 16 / 9,
    }
    updateActor(actor, 0.001, ctx)
    expect(directionOf(actor.faceDirX, actor.faceDirY)).toBe('E')

    const square = createActor(spec)
    square.u = 0.2
    square.v = 0.2
    square.path = [[0.2, 0.2], [0.2 + dx, 0.2 + dy]]
    updateActor(square, 0.001, { ...ctx, aspect: 1 })
    expect(directionOf(square.faceDirX, square.faceDirY)).toBe('SE')
  })

  it('cover 约束保留 ground homography，出生/目标落在可见走区且兼容旧 setter', async () => {
    const runtime = await SceneRuntime.create(walkScene([
      { id: 'hero', spawn: [0.5, 0.85], heightRatio: 0.3, speed: 0.45 },
    ]), new AssetStore())
    const originalH = [...runtime.homography.m]
    const before = runtime.projectPlane(0.5, 0.5)

    expect(runtime.setVisibleRange(0.2, 0.8)).toBe(true)
    expect([...runtime.homography.m]).toEqual(originalH)
    expect(runtime.groundRange).toEqual(runtime.visibleV)
    const after = runtime.projectPlane(0.5, 0.5)
    expect(after).toEqual(before)

    expect(runtime.setVisibleBounds(0.2, 0.2, 0.8, 0.8)).toBe(true)
    const actor = runtime.primaryActor!
    const spawnScene = runtime.projectPlane(actor.u, actor.v)
    expect(spawnScene[0]).toBeGreaterThanOrEqual(runtime.visibleU[0])
    expect(spawnScene[0]).toBeLessThanOrEqual(runtime.visibleU[1])
    expect(spawnScene[1]).toBeGreaterThanOrEqual(runtime.visibleV[0])
    expect(spawnScene[1]).toBeLessThanOrEqual(runtime.visibleV[1])

    expect(runtime.canWalkAt(0.1, 0.5)).toBe(false)
    expect(runtime.moveActor('hero', [0.95, 0.95])).toBe(true)
    const end = actor.path?.[actor.path.length - 1]
    expect(end).toBeDefined()
    const endScene = runtime.projectPlane(end![0], end![1])
    expect(endScene[0]).toBeGreaterThanOrEqual(runtime.visibleU[0] - 1e-6)
    expect(endScene[0]).toBeLessThanOrEqual(runtime.visibleU[1] + 1e-6)
    expect(endScene[1]).toBeGreaterThanOrEqual(runtime.visibleV[0] - 1e-6)
    expect(endScene[1]).toBeLessThanOrEqual(runtime.visibleV[1] + 1e-6)
  })

  it('贴边 ground 保持有效，不因 cover 请求被 blanket 拒绝', async () => {
    const edge = walkScene([{ id: 'hero', spawn: [0.5, 0.9], heightRatio: 0.3, speed: 0.45 }])
    const runtime = await SceneRuntime.create(edge, new AssetStore())
    const original = [...runtime.homography.m]
    expect(runtime.setVisibleRange(0.15, 0.9)).toBe(true)
    expect([...runtime.homography.m]).toEqual(original)
    expect(runtime.projectPlane(0.5, 1)[1]).toBeCloseTo(0.9, 5)
  })
})
