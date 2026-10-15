import { describe, expect, it } from 'vitest'
import { SceneRuntime } from '../src/engine/scene/runtime.ts'
import { normalizeScene } from '../src/schema/scene.rules.ts'

/**
 * 预取清单要**收全**。
 *
 * `SceneRuntime.assetPaths` 一直存在、也一直是"预取邻场景"该有的口径，
 * 但**零调用**；真正在跑的 `prefetchNeighbourAssets` 自己挑了三样
 * （背景图、热点主图、图层主图），于是"预取"只兑现了一小半：
 * 图层/物件的视觉状态图、互动音效、角色部件图集全都没预取到 ——
 * 玩家切场景时才会现拉，卡一下。
 */
const scene = normalizeScene({
  id: 's',
  bg: 'bg/room.avif',
  bgm: 'audio/bgm/room.ogg',
  layers: [
    {
      id: 'fore',
      image: 'fg/table.avif',
      visualStates: { open: 'fg/table_open.avif' },
    },
  ],
  hotspots: [
    {
      id: 'h',
      shape: { type: 'rect', x: 0.2, y: 0.2, w: 0.2, h: 0.2 },
      image: 'obj/lamp.avif',
      visualStates: { on: 'obj/lamp_on.avif' },
      interactions: [
        {
          id: 'i',
          verb: 'inspect',
          effects: [
            { type: 'story.event', name: 'lamp_lit' },
            // 音效用**新写法**：写在 effects 里。一旦这么写，摘要字段
            // `interaction.sfx` 就会被解析覆盖成 null —— 只读旧字段的收集器
            // 于是永远收不到它。
            { type: 'audio.sfx', path: 'audio/sfx/click.ogg' },
          ],
        },
      ],
    },
  ],
  actors: [{ id: 'hero', renderer: 'partRig', parts: 'rig/hero.json', spawn: [0.5, 0.6] }],
})

const paths = SceneRuntime.assetPaths(scene)

describe('场景素材清单', () => {
  const expect_ = (path: string): void => {
    expect(paths, `少收了 ${path} —— 它不会被预取到`).toContain(path)
  }

  it('收背景与背景音乐', () => {
    expect_('bg/room.avif')
    expect_('audio/bgm/room.ogg')
  })

  it('收图层主图与图层视觉状态图', () => {
    expect_('fg/table.avif')
    expect_('fg/table_open.avif')
  })

  it('收热点主图、视觉状态图与互动音效', () => {
    expect_('obj/lamp.avif')
    expect_('obj/lamp_on.avif')
    expect_('audio/sfx/click.ogg')
  })

  it('收角色部件图集', () => {
    expect_('rig/hero.json')
  })

  it('没有重复项', () => {
    expect(new Set(paths).size).toBe(paths.length)
  })
})

/**
 * 预取时**必须按扩展名分流**。
 *
 * `AssetStore.preload` 一律走 `image()`，把音频路径丢进去会被当成图片
 * 加载失败、记进 `missingAssets` —— 调试面板里会平白多出一堆"缺失素材"，
 * 作者得去追一个根本不存在的 bug。
 */
describe('预取清单的分流规则', () => {
  const IMAGE_EXT = /\.(png|jpe?g|webp|avif|gif|svg)$/i
  const JSON_EXT = /\.json$/i

  it('音效与背景音乐不会被当成图片预取', () => {
    const audio = paths.filter((p) => /\.(ogg|mp3|m4a|wav)$/i.test(p))
    expect(audio.length, '用例本身要有音频路径才有意义').toBeGreaterThan(0)
    for (const path of audio) {
      expect(IMAGE_EXT.test(path), `${path} 会被当成图片加载，然后进 missingAssets`).toBe(false)
    }
  })

  it('部件图集走 JSON 那条路，不走图片', () => {
    const atlas = paths.filter((p) => JSON_EXT.test(p))
    expect(atlas).toContain('rig/hero.json')
    for (const path of atlas) expect(IMAGE_EXT.test(path)).toBe(false)
  })
})
