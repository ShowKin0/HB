/**
 * 内容契约校验。
 *
 * 这是你写剧情与场景时最依赖的工具 —— 剧情一多，人肉记不住哪个 knot 名打错、
 * 哪张图忘了放。所有检查都是静态的，不需要起服务。
 *
 *   npm run content:check            schema 错误与悬空 ink 引用会失败，缺素材仅告警
 *   npm run content:check -- --strict 缺素材也失败（内容做完后的验收模式）
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { collectAssetRefs, expandAssetDependencies, loadScenes, scanAssets, sceneUsesStory } from './lib/content.ts'
import { buildInkSources, listInkSources } from './lib/ink.ts'
import { Reporter } from './lib/report.ts'
import { CONTENT_DIR, ASSETS_DIR, ROOT } from './lib/project.ts'
import { themeCssPath } from '../src/theme/themes.rules.ts'
import { findSafeAreaViolations, SAFE_AREA } from '../src/schema/safeArea.ts'
import { solveHomography } from '../src/render/homography.ts'
import { isPlaneWalkable, parseMask } from '../src/engine/nav/mask.ts'
import { PART_NAMES, PartAtlasSchema, SpriteAtlasSchema } from '../src/schema/rig.ts'
import { resolveInteractions, resolveSceneMode, UNIMPLEMENTED_VERBS } from '../src/schema/scene.ts'
import { ProjectSchema, defaultProject, expandCapabilities } from '../src/content/project.ts'

const STRICT = process.argv.includes('--strict')

const reporter = new Reporter()

const scenes = await loadScenes()
const inkFiles = await listInkSources()

// ── 1. ink 编译 ────────────────────────────────────────────────────────────
const inkBuild = await buildInkSources(inkFiles)
const entryInk = inkBuild.entryResult
const knots = new Set<string>()
const functions = new Set<string>()
/** 剧本里 # award: 发过的物品 id。 */
const awardedItems = new Set<string>()

// 独立 .ink 源都编译校验；被 INCLUDE 的片段通过其入口根文件报告一次。
for (const { file, result } of inkBuild.checkedSources) {
  const display = path.relative(ROOT, file).replace(/\\/g, '/')
  for (const err of result.errors) reporter.error(err, { file: display })
  for (const warn of result.warnings) reporter.warn(warn, { file: display })
  if (result.lineReport.status === 'truncated') {
    reporter.warn(
      `台词静态收集触及上限（${result.lineReport.stopReasons.join(', ')}）；` +
        '该报告不代表穷尽 Ink 的动态变量分支',
      { file: display },
    )
  }
}

if (inkFiles.length === 0) {
  reporter.info('content/story 下没有 .ink 文件，跳过剧本检查')
}

