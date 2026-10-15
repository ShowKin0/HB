import type { Pt } from '../math.ts'
import {
  cellCenter,
  isPlaneWalkable,
  isWalkable,
  nearestWalkable,
  planeToCell,
  type Cell,
  type WalkMask,
} from './mask.ts'
import { findPath } from './astar.ts'

export type { Pt }
export type PlanePath = Pt[]

/**
 * 线段与轴对齐矩形是否相交（slab 法）。
 *
 * 用精确求交而不是采样：采样步长再小也会漏掉"擦角"——线段只从一个阻挡格的
 * 角上切过去，采样点全落在两侧的可走格里。这不是理论问题，实测在随机掩码上
 * 有上千例"采样说通、实际穿格"的段。
 */
function segmentHitsRect(
  a: Pt,
  b: Pt,
  minU: number,
  minV: number,
  maxU: number,
  maxV: number,
): boolean {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  let t0 = 0
  let t1 = 1
  const axes: readonly [number, number, number, number][] = [
    [a[0], dx, minU, maxU],
    [a[1], dy, minV, maxV],
  ]
  for (const [origin, delta, lo, hi] of axes) {
    if (Math.abs(delta) < 1e-12) {
      // 该轴上不动：平行于这对边，落在区间外就不可能相交
      if (origin < lo || origin > hi) return false
      continue
    }
    let tA = (lo - origin) / delta
    let tB = (hi - origin) / delta
    if (tA > tB) [tA, tB] = [tB, tA]
    t0 = Math.max(t0, tA)
    t1 = Math.min(t1, tB)
    if (t0 > t1) return false
  }
  return true
}

/**
 * 线段是否全程可走。
 *
 * **精确判据**：找出线段可能经过的格子（端点格子围成的矩形就够了，
 * 线段不可能跑到它的包围盒之外），逐个对阻挡格做线段-矩形求交。
 *
 * 以前这里是"按半格步长采样"，注释声称"保证不会跨过整格阻挡" —— 那句话
 * 不成立：短于一个采样步的擦角采不到。而这一个函数的松紧直接决定角色会
 * 不会走进墙里，所以改成精确的。
 */
export function lineOfSight(mask: WalkMask, a: Pt, b: Pt): boolean {
  if (!isPlaneWalkable(mask, a[0], a[1])) return false
  if (!isPlaneWalkable(mask, b[0], b[1])) return false

  const [c0, r0] = planeToCell(mask, a[0], a[1])
  const [c1, r1] = planeToCell(mask, b[0], b[1])
  const minC = Math.max(0, Math.min(c0, c1))
  const maxC = Math.min(mask.cols - 1, Math.max(c0, c1))
  const minR = Math.max(0, Math.min(r0, r1))
  const maxR = Math.min(mask.rows - 1, Math.max(r0, r1))

  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      if (isWalkable(mask, c, r)) continue
      if (
        segmentHitsRect(
          a,
          b,
          c / mask.cols,
          r / mask.rows,
          (c + 1) / mask.cols,
          (r + 1) / mask.rows,
        )
      ) {
        return false
      }
    }
  }
  return true
}

/**
 * String pulling：把格子路径压成尽量少的拐点。
 *
 * A* 的输出是逐格阶梯，直接用会让角色走出"锯齿"。这一步先去掉
 * 同方向的冗余拐点，再由 roundCorners 圆化剩下的真拐角。
 */
export function simplifyPath(mask: WalkMask, cells: readonly Cell[]): PlanePath {
  if (cells.length === 0) return []
  const centers = cells.map(([c, r]) => cellCenter(mask, c, r) as Pt)
  if (centers.length <= 2) return centers

  const out: PlanePath = [centers[0]]
  let anchor = 0
  for (let i = 2; i < centers.length; i++) {
    if (!lineOfSight(mask, centers[anchor], centers[i])) {
      out.push(centers[i - 1])
      anchor = i - 1
    }
  }
  out.push(centers[centers.length - 1])
  return out
}

/** 以 cur 为拐点、半径 r 的圆角折线（二次贝塞尔采样），不含起点 a。 */
function cornerArc(prev: Pt, cur: Pt, next: Pt, r: number, samples: number): Pt[] {
  const d1 = Math.hypot(prev[0] - cur[0], prev[1] - cur[1])
  const d2 = Math.hypot(next[0] - cur[0], next[1] - cur[1])
  if (d1 < 1e-9 || d2 < 1e-9) return []

  const ax = cur[0] + ((prev[0] - cur[0]) / d1) * r
  const ay = cur[1] + ((prev[1] - cur[1]) / d1) * r
  const bx = cur[0] + ((next[0] - cur[0]) / d2) * r
  const by = cur[1] + ((next[1] - cur[1]) / d2) * r

  const arc: Pt[] = []
  const steps = Math.max(2, samples)
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const mt = 1 - t
    // 二次贝塞尔：a → control(cur) → b
    const x = mt * mt * ax + 2 * mt * t * cur[0] + t * t * bx
    const y = mt * mt * ay + 2 * mt * t * cur[1] + t * t * by
    arc.push([x, y])
  }
  return arc
}

