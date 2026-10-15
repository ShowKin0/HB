import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DIALOGUE_LAYOUT,
  insetsForPlacement,
  isPlacement,
  mergeDialogueLayout,
  normalizeDialogueLayout,
  placementVisible,
  resolveDialoguePlacement,
  shouldBlockWorldInput,
  type DialogueLayoutConfig,
} from '../src/schema/layout.rules.ts'
import { SceneSchema } from '../src/schema/scene.ts'
import { normalizeScene } from '../src/schema/scene.rules.ts'
import { fitViewport } from '../src/render/stage.ts'

/**
 * 对话布局策略。
 *
 * 这一层存在的理由：以前"横屏用右侧面板"是写死在 CSS 媒体查询里的 ——
 * 那是 soft-watercolor 主题在 iPhone 14 横屏下的**一个解**，却成了所有内容
 * 的强制行为。现在引擎只负责求值，**策略由内容声明**。
 *
 * 所以这里的用例重点在"求值是否忠实于声明"，而不是某个具体布局好不好看。
 */

describe('cover 可见场景范围', () => {
  it('contain 保留完整 U/V；cover 裁切时显式返回两轴范围', () => {
    const contain = fitViewport(1200, 600, 16 / 9, 0, 0, 'contain')
    expect([contain.visibleU0, contain.visibleU1, contain.visibleV0, contain.visibleV1]).toEqual([0, 1, 0, 1])

    const horizontalCrop = fitViewport(600, 1200, 16 / 9, 0, 0, 'cover')
    expect(horizontalCrop.visibleU0).toBeGreaterThan(0)
    expect(horizontalCrop.visibleU1).toBeLessThan(1)
    expect(horizontalCrop.visibleV0).toBe(0)
    expect(horizontalCrop.visibleV1).toBe(1)

    const verticalCrop = fitViewport(1800, 600, 16 / 9, 0, 0, 'cover')
    expect(verticalCrop.visibleU0).toBe(0)
    expect(verticalCrop.visibleU1).toBe(1)
    expect(verticalCrop.visibleV0).toBeGreaterThan(0)
    expect(verticalCrop.visibleV1).toBeLessThan(1)
  })
})

describe('引擎的中立默认', () => {
  it('默认是底部对话框，不是右侧面板', () => {
    // 选 bottom 不是随便定的：它对任何宽高比都成立，而 side 需要"够宽才划算"
    // —— 把 side 当默认，等于把某个主题的调优结论强加给所有内容
    expect(DEFAULT_DIALOGUE_LAYOUT.landscape).toBe('bottom')
    expect(DEFAULT_DIALOGUE_LAYOUT.portrait).toBe('bottom')
  })

  it('默认避让场景，但不接管世界输入', () => {
    // 引擎的底线是"不遮住内容"；想浮在场景上的内容自己声明 false
    expect(DEFAULT_DIALOGUE_LAYOUT.reserveSceneSpace).toBe(true)
    expect(DEFAULT_DIALOGUE_LAYOUT.pauseWorldInput).toBe(false)
  })
})

describe('规范化：非法值不许透传', () => {
  it('不是对象时整份回落默认', () => {
    for (const value of [null, undefined, 42, 'side', []]) {
      expect(normalizeDialogueLayout(value)).toEqual(DEFAULT_DIALOGUE_LAYOUT)
    }
  })

  it('拼错的 placement 回落到默认，而不是变成未定义行为', () => {
    const config = normalizeDialogueLayout({ landscape: 'right-panel', portrait: 'SIDE' })
    expect(config.landscape).toBe('bottom')
    expect(config.portrait).toBe('bottom')
  })

  it('合法的部分完整保留', () => {
    const config = normalizeDialogueLayout({
      landscape: 'side',
      portrait: 'overlay',
      reserveSceneSpace: false,
      pauseWorldInput: true,
    })
    expect(config).toEqual({
      landscape: 'side',
      portrait: 'overlay',
      reserveSceneSpace: false,
      pauseWorldInput: true,
    })
  })

  it('布尔字段只认真正的布尔值', () => {
    const config = normalizeDialogueLayout({ reserveSceneSpace: 'yes', pauseWorldInput: 1 })
    expect(config.reserveSceneSpace).toBe(true)
    expect(config.pauseWorldInput).toBe(false)
  })

  it('规则数组里的坏条目被丢掉，好的留下', () => {
    const config = normalizeDialogueLayout({
      landscape: [
        { placement: 'side', minAspectRatio: 1.9 },
        { placement: 'nonsense' },
        'bottom',
        { minAspectRatio: 3 },
      ],
    })
    expect(config.landscape).toEqual([{ placement: 'side', minAspectRatio: 1.9 }])
  })

  it('规则数组全坏时回落默认', () => {
    const config = normalizeDialogueLayout({ landscape: [{ placement: 'nope' }] })
    expect(config.landscape).toBe('bottom')
  })
})

