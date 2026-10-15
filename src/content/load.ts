import type { Scene } from '../schema/scene.ts'
import { normalizeScene } from '../schema/scene.rules.ts'
import { defaultProject, normalizeProject, type Project } from './project.rules.ts'

/**
 * 内容装载。
 *
 * 场景与剧本在构建期就被 Vite 打进产物，运行时只做一次校验（开发期用 Zod、
 * 生产期用规范化），因此内容写错会立刻在开发时暴露，而不是等你点开某个热点才崩。
 */
export interface GameContent {
  scenes: Map<string, Scene>
  /** 首个场景 id：优先取 project.json 声明的，其次 start.json，最后按文件名排序。 */
  startSceneId: string | null
  storyJson: string | null
  /** 项目清单：声明启用了哪些能力、手机布局、小游戏策略。 */
  project: Project
  /** 物品 id → 显示名。 */
  itemLabels: Record<string, string>
  /**
   * 内容指纹。剧本 + 场景清单算出来的短哈希。
   *
   * 存档会记下它：读档时对不上就说明内容改过了 —— 存档结构能迁移，
   * 但剧情位置可能已经失去意义。这时给提示而不是静默继续，
   * 避免"读档后剧情错乱"这种最难查的问题。
   */
  contentVersion: string
  /** 内容层面的告警，展示在调试面板里。 */
  warnings: string[]
}

/** FNV-1a 32 位。够用且不需要引依赖：这里只判断"内容有没有变过"。 */
function hashString(input: string, seed = 0x811c9dc5): number {
  let hash = seed
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * 键序无关的序列化。
 *
 * `JSON.stringify` 按对象的**插入顺序**输出键，而两条加载路径产出的键序不同：
 * 开发期走 Zod（键序由 schema 定义决定），生产期走 `normalizeScene`
 * （键序由 normalize 函数里字面量的书写顺序决定）。
 *
 * 于是同一份内容在开发期和生产期算出**不同的指纹**，交叉读档时会报假的
 * "内容已更新，这份存档可能与当前剧情对不上"。指纹只该是内容本身的函数，
 * 与"谁把它读进来的"无关。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',')}}`
}

function contentFingerprint(storyJson: string | null, scenes: Scene[]): string {
  // 顺序必须稳定，否则同样的内容会算出不同的指纹。
  // 两件事都要做：先按场景 id 排，再用键序无关的序列化 ——
  // 只排数组是不够的，对象的键序同样会因加载路径不同而不同
  const sceneDigest = [...scenes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((scene) => stableStringify(scene))
    .join('\u0000')
  const story = hashString(storyJson ?? '')
  const world = hashString(sceneDigest, story)
  return `${story.toString(36)}-${world.toString(36)}`
}

type JsonModule = { default: unknown }

export async function loadContent(): Promise<GameContent> {
  const warnings: string[] = []
  const scenes = new Map<string, Scene>()
  const ordered: { path: string; scene: Scene }[] = []

  const sceneModules = import.meta.glob('/content/scenes/*.json', { eager: true }) as Record<string, JsonModule>
  for (const path of Object.keys(sceneModules).sort()) {
    const raw = sceneModules[path].default

    /*
     * 开发期用 Zod 校验，生产期只做**规范化**。
     *
     * 生产构建里这些 JSON 是打进来的常量，而且 `npm run build` 已经先跑了
     * `content:check` —— 同样的内容校验一次就够了，再在运行时校验一遍
     * 纯粹是把 26 kB 的 zod 塞进首包。
     *
     * ⚠️ 但**默认值填充不能省**：一份没写 visualStates 的场景 JSON，
     * 少了这一步会在运行时炸成 `Object.values(undefined)`。
     * 所以生产路径走 normalizeScene（不依赖 zod），并且有一条测试
     * 拿真实内容断言它和 SceneSchema.parse 的结果深相等。
     */
    if (import.meta.env.DEV) {
      const { SceneSchema } = await import('../schema/scene.ts')
      const parsed = SceneSchema.safeParse(raw)
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          warnings.push(`${path}: ${issue.path.join('.') || '<根>'} — ${issue.message}`)
        }
        continue
      }
      if (scenes.has(parsed.data.id)) warnings.push(`场景 id 重复：${parsed.data.id}`)
      scenes.set(parsed.data.id, parsed.data)
      ordered.push({ path, scene: parsed.data })
      continue
    }

    const scene = normalizeScene(raw)
    if (scenes.has(scene.id)) warnings.push(`场景 id 重复：${scene.id}`)
    scenes.set(scene.id, scene)
    ordered.push({ path, scene })
  }

  const storyModules = import.meta.glob('/content/story/*.json', { eager: true }) as Record<string, JsonModule>
  const storyKey =
    Object.keys(storyModules).find((key) => key.endsWith('/main.json')) ?? Object.keys(storyModules).sort()[0]
  let storyJson: string | null = null
  if (storyKey) {
    const value = storyModules[storyKey].default
    storyJson = typeof value === 'string' ? value : JSON.stringify(value)
  } else {
    warnings.push('没有找到编译后的剧本，先运行 npm run ink:build。')
  }

  /*
   * 项目清单。
   *
   * 没有这份文件时用一份最小默认值 —— 引擎不该因为缺一个文件就完全跑不起来。
   * 和场景一样：开发期用 Zod，生产期只做规范化。
   */
  const projectModules = import.meta.glob('/content/project.json', { eager: true }) as Record<string, JsonModule>
  const projectModule = Object.values(projectModules)[0]
  let project: Project = defaultProject()
  if (projectModule) {
    if (import.meta.env.DEV) {
      const { ProjectSchema } = await import('./project.ts')
      const parsed = ProjectSchema.safeParse(projectModule.default)
      if (parsed.success) {
        project = parsed.data
      } else {
        for (const issue of parsed.error.issues) {
          warnings.push(`content/project.json: ${issue.path.join('.') || '<根>'} — ${issue.message}`)
        }
      }
    } else {
      project = normalizeProject(projectModule.default)
    }
  } else {
    warnings.push('没有 content/project.json，使用默认项目清单。')
  }

  const declaredStart = project.startScene ? scenes.get(project.startScene) : undefined
  if (project.startScene && !declaredStart) {
    warnings.push(`project.json 声明的起始场景 "${project.startScene}" 不存在`)
  }
  const startEntry =
    (declaredStart ? ordered.find((entry) => entry.scene.id === declaredStart.id) : undefined) ??
    ordered.find((entry) => /(^|\/)start\.json$/.test(entry.path)) ??
    ordered[0]
  if (!startEntry) warnings.push('content/scenes 下没有可用场景。')

  const itemModules = import.meta.glob('/content/items.json', { eager: true }) as Record<string, JsonModule>
  let itemLabels: Record<string, string> = {}
  const itemModule = Object.values(itemModules)[0]
  if (itemModule && typeof itemModule.default === 'object' && itemModule.default !== null) {
    itemLabels = itemModule.default as Record<string, string>
  } else if (Object.keys(itemModules).length > 0) {
    warnings.push('content/items.json 格式应为 { "item_id": "显示名" }。')
  }

  const contentVersion = contentFingerprint(
    storyJson,
    ordered.map((entry) => entry.scene),
  )

  return {
    scenes,
    startSceneId: startEntry?.scene.id ?? null,
    storyJson,
    project,
    itemLabels,
    contentVersion,
    warnings,
  }
}
