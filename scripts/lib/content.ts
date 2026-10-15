import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { SceneSchema, type Scene } from '../../src/schema/index.ts'
import { resolveInteractions } from '../../src/schema/scene.ts'
import { ProjectSchema } from '../../src/content/project.ts'
import { ASSETS_DIR, CONTENT_DIR, SCENES_DIR, rel } from './project.ts'

export interface LoadedScene {
  file: string
  scene: Scene | null
  errors: string[]
}

export async function loadScenes(): Promise<LoadedScene[]> {
  let entries: string[]
  try {
    entries = await readdir(SCENES_DIR)
  } catch {
    return []
  }

  const out: LoadedScene[] = []
  for (const name of entries.filter((n) => n.endsWith('.json')).sort()) {
    const file = path.join(SCENES_DIR, name)
    const display = rel(file)
    let raw: unknown
    try {
      // 去掉 UTF-8 BOM：记事本、部分编辑器另存为时会加上它，
      // 而 JSON.parse 会直接报 "Unexpected token"，报错信息完全看不出原因。
      const text = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '')
      raw = JSON.parse(text)
    } catch (err) {
      out.push({ file: display, scene: null, errors: [`JSON 解析失败：${(err as Error).message}`] })
      continue
    }
    const parsed = SceneSchema.safeParse(raw)
    if (!parsed.success) {
      out.push({
        file: display,
        scene: null,
        errors: parsed.error.issues.map((i) => `${i.path.join('.') || '<根>'} — ${i.message}`),
      })
      continue
    }
    out.push({ file: display, scene: parsed.data, errors: [] })
  }
  return out
}

/** 所有会访问 Ink 的场景引用，包括兼容交互、条件与显式 story effects。 */
export function sceneUsesStory(scene: Scene, sceneIds: ReadonlySet<string>): boolean {
  return Boolean(scene.entry || scene.hub) ||
    scene.layers.some((layer) => Boolean(layer.visibleWhen)) ||
    scene.exits.some((exit) => Boolean(exit.when) || !sceneIds.has(exit.to)) ||
    scene.hotspots.some((hotspot) =>
      Boolean(hotspot.visibleWhen) || resolveInteractions(hotspot).some((interaction) =>
        Boolean(interaction.action || interaction.when || interaction.emit) ||
        interaction.effects.some((effect) => effect.type === 'story.knot' || effect.type === 'story.event'),
      ),
    )
}

export async function loadProjectStartSceneId(projectFile = path.join(CONTENT_DIR, 'project.json')): Promise<string | null> {
  try {
    const text = (await readFile(projectFile, 'utf8')).replace(/^\uFEFF/, '')
    const parsed = ProjectSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data.startScene : null
  } catch {
    return null
  }
}

export function selectStartScene(scenes: readonly LoadedScene[], startSceneId: string | null): LoadedScene | undefined {
  const declared = startSceneId ? scenes.find((entry) => entry.scene?.id === startSceneId) : undefined
  return declared ?? scenes.find((entry) => entry.scene !== null && /(^|[\\/])start\.json$/.test(entry.file)) ??
    scenes.find((entry) => entry.scene !== null)
}

/** 扫描 public/assets 下的所有文件，返回相对 assets 根的正斜杠路径。 */
export async function scanAssets(): Promise<Set<string>> {
  const found = new Set<string>()
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const key = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(full, key)
      else found.add(key)
    }
  }
  await walk(ASSETS_DIR, '')
  return found
}

