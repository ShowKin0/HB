/**
 * 对话布局策略。
 *
 * **这是核心与主题之间的那道缝。**
 *
 * 之前"横屏用右侧面板"是写死在 CSS 媒体查询里的 —— 那是 soft-watercolor
 * 主题在 iPhone 14 横屏下的一个**解**，却成了所有内容的强制行为。
 * 引擎不该知道"对话应该在底部还是右侧"，那是内容/主题的声明。
 *
 * 核心只做三件事：
 *   1. 把内容/主题声明的 placement 解析成当前方向下的确定值
 *   2. 据此算出 Canvas 要避让的空间（rightInset / bottomInset）
 *   3. 据此决定这次输入归谁
 *
 * 具体长什么样、什么颜色、什么动效，全部在主题包里。
 */

export const DIALOGUE_PLACEMENTS = [
  /** 右侧（或左侧）通栏面板。窄屏上场景占比最高。 */
  'side',
  /** 底部对话框。视觉小说的经典形态，任何宽高比都成立。 */
  'bottom',
  /** 覆盖在场景上的浮层，不占位。 */
  'overlay',
  /** 铺满整屏（纯聊天/纯文本）。此时场景被完全遮住。 */
  'fullscreen',
  /** 这个场景没有对话。 */
  'none',
] as const

export type DialoguePlacement = (typeof DIALOGUE_PLACEMENTS)[number]

export type Orientation = 'landscape' | 'portrait'

/**
 * 一条带条件的布局规则。
 *
 * 为什么需要它：`landscape: 'side'` 对 iPhone 14 横屏是最优解，但对
 * iPad mini 横屏（宽高比 1.38）只剩 38% 场景 —— 侧栏把屏切成一个竖高的
 * 矩形，16:9 只能按宽度 fit，上下白扔两百多像素。
 *
 * 引擎**不该**再内置"宽高比 ≥ 1.9 才用侧栏"这种启发式：那是把某一个主题
 * 的调优结论焊进核心，正是我们要拆掉的东西。但"什么屏幕用侧栏"这件事
 * 又确实需要有人决定 —— 那就让**内容**决定，引擎只负责求值。
 */
export interface DialoguePlacementRule {
  /** 宽高比达到这个值才匹配。 */
  minAspectRatio?: number
  minWidth?: number
  minHeight?: number
  placement: DialoguePlacement
}

/**
 * 一个方向上的布局声明。
 *
 * 可以是一个确定的 placement（等价于只有一条无条件规则），
 * 也可以是一串规则 —— **按顺序取第一条满足的**，所以要带兜底项。
 */
export type DialoguePlacementSpec = DialoguePlacement | DialoguePlacementRule[]

export interface ViewportSize {
  width: number
  height: number
}

function ruleMatches(rule: DialoguePlacementRule, viewport: ViewportSize): boolean {
  if (rule.minAspectRatio !== undefined) {
    if (viewport.height <= 0) return false
    if (viewport.width / viewport.height < rule.minAspectRatio) return false
  }
  if (rule.minWidth !== undefined && viewport.width < rule.minWidth) return false
  if (rule.minHeight !== undefined && viewport.height < rule.minHeight) return false
  return true
}

/**
 * 规范化一个方向上的声明：单个 placement，或一串带条件的规则。
 *
 * **导出是为了让运行时（scene.rules.ts）和构建期（layout.ts 的 Zod）
 * 共用同一份实现。** 这里曾经有两份：Zod 那份支持数组规则，运行时那份
 * 只认单个字符串 —— 于是内容里写数组规则时，开发期（走 Zod）布局正常，
 * 生产构建（走 normalize）**静默变回兜底值**。
 *
 * 这正是本项目双路径设计的核心风险，所以能共用一份就共用一份。
 */
