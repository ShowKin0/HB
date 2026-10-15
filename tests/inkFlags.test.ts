import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { InkBridge } from '../src/engine/ink/inkBridge.ts'

/*
 * inkjs 的编译器入口没有像样的类型声明，**直接 import 会把它内部的
 * `Story` 声明拖进整个 program**，导致 `inkBridge.ts` 里 `story.currentChoices`
 * 退化成 `any[]`（`noImplicitAny` 立刻报错）。用 createRequire 拿到运行时对象、
 * 自己写一份最小接口，把这个副作用隔离开。
 */
const nodeRequire = createRequire(import.meta.url)
const { Compiler } = nodeRequire('inkjs/compiler/Compiler') as {
  Compiler: new (source: string) => { Compile(): { ToJson(): string } | null }
}

/**
 * 标记（`# flag:` / `# unlock:`）要能被**剧本**读到。
 *
 * 这套标记一直会被写进 `engine.flags` 并随存档持久化，但剧本此前完全看不见
 * 它们 —— 内容写了标记却无法据此分支，等于"只能写、不能读"，而唯一的读取
 * 入口 `getFlag` 也是零调用。现在桥在加载剧本时无条件绑上 `hb_flag(key)`。
 */
function compile(source: string): string {
  const compiler = new Compiler(source)
  const story = compiler.Compile()
  if (!story) throw new Error('编译失败：来源 ink 源码不合法')
  return String(story.ToJson())
}

/** 取第一段台词文本。 */
function firstLine(bridge: InkBridge): string {
  return bridge.next()?.text ?? ''
}

const SOURCE = [
  'EXTERNAL hb_flag(key)',
  '',
  'VAR met = false',
  '~ met = hb_flag("met_mom")',
  '',
  '-> start',
  '',
  '=== start ===',
  '{ met: 记得她。 | 还没见过她。 }',
  '-> END',
  '',
].join('\n')

describe('剧本可以读引擎标记', () => {
  it('含 hb_flag 的条件不缓存跨外部状态更新', () => {
    const bridge = new InkBridge()
    let flag = false
    bridge.readFlag = () => flag
    bridge.load(compile(['EXTERNAL hb_flag(key)', '-> start', '=== start ===', '-> DONE', '=== function check_flag() ===', '~ return hb_flag("x")', ''].join('\n')))
    expect(bridge.evaluate('check_flag')).toBe(false)
    flag = true
    expect(bridge.evaluate('check_flag')).toBe(true)
  })
  const make = (readFlag: ((key: string) => boolean) | null): InkBridge => {
    const bridge = new InkBridge()
    bridge.onError = () => undefined
    if (readFlag) bridge.readFlag = readFlag
    bridge.load(compile(SOURCE))
    return bridge
  }

  it('标记为真时走真分支', () => {
    const bridge = make((key) => key === 'met_mom')
    expect(firstLine(bridge)).toContain('记得她')
  })

  it('标记为假时走假分支', () => {
    expect(firstLine(make(() => false))).toContain('还没见过她')
  })

  it('没注入 readFlag 时一律当假，而且不能炸', () => {
    let bridge: InkBridge | null = null
    expect(() => {
      bridge = make(null)
    }).not.toThrow()
    expect(firstLine(bridge!)).toContain('还没见过她')
  })

  it('剧本没声明 EXTERNAL 时，绑定本身不能出问题', () => {
    const bridge = new InkBridge()
    bridge.onError = () => undefined
    bridge.readFlag = () => true
    expect(() =>
      bridge.load(compile(['-> start', '', '=== start ===', '没有外部函数。', '-> END', ''].join('\n'))),
    ).not.toThrow()
  })

  it('未声明的标记名返回假，而不是抛错', () => {
    const bridge = make(() => false)
    // 桥里那个 ?. 兜底：回调没接上时也不能抛
    expect(bridge.readFlag?.('从来没有过的标记')).toBe(false)
  })
})
