import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Story } from 'inkjs'
import { ErrorType } from 'inkjs/engine/Error'
import { Compiler, CompilerOptions } from 'inkjs/compiler/Compiler'
import { PosixFileHandler } from 'inkjs/compiler/FileHandler/PosixFileHandler'
import { STORY_DIR } from './project.ts'

export interface InkSymbols {
  /** 所有顶层 knot 与 function 名。 */
  knots: Set<string>
  /** 仅 `=== function name()` 形式的名字，可作为条件求值。 */
  functions: Set<string>
}

export interface InkLine {
  /** 该行所在的 knot（尽量取，取不到为空串）。 */
  knot: string
  /** 行文本。仅收录非空文本行。 */
  text: string
  /** 该行的 tag 原文，形如 ['vo: line_042', 'bg: room_night']。 */
  tags: string[]
}

export type LineCollectionStopReason = 'step-budget' | 'max-lines' | 'depth-limit' | 'continue-limit' | 'runtime-error' | 'not-run'

export interface LineCollectionReport {
  /** 是否触及了静态遍历的防护上限，不代表 Ink 的动态分支已被穷尽。 */
  status: 'within-limits' | 'truncated' | 'not-run'
  stopReasons: LineCollectionStopReason[]
  collectedLines: number
  exploredKnots: number
  scope: 'bounded-static-walk'
  note: string
}

export interface LineCollectionResult {
  lines: InkLine[]
  report: LineCollectionReport
}

export interface InkSourceFile {
  file: string
  source: string
}

export interface InkBuildResult {
  source: string
  /** 根文件与通过 Ink INCLUDE 加载的源文件。 */
  sourceFiles: InkSourceFile[]
  /** 被编译器 INCLUDE 实际加载的文件路径。 */
  includedFiles: string[]
  storyJson: string
  errors: string[]
  warnings: string[]
  symbols: InkSymbols
  lines: InkLine[]
  lineReport: LineCollectionReport
}

export interface InkSourceBuild {
  /** 运行时唯一会写入 main.json 的入口源文件。 */
  entryFile: string | null
  entryResult: InkBuildResult | null
  /** 独立源文件的编译诊断。被别的源文件 INCLUDE 的片段不重复列为独立源。 */
  checkedSources: Array<{ file: string; result: InkBuildResult }>
}

const KNOT_RE = /^\s*={2,}\s*(?!function\b)([A-Za-z_][A-Za-z0-9_]*)\b/gm
const FUNC_RE = /^\s*={2,}\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm

const LINE_COLLECTION_NOTE =
  '这是有界静态遍历的防护上限报告；Ink 变量、外部函数及运行时状态可能使其他分支可达，不代表已穷尽所有剧情分支。'

/** 从 Ink 源码抽取 knot / function 名。编译通过时这些名字必定可用。 */
export function extractSymbols(source: string): InkSymbols {
  const knots = new Set<string>()
  const functions = new Set<string>()
  for (const m of source.matchAll(FUNC_RE)) functions.add(m[1])
  for (const m of source.matchAll(KNOT_RE)) {
    // `=== a.b ===` 是 stitch 写法，只取顶层 knot
    const name = m[1].split('.')[0].trim()
    if (name) knots.add(name)
  }
  for (const fn of functions) knots.add(fn)
  return { knots, functions }
}

/** 入口固定为唯一 main.ink；没有唯一 main 时退回排序首个源文件。 */
export function selectInkEntryFile(files: readonly string[]): string | null {
  const sorted = [...files].sort()
  const mains = sorted.filter((file) => path.basename(file) === 'main.ink')
  if (mains.length === 1) return mains[0]
  return sorted[0] ?? null
}

export async function listInkSources(): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(STORY_DIR)
  } catch {
    return []
  }
  return entries
    .filter((name) => name.endsWith('.ink'))
    .sort()
    .map((name) => path.join(STORY_DIR, name))
}

function emptyLineReport(status: 'not-run' = 'not-run'): LineCollectionReport {
  return {
    status,
    stopReasons: ['not-run'],
    collectedLines: 0,
    exploredKnots: 0,
    scope: 'bounded-static-walk',
    note: LINE_COLLECTION_NOTE,
  }
}

