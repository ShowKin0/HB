import {
  isDrawableObject,
  resolveSceneMode,
  type Exit,
  type Hotspot,
  type ObjectAnim,
  type Scene,
  type SceneLayer,
  type SceneMode,
} from '../../schema/scene.rules.ts'
import type { SceneObjectState } from '../../schema/save.ts'
import { sceneObjectKey } from '../../schema/save.ts'
import {
  identityHomography,
  localScale,
  project,
  type Homography,
  type Pt,
  solveHomography,
  unproject,
} from '../../render/homography.ts'
import { parseMask, isPlaneWalkable, type WalkMask } from '../nav/mask.ts'
import type { AssetStore } from '../assets.ts'
import { createActor, moveActorTo, updateActor, type Actor } from '../actor/actor.ts'
import { hitTestShape, shapeCenter } from '../hitTest.ts'
import { resolveObjectState, type ResolvedObjectState } from '../interaction/events.ts'

export interface ActorPlacement {
  /** 场景空间坐标。 */
  x: number
  y: number
  /** 场景空间中的身高（归一化高度比例）。 */
  height: number
}

/** 一个可绘制物件在某一帧的完整绘制参数。 */
export interface DrawableObject {
  id: string
  kind: 'object' | 'layer'
  hotspot: Hotspot | null
  layer: SceneLayer | null
  image: CanvasImageSource | null
  /** 锚点在场景空间的位置（已含动效偏移）。 */
  position: Pt
  anchor: Pt
  /** 图片高度占场景高度的比例。 */
  height: number
  scale: number
  rotation: number
  v: number
  shadow: boolean
  anim: ObjectAnim
  /** 整帧铺满（旧式前景层），忽略 position / anchor / height。 */
  fullFrame: boolean
}

export interface SceneUpdateHooks {
  onFootstep?(actor: Actor): void
  onArrive?(actor: Actor, knot: string | null): void
}

/** 没有掩码时的兜底：整块地面可走。 */
function fullMask(cols = 32, rows = 18): WalkMask {
  return parseMask(Array.from({ length: rows }, () => '.'.repeat(cols)))
}

/**
 * 场景运行时：只管模拟，不管绘制。
 *
 * 它把几样东西绑在一起：场景定义、地面平面单应变换、地面上的角色，
 * 以及**物件的空间状态**。
 *
 * 空间状态（抽屉开着没有、相框转到哪了）和剧情状态（ink 变量）是分开的：
 * 前者在这里和存档里，后者在 ink 里，靠 EventBridge 单向同步事件。
 */
export class SceneRuntime {
  readonly scene: Scene
  readonly mode: SceneMode
  readonly mask: WalkMask | null
  readonly homography: Homography
  readonly actors: Actor[] = []
  /** 由 # bg: 指令临时替换的背景；null 表示用场景自带的。 */
  backgroundOverride: CanvasImageSource | null = null

  private readonly sceneBackground: CanvasImageSource | null
  private readonly depthRef: number
  /** 物件与图层的空间状态，键为物件 id。 */
  private readonly objectStates = new Map<string, ResolvedObjectState>()
  /** 所有已加载的图片，键为素材路径。 */
  private readonly images = new Map<string, CanvasImageSource | null>()

  private constructor(
    scene: Scene,
    mode: SceneMode,
    mask: WalkMask | null,
    homography: Homography,
    sceneBackground: CanvasImageSource | null,
    savedStates: Record<string, SceneObjectState>,
  ) {
    this.scene = scene
    this.mode = mode
    this.mask = mask
    this.homography = homography
    this.sceneBackground = sceneBackground

    const first = scene.actors[0]
    this.depthRef = first ? Math.max(1e-6, localScale(homography, first.spawn[0], first.spawn[1])) : 1

    if (mask) {
      for (const spec of scene.actors) this.actors.push(createActor(spec))
    }

    // 物件与图层的初始状态：场景里的初值 + 存档覆盖
    for (const hotspot of scene.hotspots) {
      this.objectStates.set(
        hotspot.id,
        resolveObjectState(
          { visible: true, state: hotspot.initialState, position: hotspot.position },
          savedStates[sceneObjectKey(scene.id, hotspot.id)],
        ),
      )
    }
    for (const layer of scene.layers) {
      this.objectStates.set(
        layer.id,
        resolveObjectState(
          { visible: true, state: layer.initialState, position: layer.position },
          savedStates[sceneObjectKey(scene.id, layer.id)],
        ),
      )
    }
  }

