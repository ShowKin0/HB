import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THEME,
  THEME_IDS,
  isThemeId,
  normalizeThemeId,
  themeCssPath,
  type ThemeId,
} from '../src/theme/themes.rules.ts'

/**
 * 主题包。
 *
 * 引擎只认名字，外观全在 `themes/<name>.css` 里 —— 那是"引擎中立"这条
 * 定位在样式侧的落点。这里守住三件事：注册表与文件同步、非法名不许透传、
 * 以及**每套主题都要把令牌补全**（漏一个就会出现"浅色主题里某块还是深色"）。
 */

const read = (relative: string): string =>
  readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

/** 从一个 CSS 文件里抽出所有自定义属性名。 */
function tokenNames(css: string): Set<string> {
  const out = new Set<string>()
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:/gi)) out.add(match[1])
  return out
}

describe('主题注册表', () => {
  it('默认主题是引擎自带的中性主题，不是当前项目的艺术风格', () => {
    // 中性主题是"没有主题包时的安全默认值"，代表当前游戏风格的是
    // soft-watercolor，那属于内容包的选择，不该是引擎的默认
    expect(DEFAULT_THEME).toBe('neutral')
  })

  it('注册表里的每个主题都有对应的 CSS 文件', () => {
    for (const id of THEME_IDS) {
      const css = read(themeCssPath(id))
      expect(css.length, `${id} 的主题文件是空的`).toBeGreaterThan(0)
      expect(css.includes(`[data-theme='${id}']`) || id === DEFAULT_THEME).toBe(true)
    }
  })

  it('只有中性主题挂在 :root 上 —— 它是兜底，必须第一帧就在', () => {
    const neutral = read(themeCssPath('neutral'))
    expect(neutral.includes(':root')).toBe(true)

    for (const id of THEME_IDS) {
      if (id === DEFAULT_THEME) continue
      const css = read(themeCssPath(id))
      // 其他主题必须**只**通过 data-theme 生效，否则会污染默认外观
      expect(css.includes('[data-theme='), `${id} 没有用 data-theme 限定作用域`).toBe(true)
      expect(/^\s*:root\s*\{/m.test(css), `${id} 直接改了 :root，会污染所有主题`).toBe(false)
    }
  })

  it('非法主题名回落默认，而不是让 data-theme 变成不存在的值', () => {
    expect(normalizeThemeId('pixel-retro')).toBe(DEFAULT_THEME)
    expect(normalizeThemeId(null)).toBe(DEFAULT_THEME)
    expect(normalizeThemeId(42)).toBe(DEFAULT_THEME)
    expect(normalizeThemeId('')).toBe(DEFAULT_THEME)
    for (const id of THEME_IDS) expect(normalizeThemeId(id)).toBe(id)
  })

  it('isThemeId 只认注册过的名字', () => {
    expect(isThemeId('soft-watercolor')).toBe(true)
    expect(isThemeId('Soft-Watercolor')).toBe(false)
    expect(isThemeId(undefined)).toBe(false)
  })
})

describe('主题完整性', () => {
  /*
   * 每套主题都必须补齐中性主题定义的**颜色与层次**令牌。
   *
   * 漏一个的后果很隐蔽：切到浅色主题后，漏掉的那块仍然是深色底 ——
   * 不是整个页面崩掉，而是某一个面板颜色不对，很容易被当成"设计如此"。
   *
   * 字体栈是**唯一**可以不覆盖的一类：引擎给的三条栈本来就是按中文场景
   * 配好的，主题想换再换，不换也不会有观感错误。强制重抄一遍只是噪音。
   */
  const neutral = tokenNames(read(themeCssPath('neutral')))
  const inheritable = (name: string): boolean => name.startsWith('--font-')
  const required = [...neutral].filter((name) => !inheritable(name)).sort()

  for (const id of THEME_IDS) {
    if (id === DEFAULT_THEME) continue

    it(`${id} 覆盖了中性主题的每一个颜色与层次令牌`, () => {
      const themed = tokenNames(read(themeCssPath(id)))
      const missing = required.filter((name) => !themed.has(name))
      expect(missing, `${id} 缺少令牌：${missing.join(', ')}`).toEqual([])
    })
  }

  it('必须覆盖的清单里确实包含颜色，字体不在其中', () => {
    // 守卫本身也要守着：判据写松了就等于没写
    expect(required).toContain('--bg-0')
    expect(required).toContain('--ink-0')
    expect(required).toContain('--accent')
    expect(required).toContain('--surface-dialogue')
    expect(required).not.toContain('--font-ui')
  })

  it('中性主题不含任何结构令牌 —— 结构归引擎，外观归主题', () => {
    // 安全区、对话占位、场景裁剪这些换主题也不该变，留在 styles.css
    for (const structural of ['--safe-t', '--safe-b', '--safe-l', '--safe-r', '--scene-inset']) {
      expect(neutral.has(structural), `中性主题里混进了结构令牌 ${structural}`).toBe(false)
    }
  })

  it('引擎结构样式不含任何外观令牌定义', () => {
    // 反向守卫：styles.css 里定义颜色/字体就等于把"当前这套配色"焊进了引擎
    const structure = tokenNames(read('src/styles.css'))
    for (const appearance of ['--bg-0', '--ink-0', '--accent', '--radius-m', '--font-ui']) {
      expect(structure.has(appearance), `styles.css 里定义了外观令牌 ${appearance}`).toBe(false)
    }
  })

  it('soft-watercolor 用的是规范里的色板，不是随手编的颜色', () => {
    // ART-STYLE-FINAL.md §3 的色值，抽查几个关键项
    const css = read(themeCssPath('soft-watercolor'))
    expect(css).toContain('#fff8f0') // 奶油白
    expect(css).toContain('#f7a8c4') // 樱花粉
    expect(css).toContain('#ff7a90') // 珊瑚红
    expect(css).toContain('color-scheme: light')
  })
})

describe('主题文件路径', () => {
  it('路径规则稳定，content:check 与实际加载用的是同一套', () => {
    for (const id of THEME_IDS as readonly ThemeId[]) {
      expect(themeCssPath(id)).toBe(`themes/${id}.css`)
    }
  })
})
