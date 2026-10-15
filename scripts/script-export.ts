/**
 * 从剧本导出配音台词表。
 *
 *   npm run script:export
 *
 * 产出 content/voice-lines.csv，列：line_id, knot, 说话人, 台词
 *
 * 关键约定：**line_id 由你在剧本里显式写死** —— `# vo: line_042`。
 * 不要让工具用文本哈希或行号生成 id：那样你改一个字、插一行，
 * 已经录好的音频就全部对不上号了。
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildInkSources, listInkSources } from './lib/ink.ts'
import { ASSETS_DIR, CONTENT_DIR, VOICE_CSV, rel } from './lib/project.ts'

const files = await listInkSources()
if (files.length === 0) {
  process.stdout.write('content/story 下没有 .ink 文件，跳过。\n')
  process.exit(0)
}

interface Row {
  lineId: string
  knot: string
  speaker: string
  text: string
}

const rows: Row[] = []
const duplicateIds = new Map<string, number>()
let totalLines = 0
let missingId = 0

const build = await buildInkSources(files)
if (!build.entryFile || !build.entryResult) {
  process.stderr.write('没有可用的 Ink 入口源文件。\n')
  process.exit(1)
}
for (const { file, result } of build.checkedSources) {
  if (result.errors.length > 0) {
    process.stderr.write(`✗ ${rel(file)} 编译失败，先运行 npm run ink:build 看详情\n`)
    process.exit(1)
  }
}
if (build.entryResult.lineReport.status === 'truncated') {
  process.stderr.write(
    `✗ ${rel(build.entryFile)} 台词收集触及上限：${build.entryResult.lineReport.stopReasons.join(', ')}。` +
      '拒绝生成不完整配音表；这不是对 Ink 动态分支的穷尽证明。\n',
  )
  process.exit(1)
}

let speaker = ''
for (const line of build.entryResult.lines) {
  totalLines += 1
  const voTag = line.tags.find((tag) => tag.trim().toLowerCase().startsWith('vo:'))
  const speakerTag = line.tags.find((tag) => tag.trim().toLowerCase().startsWith('speaker:'))
  if (speakerTag) speaker = speakerTag.slice(speakerTag.indexOf(':') + 1).trim()

  const lineId = voTag ? voTag.slice(voTag.indexOf(':') + 1).trim() : ''
  if (!lineId) {
    missingId += 1
    continue
  }
  duplicateIds.set(lineId, (duplicateIds.get(lineId) ?? 0) + 1)
  rows.push({ lineId, knot: line.knot, speaker, text: line.text })
}

await mkdir(CONTENT_DIR, { recursive: true })

const escape = (value: string): string =>
  /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value

const header = 'line_id,knot,speaker,text'
const body = rows.map((row) => [row.lineId, row.knot, row.speaker, row.text].map(escape).join(','))
// 带 BOM，Excel 打开中文才不会乱码
const csv = `\uFEFF${[header, ...body].join('\r\n')}\r\n`
await writeFile(VOICE_CSV, csv, 'utf8')

const duplicates = [...duplicateIds.entries()].filter(([, count]) => count > 1)

process.stdout.write(`\n✓ ${rel(VOICE_CSV)}\n`)
process.stdout.write(`    ${rows.length} 条配音，共 ${totalLines} 行文本\n`)
if (missingId > 0) {
  process.stdout.write(`    ! ${missingId} 行没有 # vo: 标签，不会出现在台词表里\n`)
}
if (duplicates.length > 0) {
  process.stdout.write(`    ! line_id 重复：${duplicates.map(([id, n]) => `${id}×${n}`).join(', ')}\n`)
}

// 顺带把录音目录建出来，省得你自己创建
const voDir = path.join(ASSETS_DIR, 'audio', 'vo')
await mkdir(voDir, { recursive: true })
const existing = await readdir(voDir).catch(() => [] as string[])
process.stdout.write(`    录音放到 public/assets/audio/vo/，按 <line_id>.m4a 命名（当前已有 ${existing.length} 个文件）\n\n`)
