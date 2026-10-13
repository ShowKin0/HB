/** 二维点。全工程共用这一个定义，避免 readonly 与可变版本互相不兼容。 */
export type Pt = readonly [number, number]

/** 数值夹紧到 [lo, hi]。 */
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

/** 线性插值。 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** 以固定步长逼近目标，不会越过。 */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current
  if (Math.abs(d) <= maxDelta) return target
  return current + Math.sign(d) * maxDelta
}

/**
 * 平滑衰减：与帧率无关的指数逼近。rate 越大越快。
 *
 * 朝向、姿态混合、加减速前倾都用它 —— 这个游戏的插值全是标量，
 * 所以不需要角度版（角色的左右朝向是 -1..1 的标量，不是弧度）。
 */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-rate * dt))
}

/** 点是否在多边形内（射线法）。 */
export function pointInPolygon(px: number, py: number, poly: readonly (readonly [number, number])[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    const intersects = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}
