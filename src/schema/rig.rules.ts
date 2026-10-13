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
