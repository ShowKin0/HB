/**
 * 编译 content/story/*.ink → content/story/<name>.json
 *
 * inkjs 自带编译器（inkjs/compiler/Compiler），不需要额外安装 inklecate
 * 二进制，因此这一步在任何平台都是纯 Node 的。
 *
 *   npm run ink:build
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { compileInk, listInkSources } from './lib/ink.ts'
import { rel } from './lib/project.ts'

const files = await listInkSources()

if (files.length === 0) {
  process.stdout.write('content/story 下没有 .ink 文件，跳过。\n')
  process.exit(0)
}

let failed = 0

for (const file of files) {
  const source = await readFile(file, 'utf8')
  const result = compileInk(source)
  const display = rel(file)

  if (result.errors.length > 0) {
    failed++
    process.stderr.write(`\n✗ ${display}\n`)
    for (const error of result.errors) process.stderr.write(`    ${error}\n`)
    continue
  }

  const outPath = path.join(path.dirname(file), `${path.basename(file, '.ink')}.json`)
  // ToJson 输出的就是运行时需要的 story JSON
  await writeFile(outPath, result.storyJson, 'utf8')
  const knots = result.symbols.knots.size
  const lines = result.lines.length
  process.stdout.write(`✓ ${rel(outPath)}  (${knots} 个 knot，${lines} 行文本)\n`)

  for (const warning of result.warnings) {
    process.stdout.write(`    ! ${warning}\n`)
  }
}

if (failed > 0) {
  process.stderr.write(`\n${failed} 个剧本编译失败。\n`)
  process.exit(1)
}
