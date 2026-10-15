/**
 * 场景的运行时规则。
 *
 * **单独成文件的原因很实际**：这几个函数是运行时每帧/每次点击都要用的
 * （resolveSceneMode 在进场景时、resolveInteractions 在每次点击时），
 * 而 scene.ts 里还有 68 处 Zod schema。混在一起，打包器就没法把 Zod 摇掉 ——
 * 26 kB gzip 只为了几个纯函数，不划算。
 *
 * 这里的类型全部用 `import type` 从 scene.ts 拿，编译期就被抹掉，
 * 所以本文件对 Zod 零依赖。
 */

import { normalizePlacementSpec, type DialogueLayoutOverride } from './layout.rules.ts'
import type { Hotspot, Interaction, InteractionVerb, Scene, SceneMode } from './scene.ts'

/**
 * 类型也一并再导出，这样运行时文件只需要认这一个模块 ——
 * `import type` 在编译期被抹掉，所以再导出类型不会把 Zod 带回来。
 */
export type {
  ActorSpec,
  CursorKind,
  Exit,
  Ground,
  Hotspot,
  Interaction,
  InteractionVerb,
  ObjectAnim,
  Scene,
  SceneLayer,
  SceneMode,
} from './scene.ts'

/**
 * 交互动词。
 *
 * 已实现：inspect（点一下）/ use（用物品）/ drag（把物品拖上去）/ hold（长按）
 * 已预留：sequence（按顺序点多个目标）
 *
 * sequence **会明确报错**而不是静默失效：`content:check` 会报 error，
 * 运行时也会告警。数据模型先占位，实现跟上时不用改内容格式。
 */
export const INTERACTION_VERBS = ['inspect', 'use', 'drag', 'hold', 'sequence'] as const

/** 引擎尚未实现的动词。放在一处，供校验与运行时共用。 */
export const UNIMPLEMENTED_VERBS: readonly InteractionVerb[] = ['sequence']

/**
 * 解析场景模式。schema 里 mode 允许为 null，用这个函数得到确定值。
 * 自动推断规则：有地面且有角色 → walk，否则 focus。
 */
export function resolveSceneMode(scene: Pick<Scene, 'mode' | 'ground' | 'actors'>): SceneMode {
  if (scene.mode) return scene.mode
  return scene.ground && scene.actors.length > 0 ? 'walk' : 'focus'
}

/**
 * 取物件的有效交互列表。
 *
 * 旧的 onClick / acceptsItem / onUse 会被合成成等价的新结构，
 * 于是运行时只需要处理一种形态 —— 旧内容不用改就能继续跑。
 */
export function resolveInteractions(hotspot: Hotspot): Interaction[] {
  if (hotspot.interactions.length > 0) return hotspot.interactions

  const synthesized: Interaction[] = []
  if (hotspot.onClick) {
    synthesized.push(normalizeInteraction({ verb: 'inspect', action: hotspot.onClick }))
  }
  if (hotspot.acceptsItem && hotspot.onUse) {
    synthesized.push(
      normalizeInteraction({ verb: 'use', item: hotspot.acceptsItem, action: hotspot.onUse }),
    )
  }
  return synthesized
}

/** 物件是否"自己会画出来"。只有 shape 的是纯命中区，外观由背景图承担。 */
export function isDrawableObject(hotspot: Hotspot): boolean {
  return Boolean(hotspot.image) || Object.keys(hotspot.visualStates).length > 0
}

// ── 规范化：把缺省字段补全 ─────────────────────────────────
/*
 * 生产构建里不做 Zod 校验（内容是构建期校验过的常量，没必要为首包背上 26 kB），
 * 但**默认值填充不能跟着一起去掉** —— 少了它，一份没写 visualStates 的场景
 * JSON 会在运行时炸成 `Object.values(undefined)`。
 *
 * 所以这里把"规范化"从"校验"里独立出来：schema 的 .default() 仍然写着，
 * 但真正保证对象完整的责任在下面这些函数。
 *
 * ⚠️ 两边必须一致。tests/sceneRuntime.test.ts 里有一条测试，
 * 拿真实内容文件逐个断言 normalizeScene 与 SceneSchema.parse 结果深相等 ——
 * 以后给 schema 加默认值却忘了这里，那条测试会直接失败。
 */

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function asVec2(value: unknown, fallback: [number, number]): [number, number] {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    return [value[0], value[1]]
  }
  return fallback
}

