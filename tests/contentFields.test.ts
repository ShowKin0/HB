import { describe, expect, it } from 'vitest'
import { SceneSchema } from '../src/schema/scene.ts'
import { normalizeScene } from '../src/schema/scene.rules.ts'

describe('内容字段保真', () => {
  it('根场景和热点拼错字段明确报错，不静默丢弃', () => {
    expect(SceneSchema.safeParse({ id: 'test', aspectRatio: 2 }).success).toBe(false)
    expect(SceneSchema.safeParse({ id: 'test', hotspots: [{ id: 'a', shape: { type: 'rect', x: 0, y: 0, w: 0.1, h: 0.1 }, onClick: 'k', visualState: { on: 'a.png' } }] }).success).toBe(false)
  })
  it('显式 metadata 在开发校验和生产规范化中完整保留', () => {
    const raw = { id: 'test', metadata: { editor: { note: 'hello', version: 2 }, tags: ['a', 'b'] } }
    const parsed = SceneSchema.parse(raw)
    expect(parsed.metadata).toEqual(raw.metadata)
    expect(normalizeScene(raw)).toEqual(parsed)
  })
})
