/**
 * 存档契约。
 *
 * 这里刻意**不用 Zod**。原因很实际：Zod 会往首包里塞 26 kB gzip，
 * 而它在这个文件里要挡的坏情况其实很少 —— localStorage 被清、被别的东西写脏、
 * 存档来自更早的版本。`parseSave` 用几十行挡住了同样的情况，而且**挡得住什么
 * 是被测试钉死的**（见 tests/save.test.ts）。
 *
 * 内容的完整 Zod 校验仍然保留在开发期与 content:check 里 —— 那里才是它值钱的地方。
 */

/** 存档格式版本。改动存档结构时必须递增，并在 migrateSave 中补上升级分支。 */
export const SAVE_VERSION = 4

export type FlagValue = boolean | number | string

/**
 * 单个物件的**空间状态**。
 *
 * 和剧情状态分开是有意的：
 *   - 剧情状态（分支、开关、谜题判定）在 ink 里
 *   - 空间状态（这个抽屉开着没有、相框转到哪了、东西挪到哪了）在这里
 *
 * 物件每帧的位置、拖拽过程、动画进度都不该进 ink —— 那会把剧情脚本
 * 淹在几十个只用一次的变量里，而且改一个数值就得动剧本。
 */
export interface SceneObjectState {
  /** 是否可见。未设置表示用场景里的初始值。 */
  visible?: boolean
  /** 当前视觉状态名，对应 hotspot / layer 的 visualStates 键。 */
  state?: string
  /** 覆盖绘制位置（场景空间）。未设置表示用场景里的初始值。 */
  position?: [number, number]
  /** 通用进度值（旋转进度、开合程度…），由内容自己解释。 */
  progress?: number
}

/**
 * 存档时的**呈现检查点**。
 *
 * 只存 ink 指针是不够的：ink 的状态里没有"这句话已经显示出来、但玩家还没点掉"
 * 这件事 —— `Continue()` 已经把那一行消费掉了。少了它，读档回来会跳过一整句台词。
 *
 * 选项不需要存：待选的选项本来就在 ink 的 currentChoices 里，随 inkState 一起回来。
 */
export interface PresentationCheckpoint {
  /** 正在等玩家推进的那句话。null 表示没有挂起的台词。 */
  line: { text: string; speaker: string | null; portrait: string | null } | null
  /** 玩家推进当前台词后才提交的场景切换。 */
  pendingSceneId: string | null
  storyPhase: 'idle' | 'interaction' | 'entry'
}

export function emptyCheckpoint(): PresentationCheckpoint {
  return { line: null, pendingSceneId: null, storyPhase: 'idle' }
}

/**
 * 引擎侧会话状态。
 *
 * 注意这里**不存剧情逻辑**：分支条件、开关、谜题判定全部由 ink 的
 * inkState 承载。这里只存呈现层与空间交互需要的状态。
 */
export interface EngineState {
  sceneId: string | null
  /** 角色位置，键为 `${sceneId}:${actorId}`（v2 起）。 */
  actorPositions: Record<string, [number, number]>
  /** 角色朝向，键同上。 */
  actorFacing: Record<string, number>
  inventory: string[]
  flags: Record<string, FlagValue>
  /** 物件空间状态，键为 `${sceneId}:${objectId}`。 */
  scenes: Record<string, SceneObjectState>
  /** 已发出过的事件名 → 次数，供剧情判断"这件事发生过"。 */
  events: Record<string, number>
  visitedScenes: string[]
  playMs: number
  /**
   * 能力自己的状态，按**命名空间**分开存。
   *
   * 引擎只负责保存和还原这一块，**不解释里面的业务含义** ——
   * 好感度、相册、日历、聊天记录这些概念不进核心，它们的结构由各自的
   * 能力模块决定。引擎不知道 `affection` 里放的是数字还是对象，
   * 也不知道它代表什么。
   *
   * 这样做的意义：加一个新能力（比如"相册"）不需要动存档结构，
   * 也就不需要再加一次版本迁移。
   */
  capabilities: CapabilityState
  /** 呈现检查点：读档要能还原"台词正等着被点掉"。 */
  checkpoint: PresentationCheckpoint
}

