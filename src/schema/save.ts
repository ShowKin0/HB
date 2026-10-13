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
export const SAVE_VERSION = 2

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
}

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

/** 逐项检查的字典。任何一项不合规就整体判不合格。 */
function checkRecord<T>(value: unknown, check: (entry: unknown) => boolean): Record<string, T> | null {
  if (!isRecord(value)) return null
  for (const entry of Object.values(value)) if (!check(entry)) return null
  return value as Record<string, T>
}

function checkStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.every((item) => typeof item === 'string') ? (value as string[]) : null
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
function parseSave(raw: Record<string, unknown>): Save | null {
  if (typeof raw.inkState !== 'string') return null
  if (!isFiniteNumber(raw.createdAt) || !isFiniteNumber(raw.updatedAt)) return null
  if (typeof raw.label !== 'string') return null
  if (!isRecord(raw.engine)) return null

  const engine = raw.engine
  if (engine.sceneId !== null && typeof engine.sceneId !== 'string') return null
  if (typeof engine.playMs !== 'number' || !Number.isFinite(engine.playMs)) return null

  const inventory = checkStringArray(engine.inventory)
  if (!inventory) return null
  const visitedScenes = checkStringArray(engine.visitedScenes)
  if (!visitedScenes) return null

  const actorPositions = checkRecord<[number, number]>(engine.actorPositions ?? {}, isUnitVec2)
  if (!actorPositions) return null
  const actorFacing = checkRecord<number>(engine.actorFacing ?? {}, (v) => v === -1 || v === 1)
  if (!actorFacing) return null
  const flags = checkRecord<FlagValue>(
    engine.flags ?? {},
    (v) => typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string',
  )
  if (!flags) return null
  const events = checkRecord<number>(engine.events ?? {}, (v) => isFiniteNumber(v) && v >= 0)
  if (!events) return null

  const scenes: Record<string, SceneObjectState> = {}
  if (isRecord(engine.scenes)) {
    for (const [key, entry] of Object.entries(engine.scenes)) {
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
      playMs: engine.playMs,
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

  const candidate = version < 2 ? upgradeV1toV2(raw) : raw
  return parseSave(candidate)
}
