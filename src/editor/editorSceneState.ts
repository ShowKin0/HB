import type { Scene } from '../schema/scene.ts'

export interface EditorSceneState {
  entries: { key: string; source: Scene }[]
  activeKey: string | null
  draft: Scene | null
  drafts: Map<string, Scene>
  editedKeys: Set<string>
}
export type EditorSceneAction =
  | { type: 'load'; scenes: Scene[]; startSceneId: string | null }
  | { type: 'patch'; update: (scene: Scene) => Scene }
  | { type: 'select'; key: string }
  | { type: 'add'; scene: Scene }
export const EMPTY_EDITOR_SCENES: EditorSceneState = { entries: [], activeKey: null, draft: null, drafts: new Map(), editedKeys: new Set() }
const cloneScene = (scene: Scene): Scene => JSON.parse(JSON.stringify(scene)) as Scene
function unusedSceneKey(keys: readonly string[], preferred: string): string {
  let key = preferred, suffix = 1
  while (keys.includes(key)) key = `${preferred}#${suffix++}`
  return key
}
export function editorSceneReducer(state: EditorSceneState, action: EditorSceneAction): EditorSceneState {
  if (action.type === 'load') {
    const entries: EditorSceneState['entries'] = []
    for (const source of action.scenes) entries.push({ key: unusedSceneKey(entries.map((entry) => entry.key), source.id), source })
    const initial = entries.find((entry) => entry.source.id === action.startSceneId) ?? entries[0]
    return { entries, activeKey: initial?.key ?? null, draft: initial ? cloneScene(initial.source) : null, drafts: new Map(), editedKeys: new Set() }
  }
  if (action.type === 'patch') {
    if (!state.draft || state.activeKey === null) return state
    return { ...state, draft: action.update(state.draft), editedKeys: new Set([...state.editedKeys, state.activeKey]) }
  }
  if (action.type === 'select' && (action.key === state.activeKey || !state.entries.some((entry) => entry.key === action.key))) return state
  const drafts = new Map(state.drafts)
  if (state.activeKey !== null && state.draft) drafts.set(state.activeKey, state.draft)
  if (action.type === 'select') {
    const entry = state.entries.find((candidate) => candidate.key === action.key)!
    return { ...state, activeKey: entry.key, draft: cloneScene(drafts.get(entry.key) ?? entry.source), drafts }
  }
  const key = unusedSceneKey(state.entries.map((entry) => entry.key), action.scene.id)
  const draft = cloneScene(action.scene)
  drafts.set(key, draft)
  return { entries: [...state.entries, { key, source: action.scene }], activeKey: key, draft, drafts, editedKeys: new Set([...state.editedKeys, key]) }
}
