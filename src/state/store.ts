import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ChoiceView } from '../engine/ink/inkBridge.ts'
import type { DialogueLine, DebugInfo } from '../engine/game.ts'
import { DEFAULT_AUDIO_SETTINGS, type AudioSettings } from '../engine/audio.ts'
import type { DebugFlags } from '../render/sceneRenderer.ts'
import { DEFAULT_DEBUG } from '../render/sceneRenderer.ts'
import type { SlotInfo } from '../engine/save.ts'

export type PanelKind = 'none' | 'settings' | 'saves' | 'debug' | 'credits'

export interface Toast {
  id: number
  message: string
  level: 'info' | 'error'
}

/**
 * 呈现层状态。
 *
 * 刻意**不存**每帧变化的东西（角色坐标、相位）—— 那些留在引擎里，
 * 只以 4Hz 的频率把调试信息推过来。否则每帧都会重渲染整棵组件树。
 */
export interface UiState {
  boot: 'loading' | 'ready' | 'error'
  bootMessage: string
  line: DialogueLine | null
  choices: ChoiceView[]
  inventory: string[]
  selectedItem: string | null
  sceneId: string | null
  sceneTitle: string
  sceneAspect: number
  debug: DebugInfo | null
  debugFlags: DebugFlags
  panel: PanelKind
  slots: SlotInfo[]
  toasts: Toast[]
  cursor: string
  hasContinue: boolean
  paused: boolean

  setBoot(status: UiState['boot'], message?: string): void
  setLine(line: DialogueLine | null): void
  setChoices(choices: ChoiceView[]): void
  setInventory(items: string[], selected: string | null): void
  setScene(id: string, title: string, aspect: number): void
  setDebug(info: DebugInfo): void
  toggleDebugFlag(flag: keyof DebugFlags): void
  setPanel(panel: PanelKind): void
  setSlots(slots: SlotInfo[]): void
  setCursor(cursor: string): void
  setHasContinue(value: boolean): void
  setPaused(value: boolean): void
  toast(message: string, level?: Toast['level']): void
  dismissToast(id: number): void
}

let toastSeq = 1

export const useUi = create<UiState>()((set) => ({
  boot: 'loading',
  bootMessage: '正在准备……',
  line: null,
  choices: [],
  inventory: [],
  selectedItem: null,
  sceneId: null,
  sceneTitle: '',
  sceneAspect: 16 / 9,
  debug: null,
  debugFlags: { ...DEFAULT_DEBUG },
  panel: 'none',
  slots: [],
  toasts: [],
  cursor: 'default',
  hasContinue: false,
  paused: false,

  setBoot: (boot, bootMessage = '') => set({ boot, bootMessage }),
  setLine: (line) => set({ line }),
  setChoices: (choices) => set({ choices }),
  setInventory: (inventory, selectedItem) => set({ inventory, selectedItem }),
  setScene: (sceneId, sceneTitle, sceneAspect) => set({ sceneId, sceneTitle, sceneAspect }),
  setDebug: (debug) => set({ debug }),
  toggleDebugFlag: (flag) =>
    set((state) => ({ debugFlags: { ...state.debugFlags, [flag]: !state.debugFlags[flag] } })),
  setPanel: (panel) => set({ panel }),
  setSlots: (slots) => set({ slots }),
  setCursor: (cursor) => set({ cursor }),
  setHasContinue: (hasContinue) => set({ hasContinue }),
  setPaused: (paused) => set({ paused }),
  toast: (message, level = 'info') =>
    set((state) => ({ toasts: [...state.toasts, { id: toastSeq++, message, level }].slice(-4) })),
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}))

/** 音量设置单独持久化，刷新后仍然生效。 */
interface AudioState {
  audio: AudioSettings
  setAudio(next: Partial<AudioSettings>): void
}

export const useAudioSettings = create<AudioState>()(
  persist(
    (set) => ({
      audio: { ...DEFAULT_AUDIO_SETTINGS },
      setAudio: (next) => set((state) => ({ audio: { ...state.audio, ...next } })),
    }),
    { name: 'hb.audio' },
  ),
)
