import { describe, expect, it } from 'vitest'
import { SpriteAtlasSchema } from '../src/schema/rig.ts'
import type { SpriteAtlasFile } from '../src/schema/rig.rules.ts'
import type { AssetStore } from '../src/engine/assets.ts'
import type { ActorSpec } from '../src/schema/scene.ts'
import { glideRenderer } from '../src/actorRenderers/glide.ts'
import { partRigRenderer } from '../src/actorRenderers/partRig.ts'
import { spriteSheetRenderer } from '../src/actorRenderers/spriteSheet.ts'
import { listActorRenderers, prepareActorRenderer } from '../src/actorRenderers/registry.ts'

/**
 * "渲染器漏写 `prepare`"的回归守卫。
 *
 * `prepareActorRenderer` 对没有 `prepare` 的渲染器一律返回 `undefined`，
 * 而三个渲染器的 `draw` 都在拿不到 `resources` 时**静默回落 `partRig`**。
 * 于是 `glide` 和 `spriteSheet` 两个渲染器声明了等于没声明 —— 作者在场景
 * JSON 里换来换去，画出来一模一样，没有任何提示。
 *
 * 这类问题只能靠"每个注册的渲染器都必须有 `prepare`"来守住：
 * 程序化渲染器确实不需要素材，但它得**显式**说明这一点，而不是忘掉。
 */
describe('每个注册的渲染器都要有 prepare', () => {
  it('注册表里的渲染器一个都不能漏', () => {
    for (const id of listActorRenderers()) {
      const renderer = [partRigRenderer, glideRenderer, spriteSheetRenderer].find((r) => r.id === id)
      expect(renderer, `${id} 注册了但找不到实现`).toBeDefined()
      expect(
        typeof renderer!.prepare,
        `渲染器 "${id}" 没有 prepare —— 它的 draw 会在拿不到素材时静默回落 partRig，` +
          `也就是声明了这个渲染器等于没声明。程序化渲染器请显式返回 undefined`,
      ).toBe('function')
    }
  })

  it('三个渲染器都在注册表里', () => {
    expect(listActorRenderers()).toEqual(['glide', 'partRig', 'spriteSheet'])
  })
})

/** 只实现 prepare 用到的那两个方法就够了。 */
function fakeAssets(files: Record<string, unknown>): AssetStore {
  return {
    json: async (path: string) => files[path],
    image: async (path: string) => ({ width: 64, height: 64, __path: path }),
  } as unknown as AssetStore
}

const spec = (parts: string | null): ActorSpec => ({ parts }) as unknown as ActorSpec

describe('glide：单张立绘', () => {
  it('会把 parts 当作图片路径加载', async () => {
    const resources = (await glideRenderer.prepare!(spec('art/hero.png'), fakeAssets({}))) as {
      image: { __path?: string } | null
    }
    expect(resources.image?.__path).toBe('art/hero.png')
  })

  it('没配素材时返回 undefined，让 draw 走回落', async () => {
    expect(await glideRenderer.prepare!(spec(null), fakeAssets({}))).toBeUndefined()
  })
})

describe('spriteSheet：精灵图集', () => {
  const valid: SpriteAtlasFile = {
    image: 'art/sheet.png',
    columns: 4,
    frameWidth: 32,
    frameHeight: 48,
    anchorX: 0.5,
    anchorY: 1,
    clips: { 'walk:E': [0, 1, 2, 3], 'idle:E': [4] },
  }

  it('加载图集与它引用的那张图', async () => {
    const resources = (await spriteSheetRenderer.prepare!(
      spec('art/sheet.json'),
      fakeAssets({ 'art/sheet.json': valid }),
    )) as { image: { __path?: string } | null; atlas: SpriteAtlasFile }
    expect(resources.image?.__path).toBe('art/sheet.png')
    expect(resources.atlas.columns).toBe(4)
    expect(resources.atlas.clips['walk:E']).toEqual([0, 1, 2, 3])
  })

  it('anchorY 为 0 或负数时夹到下限 —— 它同时是缩放系数，0 会算出天文尺寸', async () => {
    for (const bad of [0, -1]) {
      const resources = (await spriteSheetRenderer.prepare!(
        spec('a.json'),
        fakeAssets({ 'a.json': { ...valid, anchorY: bad } }),
      )) as { atlas: SpriteAtlasFile }
      expect(resources.atlas.anchorY).toBeGreaterThan(0)
      expect(resources.atlas.anchorY).toBeLessThanOrEqual(1)
    }
  })

  it('半截图集一律当作素材不可用，而不是把脏数据送进渲染循环', async () => {
    const broken: unknown[] = [
      null,
      {},
      { ...valid, image: '' },
      { ...valid, columns: 0 },
      { ...valid, frameHeight: -3 },
      { ...valid, clips: {} },
      { ...valid, clips: { 'walk:E': [] } },
    ]
    for (const bad of broken) {
      const got = await spriteSheetRenderer.prepare!(spec('a.json'), fakeAssets({ 'a.json': bad }))
      expect(got, `${JSON.stringify(bad)} 应该判为不可用`).toBeUndefined()
    }
  })
})

describe('构建期 schema 与运行时契约一致', () => {
  it('anchorY: 0 必须被 schema 拒绝', () => {
    const base = {
      image: 'a.png',
      columns: 4,
      frameWidth: 32,
      frameHeight: 48,
      clips: { 'walk:E': [0] },
    }
    expect(SpriteAtlasSchema.safeParse({ ...base, anchorY: 0 }).success, 'anchorY=0 能过校验，运行时会把精灵放大 1e6 倍').toBe(false)
    expect(SpriteAtlasSchema.safeParse({ ...base, anchorY: 0.9 }).success).toBe(true)
  })

  it('两个 SpriteAtlasFile 的字段集合相同', () => {
    const parsed = SpriteAtlasSchema.parse({
      image: 'a.png',
      columns: 4,
      frameWidth: 32,
      frameHeight: 48,
      clips: { 'walk:E': [0] },
    })
    const runtimeKeys: (keyof SpriteAtlasFile)[] = [
      'image',
      'columns',
      'frameWidth',
      'frameHeight',
      'anchorX',
      'anchorY',
      'clips',
    ]
    // 构建期解析出来的键必须都在运行时契约里，反之亦然 —— 少一个就意味着
    // "开发期校验通过、运行时读不到"，多一个意味着"运行时永远拿到 undefined"
    expect(Object.keys(parsed).sort()).toEqual([...runtimeKeys].sort())
  })
})

describe('prepareActorRenderer 会真的调用渲染器的 prepare', () => {
  it('装了素材的渲染器拿到的是真素材，不是 undefined', async () => {
    const resources = await prepareActorRenderer(
      { renderer: 'glide', parts: 'art/hero.png' } as unknown as ActorSpec,
      fakeAssets({}),
    )
    expect(resources, 'prepareActorRenderer 返回了 undefined —— 渲染器会被静默回落').toBeDefined()
  })
})
