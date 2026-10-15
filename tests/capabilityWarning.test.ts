import { describe, expect, it } from 'vitest'
import {
  capabilityWarning,
  expandCapabilities,
  hasCapability,
  type CapabilityId,
} from '../src/content/project.rules.ts'
import type { Project } from '../src/content/project.rules.ts'

/**
 * "内容用到了没声明的能力"该怎么报。
 *
 * 这个缺陷有两半：一半是**运行期只对 `minigame` 真的拦截**，另外 7 项未声明
 * 也照跑；另一半是 `project.rules.ts` 上写着"未列出的不会被加载"——文档描述
 * 了一套并不存在的全套门禁。
 *
 * 处理方式是：运行期**只报警、不改行为**（补硬门禁是行为变更，属于设计决定），
 * 同时把文档改成与行为一致。这里守的是"该不该报、报什么"这一半 ——
 * 真正调用它的 `Game.ensureCapability` 是私有方法又依赖整个引擎实例，
 * 那条路径没法直接测。
 */
const project = (...capabilities: CapabilityId[]): Project =>
  ({ capabilities } as unknown as Project)

describe('未声明的能力会被点名', () => {
  it('声明过就什么都不说', () => {
    expect(capabilityWarning(project('audio'), 'audio', '# bgm:')).toBeNull()
  })

  it('没声明时报出能力 id 和用它的地方', () => {
    const message = capabilityWarning(project('audio'), 'inventory', '# award:')
    expect(message).not.toBeNull()
    expect(message, '要能看出是哪个能力').toContain('inventory')
    expect(message, '要能看出是哪里用的').toContain('# award:')
    expect(message, '要告诉作者构建期会拦').toContain('content:check')
  })

  it('一个能力都没声明时，每一项都要报', () => {
    for (const id of [
      'story.ink',
      'interaction.tap',
      'interaction.hold',
      'interaction.drag',
      'audio',
      'minigame',
      'inventory',
      'actor.walk',
    ] as const) {
      expect(capabilityWarning(project(), id, '某处'), `${id} 没被覆盖到`).not.toBeNull()
    }
  })

  it('依赖展开也算声明过 —— 声明 hold 就不该再为 tap 报警', () => {
    // interaction.hold 依赖 interaction.tap
    expect(hasCapability(project('interaction.hold'), 'interaction.tap')).toBe(true)
    expect(capabilityWarning(project('interaction.hold'), 'interaction.tap', '# interact:')).toBeNull()
    // 反过来不成立
    expect(capabilityWarning(project('interaction.tap'), 'interaction.hold', '长按')).not.toBeNull()
  })

  it('依赖展开不会漏项，也不会重复', () => {
    const expanded = expandCapabilities(['interaction.drag', 'actor.walk'])
    expect(new Set(expanded).size).toBe(expanded.length)
    expect(expanded).toContain('interaction.drag')
    expect(expanded).toContain('actor.walk')
  })
})
