/**
 * 内容契约校验。
 *
 * 这是你写剧情与场景时最依赖的工具 —— 剧情一多，人肉记不住哪个 knot 名打错、
 * 哪张图忘了放。所有检查都是静态的，不需要起服务。
 *
 *   npm run content:check            schema 错误与悬空 ink 引用会失败，缺素材仅告警
 *   npm run content:check -- --strict 缺素材也失败（内容做完后的验收模式）
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { collectAssetRefs, loadScenes, scanAssets } from './lib/content.ts'
import { buildInk, listInkSources } from './lib/ink.ts'
import { Reporter } from './lib/report.ts'
import { CONTENT_DIR, ASSETS_DIR } from './lib/project.ts'
import { solveHomography } from '../src/render/homography.ts'
import { isPlaneWalkable, parseMask } from '../src/engine/nav/mask.ts'
import { PART_NAMES, PartAtlasSchema } from '../src/schema/rig.ts'
import { resolveSceneMode, UNIMPLEMENTED_VERBS } from '../src/schema/scene.ts'

const STRICT = process.argv.includes('--strict')

const reporter = new Reporter()

const scenes = await loadScenes()
const inkFiles = await listInkSources()

// ── 1. ink 编译 ────────────────────────────────────────────────────────────
const knots = new Set<string>()
const functions = new Set<string>()
/** 剧本里 # award: 发过的物品 id。 */
const awardedItems = new Set<string>()

if (inkFiles.length === 0) {
  reporter.info('content/story 下没有 .ink 文件，跳过剧本检查')
}

