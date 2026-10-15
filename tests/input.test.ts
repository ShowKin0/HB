import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_GESTURE_CONFIG,
  InputRouter,
  resolveInputOwner,
  type GestureEvent,
  type PointerSample,
} from '../src/engine/input/router.ts'
import { SessionScope, TaskCancelled, delay, isTaskCancelled } from '../src/engine/task.ts'

/**
 * 手机输入底座。
 *
 * 这一层是纯状态机，所以能完整测到"一次手势只产生一个结果"这条核心约束 ——
 * 它正是加入长按和拖动之后最容易破的地方。
 */

function sample(x: number, y: number, t = 0, pointerId = 1): PointerSample {
  return { pointerId, x, y, t }
}

/** 把一串事件压成"结果"列表，方便断言。 */
function results(events: GestureEvent[]): string[] {
  return events.map((event) => event.type)
}

describe('InputRouter 基本手势', () => {
  it('即使漏掉 move 事件，远处抬起也不触发点击', () => {
    const router = new InputRouter()
    router.down(sample(0, 0, 0))
    expect(results(router.up(sample(100, 0, 100)))).toEqual(['cancel'])
    expect(router.active).toBe(false)
  })
  it('按下不执行任何交互，只给按压反馈', () => {
    const router = new InputRouter()
    expect(results(router.down(sample(100, 100)))).toEqual(['press'])
    expect(router.state.phase).toBe('pressed')
  })

  it('按下后原地抬起 → 一次 tap', () => {
    const router = new InputRouter()
    router.down(sample(100, 100, 0))
    const events = router.up(sample(100, 100, 80))
    expect(results(events)).toEqual(['tap'])
    expect(events[0]).toMatchObject({ point: [100, 100] })
  })

  it('小幅抖动仍然算 tap（阈值内）', () => {
    const router = new InputRouter()
    router.down(sample(100, 100, 0))
    router.move(sample(105, 104, 30))
    expect(results(router.up(sample(105, 104, 60)))).toEqual(['tap'])
  })

  it('超出点击阈值后抬起不再算 tap', () => {
    const router = new InputRouter()
    router.down(sample(100, 100, 0))
    // 移动到拖动阈值之上，再移回来 —— 已经撤销了点击候选
    router.move(sample(140, 100, 20))
    router.move(sample(100, 100, 40))
    expect(results(router.up(sample(100, 100, 60)))).toEqual(['dragEnd'])
  })
})

describe('InputRouter 拖动', () => {
  it('越过拖动阈值才进入拖动，并给出起止点', () => {
    const router = new InputRouter()
    router.down(sample(100, 100, 0))
    expect(results(router.move(sample(105, 100, 10)))).toEqual([])
    expect(results(router.move(sample(130, 100, 20)))).toEqual(['dragStart', 'dragMove'])

    const events = router.up(sample(160, 120, 300))
    expect(results(events)).toEqual(['dragEnd'])
    expect(events[0]).toMatchObject({ from: [100, 100], to: [160, 120], durationMs: 300 })
  })

  it('阈值是 CSS 像素，与屏幕尺寸无关', () => {
    const router = new InputRouter()
    expect(router.gestureConfig.tapSlopPx).toBe(DEFAULT_GESTURE_CONFIG.tapSlopPx)
    router.down(sample(0, 0, 0))
    // 正好在阈值上不算越界，越界一点点才算
    expect(results(router.move(sample(10, 0, 10)))).toEqual([])
    expect(results(router.move(sample(11, 0, 20)))).toEqual(['dragStart', 'dragMove'])
  })
})

describe('InputRouter 长按', () => {
  it('按住到时间点触发一次 hold，由 tick 驱动', () => {
    const router = new InputRouter({ holdMs: 500 })
    router.down(sample(50, 50, 1000))
    expect(results(router.tick(1200))).toEqual([])
    expect(results(router.tick(1500))).toEqual(['hold'])
    // 只触发一次
    expect(results(router.tick(2000))).toEqual([])
    expect(router.state.phase).toBe('holding')
  })

  it('长按触发后抬起不再产生第二个结果', () => {
    const router = new InputRouter({ holdMs: 500 })
    router.down(sample(50, 50, 0))
    router.tick(600)
    expect(results(router.up(sample(50, 50, 700)))).toEqual([])
  })

  it('长按之后移动不会降级成拖动（一次手势只有一个结果）', () => {
    const router = new InputRouter({ holdMs: 500 })
    router.down(sample(50, 50, 0))
    router.tick(600)
    expect(results(router.move(sample(200, 200, 700)))).toEqual([])
  })

  it('移动过的手势不会被时间推进误判成长按', () => {
    const router = new InputRouter({ holdMs: 500 })
    router.down(sample(50, 50, 0))
    router.move(sample(200, 200, 100))
    // 已经进入拖动；tick 不该再发 hold
    expect(results(router.tick(900))).toEqual([])
    expect(router.state.phase).toBe('dragging')
  })
})