/**
 * 能力状态：命名空间 → 任意可序列化的值。
 *
 * 命名空间建议用能力 id（`inventory`、`chat`）或内容自己的词（`affection`）。
 * 引擎不做白名单校验 —— 那等于把业务字段又写回核心一次。
 */
export type CapabilityState = Record<string, unknown>

/**
 * 单个命名空间的序列化体积上限。
 *
 * localStorage 总共只有 5MB 左右，而没有上限的扩展状态就是一张空白支票：
 * 一个能力不小心把聊天记录全量塞进去，整局存档就废了。
 * 超限时**丢掉最大的那个命名空间**并记一次警告，而不是让存档写不进去。
 */
export const CAPABILITY_NAMESPACE_LIMIT_BYTES = 64 * 1024

/** 命名空间数量上限。防止有人用递增 key 把这块撑成无底洞。 */
export const CAPABILITY_NAMESPACE_COUNT = 32

export interface Save {
  saveVersion: number
  createdAt: number
  updatedAt: number
  label: string
  /**
   * 内容版本指纹（剧本 + 场景清单算出来的哈希）。
   *
   * 读档时如果对不上，说明内容改过了 —— 存档结构能迁移，但剧情位置可能
   * 已经失去意义。这时给提示而不是静默继续，避免"读档后剧情错乱"
   * 这种最难查的问题。
   */
  contentVersion: string
  /**
   * 写这份存档时内容声明的 `saveCompatibility`。
   *
   * 和 `contentVersion` 分工不同：指纹是**自动**算出来的，任何改动都会变，
   * 只能给一句"内容更新过"的软提示；这个是作者**手写**的意图声明 ——
   * "我这次改剧情没有破坏存档结构"。所以它不一致时该更硬气一点，
   * 而不是和指纹一样只提示一句。
   *
   * 老存档没有这个字段，读出来是空串，按"未知"处理、不报警告。
   */
  saveCompatibility: string
  /** story.state.ToJson() 的原始字符串。 */
  inkState: string
  engine: EngineState
}

export function emptyEngineState(sceneId: string | null = null): EngineState {
  return {
    sceneId,
    actorPositions: {},
    actorFacing: {},
    inventory: [],
    flags: {},
    scenes: {},
    events: {},
    visitedScenes: [],
    playMs: 0,
    capabilities: {},
    checkpoint: emptyCheckpoint(),
  }
}

/** 物件空间状态的键。统一在这里拼，避免各处手写字符串拼错。 */
export function sceneObjectKey(sceneId: string, objectId: string): string {
  return `${sceneId}:${objectId}`
}

// ── 结构检查 ───────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isUnitNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1
}

function isUnitVec2(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && isUnitNumber(value[0]) && isUnitNumber(value[1])
}

/** 把引擎状态中的可选数值限制在合法范围，坏条目由调用方丢弃。 */
function isSceneObjectState(value: unknown): value is SceneObjectState {
  if (!isRecord(value)) return false
  if ('visible' in value && typeof value.visible !== 'boolean') return false
  if ('state' in value && typeof value.state !== 'string') return false
  if ('position' in value && !isUnitVec2(value.position)) return false
  if ('progress' in value && !isFiniteNumber(value.progress)) return false
  return true
}

/**
 * 字典的逐项净化。
 *
 * 两条原则合起来的意思是：**绝不为一个字段把整份存档判死**。
 * 玩家丢掉一个字段只是少一点状态，丢掉整份存档等于从头再来。
 *
 *   · 整体不是对象 → 退化成空字典（不拒绝）
 *   · 单个条目不合格 → 只丢那一条
 *   · `__proto__` / `constructor` 这类键直接跳过（见 UNSAFE_KEYS）
 */
