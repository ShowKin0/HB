import type { Shape } from '../schema/common.ts'
import { pointInPolygon } from './math.ts'

/**
 * 热点与出口的形状命中测试，坐标一律在**场景空间**（归一化 0..1）。
 */

function normalizeRect(x: number, y: number, w: number, h: number): [number, number, number, number] {
  const left = w >= 0 ? x : x + w
  const top = h >= 0 ? y : y + h
  return [left, top, Math.abs(w), Math.abs(h)]
}

export function hitTestShape(shape: Shape, x: number, y: number): boolean {
  switch (shape.type) {
    case 'rect': {
      const [left, top, w, h] = normalizeRect(shape.x, shape.y, shape.w, shape.h)
      return x >= left && x <= left + w && y >= top && y <= top + h
    }
    case 'circle': {
      return Math.hypot(x - shape.cx, y - shape.cy) <= shape.r
    }
    case 'poly': {
      return pointInPolygon(x, y, shape.points)
    }
  }
}

/**
 * 形状包围盒的中心。物件的默认绘制锚点用它。
 *
 * 命中区常常比物件本身略大（留交互余量），所以它只是个**默认值** ——
 * 真正的位置和尺寸由物件自己的 position / height 决定。
 */
export function shapeCenter(shape: Shape): [number, number] {
  switch (shape.type) {
    case 'rect': {
      const [left, top, w, h] = normalizeRect(shape.x, shape.y, shape.w, shape.h)
      return [left + w / 2, top + h / 2]
    }
    case 'circle':
      return [shape.cx, shape.cy]
    case 'poly': {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const [px, py] of shape.points) {
        minX = Math.min(minX, px)
        minY = Math.min(minY, py)
        maxX = Math.max(maxX, px)
        maxY = Math.max(maxY, py)
      }
      if (!Number.isFinite(minX)) return [0.5, 0.5]
      return [(minX + maxX) / 2, (minY + maxY) / 2]
    }
  }
}