describe('InputRouter 取消与多指', () => {
  it('取消不产生成功结果', () => {
    const router = new InputRouter()
    router.down(sample(100, 100, 0))
    const events = router.cancel('pointercancel')
    expect(results(events)).toEqual(['cancel'])
    expect(router.state.phase).toBe('idle')
    // 取消之后再抬起什么都不发生
    expect(results(router.up(sample(100, 100, 50)))).toEqual([])
  })

  it('空闲时取消不产生事件', () => {
    const router = new InputRouter()
    expect(results(router.cancel('visibility'))).toEqual([])
  })

  it('第二根手指不改变当前操作', () => {
    const router = new InputRouter()
    router.down(sample(100, 100, 0, 1))
    // 第二根手指按下被忽略
    expect(results(router.down(sample(300, 300, 10, 2)))).toEqual([])
    expect(router.state.pointerId).toBe(1)
    // 第二根手指移动/抬起也被忽略
    expect(results(router.move(sample(400, 400, 20, 2)))).toEqual([])
    expect(results(router.up(sample(400, 400, 30, 2)))).toEqual([])
    // 主指针仍然正常结算
    expect(results(router.up(sample(100, 100, 40, 1)))).toEqual(['tap'])
  })

  it('主指针抬起后，下一次按下可以换一根手指', () => {
    const router = new InputRouter()
    router.down(sample(10, 10, 0, 7))
    router.up(sample(10, 10, 20, 7))
    expect(results(router.down(sample(20, 20, 30, 9)))).toEqual(['press'])
  })
})

describe('InputRouter 没有死区', () => {
  /*
   * 回归守卫。
   *
   * 原来 up() 同时看两个条件：phase 是 pressed **且** 没超出点击阈值。
   * 当 tapSlopPx < dragStartPx（两个都是项目可配的）时，位移落在两者
   * 之间的手势既不满足拖动、又被点击阈值否掉 —— up 返回空数组，
   * 玩家按下去、手指动了、什么也没发生，而且完全不报错。
   */
  it('位移落在两个阈值之间时仍然是点击，不是空结果', () => {
    const router = new InputRouter({ tapSlopPx: 8, dragStartPx: 20 })
    router.down(sample(0, 0, 0))
    router.move(sample(14, 0, 10))
    const events = router.up(sample(14, 0, 20))
    expect(events, '两个阈值之间的手势不能什么都不发生').toHaveLength(1)
    expect(events[0].type).toBe('tap')
  })

  it('扫一遍位移：每个手势都恰好产生一个结果', () => {
    for (let distance = 0; distance <= 60; distance += 1) {
      const router = new InputRouter({ tapSlopPx: 10, dragStartPx: 24 })
      router.down(sample(0, 0, 0))
      if (distance > 0) router.move(sample(distance, 0, 10))
      const events = router.up(sample(distance, 0, 20))
      expect(events, `位移 ${distance}px 时没有产生任何结果`).toHaveLength(1)
      expect(['tap', 'dragEnd']).toContain(events[0].type)
    }
  })

  it('阈值可以反过来配（点击容差大于拖动阈值），同样成立', () => {
    const router = new InputRouter({ tapSlopPx: 30, dragStartPx: 10 })
    router.down(sample(0, 0, 0))
    router.move(sample(20, 0, 10))
    expect(results(router.up(sample(20, 0, 20)))).toEqual(['dragEnd'])
  })

  it('tick 的时间早于按下时间时不会误触发长按', () => {
    // 时钟回拨、或者两个时间基准混用时会出现这种输入
    const router = new InputRouter({ holdMs: 500 })
    router.down(sample(0, 0, 10_000))
    expect(results(router.tick(0))).toEqual([])
    expect(router.state.phase).toBe('pressed')
  })
})

describe('输入归属', () => {
  it('面板 > 小游戏 > 对话 > 场景', () => {
    expect(resolveInputOwner('scene', 'dialogue')).toBe('dialogue')
    expect(resolveInputOwner('dialogue', 'minigame')).toBe('minigame')
    expect(resolveInputOwner('minigame', 'panel')).toBe('panel')
    expect(resolveInputOwner('scene')).toBe('scene')
    expect(resolveInputOwner()).toBe('none')
  })
})

describe('SessionScope 任务取消', () => {
  it('重开会作废旧任务，并且旧上下文不再有效', () => {
    const scope = new SessionScope()
    const before = scope.task('start')
    expect(scope.isCurrent(before)).toBe(true)

    const nextId = scope.restart()
    expect(nextId).toBeGreaterThan(before.sessionId)
    expect(before.signal.aborted).toBe(true)
    // 关键：光看 signal 不够，会话号变了也算失效
    expect(scope.isCurrent(before)).toBe(false)
    expect(scope.isCurrent(scope.task('start'))).toBe(true)
  })

  it('销毁后一切任务都失效', () => {
    const scope = new SessionScope()
    const ctx = scope.task()
    scope.dispose()
    expect(scope.isDisposed).toBe(true)
    expect(scope.isCurrent(ctx)).toBe(false)
    expect(scope.task().signal.aborted).toBe(true)
  })

  it('delay 在取消时 reject 而不是 resolve', async () => {
    const scope = new SessionScope()
    const ctx = scope.task()
    const pending = delay(10_000, ctx.signal)
    scope.restart()
    await expect(pending).rejects.toBeInstanceOf(TaskCancelled)
  })

  it('delay 正常到时', async () => {
    vi.useFakeTimers()
    const scope = new SessionScope()
    const pending = delay(50, scope.task().signal)
    await vi.advanceTimersByTimeAsync(60)
    await expect(pending).resolves.toBeUndefined()
    vi.useRealTimers()
  })

  it('已经取消的信号上 delay 立刻 reject', async () => {
    const scope = new SessionScope()
    scope.abort('test')
    await expect(delay(1000, scope.signal)).rejects.toBeInstanceOf(TaskCancelled)
  })

  it('isTaskCancelled 只认自己的取消错误', () => {
    expect(isTaskCancelled(new TaskCancelled('x'))).toBe(true)
    expect(isTaskCancelled(new Error('别的错'))).toBe(false)
    expect(isTaskCancelled(null)).toBe(false)
  })
})
