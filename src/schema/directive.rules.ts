/**
 * 演出指令的解析规则。
 *
 * 单独成文件的原因很实际：这些函数是**运行时**要用的（inkBridge 每读一个 tag
 * 就调一次），而 directive.ts 里还有 Zod schema。混在一起会让打包器把 Zod
 * 拖进首包 —— 26 kB gzip，只为了一个正则校验。
 *
 * 这里的类型用 `import type` 拿，编译期就被抹掉，所以本文件不依赖 Zod。
 */

/** 指令名：小写字母、数字、下划线。与 DirectiveNameSchema 的正则保持一致。 */
const DIRECTIVE_NAME = /^[a-z][a-z0-9_]*$/

/** 指令的原始形态，value 为冒号后的原文（已去首尾空白），可为空字符串。 */
export interface RawDirective {
  readonly name: string
  readonly value: string
  readonly raw: string
}

/**
 * 解析一条 ink tag。
 *
 * 支持 `bg: room_night` 与 `flag` 两种形态；不带冒号的指令 value 为空串，
 * 便于写 `# once`、`# mute` 这类开关型指令。
 */
export function parseDirective(tag: string): RawDirective | null {
  const raw = tag.trim()
  if (raw.length === 0) return null
  const sep = raw.indexOf(':')
  const name = (sep === -1 ? raw : raw.slice(0, sep)).trim()
  const value = sep === -1 ? '' : raw.slice(sep + 1).trim()
  if (!DIRECTIVE_NAME.test(name)) return null
  return { name, value, raw }
}

/**
 * 指令值的参数语法：`shake(0.3, 2)` → ['0.3', '2']，无括号则整体作为唯一参数。
 * 值本身也支持 `walkTo(0.3, 0.7)` 这种带空格写法。
 */
export function parseDirectiveArgs(value: string): string[] {
  const trimmed = value.trim()
  const open = trimmed.indexOf('(')
  if (open === -1 || !trimmed.endsWith(')')) {
    return trimmed.length === 0 ? [] : [trimmed]
  }
  const head = trimmed.slice(0, open).trim()
  const inner = trimmed.slice(open + 1, -1)
  const args = inner
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  return head.length > 0 ? [head, ...args] : args
}