if (entryInk) {
  // 场景引用必须存在于运行时唯一会加载的入口 story（含其 INCLUDE），不接受未加载的独立剧本符号。
  for (const name of entryInk.symbols.knots) knots.add(name)
  for (const name of entryInk.symbols.functions) functions.add(name)
  for (const source of entryInk.sourceFiles) {
    for (const match of source.source.matchAll(/#\s*award:\s*([A-Za-z0-9_-]+)/g)) {
      awardedItems.add(match[1])
    }
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
  if (!entryInk || entryInk.errors.length > 0) return // 没有入口或入口编译失败时不重复报告
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
    for (const [index, interaction] of resolveInteractions(hotspot).entries()) {
      const where = `hotspot ${hotspot.id}.interactions[${index}](${interaction.verb})`
      /*
       * 只有真的跳转 knot 才校验。
       *
       * 纯物件交互（开抽屉、点灯）不带 story.knot，action 就是空串 ——
       * 那不是"引用了不存在的 knot"，而是压根没打算碰剧情。
       * 通用引擎必须允许这种交互独立成立。
       */
      if (interaction.action) checkInkRef(interaction.action, 'knot', where, file)
      if (interaction.when) checkInkRef(interaction.when, 'function', `${where}.when`, file)
      for (const [effectIndex, effect] of interaction.effects.entries()) {
        if (effect.type === 'story.knot' && effect.knot && effect.knot !== interaction.action) {
          checkInkRef(effect.knot, 'knot', `${where}.effects[${effectIndex}].knot`, file)
        }
      }

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

      /*
       * `object.patch` 的目标必须真的存在。
       *
       * 打错一个物件 id（或者物件改名之后忘了同步），运行时
       * `patchObjectState` 找不到就直接返回 false，**既不生效也不报错** ——
       * 作者写的那条状态切换永远不会发生，而且游戏跑起来一切"正常"。
       * 这是最难查的一类内容错误：没有任何一处会提示你写错了。
       *
       * `@self` 是"这条交互所属的物件"，由解析器保证存在，不用查。
       */
      for (const effect of interaction.effects) {
        if (effect.type !== 'object.patch') continue
        /*
         * `patch.progress` 目前**只写不读**：`patchObjectState` 会把它写进
         * 物件状态、也会跟着存档走，但渲染、命中、条件求值都不看它 ——
         * 屏幕上不会有任何变化。作者写 `progress: 0.75` 期待"抽屉开了一半"，
         * 得到的是一只完全没动的抽屉，而且不报错。
         */
        if (effect.patch.progress !== undefined) {
          reporter.info(
            `${where} 的 object.patch 里写了 progress —— 这个字段目前只被保存、` +
              `没有任何消费端，画面不会变`,
            { file },
          )
        }
        if (effect.target === '@self') continue
        const known =
          scene.hotspots.some((h) => h.id === effect.target) ||
          scene.layers.some((l) => l.id === effect.target)
        if (!known) {
          reporter.error(
            `${where} 的 object.patch 指向不存在的物件 "${effect.target}"` +
              `（本场景的物件：${[...scene.hotspots.map((h) => h.id), ...scene.layers.map((l) => l.id)].join(', ') || '无'}）` +
              `，运行时它会静默不生效`,
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
    if (isScene) continue
    /*
     * 出口**不能指向 ink function**。
     *
     * `knots` 这个集合里同时装着 knot 和 function 名（见上面第 48 行），
     * 所以只判 `knots.has` 会把 function 放行。而运行时 `hasKnot` 用的是
     * `story.HasFunction`，对 function 同样返回 true，于是 ChoosePathString
     * 静默"成功"、inkjs 报 RUNTIME ERROR、`Continue()` 返回空串 ——
     * **不切场景、不出台词，出口等于死的**，而且玩家那边毫无提示。
     *
     * 剧本入口、hub、互动 action 三处都有这层判断，只有出口这条漏了。
     */
    if (functions.has(exit.to)) {
      reporter.error(
        `exit ${exit.id} 想跳到 "${exit.to}"，但它是 ink function 不是 knot —— 运行时跳不过去，出口会变成死的`,
        { file },
      )
      continue
    }
    if (!knots.has(exit.to)) {
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
    /*
     * 新格式的物品引用也得收。
     *
     * 以前这里只认 ink 的 `# award:`（见上面 awardedItems）和旧字段
     * `hotspot.acceptsItem` —— 于是 `interactions[].item`、`.accepts`、
     * `effects[].item` 三种写法**全部漏掉**。作者写一个 items.json 里
     * 没有的物品 id，检查一声不吭，运行时物品栏直接显示原始 id
     * （正是这项检查存在的意义）。而 demo 用的恰恰全是新格式。
     */
    for (const interaction of hotspot.interactions) {
      if (interaction.item) usedItems.add(interaction.item)
      for (const accepted of interaction.accepts) usedItems.add(accepted)
      for (const effect of interaction.effects) {
        if (effect.item) usedItems.add(effect.item)
      }
    }
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
  const dependencies = await expandAssetDependencies(collectAssetRefs(loaded.scene), assets)
  for (const { ref, where } of dependencies) {
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

// ── 6.5 角色图集 ───────────────────────────────────────────────────────────
// 手写图集时把部件名打错，渲染器只会静默回落程序化绘制 —— 看起来"生效了"
// 但那个部件根本没换。必须在构建期挑出来。
//
// 图集有**两种**格式，用哪种由引用它的渲染器决定：
//   · partRig    → PartAtlasSchema（部件清单）
//   · spriteSheet→ SpriteAtlasSchema（帧布局 + clips）
//
// 这里以前一律套 PartAtlasSchema，后果是**精灵图集会被判成"格式错误"** ——
// 也就是说 spriteSheet 渲染器配上真图集之后，content:check 直接失败，
// 而它报的是"部件图集格式错误：parts — Required"，完全指不到真正的原因。
const knownParts = new Set<string>(PART_NAMES)

/** 每个 JSON 素材被哪些渲染器引用（`actors[].parts`）。 */
const atlasUsers = new Map<string, Set<string>>()
for (const loaded of scenes) {
  for (const actor of loaded.scene?.actors ?? []) {
    if (!actor.parts) continue
    const users = atlasUsers.get(actor.parts) ?? new Set<string>()
    users.add(actor.renderer)
    atlasUsers.set(actor.parts, users)
  }
}

for (const file of [...assets].sort()) {
  if (!file.endsWith('.json')) continue
  if (!referenced.has(file)) continue

  const users = atlasUsers.get(file)
  // 被角色引用的 JSON 才按图集校验；其余（编辑器草稿之类）不套图集格式
  if (!users || users.size === 0) continue

  let raw: unknown
  try {
    const text = (await readFile(path.join(ASSETS_DIR, file), 'utf8')).replace(/^\uFEFF/, '')
    raw = JSON.parse(text)
  } catch (err) {
    reporter.error(`图集 JSON 解析失败：${(err as Error).message}`, { file: `public/assets/${file}` })
    continue
  }

  if (users.has('spriteSheet')) {
    const parsed = SpriteAtlasSchema.safeParse(raw)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        reporter.error(
          `精灵图集格式错误：${issue.path.join('.') || '<根>'} — ${issue.message}`,
          { file: `public/assets/${file}` },
        )
      }
      continue
    }
    if (!assets.has(parsed.data.image)) {
      reporter.warn(`精灵表的图不存在：public/assets/${parsed.data.image}`, {
        file: `public/assets/${file}`,
      })
    }
    // clip 名写错时取帧会找不到，运行时静默回落部件骨架 —— 相当于这个渲染器白配
    for (const key of Object.keys(parsed.data.clips)) {
      if (!/^(walk|idle):(E|SE|S|SW|W|NW|N|NE)$/.test(key)) {
        reporter.warn(
          `clip 名 "${key}" 不是 "walk:方向" 或 "idle:方向"（方向名见 DIR8），取帧时会找不到`,
          { file: `public/assets/${file}` },
        )
      }
    }
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

// glide 的 `parts` 是**一张图片**，不是 JSON。指成 JSON 的话运行时
// `assets.image()` 会失败、静默回落到部件骨架，作者只会觉得"立绘没生效"。
for (const loaded of scenes) {
  for (const actor of loaded.scene?.actors ?? []) {
    if (actor.renderer === 'glide' && actor.parts?.endsWith('.json')) {
      reporter.error(
        `角色 ${actor.id} 用 glide 渲染器，但 parts 指向 JSON（"${actor.parts}"）——` +
          `glide 要的是单张立绘的图片路径`,
        { file: `content/scenes/${loaded.scene?.id ?? '?'}.json` },
      )
    }
  }
}

// ── 7. 能力声明 ───────────────────────────────────────────────────────────
// 项目清单声明"这次要发生什么"，引擎按声明加载。内容里用到了却没声明的能力，
// 表现是**静默不生效** —— 所以必须在构建期挑出来。
const projectFile = path.join(CONTENT_DIR, 'project.json')
let project = defaultProject()
/** 原始 JSON，用来查"已经废弃但还写在文件里"的字段。schema 会把它们补上默认值，光看解析结果是分辨不出来的。 */
let rawProject: Record<string, unknown> = {}
try {
  const raw = (await readFile(projectFile, 'utf8')).replace(/^\uFEFF/, '')
  const json: unknown = JSON.parse(raw)
  rawProject = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {}
  const parsed = ProjectSchema.safeParse(json)
  if (parsed.success) {
    project = parsed.data
  } else {
    for (const issue of parsed.error.issues) {
      reporter.error(`project.json：${issue.path.join('.') || '<根>'} — ${issue.message}`, {
        file: 'content/project.json',
      })
    }
  }
} catch {
  reporter.warn('没有 content/project.json，使用默认能力集（只有 story.ink 与 interaction.tap）', {
    file: 'content/project.json',
  })
}

const enabled = new Set(expandCapabilities(project.capabilities))

/** 内容里实际用到的能力。 */
const needed = new Set<string>()

for (const loaded of scenes) {
  const scene = loaded.scene
  if (!scene) continue
  if (sceneUsesStory(scene, sceneIds)) needed.add('story.ink')
  if (scene.actors.length > 0 || scene.ground || scene.walkable) needed.add('actor.walk')
  if (scene.bgm) needed.add('audio')
  if (scene.hotspots.some((h) => h.approach)) needed.add('actor.walk')

  for (const hotspot of scene.hotspots) {
    for (const interaction of resolveInteractions(hotspot)) {
      if (interaction.verb === 'inspect') needed.add('interaction.tap')
      if (interaction.verb === 'use') {
        needed.add('interaction.tap')
        needed.add('inventory')
      }
      if (interaction.verb === 'hold') needed.add('interaction.hold')
      if (interaction.verb === 'drag') {
        needed.add('interaction.drag')
        needed.add('inventory')
      }
      if (interaction.sfx) needed.add('audio')
    }
  }
}

for (const sourceFile of entryInk?.sourceFiles ?? []) {
  const display = sourceFile.file
    ? path.relative(ROOT, sourceFile.file).replace(/\\/g, '/')
    : 'content/story/<memory>'
  const source = sourceFile.source
  if (/#\s*bgm:/.test(source) || /#\s*sfx:/.test(source) || /#\s*vo:/.test(source)) needed.add('audio')
  if (/#\s*minigame:/.test(source)) needed.add('minigame')
  if (/#\s*award:/.test(source)) needed.add('inventory')
  /*
   * `# portrait:` 会被解析、会存进台词、也会随存档持久化 ——
   * 但**没有任何绘制端**，对话框只渲染说话人和文本。
   * 作者认真地给每句台词配了立绘，画面上不会出现任何东西，而且一声不吭。
   * 与其让人对着"配了没效果"发懵，不如在构建期说清楚。
   */
  if (/#\s*portrait:/.test(source)) {
    reporter.info(
      `${display}: 用了 # portrait: —— 这个指令目前只做解析与保存，还没有立绘绘制端，画面上不会出现立绘`,
    )
  }
}

// interaction.* 与 minigame 缺声明会**静默不生效**，所以是 error；
// audio / inventory / actor.walk 缺声明只是降级，给 warning。
const HARD: string[] = ['story.ink', 'interaction.tap', 'interaction.hold', 'interaction.drag', 'minigame']

for (const id of [...needed].sort()) {
  if (enabled.has(id as never)) continue
  const message =
    `内容用到了能力 "${id}"，但 content/project.json 没有声明它。` +
    `把 "${id}" 加进 capabilities，或把用到它的内容去掉`
  if (HARD.includes(id)) reporter.error(message, { file: 'content/project.json' })
  else reporter.warn(message, { file: 'content/project.json' })
}

/*
 * 尚未实现的配置必须**明确警告**，不能让它静默失效。
 *
 * 这类"文档写了、schema 校验了、改了没反应"的字段最伤人 ——
 * 调半天以为是自己写错了位置。
 */
/*
 * `cover` 现在真的实现了（之前只警告"尚未实现"）。
 *
 * 但它有代价，而且是**内容侧**的代价：画面会被裁掉上下两端。所以这里不再
 * 警告"没实现"，改成提醒作者关键内容要放在中间 —— 这类问题在构建期提示，
 * 比等玩家看到半张脸被切掉要便宜得多。
 */
if (project.mobile.sceneFit === 'cover') {
  for (const entry of scenes) {
    const corners = entry.scene?.ground?.corners
    if (!corners) continue
    const lowest = Math.max(...corners.map(([, v]) => v))
    if (lowest > 0.92) {
      reporter.info(
        `${entry.file}: 地面最前端在 v=${lowest.toFixed(2)}，几乎贴着画面底边。` +
          'sceneFit = "cover" 会裁掉上下两端，走动纵深会被自动收窄到可见范围内' +
          '（角色不会走出画面，但可走的前后范围比标注时小）。把地面收到 v≈0.85 以内可以避免',
      )
    }
  }

  /*
   * 交互元素伸出安全区 = **玩家点不到它**。
   *
   * cover 会把画面多出来的部分裁掉，贴边的热点就落在画布之外了 ——
   * demo 里的出口热点正好是这个情况，一条端到端用例把整个流程卡死才暴露出来。
   * 这是错误而不是提醒：点不到的按钮和没有这个按钮是一回事，
   * 而且它只在某些屏幕比例下才发作，手测很难碰到。
   */
  for (const entry of scenes) {
    if (!entry.scene) continue
    for (const violation of findSafeAreaViolations(entry.scene)) {
      reporter.error(
        `${entry.file}: 交互元素「${violation.label}」伸出了安全区` +
          `（${violation.reasons.join('、')}）。sceneFit = "cover" 会把它裁到画布外，玩家点不到。` +
          `把它的 u / v 收进 [${SAFE_AREA.min}, ${SAFE_AREA.max}] 之内`,
        { file: entry.file },
      )
    }
  }
}

/*
 * `mobile.dialogue` 是**废弃字段**，而且很坑：它和真正生效的
 * `layout.dialogue` 名字几乎一样。作者改了这一项、屏幕上毫无变化，
 * 会一直以为自己写错了位置。
 *
 * 它以前被规范化之后就再没人读过 —— 只在文件里留着，看着像有用。
 */
const mobileRaw = rawProject.mobile
if (typeof mobileRaw === 'object' && mobileRaw !== null && 'dialogue' in mobileRaw) {
  reporter.warn(
    'mobile.dialogue 已废弃且从未生效，删掉它。' +
      '对话布局现在由 layout.dialogue 控制（landscape / portrait 各给一个 placement 或一串规则）',
    { file: 'content/project.json' },
  )
}

/*
 * 主题包必须**真的存在**。
 *
 * 注册表里列了名字、文件却不在，运行时只会静默回落到中性主题 ——
 * 表现是"配色改了没反应"，又一类最难查的问题。
 * 这里直接对着文件系统核一遍。
 */
{
  const themePath = path.join(ROOT, themeCssPath(project.theme))
  if (!existsSync(themePath)) {
    reporter.error(
      `主题包 "${project.theme}" 在注册表里，但找不到 ${themeCssPath(project.theme)}。` +
        '补上这个文件，或把 theme 改成别的已注册主题',
      { file: 'content/project.json' },
    )
  }
}

for (const id of [...enabled].sort()) {
  if (!needed.has(id)) {
    reporter.info(`已声明但内容里没用到能力 "${id}"，可以去掉`)
  }
}

// ── 8. 汇总 ───────────────────────────────────────────────────────────────
reporter.info(
  `已检查 ${scenes.length} 个场景、${inkFiles.length} 个 ink 文件、${knots.size} 个 ink 名字、` +
    `${assets.size} 个素材、${enabled.size} 项能力`,
)
const errors = reporter.flush('内容契约检查')

if (scenes.length === 0 && inkFiles.length === 0) {
  process.stdout.write('  content/ 下还没有内容，检查跳过。\n')
}

process.exit(errors > 0 ? 1 : 0)