function asNullableVec2(value: unknown): [number, number] | null {
  return Array.isArray(value) && value.length === 2 ? asVec2(value, [0, 0]) : null
}

function asStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function normalizeAnim(value: unknown): Scene['hotspots'][number]['anim'] {
  const raw = asRecord(value)
  const type = raw.type
  return {
    type: type === 'float' || type === 'sway' || type === 'pulse' ? type : 'none',
    amplitude: asNumber(raw.amplitude, 0.008),
    speed: asNumber(raw.speed, 0.6),
    phase: asNumber(raw.phase, 0),
  }
}

function normalizeDrawable(raw: Record<string, unknown>) {
  return {
    image: typeof raw.image === 'string' ? raw.image : null,
    visualStates: asStringRecord(raw.visualStates),
    initialState: typeof raw.initialState === 'string' ? raw.initialState : null,
    position: asNullableVec2(raw.position),
    anchor: asVec2(raw.anchor, [0.5, 0.5]),
    height: asNumber(raw.height, 0.3),
    scale: asNumber(raw.scale, 1),
    rotation: asNumber(raw.rotation, 0),
    v: asNumber(raw.v, 0.5),
    shadow: asBool(raw.shadow, false),
    anim: normalizeAnim(raw.anim),
  }
}

/**
 * 动作类型。
 *
 * 拆成"触发器 + 动作"两层是刻意的：**触发器**是玩家做了什么（点击、长按、
 * 用物品、拖过去），**动作**是引擎要执行什么。两者正交，所以同一套动作
 * 可以被任何触发器复用。
 *
 * 关键约束：**动作里没有 story.knot 时，整条交互完全不碰 ink。**
 * 纯物件操作（开个抽屉、点亮一盏灯）因此可以独立成立 —— 通用引擎不该
 * 要求每条交互都必须跳转 knot。
 */
export type EffectType =
  | 'object.patch'
  | 'story.knot'
  | 'story.event'
  | 'audio.sfx'
  | 'item.award'
  | 'item.consume'

/** 物件状态补丁。字段都可选，只改写了的那几项。 */
export interface ObjectPatch {
  state?: string
  visible?: boolean
  progress?: number
}

export interface Effect {
  type: EffectType
  /** object.patch 的目标物件 id。'@self' 表示这条交互所属的物件。 */
  target: string
  patch: ObjectPatch
  /** story.knot 要跳转的 knot。 */
  knot: string
  /** story.event 的事件名。 */
  name: string
  /** audio.sfx 的音频路径。 */
  path: string
  /** item.award / item.consume 的物品 id。 */
  item: string
}

export function emptyEffect(type: EffectType = 'object.patch'): Effect {
  return { type, target: '@self', patch: {}, knot: '', name: '', path: '', item: '' }
}

/**
 * 把编辑器里的**摘要字段编辑**写穿到 `effects`。
 *
 * 为什么需要它：交互有两种写法 —— 新的 `effects` 数组，和旧的摘要字段
 * （`action` / `setState` / `setVisible` / `emit` / `sfx`）。有 `effects` 时，
 * 解析会用 `summarizeEffects` 从 effects **反推**摘要字段，把作者写的旧字段
 * 覆盖掉。
 *
 * 而编辑器只编辑摘要字段。于是改一个 effects 型交互（例如 hall.json 的
 * `hs_lamp`）的"事件名"时，UI 上显示新值、导出却被反推回旧值 ——
 * **改了等于没改，全程没有任何提示**。实测确认过。
 *
 * 这里按类型找对应的 effect 改写；找不到就补一条，值被清空就把那条删掉。
 * 没有 `effects` 的纯旧格式照旧直接改摘要（解析时会由 effectsFromLegacy 转换）。
 */
