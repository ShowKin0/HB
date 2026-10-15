import { describe, expect, it } from 'vitest'
import { SceneSchema } from '../src/schema/scene.ts'
import { editorSceneReducer, type EditorSceneState } from '../src/editor/editorSceneState.ts'

const scene = (id: string, title = id) => SceneSchema.parse({ id, title, mode: 'focus' })
const initial = (): EditorSceneState => editorSceneReducer({
  entries: [], activeKey: null, draft: null, drafts: new Map(), editedKeys: new Set(),
}, { type: 'load', scenes: [scene('hall'), scene('start')], startSceneId: 'start' })

const rename = (state: EditorSceneState, id: string) => editorSceneReducer(state, {
  type: 'patch', update: (draft) => ({ ...draft, id, title: '未导出的标题', bg: 'bg/edited.avif' }),
})
const select = (state: EditorSceneState, key: string) => editorSceneReducer(state, { type: 'select', key })

describe('Editor stable scene identity', () => {
  it('opens project.startScene and keeps renamed draft edits when switching away and back', () => {
    const loaded = initial()
    expect(loaded.activeKey).toBe('start')
    const edited = rename(loaded, 'start_renamed')
    const returned = select(select(edited, 'hall'), 'start')
    expect(returned.activeKey).toBe('start')
    expect(returned.draft).toMatchObject({ id: 'start_renamed', title: '未导出的标题', bg: 'bg/edited.avif' })
    expect(returned.editedKeys).toEqual(new Set(['start']))
    expect(returned.entries).toHaveLength(2)
    expect(returned.entries.find((entry) => entry.key === 'start')?.source.id).toBe('start')
  })

  it('does not merge drafts when a scene is renamed to another scene ID', () => {
    const edited = rename(initial(), 'hall')
    const originalHall = select(edited, 'hall')
    expect(originalHall.draft).toMatchObject({ id: 'hall', title: 'hall', bg: null })
    const editedHall = editorSceneReducer(originalHall, { type: 'patch', update: (draft) => ({ ...draft, title: '原 hall 的编辑' }) })
    expect(select(editedHall, 'start').draft?.title).toBe('未导出的标题')
    expect(select(select(editedHall, 'start'), 'hall').draft?.title).toBe('原 hall 的编辑')
  })

  it('new scene creation preserves renamed drafts and assigns a separate identity for collisions', () => {
    const edited = rename(initial(), 'scene_1')
    const added = editorSceneReducer(edited, { type: 'add', scene: scene('scene_1', '新建标题') })
    const newKey = added.activeKey!
    const renamedNew = rename(added, 'hall')
    const returned = select(select(renamedNew, 'start'), newKey)
    expect(returned.draft).toMatchObject({ id: 'hall', title: '未导出的标题' })
    expect(select(returned, 'start').draft?.id).toBe('scene_1')
    expect(returned.editedKeys).toEqual(new Set(['start', newKey]))

    const collision = editorSceneReducer(returned, { type: 'add', scene: scene('start') })
    expect(collision.activeKey).not.toBe('start')
    expect(new Set(collision.entries.map((entry) => entry.key)).size).toBe(4)
    expect(select(collision, 'start').draft?.id).toBe('scene_1')
  })

  it('selecting the current or an unknown key preserves the current draft', () => {
    const edited = rename(initial(), '')
    expect(select(edited, 'start')).toBe(edited)
    expect(select(edited, 'unknown')).toBe(edited)
    expect(select(select(edited, 'hall'), 'start').draft?.id).toBe('')
  })

  it('uses Map storage so author IDs such as __proto__ cannot affect draft identity', () => {
    const loaded = editorSceneReducer(initial(), { type: 'load', scenes: [scene('__proto__'), scene('hall')], startSceneId: '__proto__' })
    expect(select(select(rename(loaded, 'renamed'), 'hall'), '__proto__').draft?.id).toBe('renamed')
  })
})