function sanitizeRecord<T>(value: unknown, check: (entry: unknown) => boolean): Record<string, T> {
  const out: Record<string, T> = {}
  if (!isRecord(value)) return out
  for (const [key, entry] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) continue
    if (check(entry)) out[key] = entry as T
  }
  return out
}

/** 值能不能安全地往返 JSON。函数、undefined、循环引用都不行。 */
function isJsonSafe(value: unknown, ancestors = new Set<object>(), depth = 0): boolean {
  if (depth > 100) return false
  if (value === null) return true
  const kind = typeof value
  if (kind === 'string' || kind === 'number' || kind === 'boolean') {
    return kind !== 'number' || Number.isFinite(value as number)
  }
  if (typeof value !== 'object' || value === null) return false
  if (ancestors.has(value)) return false
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      // 稀疏数组会在 JSON 中变成 null，不能算忠实往返。
      for (let i = 0; i < value.length; i++) {
        if (!(i in value) || !isJsonSafe(value[i], ancestors, depth + 1)) return false
      }
      return true
    }
    return Object.entries(value as Record<string, unknown>).every(
      ([key, entry]) => !UNSAFE_KEYS.has(key) && isJsonSafe(entry, ancestors, depth + 1),
    )
  } finally {
    ancestors.delete(value)
  }
}

/**
 * 净化能力状态。
 *
 * 能力状态是**唯一一处引擎完全不解释内容**的存档字段，所以这里只能做
 * 结构性约束，不能做语义校验：
 *   · 必须是普通对象（数组、字符串、null 一律丢掉）
 *   · 只保留能安全往返 JSON 的值（函数、NaN、循环引用会让整份存档写不出去）
 *   · 跳过 `__proto__` 这类键（存档可能被手改过）
 *   · 单个命名空间超过体积上限就丢掉**它自己**，而不是丢掉整份存档
 *
 * 超限的命名空间会被丢掉并计数，由调用方给出提示 —— 静默截断比丢掉更糟，
 * 那会让能力读到半截数据。
 */
export function sanitizeCapabilityState(value: unknown): {
  state: CapabilityState
  dropped: string[]
} {
  const dropped: string[] = []
  const state: CapabilityState = {}
  if (!isRecord(value)) return { state, dropped }

  const entries = Object.entries(value)
    .filter(([key]) => !UNSAFE_KEYS.has(key))
    .map(([key, entry]) => {
      let size = 0
      try {
        size = JSON.stringify(entry)?.length ?? 0
      } catch {
        // 循环引用之类：序列化不出来，按无限大处理，优先丢它
        size = Number.POSITIVE_INFINITY
      }
      return { key, entry, size }
    })

  /*
   * 名额不够时**丢体积最大的那几个**，而不是丢排在后面的。
   *
   * 判据是"尽量保住多的能力"：丢一个超大的命名空间，换回五个小的能活下来。
   * 反过来做的话，一个不小心存了几百 KB 的能力会把另外四个小能力一起挤掉 ——
   * 而那四个可能正是存档能不能继续玩下去的关键。
   */
  let candidates = entries
  if (entries.length > CAPABILITY_NAMESPACE_COUNT) {
    const overflow = entries.length - CAPABILITY_NAMESPACE_COUNT
    const bySizeDesc = [...entries].sort((a, b) => b.size - a.size).slice(0, overflow)
    const dropping = new Set(bySizeDesc.map((item) => item.key))
    dropped.push(...bySizeDesc.map((item) => item.key))
    candidates = entries.filter((item) => !dropping.has(item.key))
  }

  for (const { key, entry, size } of candidates) {
    if (!isJsonSafe(entry)) {
      dropped.push(key)
      continue
    }
    if (size > CAPABILITY_NAMESPACE_LIMIT_BYTES) {
      dropped.push(key)
      continue
    }
    state[key] = entry
  }

  return { state, dropped: dropped.sort() }
}