  static async create(
    scene: Scene,
    assets: AssetStore,
    savedStates: Record<string, SceneObjectState> = {},
  ): Promise<SceneRuntime> {
    const mode = resolveSceneMode(scene)
    const homography =
      mode === 'walk' && scene.ground
        ? (solveHomography(scene.ground.corners) ?? identityHomography())
        : identityHomography()
    const mask =
      mode === 'walk' && scene.actors.length > 0
        ? scene.walkable
          ? parseMask(scene.walkable)
          : fullMask()
        : null
    const background = await assets.image(scene.bg)

    const runtime = new SceneRuntime(scene, mode, mask, homography, background, savedStates)

    // 预加载所有可能用到的图：物件基础图、各视觉状态、图层、图层状态
    const paths = new Set<string>()
    for (const hotspot of scene.hotspots) {
      if (hotspot.image) paths.add(hotspot.image)
      for (const image of Object.values(hotspot.visualStates)) paths.add(image)
    }
    for (const layer of scene.layers) {
      paths.add(layer.image)
      for (const image of Object.values(layer.visualStates)) paths.add(image)
    }
    await Promise.all(
      [...paths].map(async (path) => {
        runtime.images.set(path, await assets.image(path))
      }),
    )

    return runtime
  }

  get background(): CanvasImageSource | null {
    return this.backgroundOverride ?? this.sceneBackground
  }

  get aspect(): number {
    return this.scene.aspect
  }

  /** 背景图缺失时用的渐变占位色，按场景 id 稳定散列，不同场景颜色不同。 */
  get placeholderColors(): [string, string] {
    let hash = 0
    for (let i = 0; i < this.scene.id.length; i++) hash = (hash * 31 + this.scene.id.charCodeAt(i)) >>> 0
    const hue = hash % 360
    return [`hsl(${hue}, 26%, 18%)`, `hsl(${(hue + 48) % 360}, 22%, 30%)`]
  }

  actorById(id: string): Actor | undefined {
    return this.actors.find((actor) => actor.spec.id === id)
  }

  /** 地面平面 → 场景空间。 */
  projectPlane(u: number, v: number): Pt {
    return project(this.homography, u, v)
  }

  /** 场景空间 → 地面平面。点在消失线上时返回 null。 */
  unprojectScene(x: number, y: number): Pt | null {
    return unproject(this.homography, x, y)
  }

  /** 角色在场景空间中的位置与身高。 */
  actorPlacement(actor: Actor): ActorPlacement {
    const [x, y] = project(this.homography, actor.u, actor.v)
    const scale = localScale(this.homography, actor.u, actor.v) / this.depthRef
    return { x, y, height: actor.spec.heightRatio * actor.spec.scale * scale }
  }

  /** 让某个角色走到地面平面上的目标点。返回是否真的产生了移动。 */
  moveActor(actorId: string, target: Pt, knot: string | null = null): boolean {
    const actor = this.actorById(actorId)
    if (!actor || !this.mask) return false
    return moveActorTo(actor, this.mask, target, knot)
  }

  /** 第一个人物角色，热点走位默认用它。 */
  get primaryActor(): Actor | undefined {
    return this.actors[0]
  }

  // ── 物件空间状态 ─────────────────────────────────────────

  objectState(id: string): ResolvedObjectState | null {
    return this.objectStates.get(id) ?? null
  }

  /** 局部更新一个物件的空间状态。返回是否真的变了。 */
  patchObjectState(id: string, patch: Partial<ResolvedObjectState>): boolean {
    const current = this.objectStates.get(id)
    if (!current) return false
    const next: ResolvedObjectState = { ...current, ...patch }
    if (
      next.visible === current.visible &&
      next.state === current.state &&
      next.progress === current.progress &&
      samePosition(next.position, current.position)
    ) {
      return false
    }
    this.objectStates.set(id, next)
    return true
  }

