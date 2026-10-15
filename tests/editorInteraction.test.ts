import { describe, expect, it } from 'vitest'
import type { Interaction } from '../src/schema/scene.ts'
import {
  applyInteractionSummaryEdit,
  emptyEffect,
  summarizeEffects,
} from '../src/schema/scene.rules.ts'

/**
 * 编辑器改交互：必须**写穿到 effects**。
 *
 * 这个 bug 的形态很隐蔽：编辑器只改摘要字段（`action` / `emit` / `setState`…），
 * 而导出时解析会用 `summarizeEffects` 从 `effects` **反推**摘要字段。
 * 于是改一个 effects 型交互，UI 上显示新值、导出后被还原成旧值，
 * 全程不报任何错。
 *
 * 所以测试必须模拟"导出时反推"这一步 —— 只断言 effects 里的值变了是不够的。
 */
describe('摘要字段编辑要写穿到 effects', () => {
  /** 模拟导出：走一遍 summarizeEffects 的反推。 */
  const throughExport = (interaction: Interaction): Interaction =>
    ({ ...interaction, ...summarizeEffects(interaction.effects) }) as Interaction

  const edit = (interaction: unknown, patch: unknown): Interaction =>
    applyInteractionSummaryEdit(
      interaction as Record<string, unknown>,
      patch as Record<string, unknown>,
    ) as unknown as Interaction

  /** hall.json 里 hs_lamp 那种：显式 effects 的交互。 */
  const lampLike = {
    id: 'i1',
    verb: 'inspect',
    effects: [
      { ...emptyEffect('object.patch'), patch: { state: 'on' } },
      { ...emptyEffect('story.event'), name: 'lamp_lit' },
    ],
    action: '',
    setState: 'on',
    setVisible: null,
    emit: 'lamp_lit',
    sfx: null,
    item: null,
    accepts: [],
    when: null,
    progress: null,
  } as unknown as Interaction

  it('改事件名之后，导出反推出来的还是新值', () => {
    const edited = edit(lampLike, { emit: 'ZZ_NEW_EVENT' })

    expect(edited.effects.find((e) => e.type === 'story.event')?.name).toBe('ZZ_NEW_EVENT')
    // 这一步才是关键：反推不能把改动吞掉
    expect(throughExport(edited).emit, '导出把编辑还原了 —— 这正是原来的 bug').toBe('ZZ_NEW_EVENT')
  })

  it('改行动 knot 会改写 story.knot，没有就补一条', () => {
    const added = edit(lampLike, { action: 'ZZ_KNOT' })
    expect(throughExport(added).action).toBe('ZZ_KNOT')

    const updated = edit(added, { action: 'ZZ_KNOT_2' })
    // 不该越改越多
    expect(updated.effects.filter((e) => e.type === 'story.knot')).toHaveLength(1)
    expect(throughExport(updated).action).toBe('ZZ_KNOT_2')
  })

  it('改切状态会写进既有的 object.patch，而不是另起一条', () => {
    const edited = edit(lampLike, { setState: 'off' })
    expect(edited.effects.filter((e) => e.type === 'object.patch')).toHaveLength(1)
    expect(throughExport(edited).setState).toBe('off')
  })

  it('清空某个值会把对应的 effect 删掉，不留空壳', () => {
    const cleared = edit(lampLike, { emit: null })
    expect(cleared.effects.some((e) => e.type === 'story.event')).toBe(false)
    expect(throughExport(cleared).emit).toBeNull()
  })

  it('补丁被清空时不留一条什么都不做的 object.patch', () => {
    const only = {
      ...lampLike,
      effects: [{ ...emptyEffect('object.patch'), patch: { state: 'on' } }],
    } as unknown as Interaction
    const cleared = edit(only, { setState: null })
    expect(cleared.effects, '留下了一条空补丁').toHaveLength(0)
  })

  it('纯旧格式（没有 effects）照旧直接改摘要字段', () => {
    const legacy = {
      id: 'i2',
      verb: 'inspect',
      effects: [],
      action: '',
      emit: null,
    } as unknown as Interaction
    const edited = edit(legacy, { action: 'ZZ_OLD' })
    expect(edited.action).toBe('ZZ_OLD')
    expect(edited.effects).toHaveLength(0)
  })

  it('不改动的字段不会被顺手清掉', () => {
    const edited = edit(lampLike, { emit: 'ZZ_NEW' })
    // 原来那条 object.patch 必须原样还在
    expect(edited.effects.find((e) => e.type === 'object.patch')?.patch.state).toBe('on')
  })

  it('音效路径也能写穿', () => {
    const edited = edit(lampLike, { sfx: 'audio/sfx/zz.ogg' })
    expect(throughExport(edited).sfx).toBe('audio/sfx/zz.ogg')
  })
})