for (const file of inkFiles) {
  const display = `content/story/${file.split(/[\\/]/).pop()}`
  const result = await buildInk(file)
  for (const err of result.errors) reporter.error(err, { file: display })
  for (const warn of result.warnings) reporter.warn(warn, { file: display })
  for (const name of result.symbols.knots) knots.add(name)
  for (const name of result.symbols.functions) functions.add(name)
  for (const match of result.source.matchAll(/#\s*award:\s*([A-Za-z0-9_-]+)/g)) {
    awardedItems.add(match[1])
  }
}

// ── 2. 场景 schema ─────────────────────────────────────────────────────────
const sceneIds = new Set<string>()
for (const loaded of scenes) {
  for (const err of loaded.errors) reporter.error(err, { file: loaded.file })
  if (!loaded.scene) continue
  if (sceneIds.has(loaded.scene.id)) {
    reporter.error(`场景 id "${loaded.scene.id}" 重复`, { file: loaded.file })
  }
  sceneIds.add(loaded.scene.id)
}

// ── 3. 场景 → ink 引用 ─────────────────────────────────────────────────────
/** 条件必须是 ink 函数，跳转必须是 ink knot。inkjs 的 EvaluateFunction 只认函数。 */
function checkInkRef(name: string, kind: 'knot' | 'function', where: string, file: string): void {
  if (knots.size === 0) return // 还没有剧本时不误报
  if (!knots.has(name)) {
    reporter.error(`${where} 引用了不存在的 ink 名字 "${name}"`, { file })
    return
  }
  if (kind === 'function' && !functions.has(name)) {
    reporter.error(
      `${where} 需要 ink 函数 "${name}"，但它是 knot。写成 "=== function ${name}() ===" 才能在条件中使用`,
      { file },
    )
  }
  if (kind === 'knot' && functions.has(name)) {
    reporter.error(
      `${where} 想跳转到 "${name}"，但它是 function。ChoosePathString 跳不进去，` +
        `改成 "=== ${name} ===" 的 knot`,
      { file },
    )
  }
}

for (const loaded of scenes) {
  const scene = loaded.scene
  if (!scene) continue
  const file = loaded.file

  if (scene.entry) checkInkRef(scene.entry, 'knot', 'entry', file)
  // hub 漏检过：写错名字不会报任何错，只是交互结束后再也不回锚点，
  // 剧情停在一个很怪的位置上，很难查。
  if (scene.hub) checkInkRef(scene.hub, 'knot', 'hub', file)

  for (const hotspot of scene.hotspots) {
    if (hotspot.visibleWhen) {
      checkInkRef(hotspot.visibleWhen, 'function', `hotspot ${hotspot.id}.visibleWhen`, file)
    }

    // ── 新形态：多交互 ──────────────────────────────────
    for (const [index, interaction] of hotspot.interactions.entries()) {
      const where = `hotspot ${hotspot.id}.interactions[${index}](${interaction.verb})`
      checkInkRef(interaction.action, 'knot', where, file)
      if (interaction.when) checkInkRef(interaction.when, 'function', `${where}.when`, file)

      if (UNIMPLEMENTED_VERBS.includes(interaction.verb)) {
        reporter.error(
          `${where} 的动词 "${interaction.verb}" 引擎尚未实现。数据模型已预留，但现在写了不会生效`,
          { file },
        )
      }
      if (interaction.verb === 'use' && !interaction.item) {
        reporter.error(`${where} 是 use 但没有指定 item，永远不会被触发`, { file })
      }
      if (interaction.verb === 'drag' && interaction.accepts.length === 0) {
        reporter.error(`${where} 是 drag 但没有 accepts，永远不会被触发`, { file })
      }
      if (interaction.verb !== 'use' && interaction.item) {
        reporter.warn(`${where} 指定了 item，但只有 use 动词会用到它`, { file })
      }
      if (interaction.verb !== 'drag' && interaction.accepts.length > 0) {
        reporter.warn(`${where} 指定了 accepts，但只有 drag 动词会用到它`, { file })
      }
      if (interaction.setState) {
        const declared = Object.keys(hotspot.visualStates)
        // visualStates 为空时，状态只是**逻辑状态**（外观由背景图承担），这是合法用法。
        // 只有在物件确实配了状态图、而 setState 指向一个不存在的键时才说明是打错了。
        if (declared.length > 0 && !(interaction.setState in hotspot.visualStates)) {
          reporter.error(
            `${where} 的 setState "${interaction.setState}" 不在该物件的 visualStates 里` +
              `（现有：${declared.join(', ')}），切过去会没有图`,
            { file },
          )
        }
      }
    }

    // ── 旧字段：能用，但建议迁移 ────────────────────────
    const legacy: string[] = []
    if (hotspot.onClick) legacy.push('onClick')
    if (hotspot.onUse) legacy.push('onUse')
    if (hotspot.acceptsItem) legacy.push('acceptsItem')
    if (legacy.length > 0) {
      if (hotspot.interactions.length > 0) {
        reporter.error(
          `hotspot ${hotspot.id} 同时写了 interactions 和旧字段 ${legacy.join('/')}。` +
            `两者都在时旧字段会被完全忽略，请删掉它们`,
          { file },
        )
      } else {
        reporter.info(
          `hotspot ${hotspot.id} 用的是旧字段 ${legacy.join('/')}，仍可运行。` +
            `需要多状态 / 多动词时再改成 interactions`,
        )
      }
    }

    // ── 外观与状态一致性 ────────────────────────────────
    const stateNames = Object.keys(hotspot.visualStates)
    if (hotspot.initialState && stateNames.length > 0 && !(hotspot.initialState in hotspot.visualStates)) {
      reporter.warn(
        `hotspot ${hotspot.id} 的 initialState "${hotspot.initialState}" 不在 visualStates 里，会回落基础图`,
        { file },
      )
    }
    if (stateNames.length > 0 && !hotspot.image) {
      reporter.warn(
        `hotspot ${hotspot.id} 只有 visualStates 没有基础图：状态名取不到时会什么都不画`,
        { file },
      )
    }
  }

  for (const layer of scene.layers) {
    if (layer.visibleWhen) {
      checkInkRef(layer.visibleWhen, 'function', `layer ${layer.id}.visibleWhen`, file)
    }
    if (layer.initialState && !(layer.initialState in layer.visualStates)) {
      reporter.warn(
        `layer ${layer.id} 的 initialState "${layer.initialState}" 不在 visualStates 里，会回落基础图`,
        { file },
      )
    }
  }

  for (const exit of scene.exits) {
    if (exit.when) checkInkRef(exit.when, 'function', `exit ${exit.id}.when`, file)
    const isScene = scenes.some((s) => s.scene?.id === exit.to)
    const isKnot = knots.has(exit.to)
    if (!isScene && !isKnot) {
      reporter.error(`exit ${exit.id} 的目标 "${exit.to}" 既不是场景 id 也不是 ink knot`, { file })
    }
  }

  // focus 模式不做寻路，走位点写了也不会生效 —— 属于"看着配了其实没用"的字段
  if (resolveSceneMode(scene) === 'focus') {
    for (const hotspot of scene.hotspots) {
      if (hotspot.approach) {
        reporter.warn(
          `hotspot ${hotspot.id} 定义了 approach，但 focus 模式没有寻路，这个字段不会生效`,
          { file },
        )
      }
    }
  }
}

// ── 4. 物品标签 ────────────────────────────────────────────────────────────
// 没有标签的物品在物品栏里会直接显示成 item_key 这样的原始 id，
// 而且只有玩家拿到手才会发现。
let itemLabels: Record<string, string> = {}
try {
  const raw = (await readFile(path.join(CONTENT_DIR, 'items.json'), 'utf8')).replace(/^\uFEFF/, '')
  const parsed: unknown = JSON.parse(raw)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    itemLabels = parsed as Record<string, string>
  } else {
    reporter.error('content/items.json 的格式应为 { "item_id": "显示名" }')
  }
} catch {
  if (awardedItems.size > 0) reporter.warn('没有 content/items.json，物品栏会显示原始 id')
}

const usedItems = new Set<string>(awardedItems)
for (const loaded of scenes) {
  for (const hotspot of loaded.scene?.hotspots ?? []) {
    if (hotspot.acceptsItem) usedItems.add(hotspot.acceptsItem)
  }
}