  /** 导出全部物件状态，供存档写入。键为 `${sceneId}:${objectId}`。 */
  snapshotObjectStates(): Record<string, SceneObjectState> {
    const out: Record<string, SceneObjectState> = {}
    for (const [id, state] of this.objectStates) {
      out[sceneObjectKey(this.scene.id, id)] = {
        visible: state.visible,
        ...(state.state !== null ? { state: state.state } : {}),
        ...(state.position ? { position: [state.position[0], state.position[1]] as [number, number] } : {}),
        ...(state.progress !== 0 ? { progress: state.progress } : {}),
      }
    }
    return out
  }

  /** 物件当前是否可见（含状态覆盖）。不含 visibleWhen —— 那是剧情条件，由上层求值。 */
  isObjectVisible(id: string): boolean {
    return this.objectStates.get(id)?.visible ?? true
  }

  /** 物件当前该用哪张图：优先当前视觉状态，其次基础图。 */
  private imageFor(owner: Hotspot | SceneLayer, id: string): CanvasImageSource | null {
    const state = this.objectStates.get(id)?.state
    const path = (state ? owner.visualStates[state] : undefined) ?? owner.image ?? null
    return path ? (this.images.get(path) ?? null) : null
  }

  /**
   * 收集本帧要画的物件与图层。
   *
   * 动效偏移在这里算：浮动 / 摇摆 / 呼吸都是纯程序化的，
   * 不需要任何额外素材 —— 这是"让物件活起来"最省力的一档。
   *
   * `conditionVisible` 用来求值 `visibleWhen`。**必须传**，否则带条件的物件
   * 会在条件为假时照样被画出来 —— 看得见却点不到，玩家只会当成 bug。
   * 不传时退化为"只看空间状态"，这是给编辑器和单测用的。
   */
  collectDrawables(
    elapsed: number,
    conditionVisible?: (owner: Hotspot | SceneLayer) => boolean,
  ): DrawableObject[] {
    const out: DrawableObject[] = []
    const passCondition = (owner: Hotspot | SceneLayer): boolean =>
      !owner.visibleWhen || (conditionVisible ? conditionVisible(owner) : true)

    for (const hotspot of this.scene.hotspots) {
      if (!isDrawableObject(hotspot)) continue
      const state = this.objectStates.get(hotspot.id)
      if (!state?.visible) continue
      if (!passCondition(hotspot)) continue
      const base = state.position ?? hotspot.position ?? shapeCenter(hotspot.shape)
      const offset = animOffset(hotspot.anim, elapsed)
      out.push({
        id: hotspot.id,
        kind: 'object',
        hotspot,
        layer: null,
        image: this.imageFor(hotspot, hotspot.id),
        position: [base[0] + offset.dx, base[1] + offset.dy],
        anchor: hotspot.anchor,
        height: hotspot.height,
        scale: hotspot.scale * offset.scale,
        rotation: hotspot.rotation + offset.rotation,
        v: hotspot.v,
        shadow: hotspot.shadow,
        anim: hotspot.anim,
        fullFrame: false,
      })
    }

    for (const layer of this.scene.layers) {
      const state = this.objectStates.get(layer.id)
      if (!state?.visible) continue
      if (!passCondition(layer)) continue
      // position 为 null 时退化成"整帧铺满"，兼容旧内容
      const base = state.position ?? layer.position
      const offset = animOffset(layer.anim, elapsed)
      out.push({
        id: layer.id,
        kind: 'layer',
        hotspot: null,
        layer,
        image: this.imageFor(layer, layer.id),
        position: base ? [base[0] + offset.dx, base[1] + offset.dy] : [0.5, 0.5],
        anchor: layer.anchor,
        height: layer.height,
        scale: layer.scale * offset.scale,
        rotation: layer.rotation + offset.rotation,
        v: layer.v,
        shadow: layer.shadow,
        anim: layer.anim,
        fullFrame: base === null,
      })
    }

    return out
  }

  update(dt: number, hooks: SceneUpdateHooks = {}): void {
    const homography = this.homography
    const mask = this.mask
    if (!mask) return
    for (const actor of this.actors) {
      updateActor(actor, dt, {
        mask,
        project: (u, v) => project(homography, u, v),
        localScale: (u, v) => localScale(homography, u, v),
        onFootstep: hooks.onFootstep,
        onArrive: hooks.onArrive,
      })
    }
  }

