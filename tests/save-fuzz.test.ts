import { describe, expect, it } from 'vitest'
import { SAVE_VERSION, emptyEngineState, migrateSave, type Save } from '../src/schema/save.ts'

/**
 * 存档的健壮性。
 *
 * 存档是**唯一从外部进来的数据**（localStorage 里可能是上个版本写的、
 * 手改的、或者被别的程序覆盖过的），所以它必须满足两条：
 *
 *   1. 解析**永不抛异常** —— 一个坏存档不能让玩家看到白屏
 *   2. 解析成功时，结果**结构一定合法** —— 下游代码可以不再防守
 *
 * 这两条靠读代码看不出来，得拿畸形数据砸。
 */

function validSave(): Save {
  const engine = emptyEngineState()
  return {
    saveVersion: SAVE_VERSION,
    createdAt: 1000,
    updatedAt: 2000,
    label: '存档 1',
    contentVersion: 'abc-def',
    saveCompatibility: '1',
    inkState: JSON.stringify({ flows: {} }),
    engine: {
      ...engine,
      sceneId: 'start',
      actorPositions: { 'start:hero': [0.3, 0.7] },
      actorFacing: { 'start:hero': -1 },
      inventory: ['item_key'],
      flags: { met_her: true, count: 3, name: 'x' },
      scenes: { 'start:hs_door': { state: 'unlocked' } },
      events: { key_taken: 1 },
      visitedScenes: ['start'],
      playMs: 12345,
      checkpoint: { line: { text: '你好', speaker: '旁白', portrait: null }, pendingSceneId: null, storyPhase: 'interaction' },
    },
  }
}

/** 从一份合法存档派生出一堆畸形变体。 */
function mutants(): { name: string; value: unknown }[] {
  const base = validSave() as unknown as Record<string, unknown>
  const engineOf = (patch: Record<string, unknown>): Record<string, unknown> => ({
    ...base,
    engine: { ...(base.engine as Record<string, unknown>), ...patch },
  })

  const out: { name: string; value: unknown }[] = [
    { name: 'null', value: null },
    { name: 'undefined', value: undefined },
    { name: '数字', value: 42 },
    { name: '字符串', value: 'nope' },
    { name: '数组', value: [1, 2, 3] },
    { name: '空对象', value: {} },
    { name: '版本号是字符串', value: { ...base, saveVersion: '2' } },
    { name: '版本号是小数', value: { ...base, saveVersion: 1.5 } },
    { name: '版本号是 0', value: { ...base, saveVersion: 0 } },
    { name: '版本号是负数', value: { ...base, saveVersion: -1 } },
    { name: '版本号来自未来', value: { ...base, saveVersion: SAVE_VERSION + 1 } },
    { name: 'inkState 不是字符串', value: { ...base, inkState: 123 } },
    { name: 'createdAt 是 NaN', value: { ...base, createdAt: Number.NaN } },
    { name: 'createdAt 是 Infinity', value: { ...base, createdAt: Number.POSITIVE_INFINITY } },
    { name: 'label 缺失', value: { ...base, label: undefined } },
    { name: 'engine 是 null', value: { ...base, engine: null } },
    { name: 'engine 是数组', value: { ...base, engine: [] } },
    { name: 'sceneId 是数字', value: engineOf({ sceneId: 7 }) },
    { name: 'playMs 是负数', value: engineOf({ playMs: -5 }) },
    { name: 'playMs 是巨大值', value: engineOf({ playMs: 1e300 }) },
    { name: 'inventory 混入数字', value: engineOf({ inventory: ['a', 3] }) },
    { name: 'inventory 缺失', value: engineOf({ inventory: undefined }) },
    { name: 'inventory 是对象', value: engineOf({ inventory: {} }) },
    { name: 'visitedScenes 缺失', value: engineOf({ visitedScenes: undefined }) },
    { name: 'events 计数为负', value: engineOf({ events: { a: -1 } }) },
    { name: 'events 计数是字符串', value: engineOf({ events: { a: '1' } }) },
    { name: 'actorFacing 非 ±1', value: engineOf({ actorFacing: { 'a:b': 0.5 } }) },
    { name: 'actorPositions 越界', value: engineOf({ actorPositions: { 'a:b': [9, -9] } }) },
    { name: 'actorPositions 是三元组', value: engineOf({ actorPositions: { 'a:b': [0.1, 0.2, 0.3] } }) },
    { name: 'scenes 里混了坏条目', value: engineOf({ scenes: { good: { state: 'x' }, bad: { state: 9 } } }) },
    { name: 'checkpoint 缺 text', value: engineOf({ checkpoint: { line: { speaker: 'x' } } }) },
    { name: 'checkpoint 是字符串', value: engineOf({ checkpoint: 'x' }) },
  ]

  // 深嵌套与超大数组：确认不会爆栈或卡死
  out.push({ name: '深层嵌套 engine', value: { ...base, engine: { engine: { engine: {} } } } })

  return out
}

