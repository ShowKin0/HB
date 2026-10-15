import { z } from 'zod'
import { PART_NAMES } from './rig.rules.ts'

/**
 * 部件与精灵表的图集契约（Zod 校验部分）。
 *
 * **运行时用到的常量与类型在 rig.rules.ts**，那个文件不依赖 Zod。
 * 这里只放 schema，给 content:check、编辑器与测试用。
 */

export { PART_NAMES }
export type { PartAtlasFile, PartDef, PartName } from './rig.rules.ts'

/**
 * 逐帧精灵表图集。
 *
 * clips 的键形如 "walk:E"、"idle:S"，方向名见 actorRenderers/spriteSheet.ts 的 DIR8。
 */
export const SpriteAtlasSchema = z.object({
  image: z.string().min(1),
  columns: z.number().int().positive(),
  frameWidth: z.number().int().positive(),
  frameHeight: z.number().int().positive(),
  /** 脚底在单帧内的位置，0..1。 */
  anchorX: z.number().min(0).max(1).default(0.5),
  /**
   * 脚底在单帧内的**纵向**位置。
   *
   * 它同时充当缩放系数（`高度 = 1 / anchorY` 个身高单位），所以**必须大于 0**：
   * 以前这里是 `.min(0)`，`anchorY: 0` 能通过校验，运行时把精灵放大到
   * 1e6 倍身高 —— 画面直接空白，而且看不出是这一项造成的。
   */
  anchorY: z.number().positive().max(1).default(1),
  clips: z.record(z.string(), z.array(z.number().int().nonnegative()).min(1)),
})
/**
 * 这里推出来的类型与 rig.rules.ts 的 `SpriteAtlasFile` 是同一份契约
 * （前者给构建期，后者给运行时）。有一条测试守着它们字段一致。
 */
export type SpriteAtlasFile = z.infer<typeof SpriteAtlasSchema>

/** 部件图集里的单个部件。字段与 rig.rules.ts 的 PartDef 一一对应。 */
export const PartDefSchema = z.object({
  image: z.string().min(1),
  /** 关节在该部件图内的位置，0..1。 */
  pivot: z.tuple([z.number(), z.number()]).default([0.5, 1]),
  /**
   * 相对关节的额外偏移，单位是身高比例（脚底为 (0,0)，y 向下）。
   *
   * 注意是**相对关节**的微调，不是关节本身的位置：`pivot` 负责把图片上的
   * 关节对准原点，这个再把它挪一点。决定四肢摆在哪的是骨架 RIG。
   * （这句注释以前写的是"关节在角色局部空间的位置"，和实现不符。）
   */
  offset: z.tuple([z.number(), z.number()]),
  /** 部件在图中的显示高度，单位是身高比例。 */
  height: z.number().positive(),
})

/**
 * 部件图集：按固定部件名出图即可替换程序化小人。
 *
 * 约定的部件名（缺哪个就用程序化绘制补哪个）见 PART_NAMES。
 */
export const PartAtlasSchema = z.object({
  parts: z.record(z.string(), PartDefSchema),
})
