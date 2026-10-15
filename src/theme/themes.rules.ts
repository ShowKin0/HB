/**
 * 主题包注册表。
 *
 * **引擎不关心某个主题长什么样**，它只认一个名字，然后去加载
 * `themes/<name>.css`。色彩、字体、圆角、手绘图标、动效预设全部属于主题，
 * 不进核心。
 *
 * 这里刻意用一张显式的表而不是文件系统扫描：
 *   · 构建脚本（scripts/content-check.ts）跑在 Node 里，没有 Vite 的
 *     `import.meta.glob`，也要能校验内容里写的主题名是否存在
 *   · 表一旦和文件不同步，content:check 会直接报错，而不是等到运行时才发现
 */

export const THEME_IDS = ['neutral', 'soft-watercolor'] as const

export type ThemeId = (typeof THEME_IDS)[number]

/**
 * 没有声明主题时用的。
 *
 * 是引擎自带的中性主题，不是当前项目的艺术风格 —— 后者是
 * soft-watercolor，属于内容包的选择。
 */
export const DEFAULT_THEME: ThemeId = 'neutral'

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value)
}

/** 非法主题名回落默认，而不是把 `data-theme` 设成一个不存在的值。 */
export function normalizeThemeId(raw: unknown): ThemeId {
  return isThemeId(raw) ? raw : DEFAULT_THEME
}

/** 主题 CSS 的路径（相对项目根），供注册表与校验共用。 */
export function themeCssPath(id: ThemeId): string {
  return `themes/${id}.css`
}
