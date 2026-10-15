import { describe, expect, it } from 'vitest'
import {
  FALLBACK_COLOR,
  isHexColor,
  parseHex,
  safeColor,
  shade,
  toHex,
} from '../src/render/color.ts'
import { solveHomography, unproject, type Homography } from '../src/render/homography.ts'
import { partRigRenderer, computePartRect } from '../src/actorRenderers/partRig.ts'
import { ActorSpecSchema } from '../src/schema/scene.ts'
import type { AssetStore } from '../src/engine/assets.ts'
import { createActor } from '../src/engine/actor/actor.ts'
import type { PartDef } from '../src/schema/rig.rules.ts'

/**
 * 颜色：**绝不产出 canvas 认不得的东西**。
 *
 * 这条线以前是断的：`parseHex('tomato')` 走 `parseInt('to', 16)` 得到 NaN，
 * 于是 `shade()` 产出 `'#NaNNaNNaN'`。而 canvas 对非法颜色是**静默忽略**的
 * —— 那次赋值失败，这段图形沿用**上一个** `strokeStyle`（实测远侧手臂变成
 * 鞋子的颜色）。看起来只是"颜色有点怪"，根本联想不到是 tint 写错了。
 */
describe('颜色解析不会产出 NaN', () => {
  it('合法写法都认', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 })
    expect(parseHex('aabbcc')).toEqual({ r: 170, g: 187, b: 204 })
    expect(parseHex('#AABBCC')).toEqual({ r: 170, g: 187, b: 204 })
  })

  it('带 alpha 的 8 位色值取前 6 位', () => {
    expect(parseHex('#aabbccdd')).toEqual({ r: 170, g: 187, b: 204 })
  })

  it('非法写法返回 null，而不是一串 NaN', () => {
    for (const bad of ['tomato', 'rgb(1,2,3)', '#12345', '', '#gggggg', 'red']) {
      expect(parseHex(bad), `${bad} 应该解析失败`).toBeNull()
    }
  })

  it('shade 对非法输入落到中灰 —— 必须是 canvas 认得的颜色', () => {
    const result = shade('tomato', 0.76)
    expect(result).not.toContain('NaN')
    expect(isHexColor(result), `shade 产出了非法颜色 ${result}`).toBe(true)
    expect(result).toBe(FALLBACK_COLOR)
  })

  it('shade 对合法输入照旧变暗', () => {
    expect(shade('#ffffff', 0.5)).toBe('#808080')
    // 三个通道都超上限，一起夹到 255
    expect(shade('#808080', 2)).toBe('#ffffff')
    // 只变暗一个通道的情况
    expect(shade('#800000', 0.5)).toBe('#400000')
    expect(isHexColor(shade('#336699', 0.76))).toBe(true)
  })

  it('safeColor 把任意输入收敛成合法 hex', () => {
    expect(safeColor('#abc')).toBe('#abc')
    expect(safeColor('tomato')).toBe(FALLBACK_COLOR)
    expect(safeColor(undefined)).toBe(FALLBACK_COLOR)
    expect(safeColor(42)).toBe(FALLBACK_COLOR)
  })

  it('toHex 夹紧越界通道', () => {
    expect(toHex({ r: -20, g: 300, b: 128 })).toBe('#00ff80')
  })
})