/** 编译单个 Ink 文件。给 sourceFilename 时通过 inkjs fileHandler 加载 INCLUDE。 */
export function compileInk(source: string, sourceFilename?: string): InkBuildResult {
  const includedSources = new Map<string, string>()
  const normalizedRoot = sourceFilename ? path.resolve(sourceFilename) : null
  const posixHandler = normalizedRoot ? new PosixFileHandler(path.dirname(normalizedRoot)) : null
  const fileHandler = posixHandler
    ? {
        // inkjs 的 PosixFileHandler 以入口目录为 INCLUDE 根目录，包括嵌套 INCLUDE。
        ResolveInkFilename: (filename: string): string => posixHandler.ResolveInkFilename(filename),
        LoadInkFileContents: (filename: string): string => {
          const resolved = path.resolve(filename)
          const included = posixHandler.LoadInkFileContents(resolved)
          if (resolved !== normalizedRoot) includedSources.set(resolved, included)
          return included
        },
      }
    : null
  const options = normalizedRoot
    ? new CompilerOptions(normalizedRoot, [], false, null, fileHandler)
    : undefined
  const compiler = new Compiler(source, options)
  let storyJson = ''
  let thrownError = ''
  try {
    const story = compiler.Compile()
    if (story) storyJson = String(story.ToJson())
  } catch (error) {
    // inkjs 通常会把错误放到 compiler.errors；某些文件系统 / 内部异常会直接抛出。
    thrownError = error instanceof Error ? error.message : String(error)
  }

  // Compiler.errors 在 Compile() 执行期间才会填充，必须在 Compile 之后采集。
  const errors = [...compiler.errors]
  if (thrownError && !errors.includes(thrownError)) errors.push(thrownError)
  if (!storyJson && errors.length === 0) errors.push('Ink 编译器没有生成 story JSON。')
  const warnings = [...compiler.warnings]
  const sourceFiles: InkSourceFile[] = [
    { file: normalizedRoot ?? '', source },
    ...[...includedSources.entries()].map(([file, includedSource]) => ({ file, source: includedSource })),
  ]
  const includedFiles = [...includedSources.keys()]

  if (errors.length > 0) {
    return {
      source,
      sourceFiles,
      includedFiles,
      storyJson: '',
      errors,
      warnings,
      symbols: { knots: new Set(), functions: new Set() },
      lines: [],
      lineReport: emptyLineReport(),
    }
  }

  const symbols = extractSymbols(sourceFiles.map((entry) => entry.source).join('\n'))
  const runtimeNames = compiler.runtimeStory.mainContentContainer.namedContent
  for (const name of symbols.knots) {
    if (!runtimeNames.has(name)) {
      symbols.knots.delete(name)
      symbols.functions.delete(name)
    }
  }
  // function 不能作为跳转目标，收台词时要排除，否则会触发 Ink 运行时错误。
  const walkableKnots = [...symbols.knots].filter((name) => !symbols.functions.has(name))
  const collection = collectLines(storyJson, walkableKnots.length > 0 ? walkableKnots : [''])
  return {
    source,
    sourceFiles,
    includedFiles,
    storyJson,
    errors,
    warnings,
    symbols,
    lines: collection.lines,
    lineReport: collection.report,
  }
}

export async function buildInk(inkPath: string): Promise<InkBuildResult> {
  return compileInk(await readFile(inkPath, 'utf8'), inkPath)
}

/** 编译项目里所有源文件用于校验，但选定单一入口作为运行时 story。 */
export async function buildInkSources(files: readonly string[]): Promise<InkSourceBuild> {
  const sorted = [...files].sort()
  const entryFile = selectInkEntryFile(sorted)
  if (!entryFile) return { entryFile: null, entryResult: null, checkedSources: [] }

  const compiled: Array<{ file: string; result: InkBuildResult }> = []
  for (const file of sorted) compiled.push({ file, result: await buildInk(file) })

  const includedFiles = new Set(compiled.flatMap(({ result }) => result.includedFiles.map((file) => path.resolve(file))))
  const checkedSources = compiled.filter(
    ({ file }) => path.resolve(file) === path.resolve(entryFile) || !includedFiles.has(path.resolve(file)),
  )
  const entryResult = compiled.find(({ file }) => path.resolve(file) === path.resolve(entryFile))?.result ?? null
  return { entryFile, entryResult, checkedSources }
}

