/**
 * 角色部件骨架的运行时契约。
 *
 * 和 rig.ts 分开的原因：PART_NAMES 是**运行时**要用的（partRig 用它检查
 * 图集里的部件名），而 rig.ts 里还有 Zod schema。混在一起会把 Zod 拖进首包。
 */

/**
 * 固定部件名清单。
 *
 * 你按这套名字出图就能替换掉默认的程序化小人，缺哪个就哪个回落程序化绘制。
 * 顺序与原有定义保持一致 —— content:check 的"图集里没有 X"提示按这个顺序列出。
 */
export const PART_NAMES = [
  'shadow',
  'leg_upper_l',
  'leg_lower_l',
  'leg_upper_r',
  'leg_lower_r',
  'torso',
  'arm_upper_l',
  'arm_lower_l',
  'head',
  'arm_upper_r',
  'arm_lower_r',
] as const

export type PartName = (typeof PART_NAMES)[number]

/**
 * 逐帧精灵表的运行时契约。
 *
 * 和 rig.ts 里的 `SpriteAtlasSchema` 一一对应，分开的理由同 PART_NAMES：
 * 渲染器要用它，而 rig.ts 拖着一个 Zod 依赖。
 */
export interface SpriteAtlas {
  /** 帧在图像上的排列：行优先，每行 columns 帧。 */
  columns: number
  frameWidth: number
  frameHeight: number
  /** 脚底在单帧内的位置，0..1。默认水平居中、贴底。 */
  anchorX?: number
  /** **必须大于 0**：它同时是"脚底以上占帧高多少"和缩放系数，取 0 会算出天文尺寸。 */
  anchorY?: number
  /** 键形如 "walk:E"、"idle:S"。 */
  clips: Record<string, number[]>
}

/** 精灵表图集文件：图集本体 + 它引用的那张图。 */
export interface SpriteAtlasFile extends SpriteAtlas {
  image: string
}

/** 单个部件的图集条目。 */
export interface PartDef {
  /** 图片路径，相对 public/assets。 */
  image: string
  /** 关节在这张图内的位置，0..1。四肢用 [0.5, 0] 或 [0.5, 1]，头用 [0.5, 0.5]。 */
  pivot: [number, number]
  /** 相对关节的额外偏移，单位为身高比例。 */
  offset: [number, number]
  /** 部件高度，单位为身高比例（与 RIG 的骨架尺寸同一套单位）。 */
  height: number
}

/** 部件图集文件。 */
export interface PartAtlasFile {
  parts: Record<string, PartDef>
}
