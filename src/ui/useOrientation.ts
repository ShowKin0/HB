import { useEffect, useState } from 'react'
import type { Orientation, ViewportSize } from '../schema/layout.rules.ts'

/** 当前设备方向。横竖屏切换会让它更新，布局据此重新解析。 */
export function useOrientation(): Orientation {
  const [portrait, setPortrait] = useState(isPortraitNow)

  useEffect(() => {
    const query = window.matchMedia('(orientation: portrait)')
    const update = (): void => setPortrait(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return portrait ? 'portrait' : 'landscape'
}

export function isPortraitNow(): boolean {
  return window.matchMedia('(orientation: portrait)').matches
}

/**
 * 当前视口尺寸。
 *
 * 布局规则里可以带 `minAspectRatio` / `minWidth` 这类条件（见 layout.rules.ts），
 * 求值需要真实尺寸 —— 而且必须在尺寸变化时**重新求值**，否则旋转屏幕后
 * 布局还停在旧规则上。
 */
export function useViewportSize(): ViewportSize {
  const [size, setSize] = useState<ViewportSize>(() => ({
    width: typeof window === 'undefined' ? 0 : (window.visualViewport?.width ?? window.innerWidth),
    height: typeof window === 'undefined' ? 0 : (window.visualViewport?.height ?? window.innerHeight),
  }))

  useEffect(() => {
    const viewport = window.visualViewport
    const update = (): void => setSize({ width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight })
    update()
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    viewport?.addEventListener('resize', update)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
      viewport?.removeEventListener('resize', update)
    }
  }, [])

  return size
}

/**
 * 当前是否处于"内容要求横屏、但设备是竖屏"的状态。
 *
 * 参数用宽类型：内容声明的是 `'landscape' | 'portrait' | 'auto'`（还能表达
 * "两种都行"），而设备的方向只有两种。混在一个 `Orientation` 名下会让
 * 调用方分不清是哪一个，所以这里显式写开。
 */
export function useOrientationBlocked(required: 'landscape' | 'portrait' | 'auto'): boolean {
  const portrait = useOrientation() === 'portrait'

  // 'auto' 表示内容两种方向都能用，这时不拦
  return required === 'landscape' ? portrait : required === 'portrait' ? !portrait : false
}

/**
 * 尽力把设备转到横屏。
 *
 * **不强制、不报错**：iOS Safari 既不支持全屏也不支持 `orientation.lock`，
 * WebView 里的行为也各不相同。所以这是"能锁就锁"，锁不上还有竖屏引导页兜底。
 * 不返回是否成功 —— 调用方没有可做的事，也免得它误以为是可靠的保证。
 */
export async function tryLockLandscape(): Promise<void> {
  try {
    const root = document.documentElement
    if (!document.fullscreenElement && typeof root.requestFullscreen === 'function') {
      await root.requestFullscreen()
    }
    const orientation = screen.orientation as
      | (ScreenOrientation & { lock?: (value: string) => Promise<void> })
      | undefined
    await orientation?.lock?.('landscape')
  } catch {
    // 不支持就静默算了，竖屏引导页已经把话说清楚了
  }
}