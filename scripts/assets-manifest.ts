/**
 * 生成素材清单。
 *
 *   npm run assets:manifest
 *
 * 产出 content/assets.manifest.json：每个素材的路径、体积、类型，
 * 以及是否被场景引用。附带一份首包预算估算。
 *
 * 为什么需要它：首包预算（≤3MB）是硬指标，而素材是你会一直往里加的东西。
 * 没有这个数字，你会在某天突然发现首屏要加载 20MB。
 */
import { stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  collectAssetRefs,
  expandAssetDependencies,
  loadProjectStartSceneId,
  loadScenes,
  scanAssets,
  selectStartScene,
} from './lib/content.ts'
import { ASSETS_DIR, MANIFEST_FILE, rel } from './lib/project.ts'

/** 首屏必须加载的素材：起始场景用到的东西。 */
interface Entry {
  path: string
  bytes: number
  kind: 'image' | 'audio' | 'font' | 'other'
  used: boolean
  entryScene: boolean
}

function kindOf(file: string): Entry['kind'] {
  const ext = path.extname(file).toLowerCase()
  if (['.avif', '.webp', '.png', '.jpg', '.jpeg', '.gif', '.svg'].includes(ext)) return 'image'
  if (['.ogg', '.m4a', '.mp3', '.wav', '.opus', '.aac'].includes(ext)) return 'audio'
  if (['.woff2', '.woff', '.ttf', '.otf'].includes(ext)) return 'font'
  return 'other'
}

const assets = await scanAssets()
const scenes = await loadScenes()

const usedBy = new Map<string, string[]>()
for (const loaded of scenes) {
  if (!loaded.scene) continue
  const dependencies = await expandAssetDependencies(collectAssetRefs(loaded.scene), assets)
  for (const { ref } of dependencies) {
    const list = usedBy.get(ref)
    if (list) {
      if (!list.includes(loaded.scene.id)) list.push(loaded.scene.id)
    } else {
      usedBy.set(ref, [loaded.scene.id])
    }
  }
}

// 与游戏本体保持一致：project.startScene、start.json、文件名排序首个依次回退。
const configuredStartScene = await loadProjectStartSceneId()
const startEntry = selectStartScene(scenes, configuredStartScene)
const startSceneId = startEntry?.scene?.id ?? null
const entryRefs = new Set<string>()
if (startEntry?.scene) {
  const dependencies = await expandAssetDependencies(collectAssetRefs(startEntry.scene), assets)
  for (const { ref } of dependencies) entryRefs.add(ref)
}

const entries: Entry[] = []
for (const file of [...assets].sort()) {
  const full = path.join(ASSETS_DIR, file)
  const info = await stat(full).catch(() => null)
  if (!info) continue
  entries.push({
    path: file,
    bytes: info.size,
    kind: kindOf(file),
    used: usedBy.has(file),
    entryScene: entryRefs.has(file),
  })
}

const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
const entryBytes = entries.filter((entry) => entry.entryScene).reduce((sum, entry) => sum + entry.bytes, 0)
const orphanBytes = entries.filter((entry) => !entry.used).reduce((sum, entry) => sum + entry.bytes, 0)

const manifest = {
  generatedAt: new Date().toISOString(),
  startSceneId,
  totalBytes,
  entrySceneBytes: entryBytes,
  unusedBytes: orphanBytes,
  entries,
}

await writeFile(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)} MB`

process.stdout.write(`\n✓ ${rel(MANIFEST_FILE)}\n`)
process.stdout.write(`    素材共 ${entries.length} 个，合计 ${mb(totalBytes)}\n`)
process.stdout.write(`    起始场景（会进首包）${mb(entryBytes)}\n`)
if (orphanBytes > 0) {
  process.stdout.write(`    ! 未被引用的素材合计 ${mb(orphanBytes)}，考虑删掉或移出 public\n`)
}

// 首包预算：JS/CSS 约 0.2MB，其余是首场景素材
const budget = 3 * 1024 * 1024
const projected = entryBytes + 220 * 1024
if (projected > budget) {
  process.stdout.write(`  ✗ 首包预估 ${mb(projected)}，已超 3MB 预算\n`)
} else {
  process.stdout.write(`    · 首包预估 ${mb(projected)} / 3.00 MB 预算\n`)
}
process.stdout.write('\n')
