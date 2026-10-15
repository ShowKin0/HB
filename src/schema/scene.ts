import { z } from 'zod'
import { DialogueLayoutOverrideSchema } from './layout.ts'
import {
  INTERACTION_VERBS,
  effectsFromLegacy,
  resolveSceneMode,
  summarizeEffects,
} from './scene.rules.ts'
import {
  AssetRefSchema,
  ColorSchema,
  MaskRowSchema,
  ShapeSchema,
  Vec2Schema,
} from './common.ts'

/**
 * 地面平面标定。
 *
 * corners 是地面平面上单位正方形的四个角在**场景空间**中的位置，
 * 顺序固定为：(0,0) 后左 → (1,0) 后右 → (1,1) 前右 → (0,1) 前左。
 *
 * 由此解出的单应矩阵把地面平面 (u,v) 映射到场景空间。
 * 若四角构成矩形，该矩阵退化为仿射变换，即正交/弱透视场景 ——
 * 同一套寻路与渲染代码同时覆盖两种情况。
 */
export const GroundSchema = z.strictObject({
  corners: z.tuple([Vec2Schema, Vec2Schema, Vec2Schema, Vec2Schema]),
})
export type Ground = z.infer<typeof GroundSchema>

/**
 * 场景模式。
 *
 *   walk  —— 固定机位 + 地面平面，角色可以走过去（当前默认）
 *   focus —— 固定镜头特写，不做寻路，重点是多个物件的局部交互与动画
 *
 * 两种模式共用同一套渲染与交互系统，区别只在"要不要地面和角色"。
 * 交互叙事里大量场景其实是 focus：桌面特写、手机屏幕、信件、相册。
 */
export const SceneModeSchema = z.enum(['walk', 'focus'])
export type SceneMode = z.infer<typeof SceneModeSchema>

/**
 * 交互动词。
 *
 * 已实现：inspect（点一下）/ use（用物品）/ drag（把物品拖上去）
 * 已预留：hold（长按）/ sequence（按顺序点多个目标）
 *
 * 预留的两个**会明确报错**而不是静默失效：`content:check` 会报 error，
 * 运行时也会告警。数据模型先占位，实现跟上时不用改内容格式。
 */
export const InteractionVerbSchema = z.enum(INTERACTION_VERBS)
export type InteractionVerb = z.infer<typeof InteractionVerbSchema>

/**
 * 运行时规则从这里再导出一份，保持 `schema/scene.ts` 作为唯一入口的手感。
 * **运行时请直接 import scene.rules.ts** —— 那个文件不依赖 Zod，能进首包。
 */
export {
  INTERACTION_VERBS,
  UNIMPLEMENTED_VERBS,
  isDrawableObject,
  resolveInteractions,
  resolveSceneMode,
} from './scene.rules.ts'

/**
 * 一条交互定义。
 *
 * 这是从"热点只有 onClick"升级过来的核心：同一个物件可以挂多条交互，
 * 按动词 + 条件（when）筛选，命中哪条就走哪条。
 */
export const ObjectPatchSchema = z.strictObject({
  state: z.string().min(1).optional(),
  visible: z.boolean().optional(),
  progress: z.number().optional(),
})

export const EffectSchema = z.strictObject({
  type: z.enum(['object.patch', 'story.knot', 'story.event', 'audio.sfx', 'item.award', 'item.consume']),
  /** object.patch 的目标物件 id。'@self' 表示这条交互所属的物件。 */
  target: z.string().min(1).default('@self'),
  patch: ObjectPatchSchema.default({}),
  knot: z.string().default(''),
  name: z.string().default(''),
  path: z.string().default(''),
  item: z.string().default(''),
})

