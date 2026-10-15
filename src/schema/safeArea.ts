/**
 * 场景内容的**安全区**检查。
 *
 * `sceneFit: "cover"` 会把画面多出来的部分裁掉，好让场景铺满整个窗口、
 * 四周不留黑边。代价是：**贴边的热点会被裁到画布外，玩家点不到**。
 *
 * 这不是理论问题。demo 里的出口热点是 `x=0.9, w=0.1`（u ∈ [0.9, 1.0]），
 * 桌面端按 cover 裁掉左右各 7.7% 之后，它的中心点正好落在画布之外 ——
 * 走完前面对话、点出口时**整个流程卡死**，是一条端到端用例抓出来的。
 *
 * 所以这里在构建期就把"哪些交互元素伸出了安全区"列出来。装饰性的图层和
 * 纯背景不受限制 —— 它们被裁掉本来就无所谓，那正是 cover 想要的。
 */

import type { Scene } from './scene.rules.ts'

/**
 * 安全区边界。
 *
 * 取中央 80% 再收紧一点（0.88 而不是 0.9）：最宽的验收尺寸（约 2.4 的
 * 画布宽高比 + 16:9 素材）会裁掉左右各约 13.5%，0.9 已经压线。
 */
export const SAFE_AREA = { min: 0.12, max: 0.88 } as const

export interface Bounds {
  minU: number
  maxU: number
  minV: number
  maxV: number
}

/** 把一个命中形状化成包围盒。认不出来的形状返回 null（交给别处报错）。 */
export function shapeBounds(shape: unknown): Bounds | null {
  if (typeof shape !== 'object' || shape === null) return null
  const s = shape as Record<string, unknown>
  const num = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null

  if (s.type === 'rect') {
    const x = num(s.x)
    const y = num(s.y)
    const w = num(s.w)
    const h = num(s.h)
    if (x === null || y === null || w === null || h === null) return null
    return { minU: x, maxU: x + w, minV: y, maxV: y + h }
  }

  if (s.type === 'circle') {
    const cx = num(s.cx)
    const cy = num(s.cy)
    const r = num(s.r)
    if (cx === null || cy === null || r === null) return null
    return { minU: cx - r, maxU: cx + r, minV: cy - r, maxV: cy + r }
  }

  if (s.type === 'poly' && Array.isArray(s.points)) {
    const pts = s.points.filter(
      (p): p is [number, number] => Array.isArray(p) && p.length >= 2 && num(p[0]) !== null && num(p[1]) !== null,
    )
    if (pts.length === 0) return null
    return {
      minU: Math.min(...pts.map((p) => p[0])),
      maxU: Math.max(...pts.map((p) => p[0])),
      minV: Math.min(...pts.map((p) => p[1])),
      maxV: Math.max(...pts.map((p) => p[1])),
    }
  }

  return null
}

export interface SafeAreaViolation {
  /** 出问题的元素 id（出口用 `-> 目标场景`）。 */
  label: string
  bounds: Bounds
  /** 越界的方向描述，给人看的。 */
  reasons: string[]
}

/**
 * 列出所有伸出安全区的**交互元素**。
 *
 * 只查热点与出口 —— 图层和背景被裁掉是 cover 的正常代价，不算问题。
 */
export function findSafeAreaViolations(scene: Scene): SafeAreaViolation[] {
  const out: SafeAreaViolation[] = []

  const check = (label: string, shape: unknown): void => {
    const bounds = shapeBounds(shape)
    if (!bounds) return
    const reasons: string[] = []
    if (bounds.minU < SAFE_AREA.min) reasons.push(`左边缘 u=${bounds.minU.toFixed(2)}`)
    if (bounds.maxU > SAFE_AREA.max) reasons.push(`右边缘 u=${bounds.maxU.toFixed(2)}`)
    if (bounds.minV < SAFE_AREA.min) reasons.push(`上边缘 v=${bounds.minV.toFixed(2)}`)
    if (bounds.maxV > SAFE_AREA.max) reasons.push(`下边缘 v=${bounds.maxV.toFixed(2)}`)
    if (reasons.length > 0) out.push({ label, bounds, reasons })
  }

  for (const hotspot of scene.hotspots) check(hotspot.id, hotspot.shape)
  for (const exit of scene.exits) check(`-> ${exit.to}`, exit.shape)

  return out
}
