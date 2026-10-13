/**
 * 素材压缩管线。
 *
 *   npm run img:optimize
 *
 * 把 art-src/ 下的原图（PNG / JPG，通常几 MB 一张）压成
 * public/assets/ 下的 AVIF + WebP 两份，并按需裁切缩放。
 *
 * 为什么原图和产物分开放：原图是你的工作文件（可能几十 MB 一张），
 * 绝对不该进 public 目录 —— 那会直接被**打进首包**。
 *
 * 目录约定：
 *   art-src/bg/room.png      → public/assets/bg/room.avif + room.webp
 *   art-src/portrait/her.png → public/assets/portrait/her.avif + her.webp
 */
import { mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { ASSETS_DIR, ROOT, rel } from './lib/project.ts'

const SRC_DIR = path.join(ROOT, 'art-src')
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tiff'])

/** 各类素材的最大边长。背景与立绘的取舍不同，分开配置。 */
const MAX_EDGE: Record<string, number> = {
  bg: 1920,
  portrait: 1200,
  ui: 1024,
  photo: 1600,
  fg: 1920,
  rig: 1024,
}
const DEFAULT_MAX_EDGE = 1600

const args = process.argv.slice(2)
const force = args.includes('--force')

interface Job {
  from: string
  to: string
  maxEdge: number
}

async function collect(dir: string, prefix: string, out: Job[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    const key = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      await collect(full, key, out)
      continue
    }
    if (!IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) continue
    const category = key.split('/')[0]
    out.push({
      from: full,
      to: key.replace(/\.[^.]+$/, ''),
      maxEdge: MAX_EDGE[category] ?? DEFAULT_MAX_EDGE,
    })
  }
}

const jobs: Job[] = []
await collect(SRC_DIR, '', jobs)

if (jobs.length === 0) {
  process.stdout.write(
    `\nart-src/ 下没有原图，跳过。\n` +
      `把要处理的图片放进 ${rel(SRC_DIR)}/，按类别分子目录（bg / portrait / ui / photo / fg / rig），\n` +
      `再运行 npm run img:optimize。\n\n`,
  )
  process.exit(0)
}

let processed = 0
let skipped = 0
let srcBytes = 0
let outBytes = 0

for (const job of jobs) {
  for (const format of ['avif', 'webp'] as const) {
    const outPath = path.join(ASSETS_DIR, `${job.to}.${format}`)
    const existing = await stat(outPath).catch(() => null)
    const source = await stat(job.from)
    if (!force && existing && existing.mtimeMs > source.mtimeMs) {
      skipped += 1
      outBytes += existing.size
      continue
    }

    await mkdir(path.dirname(outPath), { recursive: true })
    const pipeline = sharp(job.from).rotate().resize({
      width: job.maxEdge,
      height: job.maxEdge,
      fit: 'inside',
      withoutEnlargement: true,
    })

    if (format === 'avif') await pipeline.avif({ quality: 62, effort: 5 }).toFile(outPath)
    else await pipeline.webp({ quality: 82, effort: 5 }).toFile(outPath)

    const info = await stat(outPath)
    outBytes += info.size
    processed += 1
  }
  srcBytes += (await stat(job.from)).size
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)} MB`
process.stdout.write(`\n✓ 图片管线完成\n`)
process.stdout.write(`    ${jobs.length} 张原图，写出 ${processed} 个文件，跳过 ${skipped} 个（未变更）\n`)
process.stdout.write(`    原图合计 ${mb(srcBytes)} → 产物合计 ${mb(outBytes)}\n\n`)
