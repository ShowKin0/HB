import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Game, type DialogueLine } from '../src/engine/game.ts'
import { normalizeScene } from '../src/schema/scene.rules.ts'
import { defaultProject } from '../src/content/project.rules.ts'
import { SaveManager } from '../src/engine/save.ts'
import { registerMiniGame } from '../src/minigames/registry.ts'
import { SAVE_VERSION } from '../src/schema/save.ts'
import type { AudioBus } from '../src/engine/audio.ts'
import type { ChoiceView } from '../src/engine/ink/inkBridge.ts'

const { Compiler } = createRequire(import.meta.url)('inkjs/compiler/Compiler') as {
  Compiler: new (source: string) => { Compile(): { ToJson(): string } }
}
const source = [
  '-> start', '=== start ===', '-> hub', '=== hub ===', '-> DONE',
  '=== choice_test ===', 'Choose.', '* [A]', '  Alpha.', '  -> DONE', '* [B]', '  Beta.', '  -> DONE',
  '=== switch_test ===', 'Exit. # scene: hall', '-> DONE', '=== hall ===', 'Hall entry.', '-> DONE',
  '=== cancelled_test ===', 'Old. # minigame: audit_stall() # flag: stale = true', '-> DONE',
  '=== wait_test ===', '# wait: 60', 'Old wait.', '-> DONE', '',
].join('\n')
const live: Game[] = []
afterEach(() => { for (const game of live.splice(0)) game.dispose(); vi.unstubAllGlobals() })
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

function harness(story = true) {
  const data = new Map<string, string>()
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k) } as unknown as Storage
  const saves = new SaveManager(storage)
  const view = { line: null as DialogueLine | null, choices: [] as ChoiceView[], errors: [] as string[] }
  const game = new Game({
    canvas: { getContext: () => ({}) } as unknown as HTMLCanvasElement,
    content: {
      scenes: new Map([
        ['start', normalizeScene({ id: 'start', mode: 'focus', entry: story ? 'start' : null, hub: story ? 'hub' : null })],
        ['hall', normalizeScene({ id: 'hall', mode: 'focus', entry: story ? 'hall' : null, hub: story ? 'hub' : null })],
      ]), startSceneId: 'start', storyJson: story ? String(new Compiler(source).Compile().ToJson()) : null,
      project: { ...defaultProject(), capabilities: ['story.ink', 'interaction.tap', 'minigame'] },
      itemLabels: {}, contentVersion: 'test', warnings: [],
    }, saves,
    audio: { setSettings() {}, setPaused() {}, stopBgm() {}, stopVo() {}, dispose() {} } as unknown as AudioBus,
    hooks: { onLine: (line) => { view.line = line }, onChoices: (choices) => { view.choices = choices }, onScene() {}, onInventory() {}, onError: (message) => view.errors.push(message), onDebug() {} },
  })
  live.push(game)
  return { game, saves, view }
}

describe('存档与会话运行链路', () => {
  it('选项挂起后存档和读档，重新发布选项且可选择', async () => {
    const { game, saves, view } = harness()
    await game.start(); game.runKnot('choice_test'); await settle(); game.advanceStory(); await settle()
    expect(view.choices).toHaveLength(2)
    game.saveTo('1', 'choice')
    await game.start(saves.load('1')); await settle()
    expect(view.choices.map((x) => x.text)).toEqual(['A', 'B'])
    game.choose(0); await settle()
    expect(view.line?.text).toBe('Alpha.')
  })

  it('同句待切场景在读档后等玩家推进，再切场景', async () => {
    const { game, saves, view } = harness()
    await game.start(); game.runKnot('switch_test'); await settle()
    expect(view.line?.text).toBe('Exit.')
    expect(game.storyState.pendingSceneId).toBe('hall')
    game.saveTo('1', 'switch')
    expect(saves.load('1')?.saveVersion).toBe(SAVE_VERSION)
    await game.start(saves.load('1')); await settle()
    expect(game.currentSceneId).toBe('start')
    expect(game.storyState.pendingSceneId).toBe('hall')
    game.advanceStory(); await settle()
    expect(game.currentSceneId).toBe('hall')
    expect(view.line?.text).toBe('Hall entry.')
  })

  it('无 Ink 内容包保存和恢复能力状态，不误判剧情损坏', async () => {
    const { game, saves, view } = harness(false)
    await game.start()
    expect(game.setCapabilityState('demo', { progress: 42 })).toBe(true)
    game.saveTo('1', 'plain')
    await game.start(saves.load('1'))
    expect(game.getCapabilityState('demo')).toEqual({ progress: 42 })
    expect(view.errors).toEqual([])
  })

  it('取消小游戏后旧指令不写新会话，宿主和句柄都被销毁', async () => {
    let destroyed = 0, removed = 0
    vi.stubGlobal('document', { createElement: () => ({ remove: () => { removed++ } }), body: { appendChild() {} } })
    registerMiniGame({ id: 'audit_stall', title: 'test', mount: () => ({ destroy: () => { destroyed++ } }) })
    const { game, view } = harness()
    await game.start(); game.runKnot('cancelled_test'); await settle()
    expect(game.pauseState).toContain('minigame')
    await game.start(); await settle()
    expect(game.getFlag('stale')).toBeUndefined()
    expect(view.line?.text).not.toBe('Old.')
    expect(game.storyState.busy).toBe(false)
    expect(destroyed).toBe(1); expect(removed).toBe(1)
  })

  it('小游戏挂起时手动存档，读档从小游戏前检查点重播', async () => {
    let mounts = 0
    vi.stubGlobal('document', { createElement: () => ({ remove() {} }), body: { appendChild() {} } })
    registerMiniGame({ id: 'audit_stall', title: 'test', mount: () => { mounts++; return { destroy() {} } } })
    const { game, saves, view } = harness()
    await game.start(); game.runKnot('cancelled_test'); await settle()
    game.saveTo('1', 'stable')
    const load = game.start(saves.load('1'))
    await settle()
    expect(view.line).toBeNull()
    expect(mounts).toBeGreaterThanOrEqual(2)
    await game.start(); await load
  })
  it('重开取消长等待后，新会话的推进锁可继续使用', async () => {
    const { game, view } = harness()
    await game.start(); game.runKnot('wait_test'); await settle()
    await game.start(); await settle()
    game.runKnot('choice_test'); await settle()
    expect(view.line?.text).toBe('Choose.')
    expect(game.storyState.busy).toBe(false)
  })
})
