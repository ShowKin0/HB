import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SceneSchema } from '../src/schema/scene.ts'
import {
  collectAssetRefs,
  expandAssetDependencies,
  loadProjectStartSceneId,
  sceneUsesStory,
  selectStartScene,
  type LoadedScene,
} from '../scripts/lib/content.ts'
import { buildInkSources, collectLines, compileInk, selectInkEntryFile } from '../scripts/lib/ink.ts'

const tempDirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.doUnmock('../scripts/lib/project.ts')
  vi.resetModules()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function cliFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hb-cli-'))
  tempDirs.push(root)
  for (const dir of ['content/scenes', 'content/story', 'public/assets', 'themes']) {
    await mkdir(path.join(root, dir), { recursive: true })
  }
  await writeFile(path.join(root, 'themes/neutral.css'), '')
  await writeFile(path.join(root, 'content/items.json'), '{}')
  await writeFile(path.join(root, 'content/project.json'), JSON.stringify({ schemaVersion: 1, capabilities: ['story.ink', 'interaction.tap'] }))
  vi.resetModules()
  vi.doMock('../scripts/lib/project.ts', () => ({
    ROOT: root, CONTENT_DIR: path.join(root, 'content'), SCENES_DIR: path.join(root, 'content/scenes'),
    STORY_DIR: path.join(root, 'content/story'), ASSETS_DIR: path.join(root, 'public/assets'), PUBLIC_DIR: path.join(root, 'public'),
    MANIFEST_FILE: path.join(root, 'content/assets.manifest.json'), VOICE_CSV: path.join(root, 'content/voice-lines.csv'),
    rel: (file: string) => path.relative(root, file).replace(/\\/g, '/'),
  }))
  return root
}

async function runCli(load: () => Promise<unknown>): Promise<{ code: number; output: string }> {
  let output = ''
  const stop = new Error('fixture-process-exit')
  let code = 0
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: unknown) => { output += String(text); return true }) as typeof process.stdout.write)
  vi.spyOn(process.stderr, 'write').mockImplementation(((text: unknown) => { output += String(text); return true }) as typeof process.stderr.write)
  vi.spyOn(process, 'exit').mockImplementation(((status: number) => { code = status; throw stop }) as typeof process.exit)
  try { await load() } catch (error) { if (error !== stop) throw error }
  return { code, output }
}

