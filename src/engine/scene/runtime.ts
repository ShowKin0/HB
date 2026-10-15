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
import { parseMask, isPlaneWalkable, nearestWalkable, cellCenter, walkableCount, type WalkMask } from '../nav/mask.ts'
import type { AssetStore } from '../assets.ts'
import { createActor, moveActorTo, updateActor, type Actor } from '../actor/actor.ts'
import { hitTestShape, shapeCenter } from '../hitTest.ts'
import {
  hitTestTransformedShape,
  transformObjectShape,
  type ObjectTransform,
} from '../../render/objectTransform.ts'
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
  /** 完整的共享物件变换；命中与高亮也使用它。 */
  transform: ObjectTransform
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
  /** 地面平面 → 归一化场景坐标；cover 只约束可走范围，不改这张标定。 */
  homography: Homography
  readonly actors: Actor[] = []
  /** 由 # bg: 指令临时替换的背景；null 表示用场景自带的。 */
  backgroundOverride: CanvasImageSource | null = null

  private readonly sceneBackground: CanvasImageSource | null
  private activeMask: WalkMask | null
  /** 当前可见的场景纵向范围（cover 裁切后），仅用于约束行走，不改投影。 */
  private _visibleV: [number, number] = [0, 1]
  /** 当前可见的场景横向范围；目前通常为整幅，供 cover/编辑器约束使用。 */
  private _visibleU: [number, number] = [0, 1]
  /** 最近一次绘制使用的时间，让输入命中与上一帧画面保持一致。 */
  private lastDrawableElapsed = 0
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
    this.activeMask = mask
    this.homography = homography
    this.sceneBackground = sceneBackground

    if (mask) {
      for (const spec of scene.actors) {
        const actor = createActor(spec)
        const spawn = this.constrainPlanePoint(spec.spawn)
        if (spawn) {
          actor.u = spawn[0]
          actor.v = spawn[1]
        }
        this.actors.push(actor)
      }
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

  /**
   * 收窄可走区域到当前可见的场景范围。
   *
   * `cover` 可能裁掉画面边缘，但地面标定仍然描述原始背景。这里仅记录
   * 可见范围并约束地面上的 walk/move，不夹 ground corners，也不重算 H；
   * 因而近大远小和消失线位置都保持不变。
   *
   * 这个旧入口保留给现有调用方（目前只传 visibleV）。需要横向 cover 约束
   * 时调用 `setVisibleBounds(u0, u1, v0, v1)`，二者都在场景坐标中。
   */
  setVisibleRange(v0: number, v1: number): boolean {
    const lo0 = clampUnit(v0)
    const hi0 = Math.max(lo0, clampUnit(v1))
    const minSpan = 0.02
    const hi = hi0 - lo0 >= minSpan ? hi0 : Math.min(1, (lo0 + hi0) / 2 + minSpan / 2)
    const lo = Math.min(lo0, Math.max(0, hi - minSpan))
    return this.setVisibleBounds(0, lo, 1, hi)
  }

  /** 更新可见场景矩形；参数顺序为 u0、v0、u1、v1。 */
  setVisibleBounds(u0: number, v0: number, u1: number, v1: number): boolean {
    const [loU, hiU] = normalizeRange(u0, u1)
    const [loV, hiV] = normalizeRange(v0, v1)
    if (
      Math.abs(loU - this._visibleU[0]) < 1e-4 &&
      Math.abs(hiU - this._visibleU[1]) < 1e-4 &&
      Math.abs(loV - this._visibleV[0]) < 1e-4 &&
      Math.abs(hiV - this._visibleV[1]) < 1e-4
    ) {
      return false
    }

    this._visibleU = [loU, hiU]
    this._visibleV = [loV, hiV]
    this.activeMask = this.buildVisibleMask()
    for (const actor of this.actors) this.constrainActorToVisible(actor)
    return true
  }

  /** 当前实际生效的场景横向范围。 */
  get visibleU(): readonly [number, number] {
    return this._visibleU
  }

  /** 当前实际生效的场景纵向范围。 */
  get visibleV(): readonly [number, number] {
    return this._visibleV
  }

  /** 兼容旧调用方：可走纵向范围等于 visibleV。 */
  get groundRange(): readonly [number, number] {
    return this._visibleV
  }

  /** 当前场景空间点是否位于画面可见范围。 */
  private inVisibleScene(x: number, y: number): boolean {
    return x >= this._visibleU[0] - 1e-9 && x <= this._visibleU[1] + 1e-9 && y >= this._visibleV[0] - 1e-9 && y <= this._visibleV[1] + 1e-9
  }

  /** 地面平面点投影后是否仍落在当前视口内。 */
  private inVisiblePlane(u: number, v: number): boolean {
    const m = this.homography.m
    const w = m[6] * u + m[7] * v + m[8]
    if (!Number.isFinite(w) || Math.abs(w) < 1e-12) return false
    const [x, y] = project(this.homography, u, v)
    return Number.isFinite(x) && Number.isFinite(y) && this.inVisibleScene(x, y)
  }

  /** 仅保留投影后仍可见的地面格，完整格优先，窄边裁切时再保留可见中心格。 */
  private buildVisibleMask(): WalkMask | null {
    const mask = this.mask
    if (!mask) return null
    if (this._visibleU[0] <= 0 && this._visibleU[1] >= 1 && this._visibleV[0] <= 0 && this._visibleV[1] >= 1) return mask

    const make = (requireWholeCell: boolean): WalkMask => {
      const cells = new Uint8Array(mask.cells.length)
      for (let row = 0; row < mask.rows; row++) {
        for (let col = 0; col < mask.cols; col++) {
          const index = row * mask.cols + col
          if (!mask.cells[index]) continue
          const u0 = col / mask.cols
          const u1 = (col + 1) / mask.cols
          const v0 = row / mask.rows
          const v1 = (row + 1) / mask.rows
          const points: Pt[] = requireWholeCell
            ? [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]
            : [[(u0 + u1) / 2, (v0 + v1) / 2]]
          if (points.every(([u, v]) => this.inVisiblePlane(u, v))) cells[index] = 1
        }
      }
      return { cols: mask.cols, rows: mask.rows, cells }
    }

    const wholeCells = make(true)
    return walkableCount(wholeCells) > 0 ? wholeCells : make(false)
  }

  private visibleMask(): WalkMask | null {
    return this.activeMask
  }

  /** 把出生点/目标点限制在可见地面范围和可走格内。 */
  private constrainPlanePoint(point: Pt): Pt | null {
    const mask = this.visibleMask()
    if (!mask) {
      const [x, y] = project(this.homography, point[0], point[1])
      return this.inVisibleScene(x, y) ? [point[0], point[1]] : null
    }
    if (isPlaneWalkable(mask, point[0], point[1]) && this.inVisiblePlane(point[0], point[1])) {
      return [point[0], point[1]]
    }

    const col = Math.min(mask.cols - 1, Math.max(0, Math.floor(point[0] * mask.cols)))
    const row = Math.min(mask.rows - 1, Math.max(0, Math.floor(point[1] * mask.rows)))
    const nearest = nearestWalkable(mask, col, row)
    return nearest ? cellCenter(mask, nearest[0], nearest[1]) : null
  }

  private constrainActorToVisible(actor: Actor): void {
    const point = this.constrainPlanePoint([actor.u, actor.v])
    if (point) {
      actor.u = point[0]
      actor.v = point[1]
    }
    // A resized viewport invalidates the old target even if the current point
    // still fits. Repathing must be an explicit new user/story action.
    actor.path = null
    actor.pendingKnot = null
    actor.segIndex = 0
    actor.segPos = 0
    actor.speed = 0
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
    const spawnScale = Math.max(1e-6, localScale(this.homography, actor.spec.spawn[0], actor.spec.spawn[1]))
    const scale = localScale(this.homography, actor.u, actor.v) / spawnScale
    return { x, y, height: actor.spec.heightRatio * actor.spec.scale * scale }
  }

  /** 让某个角色走到地面平面上的目标点。返回是否真的产生了移动。 */
  moveActor(actorId: string, target: Pt, knot: string | null = null): boolean {
    const actor = this.actorById(actorId)
    const mask = this.visibleMask()
    if (!actor || !mask) return false
    const constrained = this.constrainPlanePoint(target)
    if (!constrained) return false
    return moveActorTo(actor, mask, constrained, knot)
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
    this.lastDrawableElapsed = elapsed
    const out: DrawableObject[] = []
    const passCondition = (owner: Hotspot | SceneLayer): boolean =>
      !owner.visibleWhen || (conditionVisible ? conditionVisible(owner) : true)

    for (const hotspot of this.scene.hotspots) {
      if (!isDrawableObject(hotspot)) continue
      const state = this.objectStates.get(hotspot.id)
      if (!state?.visible) continue
      if (!passCondition(hotspot)) continue
      const origin = hotspot.position ?? shapeCenter(hotspot.shape)
      const base = state.position ?? origin
      const offset = animOffset(hotspot.anim, elapsed)
      const position: Pt = [base[0] + offset.dx, base[1] + offset.dy]
      const scale = hotspot.scale * offset.scale
      const rotation = hotspot.rotation + offset.rotation
      const transform: ObjectTransform = {
        origin,
        position,
        scale,
        rotation,
        aspect: this.scene.aspect,
      }
      out.push({
        id: hotspot.id,
        kind: 'object',
        hotspot,
        layer: null,
        image: this.imageFor(hotspot, hotspot.id),
        transform,
        position,
        anchor: hotspot.anchor,
        height: hotspot.height,
        scale,
        rotation,
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
      const position: Pt = base ? [base[0] + offset.dx, base[1] + offset.dy] : [0.5, 0.5]
      const scale = layer.scale * offset.scale
      const rotation = layer.rotation + offset.rotation
      const transform: ObjectTransform = {
        origin: base ?? position,
        position,
        scale,
        rotation,
        aspect: this.scene.aspect,
      }
      out.push({
        id: layer.id,
        kind: 'layer',
        hotspot: null,
        layer,
        image: this.imageFor(layer, layer.id),
        transform,
        position,
        anchor: layer.anchor,
        height: layer.height,
        scale,
        rotation,
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
    const mask = this.visibleMask()
    if (!mask) return
    for (const actor of this.actors) {
      updateActor(actor, dt, {
        mask,
        project: (u, v) => project(homography, u, v),
        localScale: (u, v) => localScale(homography, u, v),
        aspect: this.scene.aspect,
        onFootstep: hooks.onFootstep,
        onArrive: hooks.onArrive,
      })
    }
  }

  /** 当前时刻带图热点的共享变换；纯热点返回 null 以保留背景场景语义。 */
  hotspotTransform(hotspotId: string, elapsed = this.lastDrawableElapsed): ObjectTransform | null {
    const hotspot = this.scene.hotspots.find((candidate) => candidate.id === hotspotId)
    if (!hotspot || !isDrawableObject(hotspot)) return null
    const state = this.objectStates.get(hotspot.id)
    if (!state?.visible) return null
    const origin = hotspot.position ?? shapeCenter(hotspot.shape)
    const base = state.position ?? origin
    const offset = animOffset(hotspot.anim, elapsed)
    return {
      origin,
      position: [base[0] + offset.dx, base[1] + offset.dy],
      scale: hotspot.scale * offset.scale,
      rotation: hotspot.rotation + offset.rotation,
      aspect: this.scene.aspect,
    }
  }

  /** 高亮/按压提示使用当前绘制时刻下的变换后热点形状。 */
  hotspotShape(hotspotId: string, elapsed = this.lastDrawableElapsed): Hotspot['shape'] | null {
    const hotspot = this.scene.hotspots.find((candidate) => candidate.id === hotspotId)
    if (!hotspot) return null
    return transformObjectShape(hotspot.shape, this.hotspotTransform(hotspotId, elapsed))
  }

  /**
   * 命中物件：带图热点先按真实绘制顺序（v、同深度定义顺序）从上往下测；
   * 纯热点未参与绘制，作为背景场景命中区仍按原定义顺序优先。
   */
  hotspotAt(x: number, y: number, extraVisible?: (hotspot: Hotspot) => boolean): Hotspot | null {
    const available = (hotspot: Hotspot): boolean =>
      this.isObjectVisible(hotspot.id) && (!extraVisible || extraVisible(hotspot))

    const drawn: Array<{ hotspot: Hotspot; index: number }> = []
    for (let i = 0; i < this.scene.hotspots.length; i++) {
      const hotspot = this.scene.hotspots[i]
      if (!available(hotspot) || !isDrawableObject(hotspot)) continue
      drawn.push({ hotspot, index: i })
    }
    drawn.sort((a, b) => b.hotspot.v - a.hotspot.v || b.index - a.index)
    for (const { hotspot } of drawn) {
      const transform = this.hotspotTransform(hotspot.id)
      if (hitTestTransformedShape(hotspot.shape, x, y, transform)) return hotspot
    }

    for (let i = this.scene.hotspots.length - 1; i >= 0; i--) {
      const hotspot = this.scene.hotspots[i]
      if (!available(hotspot) || isDrawableObject(hotspot)) continue
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
    const mask = this.visibleMask()
    if (!mask || !this.scene.ground || !this.inVisibleScene(x, y)) return false
    const plane = unproject(this.homography, x, y)
    if (!plane) return false
    return isPlaneWalkable(mask, plane[0], plane[1])
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
        /*
         * 音效的新写法在 `effects` 里。
         *
         * 上面那行只认旧字段 `interaction.sfx`，而一旦写了 `effects`，
         * 解析就会用 `summarizeEffects` 把摘要字段覆盖掉 —— 也就是说
         * **新格式的音效永远不会被收进来**。这里补上同一条路径。
         */
        for (const effect of interaction.effects) {
          if (effect.type === 'audio.sfx' && effect.path) paths.push(effect.path)
        }
      }
    }
    for (const actor of scene.actors) if (actor.parts) paths.push(actor.parts)
    /*
     * 去重后返回。
     *
     * 同一个文件确实会被走到两次：`audio.sfx` 写进 effects 之后，
     * `summarizeEffects` 会把它反推回摘要字段 `interaction.sfx`，
     * 于是上面那两条路径都会收到它。返回值是"这个场景要用哪些素材"，
     * 重复项没有意义，还会让预取白跑一趟。
     */
    return [...new Set(paths)]
  }
}

function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

function normalizeRange(start: number, end: number): [number, number] {
  const a = clampUnit(start)
  const b = clampUnit(end)
  return a <= b ? [a, b] : [b, a]
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
