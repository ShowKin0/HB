import type { InteractionVerb } from '../../schema/scene.ts'
import type { SceneObjectState } from '../../schema/save.ts'

/**
 * 事件桥。
 *
 * 解决的是"场景状态变了，剧情怎么知道"这个问题。
 *
 * 原来的做法是热点直接跳 knot，简单但把两件事焊死了：
 * 场景想先改自己的状态（抽屉拉开、相框点亮）再说台词，就没有位置放。
 *
 * 现在的数据流：
 *
 *   输入 → Interaction Resolver → 场景状态变更 → 发事件 → ink 推进 → 演出
 *
 * 事件同时走两条路：
 *   1. 记录进存档（engine.events），剧情可以判断"这件事发生过"
 *   2. 写进 ink 变量 `last_event`，剧本用 `{ last_event == "xxx": ... }` 分支
 *
 * 后者需要剧本里声明一次 `VAR last_event = ""`，见 README 的内容契约。
 */

export interface InteractionEvent {
  /** 事件名。默认 `${objectId}_${verb}`，交互里可显式覆盖。 */
  name: string
  sceneId: string
  objectId: string
  verb: InteractionVerb
  /** 触发时手上的物品。 */
  item: string | null
  /** 事件发生时刻（毫秒，引擎内累计时间）。 */
  at: number
}

/** 物件在某一时刻的实际状态，由场景初始值 + 存档覆盖合并而来。 */
export interface ResolvedObjectState {
  visible: boolean
  state: string | null
  position: [number, number] | null
  progress: number
}

export interface EventBridgeHandlers {
  /** 记录到存档。 */
  record(event: InteractionEvent): void
  /** 同步给 ink：写 `last_event` 变量。 */
  notifyInk(event: InteractionEvent): void
  /** 供调试面板观察。 */
  trace?(event: InteractionEvent): void
}

export class EventBridge {
  private readonly handlers: EventBridgeHandlers
  private readonly recent: InteractionEvent[] = []

  constructor(handlers: EventBridgeHandlers) {
    this.handlers = handlers
  }

  emit(event: InteractionEvent): void {
    // 只保留最近若干条，纯粹是给调试面板看的，不参与逻辑
    this.recent.push(event)
    if (this.recent.length > 32) this.recent.shift()

    this.handlers.record(event)
    this.handlers.notifyInk(event)
    this.handlers.trace?.(event)
  }

  /** 最近发生的事件，新的在后。 */
  get history(): readonly InteractionEvent[] {
    return this.recent
  }

  clear(): void {
    this.recent.length = 0
  }
}

/**
 * 合并场景初始值与存档覆盖，得到物件当前状态。
 *
 * 这是"空间状态"唯一的读取入口 —— 渲染和命中测试都走它，
 * 保证两边看到的永远是同一个状态。
 */
export function resolveObjectState(
  initial: { visible?: boolean; state?: string | null; position?: [number, number] | null },
  saved: SceneObjectState | undefined,
): ResolvedObjectState {
  return {
    visible: saved?.visible ?? initial.visible ?? true,
    state: saved?.state ?? initial.state ?? null,
    position: saved?.position ?? initial.position ?? null,
    progress: saved?.progress ?? 0,
  }
}