  /**
   * 命中物件。倒序遍历，让后定义的物件优先。
   *
   * 可见性走 objectStates 而不是只看场景初值 —— 否则剧情把物件藏起来之后，
   * 玩家还能点到一个看不见的东西。
   */
  hotspotAt(x: number, y: number, extraVisible?: (hotspot: Hotspot) => boolean): Hotspot | null {
    for (let i = this.scene.hotspots.length - 1; i >= 0; i--) {
      const hotspot = this.scene.hotspots[i]
      if (!this.isObjectVisible(hotspot.id)) continue
      if (extraVisible && !extraVisible(hotspot)) continue
      if (hitTestShape(hotspot.shape, x, y)) return hotspot
    }
    return null
  }

  exitAt(x: number, y: number, enabled: (exit: Exit) => boolean = () => true): Exit | null {
    for (let i = this.scene.exits.length - 1; i >= 0; i--) {
      const exit = this.scene.exits[i]
      if (!enabled(exit)) continue
      if (hitTestShape(exit.shape, x, y)) return exit
    }
    return null
  }

  /** 鼠标悬停用的光标类型。 */
  cursorAt(x: number, y: number, extraVisible?: (hotspot: Hotspot) => boolean): string {
    const hotspot = this.hotspotAt(x, y, extraVisible)
    if (hotspot) return hotspot.cursor
    return this.canWalkAt(x, y) ? 'walk' : 'default'
  }

  /** 场景空间中的点能否变成可走的地面点。focus 模式下永远为否。 */
  canWalkAt(x: number, y: number): boolean {
    if (this.mode !== 'walk') return false
    if (!this.mask || !this.scene.ground) return false
    const plane = unproject(this.homography, x, y)
    if (!plane) return false
    return isPlaneWalkable(this.mask, plane[0], plane[1])
  }

  /** 场景里所有需要预取的素材路径。 */
  static assetPaths(scene: Scene): string[] {
    const paths: string[] = []
    if (scene.bg) paths.push(scene.bg)
    if (scene.bgm) paths.push(scene.bgm)
    for (const layer of scene.layers) {
      paths.push(layer.image, ...Object.values(layer.visualStates))
    }
    for (const hotspot of scene.hotspots) {
      if (hotspot.image) paths.push(hotspot.image)
      paths.push(...Object.values(hotspot.visualStates))
      for (const interaction of hotspot.interactions) {
        if (interaction.sfx) paths.push(interaction.sfx)
      }
    }
    for (const actor of scene.actors) if (actor.parts) paths.push(actor.parts)
    return paths
  }
}

function samePosition(a: Pt | null, b: Pt | null): boolean {
  if (!a || !b) return a === b
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9
}

export interface AnimOffset {
  dx: number
  dy: number
  scale: number
  rotation: number
}

/**
 * 把动效配置换算成本帧的偏移。
 *
 * 三种都是纯程序化的，不需要任何素材：
 *   float —— 上下浮动（配合 shadow 就有悬空感）
 *   sway  —— 左右轻摆 + 少量旋转
 *   pulse —— 呼吸式缩放
 */
export function animOffset(anim: ObjectAnim, elapsed: number): AnimOffset {
  if (anim.type === 'none' || anim.amplitude <= 0) {
    return { dx: 0, dy: 0, scale: 1, rotation: 0 }
  }
  const t = elapsed * anim.speed * Math.PI * 2 + anim.phase
  switch (anim.type) {
    case 'float':
      return { dx: 0, dy: Math.sin(t) * anim.amplitude, scale: 1, rotation: 0 }
    case 'sway':
      return {
        dx: Math.sin(t) * anim.amplitude,
        dy: 0,
        scale: 1,
        rotation: Math.sin(t) * anim.amplitude * 1.5,
      }
    case 'pulse':
      return { dx: 0, dy: 0, scale: 1 + Math.sin(t) * anim.amplitude * 2, rotation: 0 }
    default:
      return { dx: 0, dy: 0, scale: 1, rotation: 0 }
  }
}
