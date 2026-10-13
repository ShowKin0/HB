import {
  emptyEngineState,
  migrateSave,
  SAVE_VERSION,
  type EngineState,
  type Save,
} from '../schema/save.ts'

const PREFIX = 'hb.save.'
export const AUTO_SLOT = 'auto'
export const MANUAL_SLOTS = ['1', '2', '3'] as const
export const ALL_SLOTS = [AUTO_SLOT, ...MANUAL_SLOTS]

export interface SlotInfo {
  slot: string
  label: string
  updatedAt: number
  playMs: number
}

/**
 * 存档管理。
 *
 * 存档 = ink 状态（剧情真相）+ 引擎状态（呈现）+ 版本号。
 * 版本号是必需的：你以后一定会改剧情，旧存档必须能被识别并优雅处理，
 * 而不是让"继续游戏"直接把页面打崩。
 */
export class SaveManager {
  private readonly storage: Storage | null

  constructor(storage?: Storage) {
    this.storage = storage ?? safeStorage()
  }

  get available(): boolean {
    return this.storage !== null
  }

  save(slot: string, label: string, inkState: string, engine: EngineState, contentVersion = ''): boolean {
    if (!this.storage) return false
    const now = Date.now()
    const previous = this.load(slot)
    const payload: Save = {
      saveVersion: SAVE_VERSION,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      label,
      contentVersion,
      inkState,
      engine,
    }
    try {
      this.storage.setItem(PREFIX + slot, JSON.stringify(payload))
      return true
    } catch {
      return false
    }
  }

  load(slot: string): Save | null {
    if (!this.storage) return null
    try {
      const raw = this.storage.getItem(PREFIX + slot)
      if (!raw) return null
      return migrateSave(JSON.parse(raw))
    } catch {
      return null
    }
  }

  /** 自动存档：每次状态变化都会调用，因此必须便宜。 */
  autosave(inkState: string, engine: EngineState, contentVersion = ''): void {
    this.save(AUTO_SLOT, '自动存档', inkState, engine, contentVersion)
  }

  remove(slot: string): void {
    this.storage?.removeItem(PREFIX + slot)
  }

  clear(): void {
    for (const slot of ALL_SLOTS) this.remove(slot)
  }

  list(): SlotInfo[] {
    if (!this.storage) return []
    const out: SlotInfo[] = []
    for (const slot of ALL_SLOTS) {
      const save = this.load(slot)
      if (!save) continue
      out.push({
        slot,
        label: save.label,
        updatedAt: save.updatedAt,
        playMs: save.engine.playMs,
      })
    }
    return out
  }

  /** 是否有可以"继续游戏"的进度。 */
  hasContinue(): boolean {
    return this.load(AUTO_SLOT) !== null
  }
}

export function createEmptyEngineState(sceneId: string | null = null): EngineState {
  return emptyEngineState(sceneId)
}

function safeStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const probe = '__hb_probe__'
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)
    return localStorage
  } catch {
    // 隐私模式或存储被禁用：游戏仍可玩，只是不能存进度
    return null
  }
}