const InteractionBaseSchema = z.strictObject({
  verb: InteractionVerbSchema,
  /** 条件：ink 函数名，返回真值时这条交互才可用。null 表示无条件。 */
  when: z.string().min(1).nullable().default(null),
  /** verb 为 use 时要求手上的物品 id。 */
  item: z.string().min(1).nullable().default(null),
  /** verb 为 drag 时接受的物品 id 列表。 */
  accepts: z.array(z.string().min(1)).default([]),
  /** 命中后跳转的 ink knot。 */
  action: z.string().default(''),
  /**
   * 命中后把物件切到哪个视觉状态。null 表示不改。
   * 状态名对应 hotspot.visualStates 的键。
   */
  setState: z.string().min(1).nullable().default(null),
  /** 命中后改变物件可见性。null 表示不改。 */
  setVisible: z.boolean().nullable().default(null),
  /** 命中后发出的事件名，会写进 ink 变量并记录到存档。null 表示不发。 */
  emit: z.string().min(1).nullable().default(null),
  /** 命中时播放的音效，相对 assets 的路径。 */
  sfx: AssetRefSchema.default(null),
  /**
   * 动作列表。
   *
   * 新格式。不写 story.knot 时**整条交互完全不碰 ink** ——
   * 纯物件操作因此可以独立成立，通用引擎不该要求每条交互都跳转 knot。
   */
  effects: z.array(EffectSchema).default([]),
})

/**
 * 交互的规范化。
 *
 * 关键：**Zod 路径与 normalizeScene 路径必须得到完全相同的结果**，
 * 所以两边都调 summarizeEffects —— 各写一份推导逻辑的话，
 * tests/normalize.test.ts 的一致性断言立刻会报漂移。
 */
export const InteractionSchema = InteractionBaseSchema.transform((value) => {
  const effects = value.effects.length > 0 ? value.effects : effectsFromLegacy(value)
  return { ...value, ...summarizeEffects(effects), effects }
})
export type Interaction = z.infer<typeof InteractionSchema>

export const CursorKindSchema = z.enum(['look', 'use', 'take', 'talk', 'exit'])
export type CursorKind = z.infer<typeof CursorKindSchema>

/**
 * 场景中的一个角色（仅 walk 模式）。
 *
 * speed 的单位是"每秒走过的地面平面比例"，因为平面恒为 [0,1]²，
 * 所以 speed = 0.5 表示横穿整个地面约需 2 秒，与分辨率、透视都无关。
 */
export const ActorSpecSchema = z.strictObject({
  id: z.string().min(1),
  /** 渲染器 id，见 src/actorRenderers/registry.ts。缺省部件骨架。 */
  renderer: z.string().min(1).default('partRig'),
  /** 出生点，地面平面坐标。 */
  spawn: Vec2Schema,
  /** 角色高度占场景高度的比例，以出生点的深度缩放为基准。 */
  heightRatio: z.number().positive().max(2).default(0.3),
  /** 移动速度，地面平面比例/秒。 */
  speed: z.number().positive().max(4).default(0.45),
  /** 初始朝向：1 面向右，-1 面向左。 */
  facing: z.union([z.literal(1), z.literal(-1)]).default(1),
  /**
   * **该渲染器自己的素材引用**，由渲染器解释含义；null 时用内置程序化绘制。
   *
   *   · `partRig`    → 部件图集 JSON（`PartAtlasFile`）
   *   · `spriteSheet`→ 精灵图集 JSON（`SpriteAtlasFile`，里面再指向那张图）
   *   · `glide`      → 单张立绘的图片路径
   *
   * 字段名沿用 `parts` 是历史原因；它不是"只给部件骨架用的"。
   */
  parts: AssetRefSchema.default(null),
  /** 主体色调，null 用渲染器默认。 */
  tint: ColorSchema.nullable().default(null),
  /** 相对基准高度的额外缩放，用于区分大小角色。 */
  scale: z.number().positive().max(4).default(1),
})
export type ActorSpec = z.infer<typeof ActorSpecSchema>

/**
 * 物件动效。程序化轻动效，不需要任何额外素材。
 *
 * 这是"让物件活起来"最省力的一档：一个杯子在画面里靠的不是自己会动，
 * 而是有呼吸感的浮动 + 影子跟着变。
 */
export const ObjectAnimSchema = z.strictObject({
  type: z.enum(['none', 'float', 'sway', 'pulse']).default('none'),
  /** 幅度，场景空间比例。 */
  amplitude: z.number().min(0).max(0.2).default(0.008),
  /** 每秒周期数。 */
  speed: z.number().min(0.05).max(5).default(0.6),
  /** 相位偏移（弧度），用来错开多个物件，避免整齐划一。 */
  phase: z.number().default(0),
})
export type ObjectAnim = z.infer<typeof ObjectAnimSchema>

