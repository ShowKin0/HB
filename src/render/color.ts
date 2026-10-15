export interface Rgb {
  r: number
  g: number
  b: number
}

/** 合法的 #rgb / #rrggbb / #rrggbbaa（井号可省）。 */
export function isHexColor(hex: unknown): hex is string {
  return typeof hex === 'string' && /^#?(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex.trim())
}

/** 解析失败返回 null —— 让调用方自己决定怎么兜底，而不是拿到一串 NaN。 */
export function parseHex(hex: string): Rgb | null {
  if (!isHexColor(hex)) return null
  const h = hex.trim().replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  }
}

export function toHex({ r, g, b }: Rgb): string {
  const c = (v: number): string =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/** 颜色不合法时的落点。取中灰：任何主题下都看得出"这里画了东西"。 */
export const FALLBACK_COLOR = '#888888'

/**
 * 把任意字符串收敛成 canvas **一定认**的 hex。
 *
 * 非 hex 输入（`tomato`、`rgb(1,2,3)`、拼错的色值）一律落到中灰。
 * 关键在于**必须返回一个合法颜色**：把非法值原样传回去并不能修好渲染 ——
 * canvas 会静默忽略这次赋值，于是这段图形沿用**上一个** `strokeStyle`，
 * 看起来只是"颜色不对"，根本联想不到是 tint 写错了。
 */
export function safeColor(color: unknown, fallback = FALLBACK_COLOR): string {
  return isHexColor(color) ? color.trim() : fallback
}

/** factor < 1 变暗，> 1 变亮。非法输入落到中灰，绝不产出 NaN 颜色。 */
export function shade(hex: string, factor: number): string {
  const rgb = parseHex(hex)
  if (!rgb) return FALLBACK_COLOR
  return toHex({ r: rgb.r * factor, g: rgb.g * factor, b: rgb.b * factor })
}


