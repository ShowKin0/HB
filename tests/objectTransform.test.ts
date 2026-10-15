import { describe, expect, it } from 'vitest'
import {
  hitTestTransformedShape,
  inverseTransformObjectPoint,
  transformObjectPoint,
  transformObjectShape,
  type ObjectTransform,
} from '../src/render/objectTransform.ts'
import type { Shape } from '../src/schema/common.ts'
import { hitTestShape } from '../src/engine/hitTest.ts'

const RECT: Shape = { type: 'rect', x: 0.4, y: 0.4, w: 0.2, h: 0.2 }

const transform: ObjectTransform = {
  origin: [0.5, 0.5],
  position: [0.7, 0.65],
  scale: 1.7,
  rotation: Math.PI / 5,
  aspect: 16 / 9,
}

describe('共享物件变换', () => {
  it('前向与逆向变换在屏幕 aspect 下互为逆运算', () => {
    for (const point of [[0.41, 0.45], [0.5, 0.5], [0.63, 0.58]] as const) {
      const screen = transformObjectPoint(transform, point)
      const back = inverseTransformObjectPoint(transform, screen)
      expect(back[0]).toBeCloseTo(point[0], 10)
      expect(back[1]).toBeCloseTo(point[1], 10)
    }
  })

  it('缩放、旋转和平移后的 hit shape 命中绘制变换后的点', () => {
    const localPoint: [number, number] = [0.57, 0.47]
    const screenPoint = transformObjectPoint(transform, localPoint)
    expect(hitTestTransformedShape(RECT, ...screenPoint, transform)).toBe(true)
    expect(hitTestShape(RECT, screenPoint[0], screenPoint[1])).toBe(false)

    const shape = transformObjectShape(RECT, transform)
    expect(shape.type).toBe('poly')
  })

  it('无变换时返回原形状，并保留圆形命中精度', () => {
    const circle: Shape = { type: 'circle', cx: 0.5, cy: 0.5, r: 0.1 }
    const identity: ObjectTransform = {
      origin: [0.5, 0.5],
      position: [0.5, 0.5],
      scale: 1,
      rotation: 0,
      aspect: 16 / 9,
    }
    expect(transformObjectShape(circle, identity)).toBe(circle)
    expect(hitTestTransformedShape(circle, 0.59, 0.5, identity)).toBe(true)
  })
})
