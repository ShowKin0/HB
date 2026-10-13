import { clamp } from '../math.ts'

/**
 * 可行走掩码。
 *
 * 掩码铺在**地面平面**上，与场景透视完全无关 —— 这也是为什么寻路
 * 能同时适配正交与透视两种场景。
 *
 * 索引约定：col 沿 u 方向递增，row 沿 v 方向递增。
 * row 0 是地面最远处（房间后墙），row rows-1 是最近处（画面下缘）。
 */
export interface WalkMask {
  readonly cols: number
  readonly rows: number
  /** 长度 cols*rows，1 表示可走。 */
  readonly cells: Uint8Array
}

export type Cell = readonly [col: number, row: number]

/** 由字符串掩码构造。'.' 可走，'#' 阻挡。 */
export function parseMask(rows: readonly string[]): WalkMask {
  const height = rows.length
  const width = rows[0]?.length ?? 0
  const cells = new Uint8Array(width * height)
  for (let r = 0; r < height; r++) {
    const row = rows[r]
    for (let c = 0; c < width; c++) {
      cells[r * width + c] = row[c] === '.' ? 1 : 0
    }
  }
  return { cols: width, rows: height, cells }
}

export function isWalkable(mask: WalkMask, col: number, row: number): boolean {
  if (col < 0 || row < 0 || col >= mask.cols || row >= mask.rows) return false
  return mask.cells[row * mask.cols + col] === 1
}

/** 格子中心在地面平面上的坐标。 */
export function cellCenter(mask: WalkMask, col: number, row: number): [number, number] {
  return [(col + 0.5) / mask.cols, (row + 0.5) / mask.rows]
}

/** 地面平面坐标 → 格子（夹紧到边界内）。 */
export function planeToCell(mask: WalkMask, u: number, v: number): [number, number] {
  return [
    clamp(Math.floor(u * mask.cols), 0, mask.cols - 1),
    clamp(Math.floor(v * mask.rows), 0, mask.rows - 1),
  ]
}

/** 平面坐标处是否可走。 */
export function isPlaneWalkable(mask: WalkMask, u: number, v: number): boolean {
  if (u < 0 || v < 0 || u > 1 || v > 1) return false
  const [col, row] = planeToCell(mask, u, v)
  return isWalkable(mask, col, row)
}

/**
 * 搜索欧氏距离最近的可走格子。
 *
 * 用途：玩家点到墙里或点出地面范围时，角色走到最近可达点，
 * 而不是原地不动 —— 生日礼物不能出现"点了没反应"。
 *
 * 先在有界窗口内扫描，窗口内无解再退化为全图扫描，
 * 保证只要图上还有可走格就一定返回结果。
 */
export function nearestWalkable(mask: WalkMask, col: number, row: number, maxRadius = 64): Cell | null {
  const c0 = clamp(col, 0, mask.cols - 1)
  const r0 = clamp(row, 0, mask.rows - 1)
  if (isWalkable(mask, c0, r0)) return [c0, r0]

  const scan = (cMin: number, cMax: number, rMin: number, rMax: number): Cell | null => {
    let best: Cell | null = null
    let bestDistance = Infinity
    for (let r = rMin; r <= rMax; r++) {
      for (let c = cMin; c <= cMax; c++) {
        if (!isWalkable(mask, c, r)) continue
        const dc = c - c0
        const dr = r - r0
        const distance = dc * dc + dr * dr
        if (distance < bestDistance) {
          bestDistance = distance
          best = [c, r]
          // 正交相邻已经不可能更近，直接返回
          if (distance === 1) return best
        }
      }
    }
    return best
  }

  return (
    scan(
      Math.max(0, c0 - maxRadius),
      Math.min(mask.cols - 1, c0 + maxRadius),
      Math.max(0, r0 - maxRadius),
      Math.min(mask.rows - 1, r0 + maxRadius),
    ) ?? scan(0, mask.cols - 1, 0, mask.rows - 1)
  )
}

/** 统计可走格子数，用于判断掩码是否可用。 */
export function walkableCount(mask: WalkMask): number {
  let n = 0
  for (let i = 0; i < mask.cells.length; i++) n += mask.cells[i]
  return n
}

/** 从掩码渲染调试用 ASCII，终端里可以直接看。 */
export function maskToText(mask: WalkMask): string {
  const lines: string[] = []
  for (let r = 0; r < mask.rows; r++) {
    let line = ''
    for (let c = 0; c < mask.cols; c++) line += isWalkable(mask, c, r) ? '.' : '#'
    lines.push(line)
  }
  return lines.join('\n')
}
