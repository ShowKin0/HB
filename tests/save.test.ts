import { describe, expect, it } from 'vitest'
import { migrateSave, SAVE_VERSION, sceneObjectKey } from '../src/schema/save.ts'

/**
 * 存档迁移。
 *
 * 这段代码平时跑不到 —— 只有当玩家手里有一份旧存档时才会执行，
 * 而那正是最不能出错的时候（出错就等于"点继续游戏就崩"）。
 * 所以每一条升级分支都必须有测试。
 */

function v1Save(): Record<string, unknown> & { engine: Record<string, unknown> } {
  return {
    saveVersion: 1,
    createdAt: 1000,
    updatedAt: 2000,
    label: '自动存档',
    inkState: '{"flows":{}}',
    engine: {
      sceneId: 'start',
      // v1：键只有角色 id
      actorPositions: { hero: [0.2, 0.9] },
      actorFacing: { hero: -1 },
      inventory: ['item_key'],
      flags: { door_unlocked: true },
      scenes: {},
      events: {},
      visitedScenes: ['start'],
      playMs: 1234,
    },
  }
}

describe('migrateSave', () => {
  it('把 v1 的角色位置键补上场景前缀', () => {
    const save = migrateSave(v1Save())
    expect(save).not.toBeNull()
    expect(save!.saveVersion).toBe(SAVE_VERSION)
    // v1 的位置只能属于玩家离开时所在的场景
    expect(save!.engine.actorPositions['start:hero']).toEqual([0.2, 0.9])
    expect(save!.engine.actorFacing['start:hero']).toBe(-1)
    // 旧键不该留下来
    expect(save!.engine.actorPositions['hero']).toBeUndefined()
  })

  it('迁移不会丢掉其他字段', () => {
    const save = migrateSave(v1Save())!
    expect(save.engine.inventory).toEqual(['item_key'])
    expect(save.engine.flags.door_unlocked).toBe(true)
    expect(save.engine.playMs).toBe(1234)
    expect(save.inkState).toBe('{"flows":{}}')
    expect(save.createdAt).toBe(1000)
  })

  it('已经是新格式的键不会被重复加前缀', () => {
    const raw = v1Save()
    raw.engine.actorPositions = { 'hall:hero': [0.5, 0.8] }
    const save = migrateSave(raw)!
    expect(save.engine.actorPositions['hall:hero']).toEqual([0.5, 0.8])
    expect(Object.keys(save.engine.actorPositions)).toHaveLength(1)
  })

  it('sceneId 为空时不做键改写，避免造出 ":hero" 这种脏键', () => {
    const raw = v1Save()
    raw.engine.sceneId = null as unknown as string
    const save = migrateSave(raw)!
    expect(save.engine.actorPositions['hero']).toEqual([0.2, 0.9])
  })

  it('v2 存档原样通过', () => {
    const current = {
      ...v1Save(),
      saveVersion: 2,
      contentVersion: 'abc',
      engine: { ...v1Save().engine, actorPositions: { 'start:hero': [0.3, 0.7] } },
    }
    const save = migrateSave(current)!
    expect(save.saveVersion).toBe(SAVE_VERSION)
    expect(save.contentVersion).toBe('abc')
    expect(save.engine.actorPositions['start:hero']).toEqual([0.3, 0.7])
  })

  it('v1 存档缺少 contentVersion 时补成空串', () => {
    const save = migrateSave(v1Save())!
    expect(save.contentVersion).toBe('')
  })

  it('拒绝未来版本，而不是猜着读', () => {
    const future = { ...v1Save(), saveVersion: SAVE_VERSION + 1 }
    expect(migrateSave(future)).toBeNull()
  })

  it('必需字段坏掉才判死，角色状态坏掉只丢那一条', () => {
    // 时间戳是必需的：没有它连"这是什么时候存的"都不知道，排序也做不了
    const nanTime = v1Save()
    nanTime.createdAt = Number.NaN
    expect(migrateSave(nanTime)).toBeNull()

    /*
     * 位置 / 朝向写坏了只丢那一条。
     *
     * 这里以前是"整份存档判 null"，但下面几行的 scenes 却是按条目丢弃的
     * —— 同一种"坏了一小块"两套标准，而且严厉的那套让玩家直接丢光进度。
     * 现在统一成按条目降级。
     */
    const outside = v1Save()
    outside.engine.actorPositions = { hero: [1.2, 0.5] }
    const a = migrateSave(outside)
    expect(a, '越界的位置不该让整份存档作废').not.toBeNull()
    expect(a!.engine.actorPositions).toEqual({})

    const badFacing = v1Save()
    badFacing.engine.actorFacing = { hero: Number.NaN }
    const b = migrateSave(badFacing)
    expect(b, '坏的朝向不该让整份存档作废').not.toBeNull()
    expect(b!.engine.actorFacing).toEqual({})
  })

  it('好条目与坏条目混在一起时只丢坏的', () => {
    const raw = v1Save()
    raw.engine.actorPositions = { good: [0.2, 0.3], bad: [9, 9] }
    const save = migrateSave(raw)!
    expect(Object.keys(save.engine.actorPositions)).toEqual(['start:good'])
    expect(save.engine.actorPositions['start:good']).toEqual([0.2, 0.3])
  })

  it('丢弃单个损坏的物件空间状态，不影响存档主体', () => {
    const raw = v1Save()
    raw.engine.scenes = {
      'start:good': { visible: false, progress: 0.5 },
      'start:bad': { position: [2, 0.5] },
    }
    const save = migrateSave(raw)!
    expect(save.engine.scenes['start:good']).toEqual({ visible: false, progress: 0.5 })
    expect(save.engine.scenes['start:bad']).toBeUndefined()
  })
  it('拒绝明显不是存档的东西', () => {
    expect(migrateSave(null)).toBeNull()
    expect(migrateSave('nope')).toBeNull()
    expect(migrateSave({})).toBeNull()
    expect(migrateSave({ saveVersion: 0 })).toBeNull()
    expect(migrateSave({ saveVersion: 1.5 })).toBeNull()
    // 结构不对（缺 inkState / engine）也不能崩，直接退回重开
    expect(migrateSave({ saveVersion: 1, createdAt: 1 })).toBeNull()
  })

  it('引擎状态缺字段时用默认值补齐（旧存档里没有 scenes/events）', () => {
    const raw = v1Save()
    delete (raw.engine as Record<string, unknown>).scenes
    delete (raw.engine as Record<string, unknown>).events
    const save = migrateSave(raw)!
    expect(save.engine.scenes).toEqual({})
    expect(save.engine.events).toEqual({})
  })
})

describe('sceneObjectKey', () => {
  it('格式稳定，物件与角色共用同一套键', () => {
    expect(sceneObjectKey('start', 'hs_door')).toBe('start:hs_door')
    expect(sceneObjectKey('hall', 'hero')).toBe('hall:hero')
  })
})
