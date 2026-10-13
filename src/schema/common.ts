import { z } from 'zod'

/** 归一化标量，取值 [0, 1]。所有场景坐标都用这个区间，与分辨率无关。 */
export const NormSchema = z.number().min(0).max(1)
export type Norm = z.infer<typeof NormSchema>

/** 归一化二维点 [x, y]。x 向右，y 向下。 */
export const Vec2Schema = z.tuple([NormSchema, NormSchema])
export type Vec2 = z.infer<typeof Vec2Schema>

/** 允许越界的点，用于编辑器中间态与地面平面以外的坐标。 */
export const FreeVec2Schema = z.tuple([z.number(), z.number()])
export type FreeVec2 = z.infer<typeof FreeVec2Schema>

/** 可走/不可走掩码字符。'.' 可走，'#' 阻挡。 */
export const MASK_WALKABLE = '.'
export const MASK_BLOCKED = '#'
export const MaskRowSchema = z.string().regex(/^[.#]+$/, '可行走掩码行只能包含 . 和 #')

/** 热点与出口的判定形状。坐标一律归一化到场景空间。 */
export const ShapeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('rect'),
    x: NormSchema,
    y: NormSchema,
    w: NormSchema,
    h: NormSchema,
  }),
  z.object({
    type: z.literal('circle'),
    cx: NormSchema,
    cy: NormSchema,
    r: NormSchema,
  }),
  z.object({
    type: z.literal('poly'),
    points: z.array(Vec2Schema).min(3, '多边形至少需要 3 个顶点'),
  }),
])
export type Shape = z.infer<typeof ShapeSchema>

/** 资源引用。nullable 表示"没有这个素材"，引擎会走降级路径。 */
export const AssetRefSchema = z.string().min(1).nullable()
export type AssetRef = z.infer<typeof AssetRefSchema>

/** 颜色，形如 "#rrggbb"。 */
export const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色格式应为 #rrggbb')
