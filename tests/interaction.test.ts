import { describe, expect, it, vi } from 'vitest'
import {
  HotspotSchema,
  SceneSchema,
  resolveInteractions,
  resolveSceneMode,
  type Hotspot,
  type Interaction,
} from '../src/schema/scene.ts'
import {
  acceptsDrop,
  eventNameFor,
  resolveClick,
  resolveDrop,
  type InteractionContext,
} from '../src/engine/interaction/resolver.ts'
import { resolveObjectState } from '../src/engine/interaction/events.ts'
import { animOffset } from '../src/engine/scene/runtime.ts'

describe('多 use 条件分支', () => {
  it('第一条条件不成立时继续寻找同物品的可用交互', () => {
    const hotspot = makeHotspot({ interactions: [
      { verb: 'use', item: 'key', when: 'locked', action: 'unlock' },
      { verb: 'use', item: 'key', when: 'opened', action: 'inspect_open' },
    ] })
    expect(resolveClick(hotspot, { selectedItem: 'key', evaluate: (name) => name === 'opened' }).intent?.interaction.action).toBe('inspect_open')
  })
})

/**
 * 交互层。
 *
 * 这是本次架构升级的核心：输入不再直接跳 knot，而是先解析成一条明确的
 * "交互意图"，再由上层统一执行（改场景状态 → 发事件 → 推进剧情）。
 * 解析器是纯函数，所以这些规则可以完整地钉在这里，不用起浏览器。
 */