/** 物件在场景里的绘制与状态。物件的空间状态存在存档里，这里只是初始值。 */
const DrawableSchema = z.strictObject({
  /** 基础图片。null 表示这个物件不自己画图（纯命中区，或由图层负责外观）。 */
  image: AssetRefSchema.default(null),
  /** 视觉状态 → 图片。当前状态取不到图时回落到 image。 */
  visualStates: z.record(z.string(), z.string().min(1)).default({}),
  /** 初始视觉状态名。 */
  initialState: z.string().min(1).nullable().default(null),
  /** 绘制锚点在场景空间的位置。null 表示用命中形状的包围盒中心。 */
  position: Vec2Schema.nullable().default(null),
  /** 锚点在图片内的相对位置，0..1。默认图片中心。 */
  anchor: Vec2Schema.default([0.5, 0.5]),
  /**
   * 图片高度占场景高度的比例。
   * 显式给定而不是从命中区推算 —— 命中区通常要留一点余量，
   * 拿它当尺寸会导致视觉大小被交互手感牵着走。
   */
  height: z.number().positive().max(2).default(0.3),
  scale: z.number().positive().max(4).default(1),
  /** 旋转弧度。 */
  rotation: z.number().default(0),
  /** 深度，与角色/图层一起排序。 */
  v: z.number().min(0).max(1).default(0.5),
  /** 是否画一圈柔和投影。 */
  shadow: z.boolean().default(false),
  anim: ObjectAnimSchema.default({ type: 'none', amplitude: 0.008, speed: 0.6, phase: 0 }),
})

/**
 * 可交互物件（沿用 hotspots 这个名字，因为它就是"能点的东西"）。
 *
 * 它同时承担两种角色：
 *   - 只有 shape 的：纯命中区，外观由背景图负责（传统热点）
 *   - 带 image 的：自己画出来，并且能切视觉状态（抽屉开/关、相框亮/暗）
 */
export const HotspotSchema = DrawableSchema.extend({
  id: z.string().min(1),
  shape: ShapeSchema,
  label: z.string().default(''),
  cursor: CursorKindSchema.default('look'),
  /** ink 函数名，返回真值时物件可见。null 表示始终可见。 */
  visibleWhen: z.string().min(1).nullable().default(null),
  /** 触发前角色应站到的地面平面位置（仅 walk 模式有意义）。 */
  approach: Vec2Schema.nullable().default(null),

  /** 多交互定义。为空时会由旧字段合成，见 resolveInteractions。 */
  interactions: z.array(InteractionSchema).default([]),

  // ── 旧字段：保留以兼容已有内容，新内容请用 interactions ──
  /** @deprecated 用 interactions 里的 inspect。 */
  onClick: z.string().min(1).nullable().default(null),
  /** @deprecated 用 interactions 里的 use。 */
  acceptsItem: z.string().min(1).nullable().default(null),
  /** @deprecated 用 interactions 里的 use 的 action。 */
  onUse: z.string().min(1).nullable().default(null),
})
export type Hotspot = z.infer<typeof HotspotSchema>

/**
 * 纯视觉图层。不参与交互，只负责画。
 *
 * 相比原来的"整帧透明 PNG + v"，这里加上了位置、锚点、缩放、旋转、
 * 可见条件与视觉状态 —— 抽屉开合、门开关、光影变化都靠它。
 * position 为 null 时退化成"整帧铺满"，兼容旧内容。
 */
export const SceneLayerSchema = DrawableSchema.extend({
  id: z.string().default(''),
  image: z.string().min(1),
  position: Vec2Schema.nullable().default(null),
  visibleWhen: z.string().min(1).nullable().default(null),
})
export type SceneLayer = z.infer<typeof SceneLayerSchema>

export const ExitSchema = z.strictObject({
  id: z.string().min(1),
  shape: ShapeSchema,
  /** 目标场景 id，或 ink knot 名（由引擎按前缀区分）。 */
  to: z.string().min(1),
  /** ink 函数名，返回真值时出口可用。 */
  when: z.string().min(1).nullable().default(null),
})
export type Exit = z.infer<typeof ExitSchema>