/**
 * 圆化拐角。
 *
 * 每个拐角用半径 r 的二次贝塞尔替代尖角。半径先按相邻边长折半，
 * 再逐步缩小直到整段弧线都落在可走区域内 —— 否则宁可保留尖角，
 * 也不能让角色穿墙。这是"走路看起来顺"的关键一步。
 */
export function roundCorners(mask: WalkMask, points: PlanePath, maxRadius = 0.06, samples = 8): PlanePath {
  if (points.length <= 2) return points

  const out: PlanePath = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]
    const cur = points[i]
    const next = points[i + 1]
    const d1 = Math.hypot(prev[0] - cur[0], prev[1] - cur[1])
    const d2 = Math.hypot(next[0] - cur[0], next[1] - cur[1])

    let radius = Math.min(maxRadius, d1 / 2, d2 / 2)
    let placed = false
    for (let attempt = 0; attempt < 5 && radius > 1e-4; attempt++) {
      const arc = cornerArc(prev, cur, next, radius, samples)
      if (arc.length > 0 && arc.every((p) => isPlaneWalkable(mask, p[0], p[1]))) {
        out.push(...arc)
        placed = true
        break
      }
      radius *= 0.5
    }
    if (!placed) out.push(cur)
  }
  out.push(points[points.length - 1])
  return out
}

/** 去掉相邻重复点，避免弧长参数化时除零。 */
export function dedupe(points: PlanePath, epsilon = 1e-6): PlanePath {
  const out: PlanePath = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > epsilon) out.push(p)
  }
  return out
}

export interface BuildPathOptions {
  maxRadius?: number
  samples?: number
}

/**
 * 从地面平面的一点走到另一点的完整管线：
 * 吸附到可走格 → A* → string pulling → 圆角 → 去重。
 *
 * 目标不可走时自动吸附到最近可走点，因此玩家点到墙里也不会没反应。
 */
export function buildPath(
  mask: WalkMask,
  from: Pt,
  to: Pt,
  options: BuildPathOptions = {},
): PlanePath | null {
  const [fc, fr] = planeToCell(mask, from[0], from[1])
  const [tc, tr] = planeToCell(mask, to[0], to[1])

  const startCell = isWalkable(mask, fc, fr) ? ([fc, fr] as Cell) : nearestWalkable(mask, fc, fr)
  const goalCell = isWalkable(mask, tc, tr) ? ([tc, tr] as Cell) : nearestWalkable(mask, tc, tr)
  if (!startCell || !goalCell) return null

  const cells = findPath(mask, startCell, goalCell)
  if (!cells || cells.length === 0) return null

  const simplified = simplifyPath(mask, cells)
  if (simplified.length === 0) return null

  /*
   * 两端替换为真实坐标：格子中心会让角色停在离点击点半格的地方。
   *
   * ⚠️ 替换**会改变首尾两段**，所以必须重新做视线校验。
   * 这里以前是"替换完直接拼"，于是最后一段可以横穿阻挡格 —— 在内容自带的
   * hall 掩码上实测：最后一段 84% 落在阻挡格内，角色在墙里连续站了 14 帧。
   * `simplifyPath` 校验的是**格子中心之间**的线段，换成真实点击坐标之后
   * 那份校验就作废了。
   *
   * 现在的写法是"看不见就退回格子中心"：中心点之间的连通性由 A* 保证。
   */
  const inner = simplified.slice(1, -1)
  const fallbackStart = simplified[0]
  const fallbackEnd = simplified[simplified.length - 1]

  const startNext: Pt = inner[0] ?? fallbackEnd
  const startPoint: Pt =
    isPlaneWalkable(mask, from[0], from[1]) && lineOfSight(mask, from, startNext)
      ? [from[0], from[1]]
      : fallbackStart

  const endPrev: Pt = inner.length > 0 ? inner[inner.length - 1] : startPoint
  const endPoint: Pt =
    isPlaneWalkable(mask, to[0], to[1]) && lineOfSight(mask, endPrev, to)
      ? [to[0], to[1]]
      : cellCenter(mask, goalCell[0], goalCell[1])

  const routed: PlanePath = [startPoint, ...inner, endPoint]
  const smoothed = roundCorners(mask, dedupe(routed), options.maxRadius ?? 0.06, options.samples ?? 8)
  return dedupe(smoothed)
}

/** 折线总长度，地面平面单位。 */
export function pathLength(path: PlanePath): number {
  let total = 0
  for (let i = 1; i < path.length; i++) {
    total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1])
  }
  return total
}
