import { describe, expect, it } from 'vitest'
import { findPath } from '../src/engine/nav/astar.ts'
import {
  isPlaneWalkable,
  isWalkable,
  nearestWalkable,
  parseMask,
  planeToCell,
  walkableCount,
} from '../src/engine/nav/mask.ts'
import { buildPath, lineOfSight, pathLength, simplifyPath } from '../src/engine/nav/smooth.ts'

/** 中间一堵墙，只能在墙的上方或下方绕行。 */
const WALLED = [
  '................',
  '................',
  '................',
  '.....######.....',
  '.....######.....',
  '.....######.....',
  '.....######.....',
  '................',
  '................',
  '................',
]

/** 对角缝隙：禁止穿角时应当无路可走。 */
const DIAGONAL_GAP = ['.#', '#.']

const DISCONNECTED = ['.#.', '.#.', '.#.']

const walled = parseMask(WALLED)
const diagonal = parseMask(DIAGONAL_GAP)
const split = parseMask(DISCONNECTED)

describe('parseMask', () => {
  it('统计可走格子', () => {
    expect(walkableCount(walled)).toBe(160 - 24)
    expect(walled.cols).toBe(16)
    expect(walled.rows).toBe(10)
  })

  it('越界一律不可走', () => {
    expect(isWalkable(walled, -1, 0)).toBe(false)
    expect(isWalkable(walled, 0, 99)).toBe(false)
    expect(isWalkable(walled, 16, 0)).toBe(false)
  })
})

describe('findPath', () => {
  it('绕开墙体而不是穿过', () => {
    const path = findPath(walled, [2, 4], [13, 4])
    expect(path).not.toBeNull()
    // 直线 11 步即可到达，但墙横跨 col 5..10 / row 3..6，
    // 必须先离开 row 3..6 才能横穿。最少 2 步斜向 + 9 步直行。
    expect(path!.length).toBeGreaterThanOrEqual(12)
    expect(path!.some(([, r]) => r <= 2 || r >= 7)).toBe(true)
    for (const [c, r] of path!) {
      expect(isWalkable(walled, c, r)).toBe(true)
    }
  })

  it('禁止穿角时对角缝隙不可通行', () => {
    expect(findPath(diagonal, [0, 0], [1, 1])).toBeNull()
  })

  it('允许穿角时对角缝隙可通行', () => {
    const path = findPath(diagonal, [0, 0], [1, 1], { allowCornerCutting: true })
    expect(path).not.toBeNull()
    expect(path!.length).toBe(2)
  })

  it('起点终点相同返回单格', () => {
    expect(findPath(walled, [3, 3], [3, 3])).toEqual([[3, 3]])
  })

  it('不连通时返回 null', () => {
    expect(findPath(split, [0, 0], [2, 0])).toBeNull()
  })

  it('目标不可走时返回 null', () => {
    expect(findPath(walled, [2, 2], [7, 4])).toBeNull()
  })
})

describe('nearestWalkable', () => {
  it('从墙内吸附到欧氏最近的可走格', () => {
    // 墙覆盖 col 5..10 / row 3..6。(7,4) 的欧氏最近解是正上方 (7,2)，距离 2
    const cell = nearestWalkable(walled, 7, 4)
    expect(cell).not.toBeNull()
    const [c, r] = cell!
    expect(isWalkable(walled, c, r)).toBe(true)
    expect(Math.hypot(c - 7, r - 4)).toBeCloseTo(2, 9)
  })

  it('与暴力搜索的结果一致', () => {
    for (const [col, row] of [
      [7, 4],
      [5, 3],
      [10, 6],
      [0, 0],
    ]) {
      let bestDistance = Infinity
      for (let r = 0; r < walled.rows; r++) {
        for (let c = 0; c < walled.cols; c++) {
          if (!isWalkable(walled, c, r)) continue
          bestDistance = Math.min(bestDistance, Math.hypot(c - col, r - row))
        }
      }
      const cell = nearestWalkable(walled, col, row)!
      expect(Math.hypot(cell[0] - col, cell[1] - row)).toBeCloseTo(bestDistance, 9)
    }
  })

  it('已经在可走格时返回原格', () => {
    expect(nearestWalkable(walled, 2, 2)).toEqual([2, 2])
  })

  it('把越界坐标夹回网格内', () => {
    const cell = nearestWalkable(walled, 999, 999)
    expect(cell).not.toBeNull()
    expect(isWalkable(walled, cell![0], cell![1])).toBe(true)
  })
})

describe('lineOfSight', () => {
  it('穿过墙体时判定为不可见', () => {
    expect(lineOfSight(walled, [0.2, 0.45], [0.9, 0.45])).toBe(false)
  })

  it('同侧无遮挡时可见', () => {
    expect(lineOfSight(walled, [0.1, 0.1], [0.4, 0.15])).toBe(true)
  })
})

describe('simplifyPath', () => {
  it('把阶梯状格子路径压成少量拐点', () => {
    const path = findPath(walled, [0, 0], [15, 9])!
    const simplified = simplifyPath(walled, path)
    expect(simplified.length).toBeGreaterThanOrEqual(2)
    expect(simplified.length).toBeLessThanOrEqual(4)
  })
})

describe('buildPath', () => {
  it('起终点被精确替换，而不是停在格子中心', () => {
    const from: [number, number] = [0.1, 0.1]
    const to: [number, number] = [0.9, 0.9]
    const path = buildPath(walled, from, to)
    expect(path).not.toBeNull()
    expect(path![0][0]).toBeCloseTo(from[0], 9)
    expect(path![0][1]).toBeCloseTo(from[1], 9)
    expect(path![path!.length - 1][0]).toBeCloseTo(to[0], 9)
    expect(path![path!.length - 1][1]).toBeCloseTo(to[1], 9)
  })

  it('圆角后整条路径都落在可走区域内', () => {
    const path = buildPath(walled, [0.13, 0.45], [0.87, 0.45])
    expect(path).not.toBeNull()
    for (const [u, v] of path!) {
      expect(isPlaneWalkable(walled, u, v)).toBe(true)
    }
  })

  it('点到墙里时吸附到最近可走点，绝不原地不动', () => {
    const wallCenterU = (7 + 0.5) / walled.cols
    const wallCenterV = (4 + 0.5) / walled.rows
    const path = buildPath(walled, [0.05, 0.05], [wallCenterU, wallCenterV])
    expect(path).not.toBeNull()
    const end = path![path!.length - 1]
    expect(isPlaneWalkable(walled, end[0], end[1])).toBe(true)
    // 终点应贴在墙边而非墙心
    const [ec, er] = planeToCell(walled, end[0], end[1])
    expect(isWalkable(walled, ec, er)).toBe(true)
  })

  it('绕行路径比直线更长', () => {
    const straight = Math.hypot(0.87 - 0.13, 0)
    const path = buildPath(walled, [0.13, 0.45], [0.87, 0.45])
    expect(path).not.toBeNull()
    expect(pathLength(path!)).toBeGreaterThan(straight)
  })

  it('完全封死时返回 null 而不是抛异常', () => {
    const sealed = parseMask(['###', '###', '###'])
    expect(buildPath(sealed, [0.1, 0.1], [0.9, 0.9])).toBeNull()
  })
})