function makeHotspot(partial: Record<string, unknown> = {}): Hotspot {
  return HotspotSchema.parse({
    id: 'hs',
    shape: { type: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    ...partial,
  })
}

function makeInteraction(partial: Partial<Interaction> = {}): Interaction {
  return {
    verb: 'inspect',
    when: null,
    item: null,
    accepts: [],
    action: 'do_it',
    setState: null,
    setVisible: null,
    emit: null,
    sfx: null,
    effects: [],
    ...partial,
  }
}

/** 条件函数表：只有列出来的名字为真。 */
function ctxWith(truthy: string[], selectedItem: string | null = null): InteractionContext {
  return {
    selectedItem,
    evaluate: (name) => truthy.includes(name),
  }
}

describe('resolveClick', () => {
  it('普通点击命中 inspect', () => {
    const hs = makeHotspot({ interactions: [makeInteraction({ action: 'look' })] })
    const result = resolveClick(hs, ctxWith([]))
    expect(result.intent?.kind).toBe('inspect')
    expect(result.intent?.interaction.action).toBe('look')
  })

  it('手上拿着匹配的物品时优先走 use', () => {
    const hs = makeHotspot({
      interactions: [
        makeInteraction({ verb: 'inspect', action: 'look' }),
        makeInteraction({ verb: 'use', item: 'item_key', action: 'unlock' }),
      ],
    })
    const result = resolveClick(hs, ctxWith([], 'item_key'))
    expect(result.intent?.kind).toBe('use')
    expect(result.intent?.interaction.action).toBe('unlock')
  })

  it('手上的物品不匹配时回落到 inspect', () => {
    const hs = makeHotspot({
      interactions: [
        makeInteraction({ verb: 'inspect', action: 'look' }),
        makeInteraction({ verb: 'use', item: 'item_key', action: 'unlock' }),
      ],
    })
    const result = resolveClick(hs, ctxWith([], 'item_cloth'))
    expect(result.intent?.kind).toBe('inspect')
  })

  it('条件不成立时返回 condition-failed 而不是静默无事发生', () => {
    const hs = makeHotspot({
      interactions: [makeInteraction({ when: 'can_open', action: 'open' })],
    })
    const result = resolveClick(hs, ctxWith([]))
    expect(result.intent).toBeNull()
    expect(result.failure).toBe('condition-failed')
  })

  it('条件成立时才真的命中', () => {
    const hs = makeHotspot({
      interactions: [makeInteraction({ when: 'can_open', action: 'open' })],
    })
    expect(resolveClick(hs, ctxWith(['can_open'])).intent?.interaction.action).toBe('open')
  })

  it('多条 inspect 按声明顺序取第一条满足条件的', () => {
    const hs = makeHotspot({
      interactions: [
        makeInteraction({ when: 'first_ok', action: 'first' }),
        makeInteraction({ action: 'second' }),
      ],
    })
    expect(resolveClick(hs, ctxWith(['first_ok'])).intent?.interaction.action).toBe('first')
    expect(resolveClick(hs, ctxWith([])).intent?.interaction.action).toBe('second')
  })

  it('未实现的动词会告警且不命中', () => {
    const warn = vi.fn()
    const hs = makeHotspot({ interactions: [makeInteraction({ verb: 'sequence', action: 'seq' })] })
    const result = resolveClick(hs, { ...ctxWith([]), warn })
    expect(result.intent).toBeNull()
    expect(result.failure).toBe('unimplemented')
    expect(warn).toHaveBeenCalledOnce()
  })

  it('长按只匹配 hold 交互，不会误触发 inspect', () => {
    const hs = makeHotspot({
      interactions: [
        makeInteraction({ verb: 'inspect', action: 'look' }),
        makeInteraction({ verb: 'hold', action: 'open' }),
      ],
    })
    expect(resolveClick(hs, ctxWith([]), 'tap').intent?.interaction.action).toBe('look')

    const hold = resolveClick(hs, ctxWith([]), 'hold')
    expect(hold.intent?.kind).toBe('hold')
    expect(hold.intent?.interaction.action).toBe('open')
  })

  it('没有 hold 交互时，长按不命中任何东西', () => {
    const hs = makeHotspot({ interactions: [makeInteraction({ verb: 'inspect', action: 'look' })] })
    expect(resolveClick(hs, ctxWith([]), 'hold').failure).toBe('no-interaction')
    expect(resolveClick(hs, ctxWith([]), 'tap').intent?.interaction.action).toBe('look')
  })

  it('长按也会走 when 条件', () => {
    const hs = makeHotspot({
      interactions: [makeInteraction({ verb: 'hold', when: 'can_open', action: 'open' })],
    })
    expect(resolveClick(hs, ctxWith([]), 'hold').failure).toBe('condition-failed')
    expect(resolveClick(hs, ctxWith(['can_open']), 'hold').intent?.interaction.action).toBe('open')
  })

  it('长按时手上的物品不参与匹配', () => {
    const hs = makeHotspot({
      interactions: [
        makeInteraction({ verb: 'use', item: 'item_key', action: 'unlock' }),
        makeInteraction({ verb: 'hold', action: 'open' }),
      ],
    })
    // 拿着钥匙长按：应当走 hold，而不是 use
    expect(resolveClick(hs, ctxWith([], 'item_key'), 'hold').intent?.interaction.action).toBe('open')
  })

  it('没有交互的物件返回 no-interaction', () => {
    const hs = makeHotspot({ onClick: 'legacy_look' })
    // onClick 会被合成成 inspect，所以这里其实能命中
    expect(resolveClick(hs, ctxWith([])).intent?.interaction.action).toBe('legacy_look')

    const empty = makeHotspot({ interactions: [makeInteraction({ verb: 'drag', accepts: ['x'] })] })
    expect(resolveClick(empty, ctxWith([])).failure).toBe('no-interaction')
  })
})

describe('resolveDrop', () => {
  const target = (accepts: string[], when: string | null = null) =>
    makeHotspot({
      interactions: [
        makeInteraction({ verb: 'inspect', action: 'look' }),
        makeInteraction({ verb: 'drag', accepts, when, action: 'place' }),
      ],
    })

  it('接受的物品命中 drag', () => {
    const result = resolveDrop(target(['item_photo']), 'item_photo', ctxWith([]))
    expect(result.intent?.kind).toBe('drag')
    expect(result.intent?.interaction.action).toBe('place')
  })

  it('不接受的物品不命中', () => {
    const result = resolveDrop(target(['item_photo']), 'item_key', ctxWith([]))
    expect(result.intent).toBeNull()
    expect(result.failure).toBe('no-interaction')
  })

  it('条件不成立时是 condition-failed', () => {
    const result = resolveDrop(target(['item_photo'], 'can_place'), 'item_photo', ctxWith([]))
    expect(result.failure).toBe('condition-failed')
  })

  it('acceptsDrop 用于 hover 提示', () => {
    expect(acceptsDrop(target(['item_photo']), 'item_photo', ctxWith([]))).toBe(true)
    expect(acceptsDrop(target(['item_photo']), 'item_key', ctxWith([]))).toBe(false)
  })
})

describe('resolveInteractions 旧字段兼容', () => {
  it('onClick 合成成 inspect', () => {
    const hs = makeHotspot({ onClick: 'look_shelf' })
    const list = resolveInteractions(hs)
    expect(list).toHaveLength(1)
    expect(list[0].verb).toBe('inspect')
    expect(list[0].action).toBe('look_shelf')
  })

  it('acceptsItem + onUse 合成成 use', () => {
    const hs = makeHotspot({ onClick: 'try_door', acceptsItem: 'item_key', onUse: 'use_key' })
    const list = resolveInteractions(hs)
    expect(list.map((i) => i.verb)).toEqual(['inspect', 'use'])
    expect(list[1].item).toBe('item_key')
  })

  it('只有 acceptsItem 没有 onUse 时不合成（旧行为就是点了没反应）', () => {
    const hs = makeHotspot({ onClick: 'look', acceptsItem: 'item_key' })
    expect(resolveInteractions(hs).map((i) => i.verb)).toEqual(['inspect'])
  })

  it('显式写了 interactions 时旧字段被完全忽略', () => {
    const hs = makeHotspot({
      onClick: 'legacy',
      interactions: [makeInteraction({ action: 'new_way' })],
    })
    expect(resolveInteractions(hs).map((i) => i.action)).toEqual(['new_way'])
  })
})

describe('eventNameFor', () => {
  it('默认由物件 id + 动词推导', () => {
    const hs = makeHotspot({ id: 'photo_frame' })
    expect(eventNameFor(hs, makeInteraction({ verb: 'inspect' }))).toBe('photo_frame_inspect')
  })

  it('显式 emit 覆盖默认名', () => {
    const hs = makeHotspot({ id: 'photo_frame' })
    expect(eventNameFor(hs, makeInteraction({ emit: 'frame_opened' }))).toBe('frame_opened')
  })
})

describe('resolveObjectState', () => {
  it('没有存档时用场景初值', () => {
    const state = resolveObjectState({ visible: true, state: 'closed', position: [0.3, 0.4] }, undefined)
    expect(state).toEqual({ visible: true, state: 'closed', position: [0.3, 0.4], progress: 0 })
  })

  it('存档逐字段覆盖初值', () => {
    const state = resolveObjectState(
      { visible: true, state: 'closed', position: [0.3, 0.4] },
      { state: 'opened', progress: 0.5 },
    )
    expect(state.state).toBe('opened')
    expect(state.progress).toBe(0.5)
    // 存档没提到的字段保持初值
    expect(state.position).toEqual([0.3, 0.4])
    expect(state.visible).toBe(true)
  })

  it('存档可以把物件隐藏', () => {
    const state = resolveObjectState({ visible: true }, { visible: false })
    expect(state.visible).toBe(false)
  })
})

describe('resolveSceneMode', () => {
  it('显式 mode 优先', () => {
    expect(resolveSceneMode({ mode: 'focus', ground: null, actors: [] })).toBe('focus')
    expect(resolveSceneMode({ mode: 'walk', ground: null, actors: [] })).toBe('walk')
  })

  it('没写 mode 时按有没有地面和角色推断', () => {
    const actor = { id: 'a' } as never
    expect(resolveSceneMode({ mode: null, ground: { corners: [] } as never, actors: [actor] })).toBe('walk')
    expect(resolveSceneMode({ mode: null, ground: null, actors: [] })).toBe('focus')
  })
})

describe('SceneSchema 的模式约束', () => {
  const base = { id: 's', mode: 'focus' as const }

  it('focus 模式不允许有角色', () => {
    const result = SceneSchema.safeParse({
      ...base,
      actors: [{ id: 'hero', spawn: [0.5, 0.5] }],
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.some((i) => i.path.join('.') === 'actors')).toBe(true)
  })

  it('focus 模式不允许有地面', () => {
    const result = SceneSchema.safeParse({
      ...base,
      ground: { corners: [[0, 0], [1, 0], [1, 1], [0, 1]] },
    })
    expect(result.success).toBe(false)
  })

  it('walk 模式必须有地面', () => {
    const result = SceneSchema.safeParse({ id: 's', mode: 'walk' })
    expect(result.success).toBe(false)
    expect(result.error?.issues.some((i) => i.path.join('.') === 'ground')).toBe(true)
  })

  it('focus 场景只要物件就能成立', () => {
    const result = SceneSchema.safeParse({
      ...base,
      hotspots: [{ id: 'h', shape: { type: 'rect', x: 0, y: 0, w: 0.1, h: 0.1 }, onClick: 'k' }],
    })
    expect(result.success).toBe(true)
  })

  it('没有交互也没有 onClick 的物件会被拒绝', () => {
    const result = SceneSchema.safeParse({
      ...base,
      hotspots: [{ id: 'h', shape: { type: 'rect', x: 0, y: 0, w: 0.1, h: 0.1 } }],
    })
    expect(result.success).toBe(false)
  })

  it('同场景内 id 不能重复', () => {
    const result = SceneSchema.safeParse({
      ...base,
      hotspots: [
        { id: 'dup', shape: { type: 'rect', x: 0, y: 0, w: 0.1, h: 0.1 }, onClick: 'k' },
        { id: 'dup', shape: { type: 'rect', x: 0.2, y: 0, w: 0.1, h: 0.1 }, onClick: 'k' },
      ],
    })
    expect(result.success).toBe(false)
  })
})

describe('animOffset', () => {
  const anim = (type: 'none' | 'float' | 'sway' | 'pulse', amplitude = 0.01) =>
    ({ type, amplitude, speed: 1, phase: 0 }) as const

  it('none 不产生任何偏移', () => {
    expect(animOffset(anim('none'), 3.7)).toEqual({ dx: 0, dy: 0, scale: 1, rotation: 0 })
  })

  it('float 只上下动', () => {
    const at = animOffset(anim('float'), 0.25)
    expect(at.dx).toBe(0)
    expect(Math.abs(at.dy)).toBeCloseTo(0.01, 6)
    expect(at.scale).toBe(1)
  })

  it('sway 左右摆并带一点旋转', () => {
    const at = animOffset(anim('sway'), 0.25)
    expect(Math.abs(at.dx)).toBeCloseTo(0.01, 6)
    expect(at.rotation).not.toBe(0)
    expect(at.dy).toBe(0)
  })

  it('pulse 只改缩放', () => {
    const at = animOffset(anim('pulse'), 0.25)
    expect(at.dx).toBe(0)
    expect(at.dy).toBe(0)
    expect(at.scale).not.toBe(1)
  })

  it('幅度为 0 时退化成静止', () => {
    expect(animOffset(anim('float', 0), 1.3)).toEqual({ dx: 0, dy: 0, scale: 1, rotation: 0 })
  })

  it('相位不同则同一时刻的偏移不同（用于错开多个物件）', () => {
    const a = animOffset({ type: 'float', amplitude: 0.01, speed: 1, phase: 0 }, 0)
    const b = animOffset({ type: 'float', amplitude: 0.01, speed: 1, phase: 1.5 }, 0)
    expect(a.dy).not.toBeCloseTo(b.dy, 4)
  })
})