describe('存档解析永不抛异常', () => {
  it('所有畸形输入都返回 null 或合法存档，不抛', () => {
    for (const { name, value } of mutants()) {
      expect(() => migrateSave(value), `输入：${name}`).not.toThrow()
    }
  })

  it('JSON 往返一圈仍然稳定', () => {
    for (const { name, value } of mutants()) {
      // JSON.stringify(undefined) 返回 undefined（不是字符串），那种输入没法走往返
      let text: string | undefined
      try {
        text = JSON.stringify(value)
      } catch {
        continue
      }
      if (typeof text !== 'string') continue
      expect(() => migrateSave(JSON.parse(text)), `输入：${name}`).not.toThrow()
    }
  })
})

describe('解析成功时结构必须合法', () => {
  const parsed = mutants()
    .map(({ name, value }) => ({ name, save: migrateSave(value) }))
    .filter((entry): entry is { name: string; save: Save } => entry.save !== null)

  it('至少有一部分畸形输入被成功降级（不是一律拒绝）', () => {
    expect(parsed.length).toBeGreaterThan(0)
  })

  for (const { name, save } of parsed) {
    it(`${name} → 结果结构合法`, () => {
      expect(save.saveVersion).toBe(SAVE_VERSION)
      expect(Number.isFinite(save.createdAt)).toBe(true)
      expect(Number.isFinite(save.updatedAt)).toBe(true)
      expect(typeof save.label).toBe('string')
      expect(typeof save.inkState).toBe('string')

      const e = save.engine
      expect(e.sceneId === null || typeof e.sceneId === 'string').toBe(true)
      expect(Number.isFinite(e.playMs), 'playMs 必须是有限数').toBe(true)
      expect(e.playMs, 'playMs 不能是负数').toBeGreaterThanOrEqual(0)

      for (const item of e.inventory) expect(typeof item).toBe('string')
      for (const scene of e.visitedScenes) expect(typeof scene).toBe('string')

      for (const [key, pos] of Object.entries(e.actorPositions)) {
        expect(Array.isArray(pos), `${key} 必须是元组`).toBe(true)
        expect(pos).toHaveLength(2)
        expect(pos[0], `${key} 的 u 必须在 0..1`).toBeGreaterThanOrEqual(0)
        expect(pos[0], `${key} 的 u 必须在 0..1`).toBeLessThanOrEqual(1)
        expect(pos[1], `${key} 的 v 必须在 0..1`).toBeGreaterThanOrEqual(0)
        expect(pos[1], `${key} 的 v 必须在 0..1`).toBeLessThanOrEqual(1)
      }

      for (const [key, facing] of Object.entries(e.actorFacing)) {
        expect([-1, 1], `${key} 的朝向只能是 ±1`).toContain(facing)
      }

      for (const [key, count] of Object.entries(e.events)) {
        expect(count, `${key} 的事件计数不能为负`).toBeGreaterThanOrEqual(0)
        expect(Number.isFinite(count)).toBe(true)
      }

      for (const state of Object.values(e.scenes)) {
        if ('visible' in state) expect(typeof state.visible).toBe('boolean')
        if ('state' in state) expect(typeof state.state).toBe('string')
      }

      if (e.checkpoint.line) {
        expect(typeof e.checkpoint.line.text).toBe('string')
        expect(e.checkpoint.line.text.length, '空的检查点台词等于没有').toBeGreaterThan(0)
      }
    })
  }
})

