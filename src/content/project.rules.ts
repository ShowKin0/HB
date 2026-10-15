/**
 * 项目清单的运行时规则。
 *
 * **和 project.ts 分开的原因**：这里的函数是运行时按值引用的（load.ts 要
 * `normalizeProject`），而 project.ts 里还有 Zod schema。放在一起，
 * 打包器就没法把 Zod 摇掉 —— 首包会白背 24 kB。
 *
 * 这个坑踩过两次，所以现在有 scripts/bundle-check.ts 在构建后守着。
 */

/**
 * 引擎支持的能力。
 *
 * 内容用到了没声明的能力时会发生什么，**分两层，别混为一谈**：
 *
 *   · 构建期 `content:check` 对"硬能力"（`story.ink`、`interaction.tap`、
 *     `interaction.hold`、`interaction.drag`、`minigame`）报 error —— 这是主要防线；
 *   · 运行期**只对 `minigame` 硬拦截**（它要动态创建宿主元素，不拦会直接炸），
 *     其余各项照常执行，但每种会**报一次警告**（见 `Game.ensureCapability`）。
 *
 * 这行注释以前写的是"未列出的不会被加载" —— 太绝对了，和实际行为对不上，
 * 会让读代码的人以为运行期有全套门禁。
 */
import {
  DEFAULT_DIALOGUE_LAYOUT,
  normalizeDialogueLayout,
  type DialogueLayoutConfig,
} from '../schema/layout.rules.ts'
import { DEFAULT_THEME, normalizeThemeId, type ThemeId } from '../theme/themes.rules.ts'

export const CAPABILITY_IDS = [
  'story.ink',
  'interaction.tap',
  'interaction.hold',
  'interaction.drag',
  'audio',
  'minigame',
  'inventory',
  'actor.walk',
] as const

export type CapabilityId = (typeof CAPABILITY_IDS)[number]

/** 能力的展示信息与依赖。 */
export interface CapabilityDescriptor {
  id: CapabilityId
  /** 一句话说明，编辑器与文档用。 */
  summary: string
  /** 依赖的能力。加载时会一并带上。 */
  requires: CapabilityId[]
  /** 内容里出现这些形态时，通常需要该能力。构建期校验用。 */
  triggers: string[]
}

export const CAPABILITY_REGISTRY: Record<CapabilityId, CapabilityDescriptor> = {
  'story.ink': {
    id: 'story.ink',
    summary: 'Ink 叙事：对白、分支、选项、剧情变量',
    requires: [],
    triggers: ['entry', 'hub', 'interactions[].action', 'exits[].to=knot'],
  },
  'interaction.tap': {
    id: 'interaction.tap',
    summary: '点击与使用物品',
    requires: [],
    triggers: ['interactions[].verb=inspect', 'interactions[].verb=use'],
  },
  'interaction.hold': {
    id: 'interaction.hold',
    summary: '长按',
    requires: ['interaction.tap'],
    triggers: ['interactions[].verb=hold'],
  },
  'interaction.drag': {
    id: 'interaction.drag',
    summary: '把物品拖到目标上',
    requires: ['interaction.tap'],
    triggers: ['interactions[].verb=drag'],
  },
  audio: {
    id: 'audio',
    summary: '背景乐与音效',
    requires: [],
    triggers: ['bgm', 'interactions[].sfx', '# bgm:', '# sfx:', '# vo:'],
  },
  minigame: {
    id: 'minigame',
    summary: '小游戏容器',
    requires: [],
    triggers: ['# minigame:'],
  },
  inventory: {
    id: 'inventory',
    summary: '物品栏与选中物品',
    requires: [],
    triggers: ['# award:', 'interactions[].verb=use', 'interactions[].verb=drag'],
  },
  'actor.walk': {
    id: 'actor.walk',
    summary: '角色寻路与走动',
    requires: [],
    triggers: ['actors', 'ground', 'walkable', 'approach'],
  },
}

export type Orientation = 'portrait' | 'landscape' | 'auto'
export type SceneFit = 'contain' | 'cover'
/**
 * @deprecated 已废弃，**从未生效过**。
 *
 * 它和真正控制对话的 `layout.dialogue` 名字几乎一样，是最容易把人带沟里的
 * 那类字段：改了它屏幕上毫无变化，作者只会以为自己写错了位置。
 * 保留类型是为了让老文件仍然能通过解析，`content:check` 会对它报警告。
 * 新内容请用 `layout.dialogue`。
 */
export type DialogueMode = 'reserved' | 'overlay' | 'hidden'

export interface MobileLayout {
  orientation: Orientation
  /** 场景缩放策略。contain 保证交互区域完整显示。 */
  sceneFit: SceneFit
  /**
   * @deprecated 用 `Project.layout.dialogue` 代替。这一项不生效。
   *
   * optional 是故意的：新项目不该再带上这个死字段。
   */
  dialogue?: DialogueMode
  /** 设备像素比上限。手机上 3 倍 DPR 的画面收益很小，内存代价很大。 */
  maxDpr: number
}

