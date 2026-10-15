import { z } from 'zod'
import { DEFAULT_THEME, THEME_IDS } from '../theme/themes.rules.ts'
import { CAPABILITY_IDS } from './project.rules.ts'
import { DEFAULT_DIALOGUE_LAYOUT, DialogueLayoutSchema } from '../schema/layout.ts'


/**
 * 项目清单的 Zod 校验部分。
 *
 * **运行时用的常量和函数在 project.rules.ts**，那个文件不依赖 Zod。
 * 这里只放 schema，给 content:check、编辑器与测试用。
 *
 * 分开的原因很实际：`load.ts` 按值引用 `normalizeProject`，只要它和
 * zod schema 在同一个模块里，打包器就摇不掉 zod —— 首包会白背 24 kB。
 * 这个坑踩过两次，所以现在有 scripts/bundle-check.ts 在构建后守着。
 */

export { CAPABILITY_IDS }
export {
  CAPABILITY_REGISTRY,
  defaultProject,
  expandCapabilities,
  hasCapability,
  normalizeProject,
} from './project.rules.ts'
export type {
  CapabilityDescriptor,
  CapabilityId,
  DialogueMode,
  MobileLayout,
  Orientation,
  Project,
  SceneFit,
} from './project.rules.ts'

export const MobileLayoutSchema = z.object({
  // 默认横屏：这个项目的主要形态是手机上横屏玩
  orientation: z.enum(['portrait', 'landscape', 'auto']).default('landscape'),
  /** 场景缩放策略。contain 保证交互区域完整显示。 */
  sceneFit: z.enum(['contain', 'cover']).default('contain'),
  /**
   * @deprecated 已废弃，从未生效。用顶层的 `layout.dialogue`。
   *
   * 设成 optional 是故意的：新项目不该再带上这个死字段，
   * 而老文件仍然能解析通过（content:check 会提示删掉它）。
   */
  dialogue: z.enum(['reserved', 'overlay', 'hidden']).optional(),
  /** 设备像素比上限。手机上 3 倍 DPR 的画面收益很小，内存代价很大。 */
  maxDpr: z.number().min(1).max(4).default(2),
})

export const ProjectSchema = z.object({
  schemaVersion: z.literal(1),
  /** 起始场景 id。null 时回退到 start.json，再回退到文件名排序最小的场景。 */
  startScene: z.string().min(1).nullable().default(null),
  /** 本项目启用的能力。未列出的能力不会加载。 */
  capabilities: z.array(z.enum(CAPABILITY_IDS)).default(['story.ink', 'interaction.tap']),
  /**
   * 存档兼容版本。
   *
   * 和内容指纹**分开**：换一张图会改变指纹，但那不该判定剧情存档不兼容。
   * 只有当你改动了会影响存档语义的内容时才递增它。
   */
  saveCompatibility: z.string().default('1'),
  mobile: MobileLayoutSchema.default({
    orientation: 'landscape',
    sceneFit: 'contain',
    maxDpr: 2,
  }),
  minigame: z
    .object({
      /** 失败几次后允许跳过。null 表示不允许。 */
      skipAfter: z.number().int().nonnegative().nullable().default(3),
    })
    .default({ skipAfter: 3 }),
  /**
   * 对话布局的内容包默认。场景可以逐项覆盖（见 SceneSchema 的 dialogue）。
   *
   * 核心不认识"聊天软件"或"视觉小说" —— 它只认这几种 placement 和两个开关。
   */
  layout: z
    .object({ dialogue: DialogueLayoutSchema.default({ ...DEFAULT_DIALOGUE_LAYOUT }) })
    .default({ dialogue: { ...DEFAULT_DIALOGUE_LAYOUT } }),
  /**
   * 内容包用哪套主题。
   *
   * 引擎只认名字 —— 具体色彩、字体、圆角、图标、动效全在 `themes/<name>.css` 里。
   * 没声明的主题不会被加载。
   */
  theme: z.enum(THEME_IDS, {
    error:
      `theme 只能是已注册的主题包之一：${THEME_IDS.join(' / ')}。` +
      '新增主题要在 src/theme/themes.rules.ts 注册，并放一份 themes/<名字>.css',
  }).default(DEFAULT_THEME),
})