export function applyInteractionSummaryEdit<T extends Record<string, unknown>>(
  interaction: T,
  patch: Partial<T>,
): T {
  const effects = (interaction as { effects?: Effect[] }).effects
  if (!effects || effects.length === 0) return { ...interaction, ...patch }

  const next: Effect[] = effects.map((effect) => ({ ...effect, patch: { ...effect.patch } }))
  const firstOf = (type: EffectType): Effect | undefined => next.find((e) => e.type === type)
  const remove = (effect: Effect): void => {
    const index = next.indexOf(effect)
    if (index >= 0) next.splice(index, 1)
  }

  if ('action' in patch) {
    const value = (patch.action as string | undefined) ?? ''
    const existing = firstOf('story.knot')
    if (value) {
      if (existing) existing.knot = value
      else next.push({ ...emptyEffect('story.knot'), knot: value })
    } else if (existing) {
      remove(existing)
    }
  }

  // setState / setVisible 共用一条 object.patch
  if ('setState' in patch || 'setVisible' in patch) {
    let target = firstOf('object.patch')
    const ensure = (): Effect => {
      if (!target) {
        target = emptyEffect('object.patch')
        next.push(target)
      }
      return target
    }
    if ('setState' in patch) {
      const value = patch.setState as string | null | undefined
      if (value) ensure().patch.state = value
      else if (target) delete target.patch.state
    }
    if ('setVisible' in patch) {
      const value = patch.setVisible as boolean | null | undefined
      if (typeof value === 'boolean') ensure().patch.visible = value
      else if (target) delete target.patch.visible
    }
    // 补丁被清空就把这条 effect 一并去掉，别留一条什么都不做的
    if (target && Object.keys(target.patch).length === 0) remove(target)
  }

  if ('emit' in patch) {
    const value = patch.emit as string | null | undefined
    const existing = firstOf('story.event')
    if (value) {
      if (existing) existing.name = value
      else next.push({ ...emptyEffect('story.event'), name: value })
    } else if (existing) {
      remove(existing)
    }
  }

  if ('sfx' in patch) {
    const value = patch.sfx as string | null | undefined
    const existing = firstOf('audio.sfx')
    if (value) {
      if (existing) existing.path = value
      else next.push({ ...emptyEffect('audio.sfx'), path: value })
    } else if (existing) {
      remove(existing)
    }
  }

  return { ...interaction, ...patch, effects: next }
}

function normalizeEffect(raw: Record<string, unknown>): Effect {
  const type = raw.type
  const known: EffectType[] = [
    'object.patch',
    'story.knot',
    'story.event',
    'audio.sfx',
    'item.award',
    'item.consume',
  ]
  const patch = asRecord(raw.patch)
  const next: ObjectPatch = {}
  if (typeof patch.state === 'string') next.state = patch.state
  if (typeof patch.visible === 'boolean') next.visible = patch.visible
  if (typeof patch.progress === 'number' && Number.isFinite(patch.progress)) next.progress = patch.progress

  return {
    type: known.includes(type as EffectType) ? (type as EffectType) : 'object.patch',
    target: asString(raw.target, '@self'),
    patch: next,
    knot: asString(raw.knot, ''),
    name: asString(raw.name, ''),
    path: asString(raw.path, ''),
    item: asString(raw.item, ''),
  }
}

/**
 * 旧字段 → 动作列表。
 *
 * 适配只做一次，之后运行时只看 effects —— 这样新增动作类型时不用在每个
 * 入口再写一遍新旧分支。
 */
export function effectsFromLegacy(raw: Record<string, unknown>): Effect[] {
  const effects: Effect[] = []
  const action = asString(raw.action, '')
  if (action) effects.push({ ...emptyEffect('story.knot'), knot: action })

  const setState = typeof raw.setState === 'string' ? raw.setState : null
  if (setState !== null) effects.push({ ...emptyEffect('object.patch'), patch: { state: setState } })

  const setVisible = typeof raw.setVisible === 'boolean' ? raw.setVisible : null
  if (setVisible !== null) effects.push({ ...emptyEffect('object.patch'), patch: { visible: setVisible } })

  const emit = typeof raw.emit === 'string' ? raw.emit : null
  if (emit) effects.push({ ...emptyEffect('story.event'), name: emit })

  const sfx = typeof raw.sfx === 'string' ? raw.sfx : null
  if (sfx) effects.push({ ...emptyEffect('audio.sfx'), path: sfx })

  return effects
}

