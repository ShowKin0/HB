import { Howl, Howler } from 'howler'
import { assetUrl } from './assets.ts'

export type AudioChannel = 'bgm' | 'sfx' | 'vo'

export interface AudioBusOptions {
  /**
   * 测试用：替换 Howl 构造。
   *
   * 淡出竞态这类问题只靠"听"是发现不了的，注入一个假实现才能在单测里
   * 用假定时器把它钉死。
   */
  createHowl?: (options: ConstructorParameters<typeof Howl>[0]) => Howl
}

export interface AudioSettings {
  master: number
  bgm: number
  sfx: number
  vo: number
  muted: boolean
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  master: 0.9,
  bgm: 0.55,
  sfx: 0.8,
  vo: 1,
  muted: false,
}

/**
 * 把任意来源的音量设置收拢成合法值。
 *
 * 这套设置是**持久化**的（zustand persist 写 localStorage），而 localStorage
 * 会被旧版本的应用、别的标签页、或者手动改过的东西污染。zustand 默认只是
 * 浅合并，不做任何校验 —— 一个 `master: null` 就够让 `Howler.volume(NaN)`
 * 把整条音频链路搞哑，或者让滑杆变成受控/非受控混用。
 *
 * 和存档那边同样的原则：外部数据一律先净化再用。
 */
export function sanitizeAudioSettings(value: unknown): AudioSettings {
  const source = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const unit = (raw: unknown, fallback: number): number =>
    typeof raw === 'number' && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : fallback
  return {
    master: unit(source.master, DEFAULT_AUDIO_SETTINGS.master),
    bgm: unit(source.bgm, DEFAULT_AUDIO_SETTINGS.bgm),
    sfx: unit(source.sfx, DEFAULT_AUDIO_SETTINGS.sfx),
    vo: unit(source.vo, DEFAULT_AUDIO_SETTINGS.vo),
    muted: typeof source.muted === 'boolean' ? source.muted : DEFAULT_AUDIO_SETTINGS.muted,
  }
}

/** 三条总线：背景乐、音效、配音。各自独立音量，方便单独调。 */
const CHANNELS: AudioChannel[] = ['bgm', 'sfx', 'vo']

/**
 * 音频总线。
 *
 * 两个关键点：
 * 1. 素材缺失时 Howler 会触发 loaderror。这里记录一次后就不再重试，
 *    绝不会因为少一个音效文件就把游戏流程卡住。
 * 2. 移动端（尤其 iOS）必须在用户手势里解锁音频，见 unlock()。
 */
export class AudioBus {
  private settings: AudioSettings = { ...DEFAULT_AUDIO_SETTINGS }
  private readonly cache = new Map<string, Howl | null>()
  private readonly failed = new Set<string>()
  private readonly createHowl: (options: ConstructorParameters<typeof Howl>[0]) => Howl
  private currentBgmKey: string | null = null
  private currentBgm: Howl | null = null
  private unlocked = false
  private disposed = false
  private paused = false
  private readonly activeSounds = new Map<Howl, Map<number, AudioChannel>>()
  private readonly resumeSounds = new Map<Howl, Set<number>>()
  private readonly fadeTimers = new Map<Howl, ReturnType<typeof setTimeout>>()
  private currentVo: Howl | null = null

  constructor(options: AudioBusOptions = {}) {
    this.createHowl = options.createHowl ?? ((howlOptions) => new Howl(howlOptions))
  }

  getSettings(): AudioSettings {
    return { ...this.settings }
  }

  setSettings(next: Partial<AudioSettings>): void {
    // 净化一次：调用方可能是 UI（值是滑杆来的），也可能是持久化恢复（值不可信）
    this.settings = sanitizeAudioSettings({ ...this.settings, ...next })
    if (this.settings.muted) Howler.mute(true)
    else Howler.mute(false)
    Howler.volume(this.settings.master)
    if (this.currentBgm) this.currentBgm.volume(this.channelVolume('bgm'))
  }

  private channelVolume(channel: AudioChannel): number {
    return this.settings.muted ? 0 : this.settings[channel]
  }

  /** 首次用户手势后调用，解开移动端音频限制。 */
  unlock(): void {
    if (this.unlocked) return
    this.unlocked = true
    try {
      const ctx = Howler.ctx as AudioContext | undefined
      if (ctx && ctx.state === 'suspended') void ctx.resume()
    } catch {
      // 部分浏览器不暴露 ctx，忽略即可
    }
  }

  private startSound(howl: Howl, channel: AudioChannel): number {
    const id = howl.play()
    const instances = this.activeSounds.get(howl) ?? new Map<number, AudioChannel>()
    instances.set(id, channel)
    this.activeSounds.set(howl, instances)
    if (this.paused) {
      howl.pause(id)
      const ids = this.resumeSounds.get(howl) ?? new Set<number>()
      ids.add(id)
      this.resumeSounds.set(howl, ids)
    }
    return id
  }