export function normalizePlacementSpec(raw: unknown): DialoguePlacementSpec | null {
  if (isPlacement(raw)) return raw
  if (!Array.isArray(raw)) return null
  const rules: DialoguePlacementRule[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const source = entry as Record<string, unknown>
    if (!isPlacement(source.placement)) continue
    const rule: DialoguePlacementRule = { placement: source.placement }
    if (typeof source.minAspectRatio === 'number' && Number.isFinite(source.minAspectRatio)) {
      rule.minAspectRatio = source.minAspectRatio
    }
    if (typeof source.minWidth === 'number' && Number.isFinite(source.minWidth)) {
      rule.minWidth = source.minWidth
    }
    if (typeof source.minHeight === 'number' && Number.isFinite(source.minHeight)) {
      rule.minHeight = source.minHeight
    }
    rules.push(rule)
  }
  return rules.length > 0 ? rules : null
}

export interface DialogueLayoutConfig {
  landscape: DialoguePlacementSpec
  portrait: DialoguePlacementSpec
  /**
   * 是否让场景避让对话区。
   *
   * true：Canvas 的可用区域扣掉对话占的地方，角色永远不会被盖住。
   * false：对话浮在场景之上，场景铺满 —— 适合"对话只是贴一层字幕"的用法。
   */
  reserveSceneSpace: boolean
  /**
   * 对话显示时是否暂停世界输入。
   *
   * true：对话期间点场景不触发交互（纯聊天/纯阅读流程）。
   * false：仍可点场景（叙事冒险里玩家常常边说话边走动）。
   */
  pauseWorldInput: boolean
}

/**
 * 引擎的中立默认。
 *
 * 刻意选 `bottom` 而不是 `side`：
 *   · `bottom` 对任何宽高比都成立，不需要"够宽才划算"这种前提
 *   · `side` 在不够宽的横屏上反而更差（iPad 横屏实测场景只剩 38%），
 *     把它当默认等于把某个主题的调优结论强加给所有内容
 *
 * `reserveSceneSpace: true` 同理 —— 引擎的底线是"不遮住内容"，
 * 想浮在场景上的内容自己声明 false。
 */
export const DEFAULT_DIALOGUE_LAYOUT: DialogueLayoutConfig = {
  landscape: 'bottom',
  portrait: 'bottom',
  reserveSceneSpace: true,
  pauseWorldInput: false,
}

/** 是不是一个合法的 placement。内容校验与场景覆盖共用。 */
export function isPlacement(value: unknown): value is DialoguePlacement {
  return typeof value === 'string' && (DIALOGUE_PLACEMENTS as readonly string[]).includes(value)
}

/**
 * 场景级的布局覆盖：每项都可选。
 *
 * 和 `DialogueLayoutConfig` 的区别是**这里没有默认值** —— 它表达的是
 * "这个场景想改什么"，没写的项留给内容包默认。用完整配置类型会逼作者
 * 把四项抄全，其中三项他并不关心。
 */
export interface DialogueLayoutOverride {
  landscape?: DialoguePlacementSpec
  portrait?: DialoguePlacementSpec
  reserveSceneSpace?: boolean
  pauseWorldInput?: boolean
}

/**
 * 规范化布局配置。
 *
 * 和别处一致：未知/非法值回落到默认，而不是原样透传 ——
 * 一个拼错的 placement 不该让布局变成未定义行为。
 */
export function normalizeDialogueLayout(raw: unknown): DialogueLayoutConfig {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_DIALOGUE_LAYOUT }
  const source = raw as Record<string, unknown>
  return {
    landscape: normalizePlacementSpec(source.landscape) ?? DEFAULT_DIALOGUE_LAYOUT.landscape,
    portrait: normalizePlacementSpec(source.portrait) ?? DEFAULT_DIALOGUE_LAYOUT.portrait,
    reserveSceneSpace:
      typeof source.reserveSceneSpace === 'boolean'
        ? source.reserveSceneSpace
        : DEFAULT_DIALOGUE_LAYOUT.reserveSceneSpace,
    pauseWorldInput:
      typeof source.pauseWorldInput === 'boolean'
        ? source.pauseWorldInput
        : DEFAULT_DIALOGUE_LAYOUT.pauseWorldInput,
  }
}