export async function writeStoryJson(outPath: string, storyJson: string): Promise<void> {
  await writeFile(outPath, storyJson, 'utf8')
}

/**
 * 遍历剧本，收集"带文本的行 + 该行的 tag"。
 *
 * 必须逐个 knot 分别进入，再对当前变量状态下可见的选项做有界深度优先展开。
 * 报告只说明是否触及了防护上限，不能证明所有运行时变量分支均已静态穷尽。
 */
export function collectLines(
  storyJson: string,
  knots: Iterable<string>,
  stepBudget = 8000,
  maxLines = 4000,
): LineCollectionResult {
  const lines: InkLine[] = []
  const seen = new Set<string>()
  const stopReasons = new Set<LineCollectionStopReason>()
  const knotNames = [...knots]
  let budget = stepBudget
  let exploredKnots = 0

  /** 收台词时不允许 inkjs 往外抛异常，也不能让它把错误堆栈刷满终端。 */
  const makeStory = (): Story => {
    const story = new Story(storyJson)
    story.onError = (_message: string, type: ErrorType) => {
      if (type === ErrorType.Error) stopReasons.add('runtime-error')
    }
    return story
  }

  const walk = (story: Story, knot: string, depth: number): void => {
    if (depth > 48) {
      stopReasons.add('depth-limit')
      return
    }
    if (budget <= 0) {
      stopReasons.add('step-budget')
      return
    }
    if (lines.length >= maxLines) {
      stopReasons.add('max-lines')
      return
    }

    let guard = 0
    while (story.canContinue && guard < 400) {
      if (lines.length >= maxLines) {
        stopReasons.add('max-lines')
        return
      }
      if (budget <= 0) {
        stopReasons.add('step-budget')
        break
      }
      guard += 1
      budget -= 1
      const text = story.Continue().trim()
      const tags = [...story.currentTags]
      if (text.length > 0) {
        lines.push({ knot, text, tags })
        if (lines.length >= maxLines && (story.canContinue || story.currentChoices.length > 0)) {
          stopReasons.add('max-lines')
          return
        }
      }
    }
    if (guard >= 400 && story.canContinue) {
      stopReasons.add('continue-limit')
      return
    }

    for (const choice of story.currentChoices) {
      if (budget <= 0) {
        stopReasons.add('step-budget')
        return
      }
      if (lines.length >= maxLines) {
        stopReasons.add('max-lines')
        return
      }
      const child = makeStory()
      try {
        child.state.LoadJson(story.state.ToJson())
        child.ChooseChoiceIndex(choice.index)
      } catch {
        // Ink 运行时状态已知不可继续；继续别的分支，但这不是完整遍历。
        stopReasons.add('continue-limit')
        continue
      }
      const key = `${depth}|${choice.targetPath ?? choice.text}|${child.currentChoices.length}`
      if (seen.has(key)) continue
      seen.add(key)
      budget -= 1
      walk(child, knot, depth + 1)
    }
  }

  for (let index = 0; index < knotNames.length; index += 1) {
    if (budget <= 0) {
      stopReasons.add('step-budget')
      break
    }
    if (lines.length >= maxLines) {
      stopReasons.add('max-lines')
      break
    }
    const knot = knotNames[index]
    const story = makeStory()
    try {
      if (knot) story.ChoosePathString(knot)
    } catch {
      // 无法进入已编译名字时保留其他 knot 的结果，但标记静态收集不完整。
      stopReasons.add('continue-limit')
      continue
    }
    exploredKnots += 1
    budget -= 1
    walk(story, knot, 0)
    if (lines.length >= maxLines && index < knotNames.length - 1) {
      stopReasons.add('max-lines')
      break
    }
  }

  const reasons = [...stopReasons]
  return {
    lines,
    report: {
      status: reasons.length > 0 ? 'truncated' : 'within-limits',
      stopReasons: reasons,
      collectedLines: lines.length,
      exploredKnots,
      scope: 'bounded-static-walk',
      note: LINE_COLLECTION_NOTE,
    },
  }
}
