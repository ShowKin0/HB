import { describe, expect, it } from 'vitest'
import type { Actor } from '../src/engine/actor/actor.ts'
import { createPose } from '../src/engine/anim/pose.ts'
import { computePartRect, partRigRenderer, RIG } from '../src/actorRenderers/partRig.ts'
import type { PartRigResources } from '../src/actorRenderers/partRig.ts'
import { DEFAULT_PALETTE, type ActorTransform } from '../src/actorRenderers/types.ts'
import type { PartDef } from '../src/schema/rig.ts'

/**
 * 部件骨架渲染器。
 *
 * 这条路径平时没有真实素材可跑（默认是程序化绘制），所以用记录式假画布
 * 把两件事钉死：
 *   1. 部件图的落点算得对不对（computePartRect）
 *   2. 有图就用图、缺图就回落胶囊体 —— 可以逐个部件替换
 */

interface DrawImageCall {
  image: unknown
  x: number
  y: number
  w: number
  h: number
}

class RecordingContext {
  drawImageCalls: DrawImageCall[] = []
  strokeCount = 0
  fillCount = 0
  lineWidth = 1
  strokeStyle = ''
  fillStyle = ''
  lineCap = ''
  lineJoin = ''
  globalAlpha = 1

  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  arc(): void {}
  ellipse(): void {}
  save(): void {}
  restore(): void {}
  translate(): void {}
  scale(): void {}
  rotate(): void {}
  stroke(): void {
    this.strokeCount += 1
  }
  fill(): void {
    this.fillCount += 1
  }
  drawImage(image: unknown, x: number, y: number, w: number, h: number): void {
    this.drawImageCalls.push({ image, x, y, w, h })
  }
}

function makeEnv(ctx: RecordingContext, transform?: Partial<ActorTransform>): Parameters<typeof partRigRenderer.draw>[0] {
  const actor = {
    spec: { id: 'hero', renderer: 'partRig', spawn: [0.5, 0.8], heightRatio: 0.2, speed: 0.4, facing: 1, scale: 1 },
    pose: createPose(),
    facing: 1,
    time: 0,
  } as unknown as Actor

  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    actor,
    transform: { px: 100, py: 300, hpx: 200, sx: 1, ...transform },
    palette: DEFAULT_PALETTE,
    dimmed: false,
  }
}

const fakeImage = { naturalWidth: 60, naturalHeight: 120 } as unknown as CanvasImageSource

describe('computePartRect', () => {
  const def = (pivot: [number, number], height: number): PartDef => ({
    image: 'rig/x.png',
    pivot,
    offset: [0, 0],
    height,
  })

  it('pivot 底边中点 → 图贴在关节上方并水平居中', () => {
    // 第三个参数就是像素高度（调用方用 def.height × 身高像素算出来）
    const rect = computePartRect(def([0.5, 1], 0.3), 1, 60)
    expect(rect.width).toBeCloseTo(60, 6)
    expect(rect.height).toBeCloseTo(60, 6)
    expect(rect.x).toBeCloseTo(-30, 6)
    expect(rect.y).toBeCloseTo(-60, 6)
  })

  it('pivot 正中 → 图以关节为中心', () => {
    const rect = computePartRect(def([0.5, 0.5], 0.2), 1, 100)
    expect(rect.x).toBeCloseTo(-50, 6)
    expect(rect.y).toBeCloseTo(-50, 6)
  })

  it('宽度按图片宽高比推出来', () => {
    const rect = computePartRect(def([0.5, 1], 0.5), 0.5, 100)
    expect(rect.height).toBeCloseTo(100, 6)
    expect(rect.width).toBeCloseTo(50, 6)
  })

  it('pivot 为 0 时图从关节向右下展开', () => {
    const rect = computePartRect(def([0, 0], 0.5), 1, 100)
    expect(rect.x).toBeCloseTo(0, 6)
    expect(rect.y).toBeCloseTo(0, 6)
  })
})

