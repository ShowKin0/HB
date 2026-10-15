import { z } from 'zod'
import { DIALOGUE_PLACEMENTS } from './layout.rules.ts'

/**
 * 对话布局的 Zod 校验。
 *
 * 运行时用的是 layout.rules.ts（不依赖 Zod）；这里给 content:check、
 * 编辑器和开发期用。分开的原因和 project/scene 一样：打包器要能摇掉 Zod。
 */

export { DIALOGUE_PLACEMENTS }
export {
  DEFAULT_DIALOGUE_LAYOUT,
  insetsForPlacement,
  mergeDialogueLayout,
  normalizeDialogueLayout,
  placementVisible,
  resolveDialoguePlacement,
} from './layout.rules.ts'
export type {
  DialogueLayoutConfig,
  DialoguePlacement,
  DialoguePlacementRule,
  DialoguePlacementSpec,
  Orientation,
  ViewportSize,
} from './layout.rules.ts'

/**
 * placement 的取值校验。
 *
 * 错误信息必须**自己写清楚**：Zod 默认只会说 "Invalid input"，而内容作者
 * 拼错一个 placement 时，最需要知道的恰恰是"合法值有哪些"。
 * 同一次校验里别的错误（能力未声明）都写着怎么改，这里不该更差。
 */
const placementHint = DIALOGUE_PLACEMENTS.join(' / ')

export const DialoguePlacementSchema = z.enum(DIALOGUE_PLACEMENTS, {
  error: `placement 只能是 ${placementHint} 之一（收到的是无效值）`,
})

/**
 * 一条带条件的布局规则。
 *
 * 条件全部满足才匹配；不写条件就是无条件（当兜底项用）。
 */
export const DialoguePlacementRuleSchema = z.strictObject({
  minAspectRatio: z.number().positive().optional(),
  minWidth: z.number().nonnegative().optional(),
  minHeight: z.number().nonnegative().optional(),
  placement: DialoguePlacementSchema,
})

/**
 * 一个方向上的声明：直接给 placement，或给一串规则。
 *
 * 串的写法是为了让**内容**表达"宽屏用侧栏"这类策略，而不是让引擎
 * 内置一条关于宽高比的启发式 —— 那是把某个主题的调优结论焊进核心。
 */
export const DialoguePlacementSpecSchema = z.union(
  [DialoguePlacementSchema, z.array(DialoguePlacementRuleSchema).min(1)],
  {
    error: `layout.dialogue 的每个方向要么直接写一个 placement（${placementHint}），要么写一串 { placement, minAspectRatio?, minWidth?, minHeight? } 规则`,
  },
)

/**
 * 场景级的布局覆盖：**每项都可选**。
 *
 * 只写想改的那几项，其余继承内容包默认 —— 强制写全四项只会逼作者
 * 复制粘贴一堆他并不关心的值。
 */
export const DialogueLayoutOverrideSchema = z.strictObject({
  landscape: DialoguePlacementSpecSchema.optional(),
  portrait: DialoguePlacementSpecSchema.optional(),
  reserveSceneSpace: z.boolean().optional(),
  pauseWorldInput: z.boolean().optional(),
})

export const DialogueLayoutSchema = z.strictObject({
  landscape: DialoguePlacementSpecSchema.default('bottom'),
  portrait: DialoguePlacementSpecSchema.default('bottom'),
  reserveSceneSpace: z.boolean().default(true),
  pauseWorldInput: z.boolean().default(false),
})
