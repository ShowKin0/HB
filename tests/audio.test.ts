import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Howl } from 'howler'
import { AudioBus } from '../src/engine/audio.ts'

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

  unload(): void {}
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
