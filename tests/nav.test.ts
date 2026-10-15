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

/**
 * 折线是否**真正**落在可走区域内。
 *
 * 关键是逐段**密采样**，而不是只检查顶点 —— 原来那条不变式用例就是
 * 只查顶点，所以路径从阻挡格里穿过去它一直是绿的。
 */
function pathStaysWalkable(
  mask: ReturnType<typeof parseMask>,
  path: readonly (readonly [number, number])[],
  samplesPerSegment = 400,
): { ok: boolean; detail: string } {
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1]
    const [bx, by] = path[i]
    for (let s = 0; s <= samplesPerSegment; s++) {
      const t = s / samplesPerSegment
      const u = ax + (bx - ax) * t
      const v = ay + (by - ay) * t
      if (!isPlaneWalkable(mask, u, v)) {
        return { ok: false, detail: `第 ${i - 1}→${i} 段在 t=${t.toFixed(3)} 处落在阻挡格 (${u.toFixed(4)}, ${v.toFixed(4)})` }
      }
    }
  }
  return { ok: true, detail: '' }
}

/**
 * 擦角：线段从一个阻挡格的角上切过去。
 *
 * 采样法抓不到这种 —— 步长再小，采样点也可能全落在两侧的可走格里。
 * 这正是 `lineOfSight` 从采样改成精确求交的原因。
 */
describe('视线判定必须精确', () => {
  const CORNER = parseMask([
    '..........',
    '......#...',
    '.....#....',
    '..........',
  ])

  it('从阻挡格的角上擦过去的线段判为不可见', () => {
    // 斜穿 (6,1) 这个阻挡格的右下角
    expect(lineOfSight(CORNER, [0.55, 0.1875], [0.85, 0.4375])).toBe(false)
  })

  it('确实绕开的线段判为可见', () => {
    expect(lineOfSight(CORNER, [0.05, 0.1], [0.95, 0.1])).toBe(true)
  })

  it('端点本身在阻挡格内时直接不可见', () => {
    // (0.65, 0.30) 落在阻挡格 (6,1) 里：u∈[0.6,0.7]、v∈[0.25,0.5]
    expect(lineOfSight(CORNER, [0.65, 0.3], [0.95, 0.1])).toBe(false)
  })
})

describe('路径每一段都不能穿墙', () => {
  /** 带一堵竖墙的掩码，绕行必须走墙的上下两端。 */
  const OBSTACLE = parseMask([
    '............',
    '............',
    '.....##.....',
    '.....##.....',
    '.....##.....',
    '............',
    '............',
  ])

  it('单次查询：逐段密采样都在可走区域内', () => {
    const path = buildPath(OBSTACLE, [0.15, 0.4], [0.85, 0.6])
    expect(path, '找不到路径').not.toBeNull()
    const check = pathStaysWalkable(OBSTACLE, path!)
    expect(check.ok, check.detail).toBe(true)
  })

  it('终点贴着阻挡格时也不穿墙', () => {
    // 终点正落在墙的左边一格，最后一段最容易从墙上切过去
    const path = buildPath(OBSTACLE, [0.1, 0.1], [0.4, 0.45])
    expect(path).not.toBeNull()
    const check = pathStaysWalkable(OBSTACLE, path!)
    expect(check.ok, check.detail).toBe(true)
  })

  it('随机起终点：每一条路径都不许穿墙', () => {
    /*
     * 这是真正能抓住问题的用例。
     *
     * 之前 `buildPath` 在视线校验**之后**才把首尾换成真实点击坐标、
     * 换完不复检，于是最后一段可以横穿阻挡格（实测 84% 落在格子里，
     * 角色在墙内站了 14 帧）。只测"顶点可走"永远看不出来。
     */
    let seed = 20261014
    const rand = (): number => {
      // 固定种子的 LCG：失败可复现，不依赖 Math.random
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }

    let checked = 0
    for (let i = 0; i < 400; i++) {
      const from: [number, number] = [rand(), rand()]
      const to: [number, number] = [rand(), rand()]
      const path = buildPath(OBSTACLE, from, to)
      if (!path) continue
      checked++
      const check = pathStaysWalkable(OBSTACLE, path, 200)
      expect(check.ok, `起点 ${from.map((n) => n.toFixed(3))} → 终点 ${to.map((n) => n.toFixed(3))}：${check.detail}`).toBe(true)
    }
    expect(checked, '一条路径都没生成出来，用例本身需要检查').toBeGreaterThan(200)
  })
})
/**
 * 证明这套判据**真的能抓到那个 bug**。
 *
 * 这里在测试内部重建"旧写法"（端点替换后不复检），断言密采样能把它抓出来。
 * 一条永远不会失败的测试等于没有测试 —— 而这条用例的存在本身就说明：
 * 判据的灵敏度是靠逐段密采样来的，只查顶点永远看不出来。
 */
describe('判据灵敏度：旧写法必须被抓到', () => {
  const M = parseMask([
    '............',
    '............',
    '.....##.....',
    '.....##.....',
    '.....##.....',
    '............',
    '............',
  ])

  /** 复刻修复前的 buildPath：把首尾换成真实坐标后**不做**视线复检。 */
  function oldWayBuildPath(from: readonly [number, number], to: readonly [number, number]) {
    const [fc, fr] = planeToCell(M, from[0], from[1])
    const [tc, tr] = planeToCell(M, to[0], to[1])
    const startCell = isWalkable(M, fc, fr) ? ([fc, fr] as const) : nearestWalkable(M, fc, fr)
    const goalCell = isWalkable(M, tc, tr) ? ([tc, tr] as const) : nearestWalkable(M, tc, tr)
    if (!startCell || !goalCell) return null
    const cells = findPath(M, startCell, goalCell)
    if (!cells || cells.length === 0) return null
    const simplified = simplifyPath(M, cells)
    if (simplified.length === 0) return null
    const startPoint = isPlaneWalkable(M, from[0], from[1]) ? from : simplified[0]
    const endPoint = isPlaneWalkable(M, to[0], to[1])
      ? to
      : [(goalCell[0] + 0.5) / M.cols, (goalCell[1] + 0.5) / M.rows]
    return [startPoint, ...simplified.slice(1, -1), endPoint] as [number, number][]
  }

  it('至少存在一条旧写法会穿墙的路径', () => {
    let seed = 20261014
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    let bad = 0
    for (let i = 0; i < 400; i++) {
      const path = oldWayBuildPath([rand(), rand()], [rand(), rand()])
      if (!path) continue
      if (!pathStaysWalkable(M, path, 200).ok) bad++
    }
    expect(bad, '旧写法一条穿墙路径都没有？那说明这组用例的掩码/采样选得不对').toBeGreaterThan(0)
  })

  it('修复后的写法在同一起终点上不穿墙', () => {
    let seed = 20261014
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let i = 0; i < 400; i++) {
      const from: [number, number] = [rand(), rand()]
      const to: [number, number] = [rand(), rand()]
      const path = buildPath(M, from, to)
      if (!path) continue
      const check = pathStaysWalkable(M, path, 200)
      expect(check.ok, `起点 ${from.map((n) => n.toFixed(3))} → ${to.map((n) => n.toFixed(3))}：${check.detail}`).toBe(true)
    }
  })
})