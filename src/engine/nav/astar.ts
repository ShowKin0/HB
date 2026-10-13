import { isWalkable, type Cell, type WalkMask } from './mask.ts'

const SQRT2 = Math.SQRT2

/** 8 邻域方向。先走斜向再走正向，配合禁止穿角使用。 */
const DIRS: readonly (readonly [number, number, number])[] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQRT2],
  [1, -1, SQRT2],
  [-1, 1, SQRT2],
  [-1, -1, SQRT2],
]

/** 八向距离启发函数，对网格图是可采纳且一致的。 */
function octile(dx: number, dy: number): number {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  return ax + ay + (SQRT2 - 2) * Math.min(ax, ay)
}

/**
 * 极简二叉最小堆。A* 用，节点数不超过网格格数。
 */
class MinHeap {
  private readonly items: number[] = []
  private readonly keys: number[] = []

  get size(): number {
    return this.items.length
  }

  push(item: number, key: number): void {
    this.items.push(item)
    this.keys.push(key)
    let i = this.items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.keys[parent] <= this.keys[i]) break
      this.swap(i, parent)
      i = parent
    }
  }

  pop(): number {
    const top = this.items[0]
    const lastItem = this.items.pop() as number
    const lastKey = this.keys.pop() as number
    if (this.items.length > 0) {
      this.items[0] = lastItem
      this.keys[0] = lastKey
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let smallest = i
        if (l < this.items.length && this.keys[l] < this.keys[smallest]) smallest = l
        if (r < this.items.length && this.keys[r] < this.keys[smallest]) smallest = r
        if (smallest === i) break
        this.swap(i, smallest)
        i = smallest
      }
    }
    return top
  }

  private swap(a: number, b: number): void {
    const ti = this.items[a]
    this.items[a] = this.items[b]
    this.items[b] = ti
    const tk = this.keys[a]
    this.keys[a] = this.keys[b]
    this.keys[b] = tk
  }
}

export interface PathOptions {
  /** 允许穿角（斜向穿过两个阻挡格之间）。默认禁止，观感更自然。 */
  allowCornerCutting?: boolean
  /** 迭代上限，防止异常输入导致卡死。 */
  maxNodes?: number
}

/**
 * 网格 A*，返回从起点到终点的格子序列（含两端）。不可达返回 null。
 *
 * 8 邻域 + 禁止穿角 + 八向距离启发，对俯视房间这种规模是毫秒级。
 */
export function findPath(
  mask: WalkMask,
  start: Cell,
  goal: Cell,
  options: PathOptions = {},
): Cell[] | null {
  const { allowCornerCutting = false } = options
  const total = mask.cols * mask.rows
  const maxNodes = options.maxNodes ?? total * 4

  const startIdx = start[1] * mask.cols + start[0]
  const goalIdx = goal[1] * mask.cols + goal[0]
  if (!isWalkable(mask, start[0], start[1]) || !isWalkable(mask, goal[0], goal[1])) return null
  if (startIdx === goalIdx) return [start]

  const gScore = new Float64Array(total).fill(Infinity)
  const cameFrom = new Int32Array(total).fill(-1)
  const closed = new Uint8Array(total)
  const heap = new MinHeap()

  gScore[startIdx] = 0
  heap.push(startIdx, octile(goal[0] - start[0], goal[1] - start[1]))

  let expanded = 0
  while (heap.size > 0) {
    const current = heap.pop()
    if (closed[current]) continue
    closed[current] = 1
    if (current === goalIdx) return reconstruct(cameFrom, current, mask.cols)
    if (++expanded > maxNodes) break

    const cc = current % mask.cols
    const cr = (current - cc) / mask.cols
    const g = gScore[current]

    for (const [dx, dy, cost] of DIRS) {
      const nc = cc + dx
      const nr = cr + dy
      if (!isWalkable(mask, nc, nr)) continue
      // 禁止穿角：斜向移动要求两侧正交格都可走
      if (dx !== 0 && dy !== 0 && !allowCornerCutting) {
        if (!isWalkable(mask, cc + dx, cr) || !isWalkable(mask, cc, cr + dy)) continue
      }
      const ni = nr * mask.cols + nc
      if (closed[ni]) continue
      const tentative = g + cost
      if (tentative >= gScore[ni]) continue
      gScore[ni] = tentative
      cameFrom[ni] = current
      heap.push(ni, tentative + octile(goal[0] - nc, goal[1] - nr))
    }
  }

  return null
}

function reconstruct(cameFrom: Int32Array, end: number, cols: number): Cell[] {
  const out: Cell[] = []
  let cur = end
  while (cur !== -1) {
    const c = cur % cols
    out.push([c, (cur - c) / cols])
    cur = cameFrom[cur]
  }
  out.reverse()
  return out
}
