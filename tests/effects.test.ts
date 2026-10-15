import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SceneSchema } from '../src/schema/scene.ts'
import {
  effectsFromLegacy,
  normalizeScene,
  resolveInteractions,
  summarizeEffects,
} from '../src/schema/scene.rules.ts'

/**
 * 触发器 / 动作拆分。
 *
 * 核心承诺：**动作里没有 story.knot 时，整条交互完全不碰 ink。**
 * 纯物件操作因此可以独立成立 —— 通用引擎不该要求每条交互都跳转 knot，
 * 也不该要求有剧情。
 */

function sceneWith(interactions: unknown[], extra: Record<string, unknown> = {}): unknown {
  return {
    id: 's',
    mode: 'focus',
    hotspots: [
      {
        id: 'hs',
        shape: { type: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        interactions,
      },
    ],
    ...extra,
  }
}

describe('旧字段 → 动作列表', () => {
  it('setState / emit / sfx / action 各自变成一个动作，顺序稳定', () => {
    const effects = effectsFromLegacy({
      action: 'knot_a',
      setState: 'opened',
      setVisible: false,
      emit: 'thing_opened',
      sfx: 'sfx/click.ogg',
    })
    expect(effects.map((e) => e.type)).toEqual([
      'story.knot',
      'object.patch',
      'object.patch',
      'story.event',
      'audio.sfx',
    ])
    expect(effects[0].knot).toBe('knot_a')
    expect(effects[1].patch).toEqual({ state: 'opened' })
    expect(effects[2].patch).toEqual({ visible: false })
    expect(effects[3].name).toBe('thing_opened')
    expect(effects[4].path).toBe('sfx/click.ogg')
  })

  it('什么都没写就是空列表 —— 也就是"纯物件交互且无效果"', () => {
    expect(effectsFromLegacy({})).toEqual([])
  })

  it('object.patch 默认目标是 @self', () => {
    const effects = effectsFromLegacy({ setState: 'on' })
    expect(effects[0].target).toBe('@self')
  })
})

describe('动作列表 → 旧字段摘要', () => {
  it('反推出 action / setState / emit / sfx', () => {
    const summary = summarizeEffects([
      { type: 'story.knot', target: '@self', patch: {}, knot: 'k', name: '', path: '', item: '' },
      { type: 'object.patch', target: '@self', patch: { state: 'on' }, knot: '', name: '', path: '', item: '' },
      { type: 'story.event', target: '@self', patch: {}, knot: '', name: 'lit', path: '', item: '' },
    ])
    expect(summary.action).toBe('k')
    expect(summary.setState).toBe('on')
    expect(summary.emit).toBe('lit')
  })

  it('目标是别的物件时不影响自身摘要', () => {
    const summary = summarizeEffects([
      { type: 'object.patch', target: 'other', patch: { state: 'on' }, knot: '', name: '', path: '', item: '' },
    ])
    expect(summary.setState).toBeNull()
  })

  it('没有 story.knot 时 action 是空串，不是 null', () => {
    expect(summarizeEffects([]).action).toBe('')
  })
})

describe('旧 onClick / acceptsItem 合成的交互', () => {
  /*
   * 这条断言是补出来的回归守卫。
   *
   * 合成旧式交互时如果只是手写一个对象、不跑一遍动作推导，
   * effects 就会是空的 —— 交互能命中、解析也正常，但**执行时什么都不做**。
   * 单元测试全绿，只有端到端会炸。所以要在这里钉死"合成结果必须带动作"。
   */
  it('onClick 合成的交互必须带 story.knot 动作', () => {
    const scene = SceneSchema.parse({
      id: 's',
      mode: 'focus',
      hotspots: [
        {
          id: 'hs',
          shape: { type: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
          onClick: 'legacy_knot',
        },
      ],
    })
    const interactions = resolveInteractions(scene.hotspots[0])
    expect(interactions).toHaveLength(1)
    expect(interactions[0].action).toBe('legacy_knot')
    expect(interactions[0].effects.map((e) => e.type)).toEqual(['story.knot'])
    expect(interactions[0].effects[0].knot).toBe('legacy_knot')
  })

  it('acceptsItem + onUse 合成的交互同样带动作', () => {
    const scene = SceneSchema.parse({
      id: 's',
      mode: 'focus',
      hotspots: [
        {
          id: 'hs',
          shape: { type: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
          acceptsItem: 'item_key',
          onUse: 'legacy_use',
        },
      ],
    })
    const interactions = resolveInteractions(scene.hotspots[0])
    expect(interactions[0].verb).toBe('use')
    expect(interactions[0].item).toBe('item_key')
    expect(interactions[0].effects[0].knot).toBe('legacy_use')
  })

  it('真实内容里每个交互都至少有一个动作，或明确就是纯状态改动', () => {
    for (const file of ['start.json', 'hall.json', 'memory_table.json']) {
      // 内容文件带 UTF-8 BOM，JSON.parse 不认识它
      const raw = JSON.parse(
        readFileSync(path.join(process.cwd(), 'content', 'scenes', file), 'utf8').replace(/^\uFEFF/, ''),
      )
      const scene = SceneSchema.parse(raw)
      for (const hotspot of scene.hotspots) {
        for (const interaction of resolveInteractions(hotspot)) {
          expect(
            interaction.effects.length,
            `${file} 的 ${hotspot.id}(${interaction.verb}) 一个动作都没有 —— 点了不会有任何反应`,
          ).toBeGreaterThan(0)
        }
      }
    }
  })
})

describe('场景里的纯物件交互', () => {
  it('只写 effects 的交互可以没有 action', () => {
    const scene = SceneSchema.parse(
      sceneWith([
        {
          verb: 'inspect',
          effects: [{ type: 'object.patch', target: '@self', patch: { state: 'on' } }],
        },
      ]),
    )
    const interaction = scene.hotspots[0].interactions[0]
    expect(interaction.action).toBe('')
    expect(interaction.effects).toHaveLength(1)
    expect(interaction.effects[0].type).toBe('object.patch')
    expect(interaction.setState).toBe('on')
  })

  it('Zod 与 normalizeScene 对纯物件交互的结果完全一致', () => {
    const raw = sceneWith([
      {
        verb: 'inspect',
        effects: [
          { type: 'object.patch', target: '@self', patch: { state: 'on' } },
          { type: 'story.event', name: 'lamp_lit' },
        ],
      },
    ])
    expect(normalizeScene(raw)).toEqual(SceneSchema.parse(raw))
  })

  it('没有 effects 时两条路径都会从旧字段补出来', () => {
    const raw = sceneWith([{ verb: 'inspect', action: 'knot_a', setState: 'opened' }])
    const viaZod = SceneSchema.parse(raw)
    const viaNormalize = normalizeScene(raw)
    expect(viaZod).toEqual(viaNormalize)
    expect(viaZod.hotspots[0].interactions[0].effects.map((e) => e.type)).toEqual([
      'story.knot',
      'object.patch',
    ])
  })

  it('item.consume 与"用完取消选中"是分开的两件事', () => {
    const scene = SceneSchema.parse(
      sceneWith([
        {
          verb: 'use',
          item: 'item_key',
          // 只跳剧情，**不消耗**物品
          effects: [{ type: 'story.knot', knot: 'use_key' }],
        },
      ]),
    )
    const interaction = scene.hotspots[0].interactions[0]
    expect(interaction.effects.some((e) => e.type === 'item.consume')).toBe(false)
  })

  it('未知的动作类型回落到 object.patch，而不是让运行时拿到不认识的东西', () => {
    const scene = normalizeScene(
      sceneWith([{ verb: 'inspect', effects: [{ type: 'nonsense' }] }]),
    )
    expect(scene.hotspots[0].interactions[0].effects[0].type).toBe('object.patch')
  })
})
