import { hitTestShape } from '../engine/hitTest.ts'
import type { Pt } from '../engine/math.ts'
import type { Shape } from '../schema/common.ts'

/**
 * The transform shared by object drawing, hit testing, and hotspot feedback.
 *
 * Coordinates are normalized scene coordinates. Rotation is defined in canvas
 * space (positive angles turn clockwise because canvas y points down), so the
 * scene aspect is needed when converting a point to/from that space.
 */
export interface ObjectTransform {
  /** Original hotspot anchor in scene coordinates. */
  readonly origin: Pt
  /** Current drawn anchor in scene coordinates, including animation offset. */
  readonly position: Pt
  /** Uniform object scale. */
  readonly scale: number
  /** Canvas rotation in radians. */
  readonly rotation: number
  /** Scene width / scene height. */
  readonly aspect: number
}

const MIN_SCALE = 1e-9

function safeAspect(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1
}

function safeScale(value: number): number {
  return Number.isFinite(value) && Math.abs(value) >= MIN_SCALE ? value : 1
}

/** Transform a normalized scene point using the same pixel-space rotation as canvas. */
export function transformObjectPoint(transform: ObjectTransform, point: Pt): Pt {
  const aspect = safeAspect(transform.aspect)
  const scale = safeScale(transform.scale)
  const angle = Number.isFinite(transform.rotation) ? transform.rotation : 0
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = (point[0] - transform.origin[0]) * aspect * scale
  const dy = (point[1] - transform.origin[1]) * scale
  return [
    transform.position[0] + (cos * dx - sin * dy) / aspect,
    transform.position[1] + sin * dx + cos * dy,
  ]
}

/** Undo an object transform for hit testing. */
export function inverseTransformObjectPoint(transform: ObjectTransform, point: Pt): Pt {
  const aspect = safeAspect(transform.aspect)
  const scale = safeScale(transform.scale)
  const angle = Number.isFinite(transform.rotation) ? transform.rotation : 0
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = (point[0] - transform.position[0]) * aspect
  const dy = point[1] - transform.position[1]
  const localX = (cos * dx + sin * dy) / scale
  const localY = (-sin * dx + cos * dy) / scale
  return [transform.origin[0] + localX / aspect, transform.origin[1] + localY]
}

/** Test a hotspot against a transformed pointer without approximating its shape. */
export function hitTestTransformedShape(
  shape: Shape,
  x: number,
  y: number,
  transform: ObjectTransform | null,
): boolean {
  if (!transform) return false
  const local = inverseTransformObjectPoint(transform, [x, y])
  return hitTestShape(shape, local[0], local[1])
}

/**
 * Return a shape suitable for drawing debug/highlight feedback. Rectangles and
 * polygons are exact; circles are kept exact when possible and otherwise are
 * sampled only for the visual path (hit testing remains exact above).
 */
export function transformObjectShape(shape: Shape, transform: ObjectTransform | null): Shape {
  if (!transform) return shape
  if (
    transform.position[0] === transform.origin[0] &&
    transform.position[1] === transform.origin[1] &&
    safeScale(transform.scale) === 1 &&
    Math.abs(transform.rotation) < 1e-12
  ) {
    return shape
  }
  const angle = Number.isFinite(transform.rotation) ? transform.rotation : 0
  const scale = safeScale(transform.scale)
  if (shape.type === 'circle' && Math.abs(angle) < 1e-12) {
    const [cx, cy] = transformObjectPoint(transform, [shape.cx, shape.cy])
    return {
      type: 'circle',
      cx,
      cy,
      r: Math.abs(shape.r * scale),
    }
  }

  const points: Pt[] =
    shape.type === 'rect'
      ? [
          [shape.x, shape.y],
          [shape.x + shape.w, shape.y],
          [shape.x + shape.w, shape.y + shape.h],
          [shape.x, shape.y + shape.h],
        ]
      : shape.type === 'circle'
        ? Array.from({ length: 32 }, (_, index) => {
            const t = (index / 32) * Math.PI * 2
            return [shape.cx + Math.cos(t) * shape.r, shape.cy + Math.sin(t) * shape.r] as Pt
          })
        : shape.points

  return {
    type: 'poly',
    points: points.map((point) => {
      const transformed = transformObjectPoint(transform, point)
      return [transformed[0], transformed[1]] as [number, number]
    }),
  }
}
