import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SceneSchema } from '../src/schema/scene.ts'
import { normalizeScene } from '../src/schema/scene.rules.ts'

/**
 * 规范化 ↔ schema 一致性。
 *
 * 生产构建不做 Zod 校验（内容是构建期校验过的常量），但**默认值填充不能省** ——
 * 少了它，一份没写 visualStates 的场景 JSON 会在运行时炸成
 * `Object.values(undefined)`。这个坑真的踩过一次。
 *
 * 于是默认值现在有两份：schema 的 .default() 和 normalizeScene。
 * 两份就会漂。下面这些测试就是用来**让漂移直接失败**的：
 * 只要给 schema 加了默认值却忘了改 normalizeScene，这里立刻红。
 */

const SCENE_DIR = path.join(process.cwd(), 'content', 'scenes')

function readScene(file: string): unknown {
  const text = readFileSync(path.join(SCENE_DIR, file), 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(text)
}

describe('真实内容：normalizeScene 与 SceneSchema 结果一致', () => {
  const files = readdirSync(SCENE_DIR).filter((name) => name.endsWith('.json'))

  it('至少有一个场景文件可测', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    it(`${file}`, () => {
      const raw = readScene(file)
      const parsed = SceneSchema.safeParse(raw)
      // 真实内容必须能通过 schema —— 通不过说明 content:check 该报的错没报
      expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true)
      expect(normalizeScene(raw)).toEqual(parsed.data)
    })
  }
})

describe('最简输入：两边填出来的默认值必须一模一样', () => {
  /** 一个什么可选字段都不写的场景 —— 专门用来逼出所有默认值。 */
  const minimal = {
    id: 'bare',
    mode: 'focus',
    hotspots: [{ id: 'h', shape: { type: 'rect', x: 0, y: 0, w: 0.1, h: 0.1 }, onClick: 'k' }],
  }

  it('整体一致', () => {
    const parsed = SceneSchema.safeParse(minimal)
    expect(parsed.success).toBe(true)
    expect(normalizeScene(minimal)).toEqual(parsed.data)
  })

  it('物件的默认值一致（这是当初崩掉的那一处）', () => {
    const parsed = SceneSchema.parse(minimal)
    const normalized = normalizeScene(minimal)
    expect(normalized.hotspots[0].visualStates).toEqual({})
    expect(normalized.hotspots[0]).toEqual(parsed.hotspots[0])
  })

  it('缺省数组一律补成空数组，而不是 undefined', () => {
    const scene = normalizeScene({ id: 'x' })
    expect(scene.actors).toEqual([])
    expect(scene.hotspots).toEqual([])
    expect(scene.layers).toEqual([])
    expect(scene.exits).toEqual([])
    expect(scene.walkable).toBeNull()
    expect(scene.ground).toBeNull()
  })

  it('交互里缺省的 accepts 补成空数组', () => {
    const scene = normalizeScene({
      id: 'x',
      mode: 'focus',
      hotspots: [
        {
          id: 'h',
          shape: { type: 'rect', x: 0, y: 0, w: 0.1, h: 0.1 },
          interactions: [{ verb: 'drag', action: 'k' }],
        },
      ],
    })
    expect(scene.hotspots[0].interactions[0].accepts).toEqual([])
    expect(scene.hotspots[0].interactions[0].when).toBeNull()
    expect(SceneSchema.safeParse(scene).success).toBe(true)
  })

  it('图层缺省时 image 补成空串（由校验去挑错，而不是留 undefined）', () => {
    const scene = normalizeScene({ id: 'x', mode: 'focus', layers: [{ id: 'l' }] })
    expect(scene.layers[0].image).toBe('')
    expect(typeof scene.layers[0].anchor[0]).toBe('number')
  })

  it('动效缺省时补成 none，且幅度有默认值', () => {
    const scene = normalizeScene({
      id: 'x',
      mode: 'focus',
      hotspots: [{ id: 'h', shape: { type: 'rect', x: 0, y: 0, w: 0.1, h: 0.1 }, onClick: 'k' }],
    })
    expect(scene.hotspots[0].anim).toEqual({ type: 'none', amplitude: 0.008, speed: 0.6, phase: 0 })
  })

  it('角色的朝向只接受 ±1，其他值一律当 1', () => {
    const base = { id: 'x', mode: 'walk', ground: { corners: [[0, 0], [1, 0], [1, 1], [0, 1]] }, walkable: ['..', '..'] }
    const scene = normalizeScene({
      ...base,
      actors: [{ id: 'a', spawn: [0.5, 0.5], facing: 7 }],
    })
    expect(scene.actors[0].facing).toBe(1)
  })
})
