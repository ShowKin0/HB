/**
 * 编译选定 Ink 入口（优先 main.ink，含 INCLUDE）→ content/story/main.json
 * 独立源文件只做编译诊断，不生成运行时未加载的 story 输出。
 *
 * inkjs 自带编译器（inkjs/compiler/Compiler），不需要额外安装 inklecate
 * 二进制，因此这一步在任何平台都是纯 Node 的。
 *
 *   npm run ink:build
 */
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildInkSources, listInkSources } from './lib/ink.ts'
import { STORY_DIR, rel } from './lib/project.ts'

const files = await listInkSources()

if (files.length === 0) {
  process.stdout.write('content/story 下没有 .ink 文件，跳过。\n')
  process.exit(0)
}

let failed = 0
const build = await buildInkSources(files)

for (const { file, result } of build.checkedSources) {
  const display = rel(file)
  if (result.errors.length > 0) {
    failed++
    process.stderr.write(`\n✗ ${display}\n`)
    for (const error of result.errors) process.stderr.write(`    ${error}\n`)
    continue
  }
  for (const warning of result.warnings) process.stdout.write(`    ! ${warning}\n`)
  if (result.lineReport.status === 'truncated') {
    process.stdout.write(
      `    ! ${display} 台词收集触及上限：${result.lineReport.stopReasons.join(', ')}；` +
        '该报告不声称穷尽 Ink 的动态变量分支。\n',
    )
  }
}

if (!build.entryFile || !build.entryResult) {
  process.stderr.write('没有可用的 Ink 入口源文件。\n')
  process.exit(1)
}

if (failed > 0 || build.entryResult.errors.length > 0) {
  process.stderr.write(`\n${failed || 1} 个剧本编译失败。\n`)
  process.exit(1)
}

const outPath = path.join(STORY_DIR, 'main.json')
await writeFile(outPath, build.entryResult.storyJson, 'utf8')
const knots = build.entryResult.symbols.knots.size
const lines = build.entryResult.lines.length
process.stdout.write(`✓ ${rel(build.entryFile)} → ${rel(outPath)}  (${knots} 个 knot，${lines} 行文本)\n`)