/**
 * 必须跳过的键。
 *
 * 存档是唯一从外部进来的数据，可能被手改过。用 `out[key] = entry` 写
 * `__proto__` 会**改掉这个对象的原型**（用 `Object.assign` 或展开则会
 * 污染 Object.prototype）。这里逐个赋值加白名单，两个问题一起挡掉。
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * 字符串数组的净化。
 *
 * 缺失或整体类型不对都退化成空数组，而不是拒绝整份存档 ——
 * 旧版本没写这两个字段是正常的（文档里也是这么承诺的）。
 */
function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * 把一份原始数据解析成存档。
 *
 * 两条原则：
 *   1. **缺失的可选字段按默认值补齐**，而不是判为损坏 —— 旧存档里没有
 *      scenes / events 是正常的，不该因此丢掉玩家的进度。
 *   2. **单个坏条目只丢它自己**。比如某个物件的状态写坏了，丢掉那一条即可，
 *      不该把整个存档判死。
 */
/** 检查点只认"能还原出一句话"的形状，坏数据一律当没有。 */
function parseCheckpoint(value: unknown): PresentationCheckpoint {
  const checkpoint = emptyCheckpoint()
  if (!isRecord(value)) return checkpoint
  if (typeof value.pendingSceneId === 'string' && value.pendingSceneId.length > 0) checkpoint.pendingSceneId = value.pendingSceneId
  if (value.storyPhase === 'interaction' || value.storyPhase === 'entry') checkpoint.storyPhase = value.storyPhase
  const line = value.line
  if (isRecord(line) && typeof line.text === 'string' && line.text.length > 0) {
    checkpoint.line = {
      text: line.text,
      speaker: typeof line.speaker === 'string' ? line.speaker : null,
      portrait: typeof line.portrait === 'string' ? line.portrait : null,
    }
    // v3 只保存台词；保留返回 hub 的安全默认行为。
    if (value.storyPhase === undefined) checkpoint.storyPhase = 'interaction'
  }
  return checkpoint
}

function parseSave(raw: Record<string, unknown>): Save | null {
  if (typeof raw.inkState !== 'string') return null
  if (!isFiniteNumber(raw.createdAt) || !isFiniteNumber(raw.updatedAt)) return null
  if (typeof raw.label !== 'string') return null
  if (!isRecord(raw.engine)) return null

  const engine = raw.engine
  if (engine.sceneId !== null && typeof engine.sceneId !== 'string') return null
  if (typeof engine.playMs !== 'number' || !Number.isFinite(engine.playMs)) return null

  /*
   * 引擎侧字段一律**尽力降级**，不拒绝整份存档。
   *
   * 之前这里是"任何一项不合格就返回 null"，于是一份旧存档只要少了
   * inventory，玩家的进度就被整个丢掉 —— 和文档承诺的
   * "缺失的可选字段按默认值补齐"完全相反。丢掉一个字段只是少一点状态，
   * 丢掉整份存档等于从头再来。
   */
  const inventory = sanitizeStringArray(engine.inventory)
  const visitedScenes = sanitizeStringArray(engine.visitedScenes)

  const actorPositions = sanitizeRecord<[number, number]>(engine.actorPositions, isUnitVec2)
  const actorFacing = sanitizeRecord<number>(engine.actorFacing, (v) => v === -1 || v === 1)
  const flags = sanitizeRecord<FlagValue>(
    engine.flags,
    (v) => typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string',
  )
  const events = sanitizeRecord<number>(engine.events, (v) => isFiniteNumber(v) && v >= 0)

  const scenes: Record<string, SceneObjectState> = {}
  if (isRecord(engine.scenes)) {
    for (const [key, entry] of Object.entries(engine.scenes)) {
      if (UNSAFE_KEYS.has(key)) continue
      if (!isSceneObjectState(entry)) continue
      const state: SceneObjectState = {}
      if (typeof entry.visible === 'boolean') state.visible = entry.visible
      if (typeof entry.state === 'string') state.state = entry.state
      if (isUnitVec2(entry.position)) state.position = [entry.position[0], entry.position[1]]
      if (isFiniteNumber(entry.progress)) state.progress = entry.progress
      scenes[key] = state
    }
  }

  return {
    saveVersion: SAVE_VERSION,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    label: raw.label,
    contentVersion: typeof raw.contentVersion === 'string' ? raw.contentVersion : '',
    // 老存档没有这个字段：读成空串表示"未知"，调用方不该拿它报警告
    saveCompatibility:
      typeof raw.saveCompatibility === 'string' ? raw.saveCompatibility : '',
    inkState: raw.inkState,
    engine: {
      sceneId: (engine.sceneId as string | null) ?? null,
      actorPositions,
      actorFacing,
      inventory,
      flags,
      scenes,
      events,
      visitedScenes,
      // 负的游玩时长是无意义的（改过的存档），夹到 0
      playMs: Math.max(0, engine.playMs),
      capabilities: sanitizeCapabilityState(engine.capabilities).state,
      checkpoint: parseCheckpoint(engine.checkpoint),
    },
  }
}

