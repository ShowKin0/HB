/**
 * 地面平面 → 场景空间的单应变换。
 *
 * 为什么需要它：真实照片背景是**透视**的。若直接按屏幕坐标寻路，
 * 角色走到房间深处会越走越大、速度还会失真。
 *
 * 做法是把游戏逻辑全部放在归一化的**地面平面 (u,v)** 里算（完全线性），
 * 渲染时再用这个矩阵投影回场景空间，并按局部缩放表现近大远小。
 *
 * 关键性质：四角若构成矩形，矩阵退化为仿射变换 —— 正交/弱透视场景
 * 就是它的退化情形，因此同一套代码覆盖两种情况。
 */

import type { Pt } from '../engine/math.ts'

export type { Pt }

/** 3x3 行主序矩阵，m[8] 恒为 1。 */
export interface Homography {
  readonly m: readonly [number, number, number, number, number, number, number, number, number]
}

/** 地面平面单位正方形的四个角，顺序为 (0,0) (1,0) (1,1) (0,1)。 */
export const UNIT_SQUARE: readonly [Pt, Pt, Pt, Pt] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
]

const EPS = 1e-12

/** 高斯-约当消元解线性方程组，奇异时返回 null。 */
function solveLinear(matrix: number[][], rhs: number[]): number[] | null {
  const n = rhs.length
  const m = matrix.map((row, i) => [...row, rhs[i]])

  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r
    }
    if (Math.abs(m[pivot][col]) < EPS) return null
    if (pivot !== col) {
      const tmp = m[col]
      m[col] = m[pivot]
      m[pivot] = tmp
    }
    const pv = m[col][col]
    for (let c = col; c <= n; c++) m[col][c] /= pv
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = m[r][col]
      if (f === 0) continue
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c]
    }
  }
  return m.map((row) => row[n])
}

/**
 * 由四组点对解出单应矩阵。
 *
 * src 固定为 UNIT_SQUARE，dst 是地面四角在场景空间中的位置。
 * 四点共线或重合时返回 null。
 */
export function solveHomography(dst: readonly [Pt, Pt, Pt, Pt], src: readonly [Pt, Pt, Pt, Pt] = UNIT_SQUARE): Homography | null {
  const a: number[][] = []
  const b: number[] = []

  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i]
    const [x, y] = dst[i]
    a.push([u, v, 1, 0, 0, 0, -u * x, -v * x])
    b.push(x)
    a.push([0, 0, 0, u, v, 1, -u * y, -v * y])
    b.push(y)
  }

  const h = solveLinear(a, b)
  if (!h || h.some((value) => !Number.isFinite(value))) return null

  return { m: [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1] }
}

export function identityHomography(): Homography {
  return { m: [1, 0, 0, 0, 1, 0, 0, 0, 1] }
}

/** 地面平面坐标 → 场景空间坐标。透视除法后 w 为 0 时回退到原点。 */
export function project(h: Homography, u: number, v: number): [number, number] {
  const m = h.m
  const w = m[6] * u + m[7] * v + m[8]
  if (Math.abs(w) < EPS) return [0, 0]
  return [(m[0] * u + m[1] * v + m[2]) / w, (m[3] * u + m[4] * v + m[5]) / w]
}

/** 场景空间坐标 → 地面平面坐标。点在消失线上时返回 null。 */
export function unproject(h: Homography, x: number, y: number): [number, number] | null {
  const inv = invert(h)
  if (!inv) return null
  return project(inv, x, y)
}

/**
 * 局部线性缩放因子，用于表现近大远小。
 *
 * 取投影雅可比行列式的平方根，等于该点附近"平面上的单位长度"
 * 对应到场景空间有多长。矩形四角情况下它是常数。
 */
export function localScale(h: Homography, u: number, v: number): number {
  const m = h.m
  const w = m[6] * u + m[7] * v + m[8]
  if (Math.abs(w) < EPS) return 1
  const w2 = w * w
  const a = m[0] * u + m[1] * v + m[2]
  const bb = m[3] * u + m[4] * v + m[5]

  const dxdu = (m[0] * w - a * m[6]) / w2
  const dxdv = (m[1] * w - a * m[7]) / w2
  const dydu = (m[3] * w - bb * m[6]) / w2
  const dydv = (m[4] * w - bb * m[7]) / w2

  const det = dxdu * dydv - dxdv * dydu
  return Math.sqrt(Math.abs(det))
}

/** 求逆矩阵。奇异时返回 null。 */
export function invert(h: Homography): Homography | null {
  const m = h.m
  const a = m[0]
  const b = m[1]
  const c = m[2]
  const d = m[3]
  const e = m[4]
  const f = m[5]
  const g = m[6]
  const hh = m[7]
  const i = m[8]

  const A = e * i - f * hh
  const B = -(d * i - f * g)
  const C = d * hh - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < EPS) return null

  const invDet = 1 / det
  const out: [number, number, number, number, number, number, number, number, number] = [
    A * invDet,
    -(b * i - c * hh) * invDet,
    (b * f - c * e) * invDet,
    B * invDet,
    (a * i - c * g) * invDet,
    -(a * f - c * d) * invDet,
    C * invDet,
    -(a * hh - b * g) * invDet,
    (a * e - b * d) * invDet,
  ]
  if (out.some((value) => !Number.isFinite(value))) return null

  // 归一化使 m[8] === 1，保持与 solveHomography 相同的表示
  if (Math.abs(out[8]) < EPS) return null
  const s = 1 / out[8]
  // 把 -0 规整为 0，避免矩阵比较与序列化时出现无意义差异
  const normalized = out.map((value) => {
    const scaled = value * s
    return scaled === 0 ? 0 : scaled
  })
  return { m: normalized as unknown as Homography['m'] }
}

/** 四角是否构成矩形（轴对齐或旋转均可），用于判断是否退化为正交场景。 */
export function isAffine(h: Homography, tolerance = 1e-6): boolean {
  return Math.abs(h.m[6]) < tolerance && Math.abs(h.m[7]) < tolerance
}
