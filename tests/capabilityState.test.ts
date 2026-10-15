import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_NAMESPACE_COUNT,
  CAPABILITY_NAMESPACE_LIMIT_BYTES,
  SAVE_VERSION,
  emptyEngineState,
  migrateSave,
  sanitizeCapabilityState,
} from '../src/schema/save.ts'

/**
 * 能力状态：引擎只保存、不解释。
 *
 * 好感度、相册、日历、聊天记录这些**概念不进核心** —— 引擎不知道
 * `affection` 里放的是数字还是对象，也不知道它代表什么。
 *
 * 所以这里的用例全部围绕"结构上安全"，而不是任何业务语义：
 * 能不能往返、坏数据会不会拖垮整份存档、有没有体积上限。
 */

describe('净化：只做结构性约束', () => {
  it('循环对象被拒绝，不抛栈溢出；重复引用不是循环', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(sanitizeCapabilityState({ bad: cyclic, good: { a: 1 } })).toEqual({ state: { good: { a: 1 } }, dropped: ['bad'] })
    const shared = { score: 1 }
    expect(sanitizeCapabilityState({ good: { a: shared, b: shared } }).dropped).toEqual([])
  })
  it('不是对象时整块丟掉', () => {
    for (const value of [null, undefined, 42, 'x', [], true]) {
      expect(sanitizeCapabilityState(value).state).toEqual({})
    }
  })

  it('跳过 __proto__ 这类键 —— 存档可能被手改过', () => {
    const raw = JSON.parse('{"affection": {"v": 1}, "__proto__": {"polluted": true}}') as unknown
    const { state } = sanitizeCapabilityState(raw)
    expect(Object.keys(state)).toEqual(['affection'])
    // 原型不能被改掉
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('丢掉不能往返 JSON 的值', () => {
    const { state, dropped } = sanitizeCapabilityState({
      good: { score: 3 },
      fn: () => undefined,
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      undef: undefined,
    })
    expect(Object.keys(state)).toEqual(['good'])
    expect(dropped.sort()).toEqual(['fn', 'inf', 'nan', 'undef'])
  })

  it('嵌套里的坏值也会被发现', () => {
    const { state, dropped } = sanitizeCapabilityState({ nested: { list: [1, Number.NaN] } })
    expect(state).toEqual({})
    expect(dropped).toEqual(['nested'])
  })

  it('数组和 null 是合法值 —— 引擎不该假设能力存的是什么形状', () => {
    const { state } = sanitizeCapabilityState({ album: [1, 2, 3], chat: null, count: 0 })
    expect(state.album).toEqual([1, 2, 3])
    expect(state.chat).toBeNull()
    expect(state.count).toBe(0)
  })

  it('单个命名空间超限时只丢它自己，不牵连整份存档', () => {
    const huge = 'x'.repeat(CAPABILITY_NAMESPACE_LIMIT_BYTES + 10)
    const { state, dropped } = sanitizeCapabilityState({ huge, small: { v: 1 } })
    expect(dropped).toEqual(['huge'])
    expect(state.small, '为了一个超大的命名空间把别的也丢了，等于因小失大').toEqual({ v: 1 })
  })

  it('命名空间太多时按体积从大到小丢，保住尽量多的能力', () => {
    const many: Record<string, unknown> = {}
    for (let i = 0; i < CAPABILITY_NAMESPACE_COUNT + 5; i++) {
      many[`ns${i}`] = { pad: 'y'.repeat(i * 10) }
    }
    const { state, dropped } = sanitizeCapabilityState(many)
    expect(Object.keys(state).length).toBe(CAPABILITY_NAMESPACE_COUNT)
    expect(dropped.length).toBe(5)
    // 被丢掉的应该是体积最大的那批，而不是碰巧排在后面的
    expect(dropped.some((key) => key === `ns${CAPABILITY_NAMESPACE_COUNT + 4}`)).toBe(true)
  })

  it('空对象是合法的', () => {
    expect(sanitizeCapabilityState({}).state).toEqual({})
  })
})

describe('存档迁移', () => {
  const base = {
    createdAt: 1,
    updatedAt: 2,
    label: '测试',
    contentVersion: 'abc',
    inkState: '{}',
    engine: {
      sceneId: 'start',
      actorPositions: {},
      actorFacing: {},
      inventory: [],
      flags: {},
      scenes: {},
      events: {},
      visitedScenes: ['start'],
      playMs: 100,
      checkpoint: { line: null },
    },
  }

  it('v2 存档补上空的能力状态，不判为损坏', () => {
    const save = migrateSave({ ...base, saveVersion: 2 })
    expect(save, '老存档不该因为少一个字段就整个作废').not.toBeNull()
    expect(save!.engine.capabilities).toEqual({})
    expect(save!.saveVersion).toBe(SAVE_VERSION)
  })

  it('v1 存档经过两次迁移也能落地', () => {
    const v1 = {
      ...base,
      saveVersion: 1,
      engine: { ...base.engine, actorPositions: { hero: [0.5, 0.5] } },
    }
    const save = migrateSave(v1)
    expect(save).not.toBeNull()
    // v1→v2 把键挂到当前场景上
    expect(save!.engine.actorPositions).toEqual({ 'start:hero': [0.5, 0.5] })
    // v2→v3 补上能力状态
    expect(save!.engine.capabilities).toEqual({})
  })

  it('v3 存档里的能力状态原样保留', () => {
    const v3 = {
      ...base,
      saveVersion: 3,
      engine: { ...base.engine, capabilities: { affection: { score: 7 }, album: [1, 2] } },
    }
    const save = migrateSave(v3)
    expect(save!.engine.capabilities).toEqual({ affection: { score: 7 }, album: [1, 2] })
  })

  it('能力状态坏掉不会拖垮整份存档', () => {
    const broken = { ...base, saveVersion: 3, engine: { ...base.engine, capabilities: 'nonsense' } }
    const save = migrateSave(broken)
    expect(save, '一块扩展状态坏了不该让玩家丢进度').not.toBeNull()
    expect(save!.engine.capabilities).toEqual({})
    expect(save!.engine.sceneId).toBe('start')
  })

  it('新存档自带空的命名空间', () => {
    expect(emptyEngineState('start').capabilities).toEqual({})
  })

  it('存档版本是 4，v3 台词检查点补齐待切场景和阶段', () => {
    expect(SAVE_VERSION).toBe(4)
    const save = migrateSave({ ...base, saveVersion: 3, engine: { ...base.engine, checkpoint: { line: { text: 'old', speaker: null, portrait: null } } } })!
    expect(save.engine.checkpoint).toEqual({ line: { text: 'old', speaker: null, portrait: null }, pendingSceneId: null, storyPhase: 'interaction' })
  })
})