export const SceneSchema = z
  .strictObject({
    id: z.string().min(1),
    title: z.string().default(''),
    /** 内容工具自己的元数据；引擎不解释，导入导出完整保留。 */
    metadata: z.record(z.string(), z.json()).default({}),
    /**
     * 场景模式。null 表示自动推断：
     * 有 ground 且有角色 → walk，否则 focus。
     * 编辑器导出时会写死具体值，所以新内容总是显式的。
     */
    mode: SceneModeSchema.nullable().default(null),
    /** 背景图；null 时引擎绘制渐变占位图。 */
    bg: AssetRefSchema.default(null),
    bgm: AssetRefSchema.default(null),
    /** 场景画面宽高比。 */
    aspect: z.number().positive().max(4).default(16 / 9),
    /** 地面标定；null 表示该场景不支持角色行走。 */
    ground: GroundSchema.nullable().default(null),
    /** 可行走掩码，每行一个字符串。null 表示整块地面可走。 */
    walkable: z.array(MaskRowSchema).min(2).nullable().default(null),
    actors: z.array(ActorSpecSchema).default([]),
    hotspots: z.array(HotspotSchema).default([]),
    layers: z.array(SceneLayerSchema).default([]),
    exits: z.array(ExitSchema).default([]),
    /** 进入场景时执行的 ink knot 名。 */
    entry: z.string().min(1).nullable().default(null),
    /**
     * 交互结束后的返回锚点 knot 名。
     *
     * 点完一个热点、该热点 knot 走完后，引擎会回到这里等待下一次点击。
     * 不填也能用（故事会停在原地），但填上后交互循环更稳。
     */
    hub: z.string().min(1).nullable().default(null),
    /**
     * 这个场景对对话布局的覆盖。null 表示完全继承内容包默认。
     *
     * 只写想改的项 —— 只写 `{"landscape": "overlay"}` 的话，其余三项
     * 继续跟着内容包走。核心不认识"聊天"或"视觉小说"，只认这些 placement。
     */
    dialogue: DialogueLayoutOverrideSchema.nullable().default(null),
  })
  .superRefine((scene, ctx) => {
    const mode = resolveSceneMode(scene)

    if (scene.walkable) {
      const cols = scene.walkable[0]?.length ?? 0
      scene.walkable.forEach((row, i) => {
        if (row.length !== cols) {
          ctx.addIssue({
            code: 'custom',
            path: ['walkable', i],
            message: `可行走掩码第 ${i} 行宽度为 ${row.length}，与首行 ${cols} 不一致`,
          })
        }
      })
    }

    if (mode === 'walk') {
      if (!scene.ground) {
        ctx.addIssue({
          code: 'custom',
          path: ['ground'],
          message:
            'walk 模式的场景必须有 ground 地面标定。如果这是固定镜头特写，把 "mode" 写成 "focus"。',
        })
      }
      if (scene.actors.length > 0 && !scene.walkable) {
        ctx.addIssue({
          code: 'custom',
          path: ['walkable'],
          message: 'walk 模式且包含角色时必须有 walkable 可行走掩码',
        })
      }
    }

    if (mode === 'focus') {
      if (scene.actors.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['actors'],
          message:
            'focus 模式不做寻路，不能有 actors。要在这个场景里放人物，请用 layers 放一张立绘。',
        })
      }
      if (scene.ground) {
        ctx.addIssue({
          code: 'custom',
          path: ['ground'],
          message: 'focus 模式不需要 ground。要去掉它，或把 mode 改成 "walk"。',
        })
      }
    }

    // id 唯一性，否则编辑器与存档会串号
    const seen = new Set<string>()
    for (const list of [scene.hotspots, scene.exits, scene.layers, scene.actors]) {
      for (const item of list) {
        if (seen.has(item.id)) {
          ctx.addIssue({
            code: 'custom',
            path: [item.id],
            message: `id "${item.id}" 在同一场景内重复`,
          })
        }
        seen.add(item.id)
      }
    }

    // 每个物件至少要有一条能触发的交互。
    // 三种形态都算数：新的 interactions 列表、旧的 onClick、
    // 以及"只接受某个物品"的 acceptsItem + onUse（这种物件点不动，
    // 但把正确的物品拖上去有反应，是合法的）。
    for (const hotspot of scene.hotspots) {
      const usable =
        hotspot.interactions.length > 0 ||
        Boolean(hotspot.onClick) ||
        Boolean(hotspot.acceptsItem && hotspot.onUse)
      if (!usable) {
        ctx.addIssue({
          code: 'custom',
          path: ['hotspots', hotspot.id],
          message: `物件 ${hotspot.id} 既没有 interactions、onClick，也没有 acceptsItem + onUse，怎么点都不会有反应`,
        })
      }
    }
  })
export type Scene = z.infer<typeof SceneSchema>



