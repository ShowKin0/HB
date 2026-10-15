import {
  resolveInteractions,
  UNIMPLEMENTED_VERBS,
  type Hotspot,
  type Interaction,
  type InteractionVerb,
} from '../../schema/scene.rules.ts'

/**
 * 交互解析。
 *
 * 这是从"热点只有 onClick"升级过来的关键一层：输入（点击 / 用物品 / 拖放）
 * 先经过这里解析成一条**明确的交互意图**，再由上层去改场景状态、发事件、
 * 推进剧情。
 *
 * 好处是职责清楚：
 *   - 命中测试只管"点到了哪个物件"
 *   - 解析器只管"这个输入对应哪条交互"
 *   - 上层只管"执行这条交互"
 *
 * 全是纯函数，所以能脱离浏览器直接单测。
 */

export interface InteractionContext {
  /** 当前选中的物品 id。null 表示手上没东西。 */
  selectedItem: string | null
  /** 条件求值：ink 函数名 → 布尔。 */
  evaluate(name: string): boolean
  /** 运行期告警出口，用于报告未实现的动词之类。 */
  warn?(message: string): void
}

export type IntentKind = 'inspect' | 'use' | 'drag' | 'hold'

export interface InteractionIntent {
  kind: IntentKind
  target: Hotspot
  interaction: Interaction
}

export type ResolutionFailure = 'no-interaction' | 'condition-failed' | 'unimplemented'

export interface InteractionResolution {
  intent: InteractionIntent | null
  failure: ResolutionFailure | null
}

function isImplemented(verb: InteractionVerb): boolean {
  return !UNIMPLEMENTED_VERBS.includes(verb)
}

/** 条件为空视为恒真；否则交给 ink 函数求值。 */
function conditionPasses(interaction: Interaction, ctx: InteractionContext): boolean {
  if (!interaction.when) return true
  return ctx.evaluate(interaction.when)
}

/**
 * 把未实现的动词挑出来并告警，返回剩下的。
 *
 * 关键在于：**一个只挂了未实现动词的物件必须报 unimplemented 而不是
 * no-interaction** —— 后者听起来像"这里本来就没东西"，前者才是
 * "你配了东西但引擎还没做"，两者对排查的价值完全不同。
 */
function splitImplemented(
  hotspot: Hotspot,
  all: readonly Interaction[],
  ctx: InteractionContext,
): Interaction[] {
  const unimplemented = all.filter((i) => !isImplemented(i.verb))
  for (const interaction of unimplemented) {
    ctx.warn?.(`交互动词 "${interaction.verb}" 引擎尚未实现，物件 ${hotspot.id} 的这条交互不会生效`)
  }
  return all.filter((i) => isImplemented(i.verb))
}

/**
 * 解析一次点击 / 长按。
 *
 * 判定顺序（同一动词内部按声明顺序，作者可以靠排列控制优先级）：
 *   tap  —— 1. 手上有物品且物件有匹配的 use → use；2. 否则 → inspect
 *   hold —— 只匹配 hold 交互
 *
 * 如果匹配到了交互但条件不成立，返回 condition-failed 而不是默默什么都没发生 ——
 * 上层可以据此给出"现在还不能这么做"的反馈。
 */
export function resolveClick(
  hotspot: Hotspot,
  ctx: InteractionContext,
  gesture: 'tap' | 'hold' = 'tap',
): InteractionResolution {
  const all = resolveInteractions(hotspot)
  if (all.length === 0) return { intent: null, failure: 'no-interaction' }

  const interactions = splitImplemented(hotspot, all, ctx)
  if (interactions.length === 0) return { intent: null, failure: 'unimplemented' }

  let sawConditionFailed = false

  // ── 长按：只认 hold ──────────────────────────────────────
  if (gesture === 'hold') {
    for (const interaction of interactions) {
      if (interaction.verb !== 'hold') continue
      if (conditionPasses(interaction, ctx)) {
        return { intent: { kind: 'hold', target: hotspot, interaction }, failure: null }
      }
      sawConditionFailed = true
    }
    return { intent: null, failure: sawConditionFailed ? 'condition-failed' : 'no-interaction' }
  }

  // ── 1. 用物品 ────────────────────────────────────────────
  if (ctx.selectedItem) {
    for (const use of interactions) {
      if (use.verb !== 'use' || use.item !== ctx.selectedItem) continue
      if (conditionPasses(use, ctx)) {
        return { intent: { kind: 'use', target: hotspot, interaction: use }, failure: null }
      }
      sawConditionFailed = true
    }
  }

  // ── 2. 普通点击 ──────────────────────────────────────────
  for (const interaction of interactions) {
    if (interaction.verb !== 'inspect') continue
    if (conditionPasses(interaction, ctx)) {
      return { intent: { kind: 'inspect', target: hotspot, interaction }, failure: null }
    }
    sawConditionFailed = true
  }

  if (sawConditionFailed) return { intent: null, failure: 'condition-failed' }
  return { intent: null, failure: 'no-interaction' }
}

/**
 * 解析一次拖放。
 *
 * 目前支持的是"把手上的物品拖到目标物件上"。物件之间的拖拽（把照片拖进相框）
 * 需要先有"可拖动的物件"概念，等真有需求再加。
 */
export function resolveDrop(
  target: Hotspot,
  itemId: string,
  ctx: InteractionContext,
): InteractionResolution {
  const all = resolveInteractions(target)
  const interactions = splitImplemented(target, all, ctx)
  let sawConditionFailed = false

  for (const interaction of interactions) {
    if (interaction.verb !== 'drag') continue
    if (!interaction.accepts.includes(itemId)) continue
    if (conditionPasses(interaction, ctx)) {
      return { intent: { kind: 'drag', target, interaction }, failure: null }
    }
    sawConditionFailed = true
  }

  return {
    intent: null,
    failure: sawConditionFailed ? 'condition-failed' : 'no-interaction',
  }
}

/** 这个物件当前是否可以拖动某物品进去。用于 hover 时提示"可以放这里"。 */
export function acceptsDrop(target: Hotspot, itemId: string, ctx: InteractionContext): boolean {
  return resolveDrop(target, itemId, ctx).intent !== null
}

/** 事件名。默认由物件 + 动词推导，交互里显式写了 emit 就用它。 */
export function eventNameFor(hotspot: Hotspot, interaction: Interaction): string {
  return interaction.emit ?? `${hotspot.id}_${interaction.verb}`
}