/**
 * 从动作列表反推旧字段（action / setState / setVisible / emit / sfx）。
 *
 * 事件桥与编辑器仍然按旧字段取值，所以两条路径（Zod 与 normalizeScene）
 * 都必须调这一个函数 —— 各写一份的话，一致性测试立刻就会报漂移。
 */
export function summarizeEffects(effects: Effect[]): {
  action: string
  setState: string | null
  setVisible: boolean | null
  emit: string | null
  sfx: string | null
} {
  let action = ''
  let setState: string | null = null
  let setVisible: boolean | null = null
  let emit: string | null = null
  let sfx: string | null = null
  for (const effect of effects) {
    if (effect.type === 'story.knot' && effect.knot) action = action || effect.knot
    if (effect.type === 'object.patch' && effect.target === '@self') {
      if (typeof effect.patch.state === 'string') setState = setState ?? effect.patch.state
      if (typeof effect.patch.visible === 'boolean') setVisible = setVisible ?? effect.patch.visible
    }
    if (effect.type === 'story.event' && effect.name) emit = emit ?? effect.name
    if (effect.type === 'audio.sfx' && effect.path) sfx = sfx ?? effect.path
  }
  return { action, setState, setVisible, emit, sfx }
}

/**
 * 场景级对话布局覆盖。
 *
 * 不在这里合并内容包默认 —— 那要等运行时拿到 project 才能做。
 * 这里只保留"场景想改什么"，并把非法值丢掉（拼错的 placement 不该
 * 变成未定义行为）。
 */
function normalizeDialogueLayoutOverride(raw: unknown): DialogueLayoutOverride | null {
  if (typeof raw !== 'object' || raw === null) return null
  const source = raw as Record<string, unknown>
  const out: DialogueLayoutOverride = {}
  /*
   * 用 layout.rules.ts 里那个**共用的**规范化函数，不要在这里再写一份
   * `isPlacement(x)` 判断。
   *
   * 这里以前只认单个 placement 字符串，于是数组规则写法被整段丢掉：
   * 开发期走 Zod（支持数组）布局正常，生产构建走这条路径**静默变回兜底值**。
   * 同一个概念两份实现，迟早会漂移 —— 这正是本项目双路径设计最大的风险。
   */
  const landscape = normalizePlacementSpec(source.landscape)
  const portrait = normalizePlacementSpec(source.portrait)
  if (landscape) out.landscape = landscape
  if (portrait) out.portrait = portrait
  if (typeof source.reserveSceneSpace === 'boolean') out.reserveSceneSpace = source.reserveSceneSpace
  if (typeof source.pauseWorldInput === 'boolean') out.pauseWorldInput = source.pauseWorldInput
  return Object.keys(out).length > 0 ? out : null
}