describe('partRig 图集运行时降级', () => {
  const spec = ActorSpecSchema.parse({ id: 'hero', spawn: [0.5, 0.5], parts: 'rig.json' })
  const assets = (json: unknown): AssetStore => ({
    json: async () => json,
    image: async () => ({ width: 32, height: 64 }),
  }) as unknown as AssetStore

  it('无效 JSON、null parts 与 null 条目不抛错并回落程序化绘制', async () => {
    for (const raw of [null, [], { parts: null }, { parts: { head: null } }]) {
      const prepared = await partRigRenderer.prepare!(spec, assets(raw))
      if (raw === null || Array.isArray(raw) || (raw as { parts?: unknown }).parts === null) {
        expect(prepared).toBeUndefined()
      } else {
        expect(prepared).toBeDefined()
        expect((prepared as { parts: Record<string, unknown> }).parts.head).toBeUndefined()
      }
    }
  })

  it('短 pivot / offset 和非法 height 被补安全默认值', async () => {
    const prepared = await partRigRenderer.prepare!(spec, assets({
      parts: {
        head: { image: 'head.png', pivot: [0.25], offset: [4], height: Number.NaN },
      },
    })) as { parts: Record<string, PartDef> }
    expect(prepared.parts.head.pivot).toEqual([0.5, 1])
    expect(prepared.parts.head.offset).toEqual([0, 0])
    expect(prepared.parts.head.height).toBe(0.2)

    const rect = computePartRect({ image: 'x', pivot: [0.4] as unknown as [number, number], offset: [0, 0], height: 0.2 }, 1, 20)
    expect(rect.x).toBeCloseTo(-10)
    expect(rect.y).toBeCloseTo(-20)
  })

  it('绘制收到运行时 null 表结构仍安全回落', () => {
    const ctx = {
      beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, ellipse() {}, save() {}, restore() {},
      translate() {}, scale() {}, rotate() {}, stroke() {}, fill() {}, drawImage() {},
      set lineWidth(_value: number) {}, set strokeStyle(_value: string) {}, set fillStyle(_value: string) {},
      set lineCap(_value: string) {}, set lineJoin(_value: string) {},
    } as unknown as CanvasRenderingContext2D
    const actor = createActor(spec)
    expect(() => partRigRenderer.draw({
      ctx, actor, transform: { px: 20, py: 40, hpx: 30, sx: 1 },
      palette: { skin: '#aaa', hair: '#222', torso: '#333', legs: '#444', shoes: '#555', shadow: '#000' },
      dimmed: false,
    }, { parts: null, images: null })).not.toThrow()
  })
})

/**
 * 消失线：解不出来就要**如实说解不出来**。
 *
 * `unproject` 以前直接转手给 `project`，而 `project` 在 `|w| < EPS` 时回退
 * `[0, 0]` —— 消失线上的点于是被解成"地面左上角"，调用方那句
 * `if (!plane) return` 成了死代码：玩家点一下就会被指使走到画面后左角。
 * 稍微偏离消失线则得到 `v = -1.5e8` 这种失控坐标，同样没有任何提示。
 *
 * 注意：demo 内容的地面透视很弱（消失线落在画面外），所以这条点击在
 * 现内容上碰不到 —— 但**文档和守卫都已经失效了**，换个地面四边形就会踩中。
 */
describe('消失线附近必须返回 null', () => {
  /** 强透视：消失线落在画面内（y ≈ 0.38）。 */
  const strong: Homography = solveHomography([
    [0.4, 0.5],
    [0.6, 0.5],
    [1, 0.98],
    [0, 0.98],
  ])!

  it('正好落在消失线上 → null，而不是 [0,0]', () => {
    const result = unproject(strong, 0.5, 0.38)
    expect(result, '消失线上解出了坐标 —— 调用方会以为点到了地面左上角').toBeNull()
  })

  it('贴得极近导致坐标发散时也要 null', () => {
    const result = unproject(strong, 0.5, 0.380000001)
    expect(result, `发散的坐标被当成有效值返回了：${JSON.stringify(result)}`).toBeNull()
  })

  it('远离消失线的正常点照旧解得出来', () => {
    const result = unproject(strong, 0.5, 0.9)
    expect(result).not.toBeNull()
    expect(result![0]).toBeGreaterThan(0)
    expect(result![0]).toBeLessThan(1)
  })

  it('退化的单应矩阵直接 null', () => {
    expect(unproject({ m: [0, 0, 0, 0, 0, 0, 0, 0, 0] }, 0.5, 0.5)).toBeNull()
  })
})
