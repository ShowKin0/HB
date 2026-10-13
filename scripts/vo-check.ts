/**
 * 检查配音文件是否齐全。
 *
 *   npm run vo:check
 *   npm run vo:check -- --strict   （缺一句就失败，用于上线前验收）
 *
 * 缺失的配音不会让游戏崩 —— 引擎会自动降级成"只出文字"。
 * 但上线前你应该知道到底缺了哪几句。
 */
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { ASSETS_DIR, VOICE_CSV, rel } from './lib/project.ts'

const STRICT = process.argv.includes('--strict')
const VO_DIR = path.join(ASSETS_DIR, 'audio', 'vo')
const AUDIO_EXT = new Set(['.m4a', '.mp3', '.ogg', '.wav', '.opus', '.aac'])

let csv: string
try {
  csv = await readFile(VOICE_CSV, 'utf8')
} catch {
  process.stdout.write('还没有 content/voice-lines.csv，先运行 npm run script:export。\n')
  process.exit(0)
}

const declared = new Set<string>()
for (const rawLine of csv.split(/\r?\n/).slice(1)) {
  if (!rawLine.trim()) continue
  // 第一列就是 line_id，不含逗号或引号（由 script:export 保证）
  const id = rawLine.split(',')[0].replace(/^\uFEFF/, '').trim()
  if (id) declared.add(id)
}

const files = await readdir(VO_DIR).catch(() => [] as string[])
const byId = new Map<string, string[]>()
for (const name of files) {
  const ext = path.extname(name).toLowerCase()
  if (!AUDIO_EXT.has(ext)) continue
  const id = path.basename(name, ext)
  const list = byId.get(id)
  if (list) list.push(name)
  else byId.set(id, [name])
}

const missing = [...declared].filter((id) => !byId.has(id)).sort()
const orphans = [...byId.keys()].filter((id) => !declared.has(id)).sort()
const multiExt = [...byId.entries()].filter(([, names]) => names.length > 1)

process.stdout.write(`\n配音检查（${rel(VO_DIR)}）\n`)
process.stdout.write(`    已声明 ${declared.size} 条，已录 ${byId.size} 条\n`)

if (missing.length > 0) {
  process.stdout.write(`  ✗ 缺少 ${missing.length} 条（游戏里会只出文字）：\n`)
  for (const id of missing.slice(0, 40)) process.stdout.write(`      ${id}\n`)
  if (missing.length > 40) process.stdout.write(`      …还有 ${missing.length - 40} 条\n`)
}

if (orphans.length > 0) {
  process.stdout.write(`  ! ${orphans.length} 个文件在剧本里找不到对应 line_id：\n`)
  for (const id of orphans.slice(0, 20)) process.stdout.write(`      ${id}\n`)
  if (orphans.length > 20) process.stdout.write(`      …还有 ${orphans.length - 20} 个\n`)
}

if (multiExt.length > 0) {
  process.stdout.write(`  ! 同一个 line_id 存在多种格式，引擎会取其中一个：\n`)
  for (const [id, names] of multiExt) process.stdout.write(`      ${id}: ${names.join(', ')}\n`)
}

if (missing.length === 0 && orphans.length === 0) {
  process.stdout.write('  ✓ 全部齐了\n')
}
process.stdout.write('\n')

process.exit(STRICT && missing.length > 0 ? 1 : 0)
