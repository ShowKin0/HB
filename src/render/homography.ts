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

/** 3x3 行主序矩阵；m[8] 通常归一为 1，但逆矩阵可采用任意非零尺度。 */
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

/**
 * 地面平面坐标的合理量级上限。
 *
 * 平面本身只有 [0,1]²；点击落到四边形之外时算出 -0.5 / 1.7 都正常，
 * 但贴近平视线时会发散到 1e8。超过这个数就只可能是数值发散，
 * 当作"没解出来"处理，比交给调用方一个天文数字安全。
 */
const PLANE_SANITY = 64

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

/**
 * 场景空间坐标 → 地面平面坐标。**点在消失线上（或贴得极近）时返回 null。**
 *
 * 以前这里直接转手给 `project`，而 `project` 在 `|w| < EPS` 时回退 `[0, 0]` ——
 * 于是消失线上的点会解成"地面左上角"，调用方那句 `if (!plane) return` 成了
 * 死代码，玩家点一下就会被指使走到画面后左角；稍微偏离消失线则得到
 * `v = -1.5e8` 这种失控坐标，同样没有任何提示。
 *
 * 这里自己做透视除法，就是为了能**如实报告失败**。
 */
export function unproject(h: Homography, x: number, y: number): [number, number] | null {
  const inv = invert(h)
  if (!inv) return null
  const m = inv.m
  const w = m[6] * x + m[7] * y + m[8]
  if (Math.abs(w) < EPS) return null
  const u = (m[0] * x + m[1] * y + m[2]) / w
  const v = (m[3] * x + m[4] * y + m[5]) / w
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null
  /*
   * 贴近平视线时结果会急剧发散（实测能到 1e8）。地面平面只有 [0,1]²，
   * 稍微点歪出个 -0.5 / 1.7 是正常的，但量级到几十就只可能是发散 ——
   * 那已经不是"点在哪儿"的问题了，交给调用方当没点到处理。
   */
  if (Math.abs(u) > PLANE_SANITY || Math.abs(v) > PLANE_SANITY) return null
  return [u, v]
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
  const source = h.m
  if (source.some((value) => !Number.isFinite(value))) return null
  const inputScale = Math.max(...source.map(Math.abs))
  if (!(inputScale > 0) || !Number.isFinite(inputScale)) return null

  // A homography is unchanged by a common non-zero scale. Normalize before
  // forming cofactors so determinant checks are independent of its encoding.
  const [a, b, c, d, e, f, g, hh, i] = source.map((value) => value / inputScale)

  const A = e * i - f * hh
  const B = -(d * i - f * g)
  const C = d * hh - e * g
  const determinant = a * A + b * B + c * C
  if (!Number.isFinite(determinant) || Math.abs(determinant) < EPS) return null

  // The adjugate is projectively equivalent to the inverse (the omitted
  // determinant is a common scalar). Unlike inverse normalization by m[8],
  // max-coefficient normalization remains valid when that coefficient is 0.
  const out: [number, number, number, number, number, number, number, number, number] = [
    A,
    c * hh - b * i,
    b * f - c * e,
    B,
    a * i - c * g,
    c * d - a * f,
    C,
    b * g - a * hh,
    a * e - b * d,
  ]
  if (out.some((value) => !Number.isFinite(value))) return null

  const outputScale = Math.max(...out.map(Math.abs))
  if (!(outputScale > 0) || !Number.isFinite(outputScale)) return null
  const normalized = out.map((value) => {
    const scaled = value / outputScale
    return scaled === 0 ? 0 : scaled
  })
  return { m: normalized as unknown as Homography['m'] }
}

/** 四角是否构成矩形（轴对齐或旋转均可），用于判断是否退化为正交场景。 */
export function isAffine(h: Homography, tolerance = 1e-6): boolean {
  return Math.abs(h.m[6]) < tolerance && Math.abs(h.m[7]) < tolerance
}