describe('缺失的可选字段按默认值补齐，而不是判为损坏', () => {
  it('v1 存档缺 inventory / visitedScenes / scenes 仍然能读', () => {
    const v1 = {
      saveVersion: 1,
      createdAt: 1,
      updatedAt: 2,
      label: '旧存档',
      contentVersion: '',
      inkState: '{}',
      engine: {
        sceneId: 'start',
        actorPositions: { hero: [0.5, 0.5] },
        actorFacing: { hero: 1 },
        // inventory / visitedScenes / scenes / events 全都没有
        playMs: 100,
      },
    }
    const save = migrateSave(v1)
    expect(save, '缺可选字段不该让整个存档作废').not.toBeNull()
    expect(save!.engine.inventory).toEqual([])
    expect(save!.engine.visitedScenes).toEqual([])
    expect(save!.engine.scenes).toEqual({})
    expect(save!.engine.events).toEqual({})
    expect(save!.engine.checkpoint.line).toBeNull()
  })

  it('v1 的角色位置被重挂到当前场景上', () => {
    const save = migrateSave({
      saveVersion: 1,
      createdAt: 1,
      updatedAt: 2,
      label: 'x',
      contentVersion: '',
      inkState: '{}',
      engine: {
        sceneId: 'hall',
        actorPositions: { hero: [0.2, 0.8] },
        actorFacing: { hero: -1 },
        playMs: 0,
      },
    })
    expect(save!.engine.actorPositions).toEqual({ 'hall:hero': [0.2, 0.8] })
    expect(save!.engine.actorFacing).toEqual({ 'hall:hero': -1 })
  })

  it('已经是新格式的键不会被重复加前缀', () => {
    const save = migrateSave({
      saveVersion: 1,
      createdAt: 1,
      updatedAt: 2,
      label: 'x',
      contentVersion: '',
      inkState: '{}',
      engine: {
        sceneId: 'hall',
        actorPositions: { 'start:hero': [0.1, 0.2] },
        actorFacing: {},
        playMs: 0,
      },
    })
    expect(Object.keys(save!.engine.actorPositions)).toEqual(['start:hero'])
  })
})

describe('数据来源不可信时的额外防线', () => {
  it('不会污染 Object.prototype', () => {
    const evil = JSON.parse(
      '{"saveVersion":2,"createdAt":1,"updatedAt":1,"label":"x","contentVersion":"","inkState":"{}",' +
        '"engine":{"sceneId":null,"playMs":0,"inventory":[],"visitedScenes":[],' +
        '"flags":{"__proto__":{"polluted":true}},"events":{},"scenes":{},"actorPositions":{},"actorFacing":{}}}',
    )
    migrateSave(evil)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('超大 playMs 会被夹到有限值或被拒绝', () => {
    const save = migrateSave({
      ...(validSave() as unknown as Record<string, unknown>),
      engine: { ...validSave().engine, playMs: 1e300 },
    })
    if (save) expect(Number.isFinite(save.engine.playMs)).toBe(true)
  })
})

describe('自己写出来的存档必须能原样读回来', () => {
  it('往返后深相等', () => {
    const save = validSave()
    const round = migrateSave(JSON.parse(JSON.stringify(save)))
    expect(round).toEqual(save)
  })
})