describe('求值：按方向 + 视口选一条规则', () => {
  const config: DialogueLayoutConfig = {
    landscape: [
      { minAspectRatio: 1.9, placement: 'side' },
      { placement: 'bottom' },
    ],
    portrait: 'bottom',
    reserveSceneSpace: true,
    pauseWorldInput: false,
  }

  it('宽屏横屏走侧栏', () => {
    // iPhone 14 横屏：844/390 = 2.16
    expect(resolveDialoguePlacement(config, 'landscape', { width: 844, height: 390 })).toBe('side')
  })

  it('不够宽的横屏走底部', () => {
    // iPad mini 横屏：1024/744 = 1.38 —— 侧栏会把屏切成竖高矩形，
    // 场景只剩 38%，底部能拿到 75%
    expect(resolveDialoguePlacement(config, 'landscape', { width: 1024, height: 744 })).toBe('bottom')
  })

  it('恰好卡在阈值上算匹配', () => {
    expect(resolveDialoguePlacement(config, 'landscape', { width: 190, height: 100 })).toBe('side')
    expect(resolveDialoguePlacement(config, 'landscape', { width: 189, height: 100 })).toBe('bottom')
  })

  it('竖屏不看横屏那串规则', () => {
    expect(resolveDialoguePlacement(config, 'portrait', { width: 390, height: 844 })).toBe('bottom')
  })

  it('给定 placement 的写法等价于一条无条件规则', () => {
    const simple = normalizeDialogueLayout({ landscape: 'overlay' })
    for (const size of [
      { width: 400, height: 800 },
      { width: 1200, height: 400 },
    ]) {
      expect(resolveDialoguePlacement(simple, 'landscape', size)).toBe('overlay')
    }
  })

  it('一条规则都没匹配上时用最后一条兜底', () => {
    // 作者把兜底项放最后，本意就是"其余情况用这个"
    const strict: DialogueLayoutConfig = {
      ...config,
      landscape: [{ minAspectRatio: 5, placement: 'side' }],
    }
    expect(resolveDialoguePlacement(strict, 'landscape', { width: 100, height: 100 })).toBe('side')
  })

  it('视口还是 0 时也给得出确定的初值', () => {
    // 首帧还没有尺寸。宁可给个确定的初值，也不要让布局短暂地悬空
    const placement = resolveDialoguePlacement(config, 'landscape', { width: 0, height: 0 })
    expect(isPlacement(placement)).toBe(true)
    expect(placement).toBe('bottom')
  })

  it('高度为 0 不会算出 Infinity 而误判', () => {
    expect(resolveDialoguePlacement(config, 'landscape', { width: 1000, height: 0 })).toBe('bottom')
  })

  it('minWidth / minHeight 也参与判断', () => {
    const byWidth: DialogueLayoutConfig = {
      ...config,
      landscape: [{ minWidth: 900, placement: 'side' }, { placement: 'bottom' }],
    }
    expect(resolveDialoguePlacement(byWidth, 'landscape', { width: 950, height: 100 })).toBe('side')
    expect(resolveDialoguePlacement(byWidth, 'landscape', { width: 850, height: 100 })).toBe('bottom')

    const byHeight: DialogueLayoutConfig = {
      ...config,
      landscape: [{ minHeight: 500, placement: 'fullscreen' }, { placement: 'bottom' }],
    }
    expect(resolveDialoguePlacement(byHeight, 'landscape', { width: 100, height: 600 })).toBe(
      'fullscreen',
    )
    expect(resolveDialoguePlacement(byHeight, 'landscape', { width: 100, height: 400 })).toBe('bottom')
  })
})