for (const itemId of [...usedItems].sort()) {
  if (!itemLabels[itemId]) {
    reporter.warn(`物品 "${itemId}" 在 items.json 里没有显示名，物品栏会显示原始 id`)
  }
}

for (const itemId of Object.keys(itemLabels).sort()) {
  if (!usedItems.has(itemId)) {
    reporter.info(`items.json 里的 "${itemId}" 没有任何地方发放或使用`)
  }
}

// ── 5. 地面标定与走位点 ────────────────────────────────────────────────────
// 这几项在运行期只会"静默降级"（吸附到最近可走点、单应矩阵退回恒等），
// 表面上不报错，实际手感已经坏了 —— 所以必须在这里挑出来。
for (const loaded of scenes) {
  const scene = loaded.scene
  if (!scene) continue
  const file = loaded.file

  if (scene.ground && !solveHomography(scene.ground.corners)) {
    reporter.error(
      '地面四角退化（共线或重合），解不出单应矩阵，行走与透视缩放都会失效。在编辑器里把四个角拉开。',
      { file },
    )
  }

  if (!scene.walkable || scene.actors.length === 0) continue
  const mask = parseMask(scene.walkable)

  for (const actor of scene.actors) {
    if (!isPlaneWalkable(mask, actor.spawn[0], actor.spawn[1])) {
      reporter.warn(`角色 ${actor.id} 的出生点落在阻挡格里（引擎会吸附到最近可走点）`, { file })
    }
  }

  for (const hotspot of scene.hotspots) {
    if (!hotspot.approach) continue
    if (!isPlaneWalkable(mask, hotspot.approach[0], hotspot.approach[1])) {
      reporter.warn(`hotspot ${hotspot.id} 的走位点落在阻挡格里（角色会停在最近可走点）`, { file })
    }
  }
}

// ── 6. 素材引用与孤儿文件 ───────────────────────────────────────────────────
const assets = await scanAssets()
const referenced = new Set<string>()

for (const loaded of scenes) {
  if (!loaded.scene) continue
  for (const { ref, where } of collectAssetRefs(loaded.scene)) {
    referenced.add(ref)
    if (!assets.has(ref)) {
      const message = `${where} 引用的素材不存在：public/assets/${ref}`
      if (STRICT) reporter.error(message, { file: loaded.file })
      else reporter.warn(`${message}（引擎会走降级占位）`, { file: loaded.file })
    }
  }
}

if (assets.size > 0) {
  for (const file of [...assets].sort()) {
    if (!referenced.has(file) && !file.startsWith('placeholder/')) {
      reporter.info(`未被任何场景引用的素材：public/assets/${file}`)
    }
  }
}

// ── 6.5 部件图集 ───────────────────────────────────────────────────────────
// 手写图集时把部件名打错，渲染器只会静默回落程序化绘制 —— 看起来"生效了"
// 但那个部件根本没换。必须在构建期挑出来。
const knownParts = new Set<string>(PART_NAMES)
for (const file of [...assets].sort()) {
  if (!file.endsWith('.json')) continue
  if (!referenced.has(file)) continue

  let raw: unknown
  try {
    const text = (await readFile(path.join(ASSETS_DIR, file), 'utf8')).replace(/^\uFEFF/, '')
    raw = JSON.parse(text)
  } catch (err) {
    reporter.error(`图集 JSON 解析失败：${(err as Error).message}`, { file: `public/assets/${file}` })
    continue
  }

  const parsed = PartAtlasSchema.safeParse(raw)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      reporter.error(`部件图集格式错误：${issue.path.join('.') || '<根>'} — ${issue.message}`, {
        file: `public/assets/${file}`,
      })
    }
    continue
  }

  for (const [name, def] of Object.entries(parsed.data.parts)) {
    if (!knownParts.has(name)) {
      reporter.error(`部件名 "${name}" 不被识别，该部件会回落程序化绘制`, {
        file: `public/assets/${file}`,
      })
    }
    if (!assets.has(def.image)) {
      reporter.warn(`部件 "${name}" 的图不存在：public/assets/${def.image}`, {
        file: `public/assets/${file}`,
      })
    }
  }

  for (const name of PART_NAMES) {
    if (!(name in parsed.data.parts)) {
      reporter.info(`图集里没有 "${name}"，该部件将使用程序化绘制`)
    }
  }
}

// ── 7. 汇总 ───────────────────────────────────────────────────────────────
reporter.info(
  `已检查 ${scenes.length} 个场景、${inkFiles.length} 个 ink 文件、${knots.size} 个 ink 名字、${assets.size} 个素材`,
)
const errors = reporter.flush('内容契约检查')

if (scenes.length === 0 && inkFiles.length === 0) {
  process.stdout.write('  content/ 下还没有内容，检查跳过。\n')
}

process.exit(errors > 0 ? 1 : 0)
