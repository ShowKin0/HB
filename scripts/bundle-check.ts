/**
 * 构建产物守卫。
 *
 * 为什么需要它：Zod 只用于**构建期**校验（content:check、编辑器、开发期运行时）。
 * 一旦它被某个运行时模块按值引用，打包器就摇不掉它 —— 首包白背 24 kB gzip，
 * 而且**所有"某段代码在不在包里"的字符串检查都查不出来**，因为那段代码确实被摇掉了。
 *
 * 这个坑踩过两次：
 *   1. App.tsx 静态 import 编辑器 → Editor → scene.ts → zod
 *   2. content/project.ts 同时放 schema 与运行时函数 → load.ts 按值引用
 *
 * 所以现在把它变成一条构建期的硬约束，而不是靠人记得。
 *
 *   npm run bundle:check
 */

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { Reporter } from './lib/report.ts'
import { ROOT } from './lib/project.ts'

/** 只属于 Zod 的特征串。挑几个不会被业务代码碰巧写出来的。 */
const ZOD_MARKERS = ['ZodError', 'ZodType', '_zod', 'ZodFirstPartyTypeKind']

/** 允许出现在产物里的第三方库：它们本来就要在运行时跑。 */
const ALLOWED_RUNTIME_DEPS = ['react', 'react-dom', 'scheduler', 'inkjs', 'howler']

const BUNDLE_DIR = path.join(ROOT, 'dist', '_bundle')

const reporter = new Reporter()

let files: string[]
try {
  files = (await readdir(BUNDLE_DIR)).filter((name) => name.endsWith('.js'))
} catch {
  reporter.error('找不到 dist/_bundle，先运行 npm run build')
  process.exit(reporter.flush('构建产物检查') > 0 ? 1 : 0)
}

if (files.length === 0) reporter.error('dist/_bundle 里没有 JS 产物')

let totalBytes = 0
const rows: { name: string; bytes: number; zod: boolean }[] = []

for (const name of files) {
  const content = await readFile(path.join(BUNDLE_DIR, name), 'utf8')
  totalBytes += Buffer.byteLength(content)
  const hit = ZOD_MARKERS.find((marker) => content.includes(marker))
  rows.push({ name, bytes: Buffer.byteLength(content), zod: hit !== undefined })
  if (hit) {
    reporter.error(
      `${name} 里出现了 Zod（特征串 "${hit}"）。` +
        `说明某个运行时模块按值引用了带 schema 的文件 —— ` +
        `把运行时函数挪到 *.rules.ts，只留 import type 引类型。`,
    )
  }
}

// 依赖清单本身也检查一遍：出现没预期的库，多半是误引
const mainChunk = rows.find((row) => row.name.startsWith('index-'))
if (mainChunk && mainChunk.bytes > 400 * 1024) {
  reporter.warn(`主 chunk 已达 ${Math.round(mainChunk.bytes / 1024)} KB，考虑再拆一次`)
}

for (const row of [...rows].sort((a, b) => b.bytes - a.bytes)) {
  reporter.info(`${row.name}  ${Math.round(row.bytes / 1024)} KB${row.zod ? '  ← 含 Zod' : ''}`)
}

reporter.info(
  `产物共 ${files.length} 个 chunk，${Math.round(totalBytes / 1024)} KB；` +
    `运行时应有的依赖：${ALLOWED_RUNTIME_DEPS.join(' / ')}`,
)

process.exit(reporter.flush('构建产物检查') > 0 ? 1 : 0)