describe('partRigRenderer.draw', () => {
  it('没有部件图时走纯程序化路径，一次 drawImage 都不调', () => {
    const ctx = new RecordingContext()
    partRigRenderer.draw(makeEnv(ctx))
    expect(ctx.drawImageCalls).toHaveLength(0)
    // 胶囊体是靠 stroke 画的，腿/臂/躯干加起来必然有多条
    expect(ctx.strokeCount).toBeGreaterThan(5)
    expect(ctx.fillCount).toBeGreaterThan(0)
  })

  it('只提供 head 图时，头部用图、其余仍是程序化', () => {
    const ctx = new RecordingContext()
    const resources: PartRigResources = {
      parts: { head: { image: 'rig/head.png', pivot: [0.5, 0.5], offset: [0, 0], height: 0.25 } },
      images: { head: fakeImage },
    }
    partRigRenderer.draw(makeEnv(ctx), resources)

    expect(ctx.drawImageCalls).toHaveLength(1)
    const call = ctx.drawImageCalls[0]
    expect(call.image).toBe(fakeImage)
    // hpx 200 × height 0.25 = 50；图宽高比 60/120 = 0.5 → 宽 25
    expect(call.h).toBeCloseTo(50, 6)
    expect(call.w).toBeCloseTo(25, 6)
    // 其余部件仍然靠 stroke 画出来
    expect(ctx.strokeCount).toBeGreaterThan(5)
  })

  it('图集里有条目但图片加载失败时，该部件回落程序化', () => {
    const ctx = new RecordingContext()
    const resources: PartRigResources = {
      parts: { head: { image: 'rig/missing.png', pivot: [0.5, 0.5], offset: [0, 0], height: 0.25 } },
      images: { head: null },
    }
    partRigRenderer.draw(makeEnv(ctx), resources)
    expect(ctx.drawImageCalls).toHaveLength(0)
  })

  it('全部件都给图时不再画任何胶囊体', () => {
    const ctx = new RecordingContext()
    const names = [
      'shadow',
      'leg_upper_l',
      'leg_lower_l',
      'leg_upper_r',
      'leg_lower_r',
      'torso',
      'arm_upper_l',
      'arm_lower_l',
      'arm_upper_r',
      'arm_lower_r',
      'head',
    ]
    const parts: Record<string, PartDef> = {}
    const images: Record<string, CanvasImageSource | null> = {}
    for (const name of names) {
      parts[name] = { image: `rig/${name}.png`, pivot: [0.5, 0.5], offset: [0, 0], height: 0.2 }
      images[name] = fakeImage
    }
    partRigRenderer.draw(makeEnv(ctx), { parts, images })

    // 除了脖子那一段，其余肢体都应走图片
    expect(ctx.drawImageCalls.length).toBe(names.length)
    // 影子也不再是 ellipse，只剩脖子 + 两只脚是程序化
    expect(ctx.strokeCount).toBeLessThanOrEqual(4)
  })

  it('朝向为负时 drawImage 之前会做水平镜像', () => {
    const ctx = new RecordingContext()
    const scaled: number[] = []
    ctx.scale = ((x: number) => {
      scaled.push(x)
    }) as never

    const resources: PartRigResources = {
      parts: { torso: { image: 'rig/torso.png', pivot: [0.5, 1], offset: [0, 0], height: 0.3 } },
      images: { torso: fakeImage },
    }
    partRigRenderer.draw(makeEnv(ctx, { sx: -1 }), resources)

    expect(scaled).toContain(-1)
    expect(ctx.drawImageCalls).toHaveLength(1)
  })

  it('躯干关节落在髋部高度上', () => {
    const ctx = new RecordingContext()
    partRigRenderer.draw(makeEnv(ctx))
    // 程序化路径下髋部由 bobY/swayX 决定，静止时 swayX 为 0
    expect(RIG.hipY + RIG.thigh + RIG.shin).toBeCloseTo(0, 9)
  })
})
