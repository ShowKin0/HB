import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Howl } from 'howler'
import { AudioBus, DEFAULT_AUDIO_SETTINGS, sanitizeAudioSettings } from '../src/engine/audio.ts'

/**
 * 音频总线的淡出竞态。
 *
 * 淡出是异步的（setTimeout），而在这段窗口里同一首曲子完全可能被重新播起来。
 * 修复前定时器会无条件 `stop()`，把刚起播的音乐掐掉，还会把它从缓存里误删。
 * 这类问题只靠听是发现不了的 —— 所以注入一个假 Howl，用假定时器钉死。
 */

class FakeHowl {
  static created: FakeHowl[] = []
  src: string
  isPlaying = false
  volumeValue = 1
  stopCount = 0
  playCount = 0
  pauseCount = 0
  unloadCount = 0

  constructor(options: { src?: string[] }) {
    this.src = options.src?.[0] ?? ''
    FakeHowl.created.push(this)
  }

  loop(): this {
    return this
  }

  play(): number {
    this.playCount += 1
    this.isPlaying = true
    return 1
  }

  playing(): boolean {
    return this.isPlaying
  }

  stop(): void {
    this.stopCount += 1
    this.isPlaying = false
  }

  fade(): this {
    return this
  }

  volume(value?: number): number {
    if (value !== undefined) this.volumeValue = value
    return this.volumeValue
  }

  pause(): void { this.pauseCount += 1; this.isPlaying = false }

  unload(): void { this.unloadCount += 1 }
}

function makeBus(): AudioBus {
  return new AudioBus({ createHowl: (options) => new FakeHowl(options as never) as unknown as Howl })
}

beforeEach(() => {
  FakeHowl.created = []
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AudioBus 淡出竞态', () => {
  it('后台暂停与恢复对应已播放实例', () => {
    const bus = makeBus()
    bus.playBgm('bgm/theme.ogg')
    const theme = FakeHowl.created[0]
    bus.setPaused(true)
    expect(theme.pauseCount).toBe(1)
    bus.setPaused(false)
    expect(theme.playCount).toBe(2)
    bus.dispose()
  })

  it('语音使用自定义目录也会停止上一句', () => {
    const bus = makeBus()
    bus.playVo('custom/a.mp3')
    const first = FakeHowl.created[0]
    bus.playVo('custom/b.mp3')
    expect(first.stopCount).toBe(1)
    bus.dispose()
  })

  it('销毁后淡出计时器不再操作已卸载对象', () => {
    const bus = makeBus()
    bus.playBgm('bgm/a.ogg')
    const a = FakeHowl.created[0]
    bus.stopBgm(1)
    bus.dispose()
    vi.advanceTimersByTime(2000)
    expect(a.unloadCount).toBe(1)
    expect(a.stopCount).toBe(0)
  })
  it('stopBgm 之后立刻重播同一首，不会被迟到的定时器掐掉', () => {
    const bus = makeBus()
    bus.playBgm('bgm/theme.ogg', 0.5)
    const theme = FakeHowl.created[0]
    expect(theme.playCount).toBe(1)

    bus.stopBgm(0.5)
    bus.playBgm('bgm/theme.ogg', 0.5)

    vi.advanceTimersByTime(2000)

    expect(theme.stopCount).toBe(0)
    expect(theme.isPlaying).toBe(true)
  })

  it('切走再切回同一首，淡出定时器不会误停', () => {
    const bus = makeBus()
    bus.playBgm('bgm/a.ogg', 0.3)
    const a = FakeHowl.created[0]

    bus.playBgm('bgm/b.ogg', 0.3)
    const b = FakeHowl.created[1]

    // 在 A 的淡出窗口内切回来
    bus.playBgm('bgm/a.ogg', 0.3)

    vi.advanceTimersByTime(2000)

    // A 应当还在播；B 应当被停掉
    expect(a.stopCount).toBe(0)
    expect(a.isPlaying).toBe(true)
    expect(b.stopCount).toBe(1)
    expect(b.isPlaying).toBe(false)
  })

  it('正常切歌时，旧的那首会被淡出停掉', () => {
    const bus = makeBus()
    bus.playBgm('bgm/a.ogg', 0.3)
    const a = FakeHowl.created[0]

    bus.playBgm('bgm/b.ogg', 0.3)
    vi.advanceTimersByTime(2000)

    expect(a.stopCount).toBe(1)
  })

  it('重复播同一首且仍在播放时不会重开', () => {
    const bus = makeBus()
    bus.playBgm('bgm/a.ogg', 0.3)
    bus.playBgm('bgm/a.ogg', 0.3)
    expect(FakeHowl.created).toHaveLength(1)
    expect(FakeHowl.created[0].playCount).toBe(1)
  })

  it('静音只影响音量，不影响播放状态', () => {
    const bus = makeBus()
    bus.setSettings({ muted: true })
    bus.playBgm('bgm/a.ogg', 0)
    const a = FakeHowl.created[0]
    expect(a.playCount).toBe(1)
    expect(bus.getSettings().muted).toBe(true)
  })
})

describe('音量设置的净化', () => {
  /*
   * 这套设置是持久化的（zustand persist → localStorage），而 zustand 默认
   * 只做浅合并、不做校验。localStorage 会被旧版本、别的标签页、手改污染，
   * 一个 master:null 就够让 Howler.volume(NaN) 把音频搞哑。
   */
  it('非法值回落到默认，而不是原样透传', () => {
    const settings = sanitizeAudioSettings({ master: 'loud', bgm: null, sfx: [], vo: {} , muted: 'yes' })
    expect(settings).toEqual(DEFAULT_AUDIO_SETTINGS)
  })

  it('越界数值被夹回 0..1', () => {
    const settings = sanitizeAudioSettings({ master: 99, bgm: -5, sfx: 0.5, vo: 1, muted: false })
    expect(settings.master).toBe(1)
    expect(settings.bgm).toBe(0)
    expect(settings.sfx).toBe(0.5)
  })

  it('NaN / Infinity 不会漏过去', () => {
    const settings = sanitizeAudioSettings({ master: Number.NaN, bgm: Number.POSITIVE_INFINITY })
    expect(Number.isFinite(settings.master)).toBe(true)
    expect(Number.isFinite(settings.bgm)).toBe(true)
  })

  it('不是对象时整份回落默认', () => {
    for (const value of [null, undefined, 42, 'x', []]) {
      expect(sanitizeAudioSettings(value)).toEqual(DEFAULT_AUDIO_SETTINGS)
    }
  })

  it('合法的部分完整保留', () => {
    const settings = sanitizeAudioSettings({ master: 0.3, bgm: 0.2, sfx: 0.1, vo: 0.9, muted: true })
    expect(settings).toEqual({ master: 0.3, bgm: 0.2, sfx: 0.1, vo: 0.9, muted: true })
  })
})