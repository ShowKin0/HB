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
 * 已实现：inspect（点一下）/ use（用物品）/ drag（把物品拖上去）
 * 已预留：hold（长按）/ sequence（按顺序点多个目标）
 *
 * 预留的两个**会明确报错**而不是静默失效：`content:check` 会报 error，
 * 运行时也会告警。数据模型先占位，实现跟上时不用改内容格式。
 */
export const INTERACTION_VERBS = ['inspect', 'use', 'drag', 'hold', 'sequence'] as const

/** 引擎尚未实现的动词。放在一处，供校验与运行时共用。 */
export const UNIMPLEMENTED_VERBS: readonly InteractionVerb[] = ['hold', 'sequence']

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
    synthesized.push({
      verb: 'inspect',
      when: null,
      item: null,
      accepts: [],
      action: hotspot.onClick,
      setState: null,
      setVisible: null,
      emit: null,
      sfx: null,
    })
  }
  if (hotspot.acceptsItem && hotspot.onUse) {
    synthesized.push({
      verb: 'use',
      when: null,
      item: hotspot.acceptsItem,
      accepts: [],
      action: hotspot.onUse,
      setState: null,
      setVisible: null,
      emit: null,
      sfx: null,
    })
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

function normalizeInteraction(raw: Record<string, unknown>): Interaction {
  const verb = raw.verb
  return {
    verb:
      verb === 'use' || verb === 'drag' || verb === 'hold' || verb === 'sequence' ? verb : 'inspect',
    when: typeof raw.when === 'string' ? raw.when : null,
    item: typeof raw.item === 'string' ? raw.item : null,
    accepts: asArray<string>(raw.accepts).filter((entry) => typeof entry === 'string'),
    action: asString(raw.action, ''),
    setState: typeof raw.setState === 'string' ? raw.setState : null,
    setVisible: typeof raw.setVisible === 'boolean' ? raw.setVisible : null,
    emit: typeof raw.emit === 'string' ? raw.emit : null,
    sfx: typeof raw.sfx === 'string' ? raw.sfx : null,
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
  }
}
