import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { SceneSchema, type Scene } from '../../src/schema/index.ts'
import { ASSETS_DIR, SCENES_DIR, rel } from './project.ts'

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
  for (const layer of scene.layers) refs.push({ ref: layer.image, where: `layers.${layer.id}` })
  for (const actor of scene.actors) {
    if (actor.parts) refs.push({ ref: actor.parts, where: `actors.${actor.id}.parts` })
  }
  return refs
}
