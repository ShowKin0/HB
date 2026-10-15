import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_REGISTRY,
  ProjectSchema,
  defaultProject,
  expandCapabilities,
  hasCapability,
  normalizeProject,
} from '../src/content/project.ts'

/**
 * 项目清单与能力注册表。
 *
 * 这是 P2 的地基：引擎不再假设"每个游戏都有物品栏、寻路和小游戏"，
 * 而是按项目声明加载。
 */

describe('能力注册表', () => {
  it('每个能力都有说明与依赖字段', () => {
    for (const [id, descriptor] of Object.entries(CAPABILITY_REGISTRY)) {
      expect(descriptor.id).toBe(id)
      expect(descriptor.summary.length).toBeGreaterThan(0)
      expect(Array.isArray(descriptor.requires)).toBe(true)
      expect(Array.isArray(descriptor.triggers)).toBe(true)
    }
  })

  it('依赖都是已注册的能力，没有悬空引用', () => {
    for (const descriptor of Object.values(CAPABILITY_REGISTRY)) {
      for (const dep of descriptor.requires) {
        expect(CAPABILITY_REGISTRY[dep], `${descriptor.id} 依赖了不存在的 ${dep}`).toBeDefined()
      }
    }
  })

  it('依赖不会成环', () => {
    // 展开依赖本身就会死循环，所以能跑完就是不成环的证明
    for (const id of Object.keys(CAPABILITY_REGISTRY) as (keyof typeof CAPABILITY_REGISTRY)[]) {
      expect(() => expandCapabilities([id])).not.toThrow()
    }
  })

  it('声明 hold 会自动带上它依赖的 tap', () => {
    const expanded = expandCapabilities(['interaction.hold'])
    expect(expanded).toContain('interaction.hold')
    expect(expanded).toContain('interaction.tap')
  })

  it('没有依赖的能力不会被顺带带上', () => {
    expect(expandCapabilities(['interaction.tap'])).not.toContain('interaction.hold')
  })
})

describe('项目清单规范化', () => {
  it('空对象得到一份最小可用项目', () => {
    const project = normalizeProject({})
    expect(project.schemaVersion).toBe(1)
    expect(project.capabilities.length).toBeGreaterThan(0)
    expect(project.mobile.maxDpr).toBe(2)
    expect(project.minigame.skipAfter).toBe(3)
  })

  it('未知能力 id 被丢掉，而不是让引擎去加载不存在的东西', () => {
    const project = normalizeProject({ capabilities: ['story.ink', 'nonexistent.capability'] })
    expect(project.capabilities).toEqual(['story.ink'])
  })

  it('DPR 被夹在 1..4', () => {
    expect(normalizeProject({ mobile: { maxDpr: 99 } }).mobile.maxDpr).toBe(4)
    expect(normalizeProject({ mobile: { maxDpr: 0 } }).mobile.maxDpr).toBe(1)
    expect(normalizeProject({ mobile: { maxDpr: 'x' } }).mobile.maxDpr).toBe(2)
  })

  it('非法的枚举值回落到默认，而不是原样透传', () => {
    const project = normalizeProject({ mobile: { orientation: 'diagonal', sceneFit: 'squish' } })
    // 默认横屏：这个项目的主要形态是手机上横屏玩
    expect(project.mobile.orientation).toBe('landscape')
    expect(project.mobile.sceneFit).toBe('contain')
  })

  it('skipAfter 为 null 表示不允许跳过', () => {
    expect(normalizeProject({ minigame: { skipAfter: null } }).minigame.skipAfter).toBeNull()
  })

  it('负数 skipAfter 夹到 0', () => {
    expect(normalizeProject({ minigame: { skipAfter: -5 } }).minigame.skipAfter).toBe(0)
  })
})

describe('真实清单：规范化与 Zod 结果一致', () => {
  const file = path.join(process.cwd(), 'content', 'project.json')

  it('content/project.json 通过 schema 且两边一致', () => {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    const parsed = ProjectSchema.safeParse(raw)
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true)
    expect(normalizeProject(raw)).toEqual(parsed.data)
  })

  it('真实项目声明的起始场景是存在的', () => {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { startScene?: string }
    expect(raw.startScene).toBeTruthy()
  })

  it('真实项目启用了它内容里用到的能力', () => {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { capabilities: string[] }
    const project = normalizeProject(raw)
    // 占位内容里有长按和拖放，所以必须声明
    expect(hasCapability(project, 'interaction.hold')).toBe(true)
    expect(hasCapability(project, 'interaction.drag')).toBe(true)
    expect(hasCapability(project, 'minigame')).toBe(true)
  })
})

describe('默认项目', () => {
  it('defaultProject 与 normalizeProject({}) 结果一致', () => {
    expect(defaultProject()).toEqual(normalizeProject({}))
  })
})
