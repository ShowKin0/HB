import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Story } from 'inkjs'
import { Compiler } from 'inkjs/compiler/Compiler'
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

export interface InkBuildResult {
  source: string
  storyJson: string
  errors: string[]
  warnings: string[]
  symbols: InkSymbols
  lines: InkLine[]
}

const KNOT_RE = /^\s*===\s*(?!function\b)([^=\n]+?)\s*===\s*$/gm
const FUNC_RE = /^\s*===\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm

/** 从 ink 源码抽取 knot / function 名。编译通过时这些名字必定可用。 */
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

/** 编译单个 ink 文件，返回产物与错误。纯内存，不写盘。 */
export function compileInk(source: string): InkBuildResult {
  const compiler = new Compiler(source)
  const base = { source, errors: [...compiler.errors], warnings: [...compiler.warnings] }

  let storyJson = ''
  try {
    storyJson = (compiler.Compile() as unknown as { ToJson(): string }).ToJson()
  } catch {
    // 细节在 compiler.errors 里，这里不再抛，由调用方汇报。
    return { ...base, storyJson: '', symbols: { knots: new Set(), functions: new Set() }, lines: [] }
  }

  const errors = [...compiler.errors]
  if (errors.length > 0) {
    return { ...base, errors, storyJson: '', symbols: { knots: new Set(), functions: new Set() }, lines: [] }
  }

  const symbols = extractSymbols(source)
  // function 不能作为跳转目标，收台词时要排除，否则会触发 ink 运行时错误
  const walkableKnots = [...symbols.knots].filter((name) => !symbols.functions.has(name))
  return {
    ...base,
    errors,
    storyJson,
    symbols,
    lines: collectLines(storyJson, walkableKnots),
  }
}

export async function buildInk(inkPath: string): Promise<InkBuildResult> {
  return compileInk(await readFile(inkPath, 'utf8'))
}

export async function writeStoryJson(outPath: string, storyJson: string): Promise<void> {
  await writeFile(outPath, storyJson, 'utf8')
}

/**
 * 遍历剧本，收集"带文本的行 + 该行的 tag"。
 *
 * 必须**逐个 knot 分别进入**再走：热点 knot 是由引擎用 ChoosePathString
 * 外部跳进去的，从 main 线性遍历根本到不了它们，那样会漏掉大半台词。
 *
 * 每个 knot 内部的选项分支用有界深度优先展开，并受限流保护。
 */
export function collectLines(
  storyJson: string,
  knots: Iterable<string>,
  stepBudget = 8000,
  maxLines = 4000,
): InkLine[] {
  const lines: InkLine[] = []
  const seen = new Set<string>()
  let budget = stepBudget

  /** 收台词时不允许 inkjs 往外抛异常，也不能让它把错误堆栈刷满终端。 */
  const makeStory = (): Story => {
    const story = new Story(storyJson)
    story.onError = () => {}
    return story
  }

  const walk = (story: Story, knot: string, depth: number): void => {
    if (budget <= 0 || lines.length >= maxLines || depth > 48) return

    let guard = 0
    while (story.canContinue && guard++ < 400 && budget-- > 0) {
      const text = story.Continue().trim()
      const tags = [...story.currentTags]
      if (text.length > 0) {
        lines.push({ knot, text, tags })
        if (lines.length >= maxLines) return
      }
    }

    for (const choice of story.currentChoices) {
      if (budget <= 0 || lines.length >= maxLines) return
      const child = makeStory()
      try {
        child.state.LoadJson(story.state.ToJson())
        child.ChooseChoiceIndex(choice.index)
      } catch {
        continue
      }
      const key = `${depth}|${choice.targetPath ?? choice.text}|${child.currentChoices.length}`
      if (seen.has(key)) continue
      seen.add(key)
      budget -= 1
      walk(child, knot, depth + 1)
    }
  }

  for (const knot of knots) {
    if (budget <= 0 || lines.length >= maxLines) break
    const story = makeStory()
    try {
      story.ChoosePathString(knot)
    } catch {
      continue
    }
    budget -= 1
    walk(story, knot, 0)
  }

  return lines
}