/** 场景里所有对素材的引用，用于"引用是否存在"与"孤儿文件"两项检查。 */
export function collectAssetRefs(scene: Scene): { ref: string; where: string }[] {
  const refs: { ref: string; where: string }[] = []
  if (scene.bg) refs.push({ ref: scene.bg, where: 'bg' })
  if (scene.bgm) refs.push({ ref: scene.bgm, where: 'bgm' })
  for (const layer of scene.layers) {
    refs.push({ ref: layer.image, where: `layers.${layer.id}` })
    for (const [state, image] of Object.entries(layer.visualStates)) {
      if (image) refs.push({ ref: image, where: `layers.${layer.id}.visualStates.${state}` })
    }
  }
  for (const actor of scene.actors) {
    if (actor.parts) refs.push({ ref: actor.parts, where: `actors.${actor.id}.parts` })
  }
  /*
   * 热点自己也是会画图的，而且有视觉状态。
   *
   * 这几行以前漏掉了，后果是「引用了不存在的素材」这项检查对热点**完全失效**：
   * 写一个不存在的 `image`，`content:check --strict` 一条告警都不给；运行时那个
   * 物件既不画出来、又照样能被点到（命中判定只看 shape）—— 玩家会撞上一个
   * "看不见但点得到"的按钮。图层的同一条路径一直是会报的，
   * 所以这种漏检格外容易让人以为"检查过了就是没问题"。
   */
  for (const hotspot of scene.hotspots) {
    if (hotspot.image) refs.push({ ref: hotspot.image, where: `hotspots.${hotspot.id}.image` })
    for (const [state, image] of Object.entries(hotspot.visualStates)) {
      if (image) refs.push({ ref: image, where: `hotspots.${hotspot.id}.visualStates.${state}` })
    }
    for (const interaction of hotspot.interactions) {
      if (interaction.sfx) {
        refs.push({ ref: interaction.sfx, where: `hotspots.${hotspot.id}.interactions.sfx` })
      }
      for (const effect of interaction.effects) {
        if (effect.type === 'audio.sfx' && effect.path) {
          refs.push({ ref: effect.path, where: `hotspots.${hotspot.id}.effects(${effect.type})` })
        }
      }
    }
  }
  return refs
}

/**
 * 递归展开角色图集依赖。素材清单与内容检查都应把图集本身及其图片视为同一条依赖链。
 * 仅识别运行时支持的两种图集形态，不把任意 JSON 字段猜成素材引用。
 */
export async function expandAssetDependencies(
  refs: readonly { ref: string; where: string }[],
  assets: ReadonlySet<string>,
  assetsRoot = ASSETS_DIR,
): Promise<{ ref: string; where: string }[]> {
  const expanded: { ref: string; where: string }[] = []
  const queue = [...refs]
  const seenRefs = new Set<string>()
  const expandedAtlases = new Set<string>()
  const root = path.resolve(assetsRoot)

  while (queue.length > 0) {
    const current = queue.shift()!
    const key = `${current.ref}\u0000${current.where}`
    if (seenRefs.has(key)) continue
    seenRefs.add(key)
    expanded.push(current)

    if (!current.ref.toLowerCase().endsWith('.json') || !assets.has(current.ref)) continue
    if (expandedAtlases.has(current.ref)) continue
    expandedAtlases.add(current.ref)

    const fullPath = path.resolve(root, current.ref)
    const relativePath = path.relative(root, fullPath)
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) continue

    let raw: unknown
    try {
      raw = JSON.parse((await readFile(fullPath, 'utf8')).replace(/^\uFEFF/, ''))
    } catch {
      // 格式错误由 content-check 的图集校验报告；这里仍返回图集引用本身。
      continue
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const record = raw as Record<string, unknown>
    const parts = record.parts
    if (typeof parts === 'object' && parts !== null && !Array.isArray(parts)) {
      for (const [name, definition] of Object.entries(parts as Record<string, unknown>)) {
        if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) continue
        const image = (definition as Record<string, unknown>).image
        if (typeof image === 'string' && image.length > 0) {
          queue.push({ ref: image, where: `${current.where}.parts.${name}.image` })
        }
      }
      continue
    }

    const isSpriteAtlas =
      typeof record.image === 'string' &&
      typeof record.columns === 'number' &&
      typeof record.frameWidth === 'number' &&
      typeof record.frameHeight === 'number'
    if (isSpriteAtlas) queue.push({ ref: record.image as string, where: `${current.where}.image` })
  }

  return expanded
}