export interface Project {
  schemaVersion: 1
  /** 起始场景 id。null 时回退到 start.json，再回退到文件名排序最小的场景。 */
  startScene: string | null
  /** 本项目启用的能力。未列出的能力不会加载。 */
  capabilities: CapabilityId[]
  /**
   * 存档兼容版本。
   *
   * 和内容指纹**分开**：换一张图会改变指纹，但那不该判定剧情存档不兼容。
   * 只有当你改动了会影响存档语义的内容时才递增它。
   */
  saveCompatibility: string
  mobile: MobileLayout
  minigame: { skipAfter: number | null }
  /**
   * 这套内容用哪个主题包。
   *
   * 引擎只认名字，去加载 `themes/<name>.css`。色彩、字体、圆角、手绘图标、
   * 动效预设全在主题包里 —— 换主题不用碰引擎，引擎也不知道某个主题长什么样。
   *
   * 不声明时用引擎自带的中性主题（开发占位 / 缺素材兜底），
   * **不是**当前项目的艺术风格。
   */
  theme: ThemeId
  /**
   * 对话布局的**内容包默认**，场景可以逐项覆盖。
   *
   * 这是"核心不决定对话在哪"的落点。引擎给一个中立默认（底部、避让场景），
   * 具体主题想要右侧面板还是浮层，由内容/主题声明。
   */
  layout: { dialogue: DialogueLayoutConfig }
}

/** 没有任何清单时的默认项目：够跑一个最小场景。 */
export function defaultProject(): Project {
  return {
    schemaVersion: 1,
    startScene: null,
    capabilities: ['story.ink', 'interaction.tap'],
    saveCompatibility: '1',
    // 默认横屏：这个项目的主要形态是手机上横屏玩
    mobile: { orientation: 'landscape', sceneFit: 'contain', maxDpr: 2 },
    minigame: { skipAfter: 3 },
    layout: { dialogue: { ...DEFAULT_DIALOGUE_LAYOUT } },
    theme: DEFAULT_THEME,
  }
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/**
 * 规范化项目清单。
 *
 * 原则和场景规范化一致：**未知/非法值回落到默认，而不是原样透传**。
 * 一份写坏的能力 id 不该让引擎去加载不存在的东西。
 */
export function normalizeProject(raw: unknown): Project {
  const source = asRecord(raw)
  const mobile = asRecord(source.mobile)
  const minigame = asRecord(source.minigame)

  const capabilities = Array.isArray(source.capabilities)
    ? (source.capabilities.filter((id) =>
        (CAPABILITY_IDS as readonly string[]).includes(id as string),
      ) as CapabilityId[])
    : defaultProject().capabilities

  const skipRaw = minigame.skipAfter
  const skipAfter =
    skipRaw === null
      ? null
      : typeof skipRaw === 'number' && Number.isFinite(skipRaw)
        ? Math.max(0, Math.floor(skipRaw))
        : 3

  const dpr = mobile.maxDpr

  return {
    schemaVersion: 1,
    startScene: typeof source.startScene === 'string' && source.startScene.length > 0 ? source.startScene : null,
    capabilities,
    saveCompatibility:
      typeof source.saveCompatibility === 'string' && source.saveCompatibility.length > 0
        ? source.saveCompatibility
        : '1',
    mobile: {
      orientation: asEnum(mobile.orientation, ['portrait', 'landscape', 'auto'] as const, 'landscape'),
      sceneFit: asEnum(mobile.sceneFit, ['contain', 'cover'] as const, 'contain'),
      // 废弃字段：只在文件里真的写了时才带上，避免新项目凭空多出一个死字段
      ...(mobile.dialogue === 'reserved' || mobile.dialogue === 'overlay' || mobile.dialogue === 'hidden'
        ? { dialogue: mobile.dialogue }
        : {}),
      maxDpr: typeof dpr === 'number' && Number.isFinite(dpr) ? Math.min(4, Math.max(1, dpr)) : 2,
    },
    minigame: { skipAfter },
    layout: { dialogue: normalizeDialogueLayout(asRecord(source.layout).dialogue) },
    theme: normalizeThemeId(source.theme),
  }
}

/** 展开依赖：声明了 interaction.hold 就自动带上 interaction.tap。 */
export function expandCapabilities(ids: readonly CapabilityId[]): CapabilityId[] {
  const out = new Set<CapabilityId>()
  const add = (id: CapabilityId): void => {
    if (out.has(id)) return
    out.add(id)
    for (const dep of CAPABILITY_REGISTRY[id].requires) add(dep)
  }
  for (const id of ids) add(id)
  return [...out]
}

/** 这个项目是否启用了某项能力（含依赖展开）。 */
export function hasCapability(project: Project, id: CapabilityId): boolean {
  return expandCapabilities(project.capabilities).includes(id)
}

/**
 * 内容用到了没声明的能力时，该说什么。声明齐全就返回 `null`。
 *
 * 抽成纯函数是为了能被单测守住：真正调用它的 `Game.ensureCapability` 是私有
 * 方法、又依赖整个引擎实例，那条路径很难直接测；而"该不该报、报什么"恰恰是
 * 这段逻辑里唯一会出错的部分。
 */
export function capabilityWarning(project: Project, id: CapabilityId, where: string): string | null {
  if (hasCapability(project, id)) return null
  return (
    `内容用到了能力 "${id}"（${where}），但 content/project.json 没有声明它。` +
    `构建期 content:check 会拦住这类内容`
  )
}