describe('合并：内容包默认 ← 场景覆盖', () => {
  const base = normalizeDialogueLayout({ landscape: 'side', portrait: 'bottom' })

  it('场景只写想改的项，其余继承', () => {
    const merged = mergeDialogueLayout(base, { landscape: 'overlay' })
    expect(merged.landscape).toBe('overlay')
    expect(merged.portrait, '没写的项不该被动').toBe('bottom')
    expect(merged.reserveSceneSpace).toBe(base.reserveSceneSpace)
  })

  it('场景不写就完全继承', () => {
    expect(mergeDialogueLayout(base, null)).toEqual(base)
    expect(mergeDialogueLayout(base, undefined)).toEqual(base)
  })

  it('场景里的非法值被忽略，不覆盖内容包默认', () => {
    const merged = mergeDialogueLayout(base, { landscape: 'garbage', pauseWorldInput: 'x' })
    expect(merged.landscape).toBe('side')
    expect(merged.pauseWorldInput).toBe(false)
  })

  it('合并不会改动传入的对象', () => {
    const before = JSON.stringify(base)
    mergeDialogueLayout(base, { landscape: 'none', reserveSceneSpace: false })
    expect(JSON.stringify(base)).toBe(before)
  })
})

describe('inset：把"占在哪一侧"翻译成 Canvas 要避开的空间', () => {
  const panel = { side: 253, bottom: 104 }

  it('侧栏只让右侧', () => {
    expect(insetsForPlacement('side', true, panel)).toEqual({ right: 253, bottom: 0 })
  })

  it('底部只让下方', () => {
    expect(insetsForPlacement('bottom', true, panel)).toEqual({ right: 0, bottom: 104 })
  })

  it('浮层不占位 —— 这正是它和 bottom 的区别', () => {
    expect(insetsForPlacement('overlay', true, panel)).toEqual({ right: 0, bottom: 0 })
  })

  it('全屏和无对话都不让空间', () => {
    expect(insetsForPlacement('fullscreen', true, panel)).toEqual({ right: 0, bottom: 0 })
    expect(insetsForPlacement('none', true, panel)).toEqual({ right: 0, bottom: 0 })
  })

  it('声明不避让时，任何形态都不让', () => {
    for (const placement of ['side', 'bottom', 'overlay', 'fullscreen', 'none'] as const) {
      expect(insetsForPlacement(placement, false, panel)).toEqual({ right: 0, bottom: 0 })
    }
  })

  it('面板尺寸为 0 时结果也是 0，不会算出负数', () => {
    const zero = { side: 0, bottom: 0 }
    for (const placement of ['side', 'bottom'] as const) {
      const insets = insetsForPlacement(placement, true, zero)
      expect(insets.right).toBeGreaterThanOrEqual(0)
      expect(insets.bottom).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('对话层可见性', () => {
  it('只有 none 不显示', () => {
    expect(placementVisible('none')).toBe(false)
    for (const placement of ['side', 'bottom', 'overlay', 'fullscreen'] as const) {
      expect(placementVisible(placement)).toBe(true)
    }
  })
})

/**
 * 什么时候该停掉世界输入。
 *
 * 这个 bug 藏得很深：**开关本身（引擎侧）全是对的**，错的是"什么时候调它"。
 * 当时判据写的是"对话层渲染出来了"，而 `overlay` 形态下浮层的 DOM
 * **始终**挂在那儿 —— 于是 `pauseWorldInput: true` 会让世界输入永久关闭：
 * 点场景什么都不发生、角色再也不能被指使走动，而且不报任何错。
 *
 * 所以判据必须是"**真的有一句台词或选项在等玩家**"，而不是"层在那儿"。
 */
describe('世界输入的接管时机', () => {
  const base = { ...DEFAULT_DIALOGUE_LAYOUT, pauseWorldInput: true }

  it('没有内容等玩家时不接管 —— 哪怕对话层就挂在 DOM 里', () => {
    // 这是上面那个 bug 的核心：overlay 下"层可见"恒为真，
    // 拿它当判据等于把世界输入永久关掉
    expect(shouldBlockWorldInput(base, false)).toBe(false)
  })

  it('有台词或选项在等玩家时才接管', () => {
    expect(shouldBlockWorldInput(base, true)).toBe(true)
  })

  it('内容没声明要接管时，任何情况都不接管', () => {
    const off = { ...DEFAULT_DIALOGUE_LAYOUT, pauseWorldInput: false }
    expect(shouldBlockWorldInput(off, true)).toBe(false)
    expect(shouldBlockWorldInput(off, false)).toBe(false)
  })

  it('默认配置不会接管世界输入 —— 叙事冒险里玩家要能边走边说话', () => {
    expect(shouldBlockWorldInput(DEFAULT_DIALOGUE_LAYOUT, true)).toBe(false)
  })
})

/**
 * 架构守卫。
 *
 * 这一层抽象存在的全部意义，就是把"对话排在哪"从核心挪到内容。
 * 所以核心源码里不该再出现**关于屏幕形状的布局判据** —— 一旦出现，
 * 说明有人在引擎里又焊死了一个主题的结论，抽象立刻名存实亡。
 *
 * 这类东西靠人自觉守不住：写的时候都很合理（"宽屏就用侧栏嘛"），
 * 只有机器盯着才拦得住。
 */
/**
 * 两条加载路径必须对**场景级布局覆盖**给出同一个答案。
 *
 * 这是本项目双路径设计（运行时 normalizeScene / 构建期 SceneSchema）最大的
 * 风险点，而它真的漂移过：运行时那份只认单个 placement 字符串，
 * **数组规则被整段丢掉** —— 开发期（走 Zod）布局正常，生产构建静默变回
 * 兜底值，而且现有测试与内容都没走过这条路，所以完全隐形。
 */
describe('场景级覆盖：两条路径不许漂移', () => {
  const sceneWith = (dialogue: unknown): unknown => ({
    id: 's',
    // 热点必须有可触发的东西，否则 schema 的可用性规则会把它判为非法
    hotspots: [{ id: 'h', shape: { type: 'rect', x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, onClick: 'look_h' }],
    dialogue,
  })

  it('数组规则写法在两条路径下结果一致', () => {
    const dialogue = {
      landscape: [
        { minAspectRatio: 1.9, placement: 'side' },
        { placement: 'bottom' },
      ],
    }
    const viaSchema = SceneSchema.parse(sceneWith(dialogue)).dialogue
    const viaRules = normalizeScene(sceneWith(dialogue)).dialogue
    expect(viaRules, '运行时把数组规则丢了 —— 生产构建会静默变回兜底值').toEqual(viaSchema)
    expect(viaRules?.landscape).toEqual([
      { minAspectRatio: 1.9, placement: 'side' },
      { placement: 'bottom' },
    ])
  })

  it('混合写法（一个方向是字符串、另一个是规则串）也不许丢一半', () => {
    const dialogue = {
      portrait: 'bottom',
      landscape: [{ minWidth: 900, placement: 'side' }, { placement: 'overlay' }],
      reserveSceneSpace: false,
    }
    const viaSchema = SceneSchema.parse(sceneWith(dialogue)).dialogue
    const viaRules = normalizeScene(sceneWith(dialogue)).dialogue
    expect(viaRules).toEqual(viaSchema)
    expect(viaRules?.portrait).toBe('bottom')
    expect(viaRules?.reserveSceneSpace).toBe(false)
  })

  it('非法规则：构建期拒绝、运行时降级 —— 两者本来就该不同', () => {
    const dialogue = { landscape: [{ minAspectRatio: 2, placement: 'nonsense' }] }
    /*
     * 这两条路径**不是**同一件事，对非法输入不该给同一个答案：
     *   · Zod 是校验器 —— 构建期直接拒绝，作者必须改内容
     *   · normalizeScene 是降级器 —— 运行时丢弃坏值、继续跑
     * 要求它们一致就搞错了方向；要一致的是**合法输入**的处理结果
     * （上面两条用例）。
     */
    expect(() => SceneSchema.parse(sceneWith(dialogue))).toThrow()
    expect(normalizeScene(sceneWith(dialogue)).dialogue).toBeNull()
  })
})

describe('核心不许内置布局判据', () => {
  const read = (relative: string): string =>
    readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

  it('引擎与渲染层不出现宽高比 / 方向的媒体查询判据', () => {
    const guarded = [
      'src/engine/game.ts',
      'src/engine/input/router.ts',
      'src/render/stage.ts',
      'src/render/sceneRenderer.ts',
    ]
    for (const file of guarded) {
      const source = read(file)
      for (const forbidden of ['min-aspect-ratio', 'max-aspect-ratio', 'orientation: landscape']) {
        expect(source.includes(forbidden), `${file} 里出现了布局判据「${forbidden}」`).toBe(false)
      }
    }
  })

  it('引擎不引用布局求值函数 —— 求值是 UI 的事', () => {
    const engine = read('src/engine/game.ts')
    expect(engine.includes('resolveDialoguePlacement')).toBe(false)
    expect(engine.includes('insetsForPlacement')).toBe(false)
    // 引擎只交出声明本身（类型导入），不参与合成与求值
    expect(engine.includes('mergeDialogueLayout')).toBe(false)
  })

  it('布局规则不依赖 Zod —— 它要能进运行时包', () => {
    const rules = read('src/schema/layout.rules.ts')
    expect(rules.includes("from 'zod'"), 'layout.rules.ts 引入了 Zod，会把校验库拖进首屏').toBe(
      false,
    )
  })
})
