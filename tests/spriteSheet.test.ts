import { describe, expect, it } from 'vitest'
import { DIR8, directionOf, pickFrame, type SpriteAtlas } from '../src/actorRenderers/spriteSheet.ts'

/**
 * 精灵表渲染器的纯逻辑测试。
 *
 * 这条渲染路径没有真实素材可跑，所以至少要把它唯一的两个纯函数
 * （方向判定与选帧）钉死 —— 否则它只是一段"看起来对"的代码。
 */

describe('directionOf', () => {
  it('八个方向都映射到正确的名字', () => {
    expect(directionOf(1, 0)).toBe('E')
    expect(directionOf(1, 1)).toBe('SE')
    expect(directionOf(0, 1)).toBe('S')
    expect(directionOf(-1, 1)).toBe('SW')
    expect(directionOf(-1, 0)).toBe('W')
    expect(directionOf(-1, -1)).toBe('NW')
    expect(directionOf(0, -1)).toBe('N')
    expect(directionOf(1, -1)).toBe('NE')
  })

  it('任意向量都落在八个方向里', () => {
    for (let i = 0; i < 64; i++) {
      const angle = (i / 64) * Math.PI * 2
      expect(DIR8).toContain(directionOf(Math.cos(angle), Math.sin(angle)))
    }
  })
})

const ATLAS: SpriteAtlas = {
  columns: 4,
  frameWidth: 32,
  frameHeight: 48,
  clips: {
    'walk:S': [0, 1, 2, 3],
    'idle:S': [4],
    'walk:E': [5, 6],
  },
}

describe('pickFrame', () => {
  it('按相位在片段内取帧', () => {
    expect(pickFrame(ATLAS, 'S', 0, true)).toBe(0)
    expect(pickFrame(ATLAS, 'S', Math.PI / 2, true)).toBe(1)
    expect(pickFrame(ATLAS, 'S', Math.PI, true)).toBe(2)
    expect(pickFrame(ATLAS, 'S', Math.PI * 1.5, true)).toBe(3)
  })

  it('站立时只取 idle 的首帧，不随相位变', () => {
    expect(pickFrame(ATLAS, 'S', 0, false)).toBe(4)
    expect(pickFrame(ATLAS, 'S', 2.5, false)).toBe(4)
  })

  it('缺少该方向时回退到 S', () => {
    expect(pickFrame(ATLAS, 'N', 0, true)).toBe(0)
    expect(pickFrame(ATLAS, 'NW', Math.PI / 2, true)).toBe(1)
  })

  it('相位为负也不越界', () => {
    const frame = pickFrame(ATLAS, 'S', -Math.PI / 2, true)
    expect(frame).not.toBeNull()
    expect(frame!).toBeGreaterThanOrEqual(0)
    expect(frame!).toBeLessThan(4)
  })

  it('相位超过一整圈也不越界', () => {
    const frame = pickFrame(ATLAS, 'S', Math.PI * 2 * 3.7, true)
    expect(frame).not.toBeNull()
    expect(frame!).toBeGreaterThanOrEqual(0)
    expect(frame!).toBeLessThan(4)
  })

  it('单帧片段恒定返回该帧', () => {
    expect(pickFrame(ATLAS, 'S', 1.1, false)).toBe(4)
  })

  it('没有可用片段时返回 null，交给调用方降级', () => {
    expect(pickFrame({ ...ATLAS, clips: {} }, 'S', 0, true)).toBeNull()
  })

  it('只有 idle 片段时，行走也能拿到帧而不是 null', () => {
    const onlyIdle: SpriteAtlas = { ...ATLAS, clips: { 'idle:S': [7] } }
    expect(pickFrame(onlyIdle, 'S', 0, true)).toBe(7)
  })
})