/**
 * v1 → v2：角色位置/朝向的键从 `${actorId}` 改成 `${sceneId}:${actorId}`。
 *
 * 旧格式只按角色 id 存，不同场景里同名的角色会互相串位。迁移时把旧键挂到
 * 存档记录的当前场景上 —— 那正是玩家离开时所在的场景，也是这个位置唯一可能的归属。
 */
function upgradeV1toV2(raw: Record<string, unknown>): Record<string, unknown> {
  const engine = raw.engine
  if (!isRecord(engine)) return raw
  const sceneId = typeof engine.sceneId === 'string' ? engine.sceneId : null
  if (!sceneId) return raw

  const rekey = (value: unknown): unknown => {
    if (!isRecord(value)) return value
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      // 已经是新格式的键就不再动它
      out[key.includes(':') ? key : `${sceneId}:${key}`] = entry
    }
    return out
  }

  return {
    ...raw,
    engine: {
      ...engine,
      actorPositions: rekey(engine.actorPositions),
      actorFacing: rekey(engine.actorFacing),
    },
  }
}

/**
 * v2 → v3：加入能力状态命名空间。
 *
 * 老存档没有这一块，补一个空对象即可 —— 引擎不解释里面的内容，
 * 所以不存在"旧数据要翻译成新语义"的问题。这正是把它做成不透明命名空间
 * 的好处：以后再加能力，存档结构不用动，也就不需要新的迁移。
 */
function upgradeV2toV3(raw: Record<string, unknown>): Record<string, unknown> {
  const engine = raw.engine
  if (!isRecord(engine)) return raw
  if (isRecord(engine.capabilities)) return raw
  return { ...raw, engine: { ...engine, capabilities: {} } }
}

/**
 * 把任意来源的存档升级到当前版本。
 *
 * 因为你以后会不断改剧情和场景，旧存档一定会失效 —— 这里必须显式处理，
 * 而不是让玩家点"继续游戏"就崩。解析失败返回 null，由调用方退回重开。
 */
export function migrateSave(raw: unknown): Save | null {
  if (!isRecord(raw)) return null
  const version = raw.saveVersion
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null
  if (version > SAVE_VERSION) return null

  let candidate = version < 2 ? upgradeV2toV3(upgradeV1toV2(raw)) : version < 3 ? upgradeV2toV3(raw) : raw
  if (version < 4 && isRecord(candidate.engine)) {
    candidate = { ...candidate, engine: { ...candidate.engine, checkpoint: parseCheckpoint(candidate.engine.checkpoint) } }
  }
  return parseSave(candidate)
}
