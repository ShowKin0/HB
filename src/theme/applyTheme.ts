/**
 * 按内容声明的名字加载主题包。
 *
 * **没有声明的主题不会进首屏** —— 这是"未使用的 UI 与专用资源不进入
 * 首屏加载"的落点。用 `import.meta.glob` 拿到的是惰性加载器，
 * 只有真的 applyTheme 到某个名字时，那一份 CSS 才会被下载。
 *
 * 这里同时把 `data-theme` 写到 `<html>` 上。写根元素而不是应用根 div：
 * 主题可能要给 `<body>` 背景上色，而 body 不是应用根的后代。
 */

import { DEFAULT_THEME, normalizeThemeId, type ThemeId } from './themes.rules.ts'

/**
 * 项目根下的 themes/*.css。
 *
 * 用负向模式排除中性主题：它在 main.tsx 里静态引入（兜底必须第一帧就在），
 * 再收进 glob 会让打包器同时看到静态和动态两条路径并报警告，
 * 而且那份 CSS 会被重复打进一个永远用不到的 chunk。
 */
const loaders = import.meta.glob(['/themes/*.css', '!/themes/neutral.css']) as Record<
  string,
  () => Promise<unknown>
>

/** 已经加载过的主题，避免重复注入样式。 */
const loaded = new Set<ThemeId>()

let current: ThemeId | null = null

/** 当前生效的主题。未设置过时返回 null，方便测试区分"没设过"和"设的是默认"。 */
export function currentTheme(): ThemeId | null {
  return current
}

/**
 * 应用主题。重复调用同一个主题是廉价的空操作。
 *
 * 失败不抛：主题加载不了（文件缺失、网络问题）时保留中性默认值继续跑，
 * 而不是让整个游戏起不来 —— 一套颜色不值得拿可用性去换。
 */
export async function applyTheme(raw: unknown): Promise<ThemeId> {
  const id = normalizeThemeId(raw)

  // 先写属性：CSS 文件可能还没到，但属性到位后一旦样式注入立刻生效，
  // 不会出现"属性还是旧主题、样式已经换了"的错配
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', id)
  }

  if (loaded.has(id)) {
    current = id
    return id
  }

  // 中性默认主题在 main.tsx 里**静态引入** —— 它是没有主题包时的兜底，
  // 必须第一帧就在，否则会闪一下无样式的页面。所以这里不再重复加载它。
  if (id === DEFAULT_THEME) {
    loaded.add(id)
    current = id
    return id
  }

  const key = `/themes/${id}.css`
  const load = loaders[key]
  if (load) {
    try {
      await load()
      loaded.add(id)
    } catch {
      // 保持中性默认值继续跑
    }
  } else {
    // 注册表里列了但文件不存在 —— content:check 会先拦住，这里只是兜底
    console.warn(`[theme] 找不到主题文件 themes/${id}.css，继续用中性默认主题`)
  }

  current = id
  return id
}

/** 仅供测试：清掉"已加载"记录。 */
export function resetThemeCache(): void {
  loaded.clear()
  current = null
}