function normalizeInteraction(raw: Record<string, unknown>): Interaction {
  const verb = raw.verb
  const explicit = asArray<unknown>(raw.effects).filter(
    (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
  )
  // 有显式 effects 就用它；否则把旧字段适配成等价的动作列表
  const effects = explicit.length > 0 ? explicit.map(normalizeEffect) : effectsFromLegacy(raw)
  const summary = summarizeEffects(effects)

  return {
    verb:
      verb === 'use' || verb === 'drag' || verb === 'hold' || verb === 'sequence' ? verb : 'inspect',
    when: typeof raw.when === 'string' ? raw.when : null,
    item: typeof raw.item === 'string' ? raw.item : null,
    accepts: asArray<string>(raw.accepts).filter((entry) => typeof entry === 'string'),
    action: summary.action,
    setState: summary.setState,
    setVisible: summary.setVisible,
    emit: summary.emit,
    sfx: summary.sfx,
    effects,
  }
}

function normalizeActor(raw: Record<string, unknown>): Scene['actors'][number] {
  return {
    id: asString(raw.id, ''),
    renderer: asString(raw.renderer, 'partRig'),
    spawn: asVec2(raw.spawn, [0.5, 0.5]),
    heightRatio: asNumber(raw.heightRatio, 0.3),
    speed: asNumber(raw.speed, 0.45),
    facing: raw.facing === -1 ? -1 : 1,
    parts: typeof raw.parts === 'string' ? raw.parts : null,
    tint: typeof raw.tint === 'string' ? raw.tint : null,
    scale: asNumber(raw.scale, 1),
  }
}

function normalizeHotspot(raw: Record<string, unknown>): Hotspot {
  return {
    id: asString(raw.id, ''),
    shape: raw.shape as Hotspot['shape'],
    label: asString(raw.label, ''),
    cursor: (['look', 'use', 'take', 'talk', 'exit'] as const).includes(raw.cursor as never)
      ? (raw.cursor as Hotspot['cursor'])
      : 'look',
    visibleWhen: typeof raw.visibleWhen === 'string' ? raw.visibleWhen : null,
    approach: asNullableVec2(raw.approach),
    interactions: asArray<Record<string, unknown>>(raw.interactions).map(normalizeInteraction),
    onClick: typeof raw.onClick === 'string' ? raw.onClick : null,
    acceptsItem: typeof raw.acceptsItem === 'string' ? raw.acceptsItem : null,
    onUse: typeof raw.onUse === 'string' ? raw.onUse : null,
    ...normalizeDrawable(raw),
  }
}

function normalizeLayer(raw: Record<string, unknown>): Scene['layers'][number] {
  const drawable = normalizeDrawable(raw)
  return {
    ...drawable,
    // 图层必须有自己的图，drawable 里允许 null，这里收紧成空串由校验去挑错
    image: typeof drawable.image === 'string' ? drawable.image : '',
    id: asString(raw.id, ''),
    visibleWhen: typeof raw.visibleWhen === 'string' ? raw.visibleWhen : null,
  }
}

function normalizeExit(raw: Record<string, unknown>): Scene['exits'][number] {
  return {
    id: asString(raw.id, ''),
    shape: raw.shape as Scene['exits'][number]['shape'],
    to: asString(raw.to, ''),
    when: typeof raw.when === 'string' ? raw.when : null,
  }
}

function normalizeGround(value: unknown): Scene['ground'] {
  const raw = asRecord(value)
  if (!Array.isArray(raw.corners) || raw.corners.length !== 4) return null
  const corners = raw.corners.map((corner) => asVec2(corner, [0, 0]))
  return { corners: corners as unknown as NonNullable<Scene['ground']>['corners'] }
}

/**
 * 把一份原始场景 JSON 补全成完整对象。
 *
 * 生产环境走这条路径（开发环境仍然用 Zod 校验一遍）。
 * 它只负责**填默认值**，不做合法性判断 —— 判断交给 content:check。
 */
export function normalizeScene(raw: unknown): Scene {
  const source = asRecord(raw)
  return {
    id: asString(source.id, ''),
    title: asString(source.title, ''),
    metadata: asRecord(source.metadata) as Scene['metadata'],
    mode: source.mode === 'walk' || source.mode === 'focus' ? source.mode : null,
    bg: typeof source.bg === 'string' ? source.bg : null,
    bgm: typeof source.bgm === 'string' ? source.bgm : null,
    aspect: asNumber(source.aspect, 16 / 9),
    ground: normalizeGround(source.ground),
    walkable: Array.isArray(source.walkable) ? (source.walkable as string[]) : null,
    actors: asArray<Record<string, unknown>>(source.actors).map(normalizeActor),
    hotspots: asArray<Record<string, unknown>>(source.hotspots).map(normalizeHotspot),
    layers: asArray<Record<string, unknown>>(source.layers).map(normalizeLayer),
    exits: asArray<Record<string, unknown>>(source.exits).map(normalizeExit),
    entry: typeof source.entry === 'string' ? source.entry : null,
    hub: typeof source.hub === 'string' ? source.hub : null,
    /*
     * 对话布局覆盖：**保留原样**，不在这一层合并。
     *
     * 合并要跟内容包默认一起做，而 normalizeScene 只看得到场景自己。
     * 这里存"场景想改什么"，由 UI 用 mergeDialogueLayout 叠到内容包默认上。
     * 存合并结果是错的：那样内容包一改默认，已有场景就再也跟不上了。
     */
    dialogue: normalizeDialogueLayoutOverride(source.dialogue),
  }
}