describe('content pipeline CLI integration', () => {
  it('ink-build writes only main.json and script-export excludes independent voice lines', async () => {
    const root = await cliFixture()
    await writeFile(path.join(root, 'content/story/z_entry.ink'), '=== entry ===\nEntry line. # vo: entry_01\n-> END\n')
    await writeFile(path.join(root, 'content/story/zz_unused.ink'), '=== unused ===\nUnused line. # vo: unused_01\n-> END\n')
    expect((await runCli(() => import('../scripts/ink-build.ts'))).code).toBe(0)
    const story = await readFile(path.join(root, 'content/story/main.json'), 'utf8')
    expect(story).toContain('entry_01')
    expect(story).not.toContain('unused_01')
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(path.join(root, 'content/story'))).filter((file) => file.endsWith('.json'))).toEqual(['main.json'])
    expect((await runCli(() => import('../scripts/script-export.ts'))).code).toBe(0)
    const csv = await readFile(path.join(root, 'content/voice-lines.csv'), 'utf8')
    expect(csv).toContain('entry_01,entry')
    expect(csv).not.toContain('unused_01')
  })

  it('script-export refuses a traversal that hits its continuation limit', async () => {
    const root = await cliFixture()
    const source = `=== long_story ===\n${Array.from({ length: 405 }, (_, index) => `Line ${index}. # vo: long_${index}`).join('\n')}\n-> END\n`
    await writeFile(path.join(root, 'content/story/main.ink'), source)
    const result = await runCli(() => import('../scripts/script-export.ts'))
    expect(result.code).toBe(1)
    expect(result.output).toContain('continue-limit')
    expect(result.output).toContain('拒绝生成不完整配音表')
    await expect(readFile(path.join(root, 'content/voice-lines.csv'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('checker rejects references that exist only in an unloaded independent story', async () => {
    const root = await cliFixture()
    await writeFile(path.join(root, 'content/story/main.ink'), '=== entry ===\nEntry.\n-> END\n')
    await writeFile(path.join(root, 'content/story/unused.ink'), '=== unloaded ===\nUnused.\n-> END\n')
    await writeFile(path.join(root, 'content/scenes/start.json'), JSON.stringify({ id: 'start', mode: 'focus', entry: 'unloaded' }))
    const result = await runCli(() => import('../scripts/content-check.ts'))
    expect(result.code).toBe(1)
    expect(result.output).toContain('entry 引用了不存在的 ink 名字 "unloaded"')
  })

  it('checker rejects missing references even for a successfully compiled knot-free entry', async () => {
    const root = await cliFixture()
    await writeFile(path.join(root, 'content/story/main.ink'), 'Root line.\n-> END\n')
    await writeFile(path.join(root, 'content/scenes/start.json'), JSON.stringify({ id: 'start', mode: 'focus', hub: 'missing' }))
    const result = await runCli(() => import('../scripts/content-check.ts'))
    expect(result.code).toBe(1)
    expect(result.output).toContain('hub 引用了不存在的 ink 名字 "missing"')
  })

  it('manifest startScene budget includes both atlas files and their images', async () => {
    const root = await cliFixture()
    const assetsRoot = path.join(root, 'public/assets')
    const partAtlas = JSON.stringify({ parts: { torso: { image: 'body.png', offset: [0, 0], height: 1 } } })
    const spriteAtlas = JSON.stringify({ image: 'sheet.png', columns: 1, frameWidth: 1, frameHeight: 1, clips: { 'idle:S': [0] } })
    await writeFile(path.join(assetsRoot, 'parts.json'), partAtlas)
    await writeFile(path.join(assetsRoot, 'sprite.json'), spriteAtlas)
    await writeFile(path.join(assetsRoot, 'body.png'), 'body')
    await writeFile(path.join(assetsRoot, 'sheet.png'), 'sheet')
    await writeFile(path.join(assetsRoot, 'start.png'), 'fallback')
    await writeFile(path.join(root, 'content/scenes/start.json'), JSON.stringify({ id: 'start', mode: 'focus', bg: 'start.png' }))
    await writeFile(path.join(root, 'content/scenes/declared.json'), JSON.stringify({
      id: 'declared', mode: 'walk', ground: { corners: [[0, 0], [1, 0], [1, 1], [0, 1]] }, walkable: ['..', '..'],
      actors: [{ id: 'parts', spawn: [0.5, 0.5], parts: 'parts.json' }, { id: 'sprite', spawn: [0.5, 0.5], renderer: 'spriteSheet', parts: 'sprite.json' }],
    }))
    await writeFile(path.join(root, 'content/project.json'), JSON.stringify({ schemaVersion: 1, startScene: 'declared', capabilities: ['actor.walk'] }))
    await runCli(() => import('../scripts/assets-manifest.ts'))
    const manifest = JSON.parse(await readFile(path.join(root, 'content/assets.manifest.json'), 'utf8')) as {
      startSceneId: string; entrySceneBytes: number; unusedBytes: number; entries: { path: string; used: boolean; entryScene: boolean }[]
    }
    expect(manifest.startSceneId).toBe('declared')
    expect(manifest.entrySceneBytes).toBe(Buffer.byteLength(partAtlas) + Buffer.byteLength(spriteAtlas) + 9)
    expect(manifest.unusedBytes).toBe(0)
    expect(manifest.entries.filter((entry) => entry.entryScene).map((entry) => entry.path)).toEqual(['body.png', 'parts.json', 'sheet.png', 'sprite.json'])
    const check = await runCli(() => import('../scripts/content-check.ts'))
    expect(check.code, check.output).toBe(0)
    expect(check.output).not.toContain('未被任何场景引用的素材')
  })
})

describe('content pipeline', () => {
  it('compiles INCLUDE through CompilerOptions and produces one entry story with included symbols', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hb-ink-'))
    tempDirs.push(dir)
    await mkdir(path.join(dir, 'chapters'))
    await writeFile(path.join(dir, 'shared.ink'), '=== included_knot ===\nShared line. # vo: shared_01\n-> END\n')
    await writeFile(path.join(dir, 'chapters/nested.ink'), 'INCLUDE deep.ink\n=== nested_knot ===\nNested line. # vo: nested_01\n-> END\n')
    await writeFile(path.join(dir, 'deep.ink'), '=== function available() ===\n~ return true\n')
    await writeFile(path.join(dir, 'main.ink'), 'INCLUDE shared.ink\nINCLUDE chapters/nested.ink\n=== entry_knot ===\nMain line. # vo: main_01\n-> END\n')

    const main = compileInk(await readFile(path.join(dir, 'main.ink'), 'utf8'), path.join(dir, 'main.ink'))
    expect(main.errors).toEqual([])
    expect(main.includedFiles).toEqual([path.join(dir, 'shared.ink'), path.join(dir, 'chapters/nested.ink'), path.join(dir, 'deep.ink')])
    expect(main.symbols.knots).toEqual(new Set(['included_knot', 'nested_knot', 'entry_knot', 'available']))
    expect(main.symbols.functions).toEqual(new Set(['available']))
    expect(main.storyJson).toContain('entry_knot')
    expect(main.lines.map((line) => line.text)).toEqual(expect.arrayContaining(['Shared line.', 'Nested line.', 'Main line.']))

    const built = await buildInkSources([path.join(dir, 'shared.ink'), path.join(dir, 'main.ink'), path.join(dir, 'deep.ink')])
    expect(built.entryFile).toBe(path.join(dir, 'main.ink'))
    expect(built.checkedSources.map(({ file }) => path.basename(file))).toEqual(['main.ink'])
    expect(selectInkEntryFile([path.join(dir, 'z.ink'), path.join(dir, 'main.ink')])).toBe(path.join(dir, 'main.ink'))
  })

  it('does not treat independent story files as entry symbols', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hb-ink-independent-'))
    tempDirs.push(dir)
    await writeFile(path.join(dir, 'main.ink'), '=== entry ===\nEntry.\n')
    await writeFile(path.join(dir, 'unused.ink'), '=== accidental_target ===\nIndependent.\n')
    const built = await buildInkSources([path.join(dir, 'main.ink'), path.join(dir, 'unused.ink')])
    expect(built.entryResult?.symbols.knots.has('accidental_target')).toBe(false)
    expect(built.checkedSources.map(({ file }) => path.basename(file))).toEqual(['main.ink', 'unused.ink'])
  })

  it('reports bounded traversal truncation and warns that dynamic branches remain unproven', () => {
    const result = compileInk('=== loop ===\n- A\n- B\n', 'memory.ink')
    expect(result.errors).toEqual([])
    const bounded = collectLines(result.storyJson, ['loop'], 1, 100)
    expect(bounded.report.status).toBe('truncated')
    expect(bounded.report.stopReasons).toContain('step-budget')
    expect(bounded.report.note).toMatch(/不代表已穷尽/)
  })

  it('expands part and sprite atlas internal images into the dependency set', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hb-assets-'))
    tempDirs.push(dir)
    await mkdir(path.join(dir, 'nested'), { recursive: true })
    await writeFile(path.join(dir, 'parts.json'), JSON.stringify({ parts: { body: { image: 'nested/body.png' } } }))
    await writeFile(path.join(dir, 'sprite.json'), JSON.stringify({ image: 'nested/sheet.png', columns: 2, frameWidth: 16, frameHeight: 16, clips: { 'idle:S': [0] } }))
    const assets = new Set(['parts.json', 'sprite.json', 'nested/body.png', 'nested/sheet.png'])
    const expanded = await expandAssetDependencies([
      { ref: 'parts.json', where: 'actor.parts' },
      { ref: 'sprite.json', where: 'actor.sprite' },
    ], assets, dir)
    expect(expanded.map(({ ref }) => ref)).toEqual(expect.arrayContaining([...assets]))
  })

  it('uses declared project start scene and derives story capability from every story access', () => {
    const make = (id: string, extra: Record<string, unknown>): LoadedScene => ({
      file: `content/scenes/${id}.json`, scene: SceneSchema.parse({ id, title: id, mode: 'focus', ...extra }), errors: [],
    })
    const scenes = [make('fallback', {}), make('declared', {})]
    expect(selectStartScene(scenes, 'declared')?.scene?.id).toBe('declared')
    const storyScene = SceneSchema.parse({
      id: 'story', title: 'story', mode: 'focus',
      hotspots: [{ id: 'event', shape: { type: 'rect', x: 0, y: 0, w: 1, h: 1 }, interactions: [{ verb: 'inspect', action: '', effects: [{ type: 'story.event', name: 'seen' }] }] }],
    })
    expect(sceneUsesStory(storyScene, new Set(['story']))).toBe(true)
  })

  it.each([
    ['entry', { entry: 'intro' }],
    ['hub', { hub: 'anchor' }],
    ['layer.visibleWhen', { layers: [{ id: 'layer', image: 'layer.png', visibleWhen: 'visible' }] }],
    ['hotspot.visibleWhen', { hotspots: [{ id: 'hotspot', shape: { type: 'rect', x: 0, y: 0, w: 1, h: 1 }, visibleWhen: 'visible', interactions: [{ verb: 'inspect' }] }] }],
    ['legacy onClick', { hotspots: [{ id: 'hotspot', shape: { type: 'rect', x: 0, y: 0, w: 1, h: 1 }, onClick: 'intro' }] }],
    ['legacy onUse', { hotspots: [{ id: 'hotspot', shape: { type: 'rect', x: 0, y: 0, w: 1, h: 1 }, onUse: 'intro', acceptsItem: 'key' }] }],
    ['interaction.when', { hotspots: [{ id: 'hotspot', shape: { type: 'rect', x: 0, y: 0, w: 1, h: 1 }, interactions: [{ verb: 'inspect', when: 'enabled' }] }] }],
    ['interaction.emit', { hotspots: [{ id: 'hotspot', shape: { type: 'rect', x: 0, y: 0, w: 1, h: 1 }, interactions: [{ verb: 'inspect', emit: 'seen' }] }] }],
    ['story.knot effect', { hotspots: [{ id: 'hotspot', shape: { type: 'rect', x: 0, y: 0, w: 1, h: 1 }, interactions: [{ verb: 'inspect', effects: [{ type: 'story.knot', knot: 'intro' }] }] }] }],
    ['exit.when', { exits: [{ id: 'exit', shape: { type: 'rect', x: 0, y: 0, w: 1, h: 1 }, to: 'other_scene', when: 'enabled' }] }],
    ['exit to knot', { exits: [{ id: 'exit', shape: { type: 'rect', x: 0, y: 0, w: 1, h: 1 }, to: 'intro' }] }],
  ] as const)('requires story.ink for %s', (_where, extra) => {
    const scene = SceneSchema.parse({ id: 'sample', mode: 'focus', ...extra })
    expect(sceneUsesStory(scene, new Set(['sample', 'other_scene']))).toBe(true)
  })

  it('does not infer story from scene-only exits or object-only effects', () => {
    const scene = SceneSchema.parse({ id: 'sample', mode: 'focus',
      exits: [{ id: 'exit', shape: { type: 'rect', x: 0, y: 0, w: 1, h: 1 }, to: 'other_scene' }],
      hotspots: [{ id: 'hotspot', shape: { type: 'rect', x: 0, y: 0, w: 1, h: 1 }, interactions: [{ verb: 'inspect', effects: [{ type: 'object.patch', target: '@self', patch: { state: 'open' } }] }] }],
    })
    expect(sceneUsesStory(scene, new Set(['sample', 'other_scene']))).toBe(false)
  })

  it('ignores invalid project configuration and invalid start.json when selecting the manifest entry scene', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hb-project-'))
    tempDirs.push(dir)
    const file = path.join(dir, 'project.json')
    await writeFile(file, JSON.stringify({ startScene: 'declared', capabilities: ['unknown'] }))
    expect(await loadProjectStartSceneId(file)).toBeNull()
    await writeFile(file, JSON.stringify({ schemaVersion: 1, startScene: 'declared', capabilities: [] }))
    expect(await loadProjectStartSceneId(file)).toBe('declared')
    const loaded = [
      { file: 'content/scenes/start.json', scene: null, errors: ['invalid'] },
      { file: 'content/scenes/fallback.json', scene: SceneSchema.parse({ id: 'fallback', mode: 'focus' }), errors: [] },
    ]
    expect(selectStartScene(loaded, 'missing')?.scene?.id).toBe('fallback')
  })

  it('collects atlas references from scenes before expansion', () => {
    const scene = SceneSchema.parse({ id: 'atlas', title: 'atlas', mode: 'walk', ground: { corners: [[0, 0], [1, 0], [1, 1], [0, 1]] }, walkable: ['..', '..'], actors: [{ id: 'hero', spawn: [0.5, 0.8], parts: 'hero.json' }] })
    expect(collectAssetRefs(scene)).toContainEqual({ ref: 'hero.json', where: 'actors.hero.parts' })
  })
})
