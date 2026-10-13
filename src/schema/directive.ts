import { z } from 'zod'
import { parseDirective, parseDirectiveArgs } from './directive.rules.ts'

/**
 * 演出指令契约（Zod 校验部分）。
 *
 * **解析函数在 directive.rules.ts**，那个文件不依赖 Zod —— inkBridge 每读一个
 * tag 就要解析一次，把它和 schema 放在一起会让打包器把 Zod 拖进首包。
 */

export { parseDirective, parseDirectiveArgs }
export type { RawDirective } from './directive.rules.ts'

/**
 * 演出指令名。剧本里写成 `# name: value`，由引擎的指令注册表解释执行。
 *
 * 内置指令见 src/engine/directives/builtin.ts；你可以在不改引擎的前提下
 * 通过 registerDirective 注册新指令。
 */
export const DirectiveNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/, '指令名须为小写字母、数字、下划线')