  setPaused(paused: boolean): void {
    if (this.disposed || this.paused === paused) return
    this.paused = paused
    if (paused) {
      for (const [howl, instances] of this.activeSounds) {
        for (const id of instances.keys()) {
          if (!howl.playing(id)) continue
          const ids = this.resumeSounds.get(howl) ?? new Set<number>()
          ids.add(id)
          this.resumeSounds.set(howl, ids)
          howl.pause(id)
        }
      }
    } else {
      for (const [howl, ids] of this.resumeSounds) {
        for (const id of ids) if (this.activeSounds.get(howl)?.has(id)) howl.play(id)
      }
      this.resumeSounds.clear()
    }
  }

  private howl(path: string): Howl | null {
    if (this.disposed) return null
    if (this.failed.has(path)) return null
    const cached = this.cache.get(path)
    if (cached !== undefined) return cached

    const howl = this.createHowl({
      src: [assetUrl(path)],
      html5: false,
      preload: true,
      onloaderror: () => {
        if (this.disposed) return
        this.failed.add(path)
        this.cache.set(path, null)
        console.warn(`[audio] 缺失，已静默降级：assets/${path}`)
      },
      onend: (id) => {
        this.activeSounds.get(howl)?.delete(id)
        this.resumeSounds.get(howl)?.delete(id)
      },
      onplayerror: () => {
        // 未解锁时 Howler 会把声音挂起，解锁后会补播
        this.unlocked = false
      },
    })
    this.cache.set(path, howl)
    return howl
  }

  /**
   * 淡出并停止一条背景乐，然后把它移出缓存。
   *
   * 关键在于淡出是**异步**的（setTimeout），而在这段窗口里同一首曲子
   * 完全可能被重新播起来 —— 比如剧本里先 `# bgm: none` 再 `# bgm: theme`，
   * 或者切走又切回同一个场景。所以定时器里必须重新确认"它还是不是当前那条"，
   * 否则会把刚起播的音乐掐掉，并把它从缓存里误删。
   */
  private fadeOutAndEvict(howl: Howl, key: string | null, fadeSeconds: number): void {
    const ms = Math.max(0, fadeSeconds) * 1000
    const existing = this.fadeTimers.get(howl)
    if (existing) clearTimeout(existing)
    howl.fade(howl.volume(), 0, ms)
    const timer = setTimeout(() => {
      this.fadeTimers.delete(howl)
      if (this.disposed || this.currentBgm === howl) return
      howl.stop()
      this.activeSounds.delete(howl)
      this.resumeSounds.delete(howl)
      if (key && this.currentBgmKey !== key && this.cache.get(key) === howl) {
        this.cache.delete(key)
        howl.unload()
      }
    }, ms + 50)
    this.fadeTimers.set(howl, timer)
  }

  playBgm(path: string, fadeSeconds = 1.2): void {
    if (!path || path === 'none') {
      this.stopBgm(fadeSeconds)
      return
    }
    if (this.currentBgmKey === path && this.currentBgm && (this.currentBgm.playing() || this.paused)) return

    const previous = this.currentBgm
    const previousKey = this.currentBgmKey
    if (previous) this.fadeOutAndEvict(previous, previousKey, fadeSeconds)

    const howl = this.howl(path)
    if (!howl) return
    this.currentBgmKey = path
    this.currentBgm = howl
    const target = this.channelVolume('bgm')
    howl.loop(true)
    howl.volume(0)
    this.startSound(howl, 'bgm')
    howl.fade(0, target, Math.max(0, fadeSeconds) * 1000)
  }

  stopBgm(fadeSeconds = 0.8): void {
    const howl = this.currentBgm
    if (!howl) return
    const key = this.currentBgmKey
    this.currentBgm = null
    this.currentBgmKey = null
    this.fadeOutAndEvict(howl, key, fadeSeconds)
  }

  playSfx(path: string): void {
    const howl = this.howl(path)
    if (!howl) return
    const id = this.startSound(howl, 'sfx')
    howl.volume(this.channelVolume('sfx'), id)
  }

  playVo(path: string): void {
    /*
     * 播新的一句之前先把上一句停掉。
     *
     * Howler 的 `play()` 是**新起一个实例**，不是重播同一个 —— 玩家快速
     * 推进台词时，前一句的语音会和新的一句叠在一起说。`stopVo` 早就写好了，
     * 但全仓没有调用方，所以这个行为一直没生效（面板里却已经有 vo 音量滑块，
     * 看起来像是接好了的）。
     */
    this.stopVo()
    const howl = this.howl(path)
    if (!howl) return
    this.currentVo = howl
    const id = this.startSound(howl, 'vo')
    howl.volume(this.channelVolume('vo'), id)
  }

  /** 停掉所有正在播的语音。换场景、重开一句时都该调。 */
  stopVo(): void {
    if (this.currentVo) {
      this.currentVo.stop()
      this.activeSounds.delete(this.currentVo)
      this.resumeSounds.delete(this.currentVo)
      this.currentVo = null
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.fadeTimers.values()) clearTimeout(timer)
    this.fadeTimers.clear()
    for (const howl of this.cache.values()) howl?.unload()
    this.cache.clear()
    this.activeSounds.clear()
    this.resumeSounds.clear()
    this.currentBgm = null
    this.currentBgmKey = null
    this.currentVo = null
  }

  /** 供设置面板展示，哪些音频文件实际缺失。 */
  get failedAssets(): string[] {
    return [...this.failed].sort()
  }
}

export { CHANNELS }
