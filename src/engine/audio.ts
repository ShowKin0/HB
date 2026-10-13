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

  constructor(options: AudioBusOptions = {}) {
    this.createHowl = options.createHowl ?? ((howlOptions) => new Howl(howlOptions))
  }

  getSettings(): AudioSettings {
    return { ...this.settings }
  }

  setSettings(next: Partial<AudioSettings>): void {
    this.settings = { ...this.settings, ...next }
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

  private howl(path: string): Howl | null {
    if (this.failed.has(path)) return null
    const cached = this.cache.get(path)
    if (cached !== undefined) return cached

    const howl = this.createHowl({
      src: [assetUrl(path)],
      html5: false,
      preload: true,
      onloaderror: () => {
        this.failed.add(path)
        this.cache.set(path, null)
        console.warn(`[audio] 缺失，已静默降级：assets/${path}`)
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
    howl.fade(howl.volume(), 0, ms)
    setTimeout(() => {
      // 已经重新成为当前背景乐：什么都不做
      if (this.currentBgm === howl) return
      howl.stop()
      if (key && this.currentBgmKey !== key) this.cache.delete(key)
    }, ms + 50)
  }

  playBgm(path: string, fadeSeconds = 1.2): void {
    if (!path || path === 'none') {
      this.stopBgm(fadeSeconds)
      return
    }
    if (this.currentBgmKey === path && this.currentBgm?.playing()) return

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
    howl.play()
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
    const id = howl.play()
    howl.volume(this.channelVolume('sfx'), id)
  }

  playVo(path: string): void {
    const howl = this.howl(path)
    if (!howl) return
    const id = howl.play()
    howl.volume(this.channelVolume('vo'), id)
  }

  stopVo(): void {
    for (const [path, howl] of this.cache) {
      if (howl && path.includes('/vo/')) howl.stop()
    }
  }

  dispose(): void {
    for (const howl of this.cache.values()) howl?.unload()
    this.cache.clear()
  }

  /** 供设置面板展示，哪些音频文件实际缺失。 */
  get failedAssets(): string[] {
    return [...this.failed].sort()
  }
}

export { CHANNELS }