/**
 * 按优先级合并：内容包默认 → 场景覆盖。
 *
 * 场景只写想改的那几项，其余继承。这样内容作者在单个场景里写
 * `{ "landscape": "overlay" }` 就够了，不用把四项抄全。
 */
export function mergeDialogueLayout(
  base: DialogueLayoutConfig,
  override: unknown,
): DialogueLayoutConfig {
  if (typeof override !== 'object' || override === null) return base
  const source = override as Record<string, unknown>
  const next = { ...base }
  const landscape = normalizePlacementSpec(source.landscape)
  const portrait = normalizePlacementSpec(source.portrait)
  if (landscape) next.landscape = landscape
  if (portrait) next.portrait = portrait
  if (typeof source.reserveSceneSpace === 'boolean') next.reserveSceneSpace = source.reserveSceneSpace
  if (typeof source.pauseWorldInput === 'boolean') next.pauseWorldInput = source.pauseWorldInput
  return next
}

/**
 * 当前方向 + 当前视口下实际生效的布局。
 *
 * 规则**按声明顺序取第一条满足的**，所以内容里最后一条通常是无条件兜底项。
 * 视口为 0 时（还没有尺寸）按方向返回第一条规则的 placement —— 宁可给个
 * 确定的初值，也不要让布局短暂地悬空。
 */
export function resolveDialoguePlacement(
  config: DialogueLayoutConfig,
  orientation: Orientation,
  viewport: ViewportSize = { width: 0, height: 0 },
): DialoguePlacement {
  const spec = orientation === 'landscape' ? config.landscape : config.portrait
  if (isPlacement(spec)) return spec
  if (spec.length === 0) return 'bottom'
  for (const rule of spec) {
    if (ruleMatches(rule, viewport)) return rule.placement
  }
  // 一条都没匹配上：用最后一条当兜底，而不是回落默认 —— 作者把它放在
  // 最后，本意就是"其余情况用这个"
  return spec[spec.length - 1].placement
}

/**
 * 这次布局要让 Canvas 避开多少空间。
 *
 * `panelSize` 由主题层量出来（面板实际多宽/多高），核心不猜 ——
 * 它只负责把"占在哪一侧"翻译成 inset。
 */
export function insetsForPlacement(
  placement: DialoguePlacement,
  reserveSceneSpace: boolean,
  panelSize: { side: number; bottom: number },
): { right: number; bottom: number } {
  if (!reserveSceneSpace) return { right: 0, bottom: 0 }
  switch (placement) {
    case 'side':
      return { right: panelSize.side, bottom: 0 }
    case 'bottom':
      return { right: 0, bottom: panelSize.bottom }
    case 'overlay':
      // 浮层本来就不占位 —— 这是它和 bottom 的区别
      return { right: 0, bottom: 0 }
    case 'fullscreen':
      // 场景被完全遮住，避让多少都没意义；给 0 让场景照常渲染在下面，
      // 切走时不需要重新布局
      return { right: 0, bottom: 0 }
    case 'none':
      return { right: 0, bottom: 0 }
  }
}

/** 这个 placement 会不会真的显示对话层。 */
export function placementVisible(placement: DialoguePlacement): boolean {
  return placement !== 'none'
}

/**
 * 对话层是否该停掉世界输入。
 *
 * ⚠️ `showing` 指的是"**真的有一句台词或选项在等玩家**"，不是"对话层渲染出来了"。
 *
 * 这两件事在 `overlay` 形态下会分道扬镳：浮层的 DOM **始终**挂在那儿，
 * 拿"层可见"当判据的话，`pauseWorldInput: true` 会让世界输入**永久关闭**
 * —— 点场景什么都不发生、角色再也不能被指使走动，而且不报任何错。
 *
 * 抽成函数是为了让它能被单测守住：这个 bug 藏在"**什么时候该调开关**"里，
 * 而开关本身（引擎侧）当时全是对的，直接测引擎永远测不出来。
 */
export function shouldBlockWorldInput(
  config: DialogueLayoutConfig,
  showing: boolean,
): boolean {
  return config.pauseWorldInput && showing
}
