import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SceneSchema, resolveInteractions, type Hotspot, type Interaction, type Scene } from '../schema/scene.ts'
import { loadContent } from '../content/load.ts'
import { AssetStore } from '../engine/assets.ts'
import { SceneRuntime } from '../engine/scene/runtime.ts'
import { CanvasStage } from '../render/stage.ts'
import { renderScene } from '../render/sceneRenderer.ts'
import { project, solveHomography, unproject, type Homography, type Pt } from '../render/homography.ts'
import { planeToCell } from '../engine/nav/mask.ts'
import { MASK_BLOCKED, MASK_WALKABLE } from '../schema/common.ts'
import styles from './editor.module.css'

/**
 * 场景编辑器。
 *
 * 手写归一化坐标是不可持续的 —— 所以这个编辑器是必要工程，不是锦上添花。
 * 它只做一件事：让你用鼠标把场景"摆"出来，然后导出一份合法的场景 JSON。
 *
 * 只在开发模式可用（见 App.tsx 的路由）。
 */

/** 新建物件的完整默认值。schema 里所有字段都有默认值，但编辑器直接构造对象， 所以必须补齐。 */
function emptyHotspot(): Hotspot {
  return {
    id: '',
    shape: { type: 'rect', x: 0, y: 0, w: 0, h: 0 },
    label: '',
    cursor: 'look',
    visibleWhen: null,
    approach: null,
    interactions: [],
    image: null,
    visualStates: {},
    initialState: null,
    position: null,
    anchor: [0.5, 0.5],
    height: 0.3,
    scale: 1,
    rotation: 0,
    v: 0.5,
    shadow: false,
    anim: { type: 'none', amplitude: 0.008, speed: 0.6, phase: 0 },
    onClick: null,
    acceptsItem: null,
    onUse: null,
  }
}

/** 新建一条交互。 */
function emptyInteraction(): Interaction {
  return {
    verb: 'inspect',
    when: null,
    item: null,
    accepts: [],
    action: '',
    setState: null,
    setVisible: null,
    emit: null,
    sfx: null,
  }
}

/** 新建一个图层。 */
function emptyLayer(index: number) {
  return {
    id: `layer_${index}`,
    image: '',
    visualStates: {},
    initialState: null,
    position: null,
    anchor: [0.5, 0.5] as [number, number],
    height: 0.3,
    scale: 1,
    rotation: 0,
    v: 0.9,
    shadow: false,
    anim: { type: 'none' as const, amplitude: 0.008, speed: 0.6, phase: 0 },
    visibleWhen: null,
  }
}

type Tool = 'select' | 'ground' | 'hotspot' | 'walk' | 'block' | 'approach' | 'spawn' | 'size'

const TOOL_LABELS: Record<Tool, string> = {
  select: '选择',
  ground: '地面四角',
  hotspot: '画热点',
  walk: '涂可走',
  block: '涂阻挡',
  approach: '走位点',
  spawn: '出生点',
  size: '角色身高',
}

const TOOL_HINTS: Record<Tool, string> = {
  select: '拖动热点 / 地面角点 / 走位点。',
  ground: '拖动四个角点对齐照片里的地面。顺序固定：后左 → 后右 → 前右 → 前左。四角构成矩形时会自动退化为正交场景。',
  hotspot: '在画面上拖出一个矩形，松开即创建热点。',
  walk: '按住拖动，把格子涂成可走。',
  block: '按住拖动，把格子涂成阻挡。',
  approach: '点一下，把当前位置设为选中热点的走位点。',
  spawn: '点一下，把角色出生点设到那里。',
  size: '上下拖动，调整角色身高。',
}

function newSceneTemplate(id: string): Scene {
  return SceneSchema.parse({
    id,
    title: '新场景',
    bg: null,
    ground: {
      corners: [
        [0.1, 0.55],
        [0.9, 0.55],
        [1, 0.98],
        [0, 0.98],
      ],
    },
    walkable: Array.from({ length: 16 }, () => MASK_WALKABLE.repeat(32)),
    actors: [{ id: 'hero', spawn: [0.5, 0.85], heightRatio: 0.22, speed: 0.42 }],
    hotspots: [],
    exits: [],
    entry: null,
    hub: null,
  })
}

interface DragState {
  kind: 'ground' | 'hotspot' | 'approach' | 'spawn' | 'size' | 'newHotspot' | 'paint'
  index: number
  startScene?: Pt
}

export function Editor(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<CanvasStage | null>(null)
  const runtimeRef = useRef<SceneRuntime | null>(null)
  const assetsRef = useRef(new AssetStore())

  const [allScenes, setAllScenes] = useState<Scene[]>([])
  const [draft, setDraft] = useState<Scene | null>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [selectedHotspot, setSelectedHotspot] = useState<string | null>(null)
  const [viewport, setViewport] = useState({ x: 0, y: 0, w: 0, h: 0 })
  const [missing, setMissing] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const dragRef = useRef<DragState | null>(null)
  /** 新建热点的 id 序号。用计数器而不是 Date.now()，避免在渲染期调用非纯函数。 */
  const idSeqRef = useRef(0)

  // ── 载入内容 ──────────────────────────────────────────────
  useEffect(() => {
    void loadContent().then((content) => {
      const scenes = [...content.scenes.values()]
      setAllScenes(scenes)
      // 默认打开起始场景，而不是字母序第一个 ——
      // Map 的顺序来自文件名的字典序，hall 会排在 start 前面，
      // 那样一进编辑器就在改错的场景。
      const initial =
        scenes.find((scene) => scene.id === content.startSceneId) ?? scenes[0] ?? newSceneTemplate('new_scene')
      setDraft(JSON.parse(JSON.stringify(initial)) as Scene)
      setMissing(content.warnings)
    })
  }, [])

  // ── 由草稿构建运行时（图片走缓存，因此重建很便宜）──────────
  useEffect(() => {
    if (!draft || !canvasRef.current) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void SceneRuntime.create(draft, assetsRef.current).then((runtime) => {
        if (cancelled) return
        runtimeRef.current = runtime
        setMissing(assetsRef.current.missingAssets)
      })
    }, 120)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [draft])

  // ── 画布尺寸与绘制循环 ────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const stage = new CanvasStage(canvas, { aspect: draft?.aspect ?? 16 / 9 })
    stageRef.current = stage

    let raf = 0
    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      const runtime = runtimeRef.current
      if (!runtime) return
      const parent = canvas.parentElement
      if (parent) {
        const rect = parent.getBoundingClientRect()
        stage.aspect = runtime.aspect
        stage.resize(rect.width, rect.height)
        setViewport((prev) =>
          Math.abs(prev.w - stage.viewport.w) > 0.5 || Math.abs(prev.x - stage.viewport.x) > 0.5
            ? { ...stage.viewport }
            : prev,
        )
      }
      renderScene({
        runtime,
        stage,
        resources: new Map(),
        debug: { ground: false, mask: true, paths: false, anchors: true },
      })
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [draft?.aspect])

  // ── 投影 ─────────────────────────────────────────────────
  const ground = draft?.ground ?? null
  const homography: Homography | null = useMemo(
    () => (ground ? solveHomography(ground.corners) : null),
    [ground],
  )

  const toScreen = useCallback(
    (x: number, y: number): [number, number] => [viewport.x + x * viewport.w, viewport.y + y * viewport.h],
    [viewport],
  )

  const scenePointOf = (event: React.PointerEvent): Pt | null => {
    const stage = stageRef.current
    if (!stage) return null
    return stage.toScene(event.clientX, event.clientY)
  }

  const patch = (updater: (scene: Scene) => Scene): void => {
    setDraft((prev) => (prev ? updater(prev) : prev))
  }

  // ── 指针交互 ─────────────────────────────────────────────
  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (!draft) return
    const point = scenePointOf(event)
    if (!point) return
    ;(event.target as Element).setPointerCapture?.(event.pointerId)

    if (tool === 'walk' || tool === 'block') {
      dragRef.current = { kind: 'paint', index: 0 }
      paint(point, tool === 'walk')
      return
    }
    if (tool === 'approach' && selectedHotspot) {
      patch((scene) => ({
        ...scene,
        hotspots: scene.hotspots.map((h) => (h.id === selectedHotspot ? { ...h, approach: [point[0], point[1]] } : h)),
      }))
      return
    }
    if (tool === 'spawn') {
      patch((scene) => ({
        ...scene,
        actors: scene.actors.map((a, i) => (i === 0 ? { ...a, spawn: [point[0], point[1]] } : a)),
      }))
      return
    }
    if (tool === 'hotspot') {
      dragRef.current = { kind: 'newHotspot', index: 0, startScene: point }
      return
    }
  }

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (!draft) return
    const point = scenePointOf(event)
    if (!point) return

    if (tool === 'walk' || tool === 'block') {
      if (dragRef.current?.kind === 'paint') paint(point, tool === 'walk')
      return
    }

    const drag = dragRef.current
    if (!drag) return

    if (drag.kind === 'ground' && draft.ground) {
      // zod 推断出的是可变元组，而 Pt 是只读的，这里显式构造新元组
      const corners = draft.ground.corners.map((c, i): [number, number] =>
        i === drag.index ? [point[0], point[1]] : [c[0], c[1]],
      )
      patch((scene) => ({
        ...scene,
        ground: { corners: [corners[0], corners[1], corners[2], corners[3]] },
      }))
      return
    }

    if (drag.kind === 'hotspot') {
      patch((scene) => ({
        ...scene,
        hotspots: scene.hotspots.map((h, i) =>
          i === drag.index && h.shape.type === 'rect'
            ? { ...h, shape: { ...h.shape, x: point[0], y: point[1] } }
            : h,
        ),
      }))
      return
    }

    if (drag.kind === 'approach') {
      patch((scene) => ({
        ...scene,
        hotspots: scene.hotspots.map((h, i) =>
          i === drag.index ? { ...h, approach: [point[0], point[1]] } : h,
        ),
      }))
      return
    }

    if (drag.kind === 'spawn') {
      patch((scene) => ({
        ...scene,
        actors: scene.actors.map((a, i) => (i === drag.index ? { ...a, spawn: [point[0], point[1]] } : a)),
      }))
      return
    }

    if (drag.kind === 'size') {
      patch((scene) => ({
        ...scene,
        actors: scene.actors.map((a, i) =>
          i === drag.index ? { ...a, heightRatio: Math.max(0.03, Math.min(1.2, a.spawn[1] - point[1])) } : a,
        ),
      }))
    }
  }

  const handlePointerUp = (event: React.PointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current
    dragRef.current = null
    if (!draft || !drag) return

    if (drag.kind === 'newHotspot' && drag.startScene) {
      const point = scenePointOf(event) ?? drag.startScene
      const x = Math.min(drag.startScene[0], point[0])
      const y = Math.min(drag.startScene[1], point[1])
      const w = Math.abs(point[0] - drag.startScene[0])
      const h = Math.abs(point[1] - drag.startScene[1])
      if (w < 0.01 || h < 0.01) return
      idSeqRef.current += 1
      const id = `hs_${idSeqRef.current}`
      patch((scene) => ({
        ...scene,
        hotspots: [
          ...scene.hotspots,
          {
            ...emptyHotspot(),
            id,
            shape: { type: 'rect', x, y, w, h },
            label: '新热点',
          },
        ],
      }))
      setSelectedHotspot(id)
      setTool('select')
    }
  }

  const paint = (point: Pt, walkable: boolean): void => {
    if (!draft?.walkable || !homography) return
    // 复用渲染层已测试过的逆变换，不要在这里手写一遍单应矩阵求逆
    const plane = unproject(homography, point[0], point[1])
    if (!plane || plane[0] < 0 || plane[0] > 1 || plane[1] < 0 || plane[1] > 1) return
    const cols = draft.walkable[0].length
    const rows = draft.walkable.length
    const [col, row] = planeToCell({ cols, rows, cells: new Uint8Array(cols * rows) }, plane[0], plane[1])
    const char = walkable ? MASK_WALKABLE : MASK_BLOCKED
    if (draft.walkable[row][col] === char) return
    patch((scene) => ({
      ...scene,
      walkable: scene.walkable?.map((line, r) =>
        r === row ? `${line.slice(0, col)}${char}${line.slice(col + 1)}` : line,
      ) ?? null,
    }))
  }

  // ── 导出 ─────────────────────────────────────────────────
  const exportScene = (): void => {
    if (!draft) return
    const parsed = SceneSchema.safeParse(draft)
    if (!parsed.success) {
      setStatus(`校验失败：${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`)
      return
    }
    const blob = new Blob([`${JSON.stringify(parsed.data, null, 2)}\n`], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${parsed.data.id}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    setStatus(`已导出 ${parsed.data.id}.json —— 覆盖 content/scenes/${parsed.data.id}.json 即可`)
  }

  if (!draft) {
    return (
      <div className={styles.root}>
        <div className={styles.sidebar}>正在载入内容……</div>
      </div>
    )
  }

  const actor = draft.actors[0]
  const spawnScreen = actor ? toScreen(actor.spawn[0], actor.spawn[1]) : null
  const sizeScreen = actor ? toScreen(actor.spawn[0], actor.spawn[1] - actor.heightRatio) : null

  return (
    <div className={styles.root}>
      <div className={styles.sidebar}>
        <h1 className={styles.title}>场景编辑器</h1>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>场景</div>
          <div className={styles.row}>
            <select
              className={styles.select}
              aria-label="当前场景"
              value={draft.id}
              onChange={(event) => {
                const found = allScenes.find((s) => s.id === event.target.value)
                if (found) {
                  setDraft(JSON.parse(JSON.stringify(found)) as Scene)
                  setSelectedHotspot(null)
                }
              }}
            >
              {allScenes.map((scene) => (
                <option key={scene.id} value={scene.id}>
                  {scene.id}
                </option>
              ))}
              <option value={draft.id}>{draft.id}（当前）</option>
            </select>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>模式</span>
            <select
              className={styles.select}
              aria-label="场景模式"
              value={draft.mode ?? 'auto'}
              onChange={(event) => {
                const value = event.target.value
                // 切到 focus 时顺手清掉地面与角色 —— 否则会留下一个不合法组合
                if (value === 'focus') {
                  patch((scene) => ({ ...scene, mode: 'focus', ground: null, walkable: null, actors: [] }))
                } else if (value === 'walk') {
                  patch((scene) => ({ ...scene, mode: 'walk' }))
                } else {
                  patch((scene) => ({ ...scene, mode: null }))
                }
              }}
            >
              <option value="auto">自动推断</option>
              <option value="walk">walk 角色可走动</option>
              <option value="focus">focus 固定镜头特写</option>
            </select>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>id</span>
            <input
              className={styles.input}
              value={draft.id}
              onChange={(event) => patch((scene) => ({ ...scene, id: event.target.value }))}
            />
          </div>
          <div className={styles.row}>
            <span className={styles.label}>标题</span>
            <input
              className={styles.input}
              value={draft.title}
              onChange={(event) => patch((scene) => ({ ...scene, title: event.target.value }))}
            />
          </div>
          <div className={styles.row}>
            <span className={styles.label}>背景图</span>
            <input
              className={styles.input}
              placeholder="bg/room.avif"
              value={draft.bg ?? ''}
              onChange={(event) => patch((scene) => ({ ...scene, bg: event.target.value || null }))}
            />
          </div>
          <div className={styles.row}>
            <span className={styles.label}>entry</span>
            <input
              className={styles.input}
              placeholder="ink knot"
              value={draft.entry ?? ''}
              onChange={(event) => patch((scene) => ({ ...scene, entry: event.target.value || null }))}
            />
          </div>
          <div className={styles.row}>
            <span className={styles.label}>hub</span>
            <input
              className={styles.input}
              placeholder="交互后返回的 knot"
              value={draft.hub ?? ''}
              onChange={(event) => patch((scene) => ({ ...scene, hub: event.target.value || null }))}
            />
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>工具</div>
          <div className={styles.toolbar}>
            {(Object.keys(TOOL_LABELS) as Tool[]).map((key) => (
              <button
                key={key}
                type="button"
                className={`${styles.button} ${tool === key ? styles.buttonActive : ''}`}
                onClick={() => setTool(key)}
              >
                {TOOL_LABELS[key]}
              </button>
            ))}
          </div>
          <p className={styles.mono} style={{ marginTop: 8 }}>
            {TOOL_HINTS[tool]}
          </p>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>角色</div>
          {actor ? (
            <>
              <div className={styles.row}>
                <span className={styles.label}>渲染器</span>
                <select
                  className={styles.select}
                  value={actor.renderer}
                  onChange={(event) =>
                    patch((scene) => ({
                      ...scene,
                      actors: scene.actors.map((a, i) => (i === 0 ? { ...a, renderer: event.target.value } : a)),
                    }))
                  }
                >
                  {['partRig', 'glide', 'spriteSheet'].map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.row}>
                <span className={styles.label}>身高</span>
                <input
                  className={styles.input}
                  type="number"
                  step={0.01}
                  value={actor.heightRatio}
                  onChange={(event) =>
                    patch((scene) => ({
                      ...scene,
                      actors: scene.actors.map((a, i) =>
                        i === 0 ? { ...a, heightRatio: Number(event.target.value) || 0.2 } : a,
                      ),
                    }))
                  }
                />
              </div>
              <div className={styles.row}>
                <span className={styles.label}>速度</span>
                <input
                  className={styles.input}
                  type="number"
                  step={0.05}
                  value={actor.speed}
                  onChange={(event) =>
                    patch((scene) => ({
                      ...scene,
                      actors: scene.actors.map((a, i) =>
                        i === 0 ? { ...a, speed: Number(event.target.value) || 0.4 } : a,
                      ),
                    }))
                  }
                />
              </div>
              <div className={styles.row}>
                <span className={styles.label}>出生点</span>
                <span className={styles.mono}>
                  {actor.spawn[0].toFixed(3)}, {actor.spawn[1].toFixed(3)}
                </span>
              </div>
            </>
          ) : (
            <p className={styles.mono}>该场景没有角色（纯热点场景，不允许行走）。</p>
          )}
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>热点</div>
          {draft.hotspots.map((hotspot, index) => (
            <div
              key={hotspot.id}
              className={`${styles.hotspotItem} ${selectedHotspot === hotspot.id ? styles.hotspotSelected : ''}`}
              onClick={() => setSelectedHotspot(hotspot.id)}
            >
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{hotspot.id}</span>
              <button
                type="button"
                className={styles.button}
                onClick={(event) => {
                  event.stopPropagation()
                  patch((scene) => ({ ...scene, hotspots: scene.hotspots.filter((_, i) => i !== index) }))
                }}
              >
                删
              </button>
            </div>
          ))}
          {selectedHotspot ? (
            <HotspotEditor
              scene={draft}
              hotspotId={selectedHotspot}
              onChange={patch}
              onKnotFocus={() => undefined}
            />
          ) : (
            <p className={styles.mono}>选一个热点，或用"画热点"工具新建。</p>
          )}
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>图层</div>
          <p className={styles.mono}>
            图层不参与交互，只负责画：遮挡角色的桌沿、抽屉开合的图、光影变化。
            位置留空表示整帧铺满（旧式前景层）。
          </p>
          {draft.layers.map((layer, index) => (
            <div key={layer.id} className={styles.card}>
              <div className={styles.row}>
                <span className={styles.label}>id</span>
                <input
                  className={styles.input}
                  value={layer.id}
                  onChange={(e) =>
                    patch((scene) => ({
                      ...scene,
                      layers: scene.layers.map((l, i) => (i === index ? { ...l, id: e.target.value } : l)),
                    }))
                  }
                />
                <button
                  type="button"
                  className={styles.button}
                  onClick={() =>
                    patch((scene) => ({ ...scene, layers: scene.layers.filter((_, i) => i !== index) }))
                  }
                >
                  删
                </button>
              </div>
              <div className={styles.row}>
                <span className={styles.label}>图片</span>
                <input
                  className={styles.input}
                  placeholder="fg/table.avif"
                  value={layer.image}
                  onChange={(e) =>
                    patch((scene) => ({
                      ...scene,
                      layers: scene.layers.map((l, i) => (i === index ? { ...l, image: e.target.value } : l)),
                    }))
                  }
                />
              </div>
              <div className={styles.row}>
                <span className={styles.label}>深度 v</span>
                <input
                  className={styles.input}
                  type="number"
                  step={0.01}
                  value={layer.v}
                  onChange={(e) =>
                    patch((scene) => ({
                      ...scene,
                      layers: scene.layers.map((l, i) => (i === index ? { ...l, v: Number(e.target.value) } : l)),
                    }))
                  }
                />
                <span className={styles.label}>高度</span>
                <input
                  className={styles.input}
                  type="number"
                  step={0.01}
                  value={layer.height}
                  onChange={(e) =>
                    patch((scene) => ({
                      ...scene,
                      layers: scene.layers.map((l, i) => (i === index ? { ...l, height: Number(e.target.value) } : l)),
                    }))
                  }
                />
              </div>
              <div className={styles.row}>
                <span className={styles.label}>动效</span>
                <select
                  className={styles.select}
                  value={layer.anim.type}
                  onChange={(e) =>
                    patch((scene) => ({
                      ...scene,
                      layers: scene.layers.map((l, i) =>
                        i === index ? { ...l, anim: { ...l.anim, type: e.target.value as typeof l.anim.type } } : l,
                      ),
                    }))
                  }
                >
                  <option value="none">无</option>
                  <option value="float">浮动</option>
                  <option value="sway">摇摆</option>
                  <option value="pulse">呼吸</option>
                </select>
                <span className={styles.label}>条件</span>
                <input
                  className={styles.input}
                  placeholder="ink 函数名"
                  value={layer.visibleWhen ?? ''}
                  onChange={(e) =>
                    patch((scene) => ({
                      ...scene,
                      layers: scene.layers.map((l, i) =>
                        i === index ? { ...l, visibleWhen: e.target.value || null } : l,
                      ),
                    }))
                  }
                />
              </div>
            </div>
          ))}
          <div className={styles.row}>
            <button
              type="button"
              className={styles.button}
              onClick={() =>
                patch((scene) => ({ ...scene, layers: [...scene.layers, emptyLayer(scene.layers.length + 1)] }))
              }
            >
              加图层
            </button>
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>可行走掩码</div>
          <p className={styles.mono}>
            {draft.walkable ? `${draft.walkable[0].length} × ${draft.walkable.length}` : '无（该场景不可行走）'}
            {'\n'}
            用"涂可走 / 涂阻挡"直接在地面上画。
          </p>
        </div>

        {missing.length > 0 ? (
          <div className={styles.section}>
            <div className={styles.sectionTitle}>缺失素材</div>
            <p className={`${styles.mono} ${styles.warn}`}>{missing.join('\n')}</p>
          </div>
        ) : null}

        <div className={styles.section}>
          <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={exportScene}>
            导出场景 JSON
          </button>
          <button
            type="button"
            className={styles.button}
            style={{ width: '100%', marginTop: 6 }}
            onClick={() => {
              idSeqRef.current += 1
              setDraft(newSceneTemplate(`scene_${idSeqRef.current}`))
              setSelectedHotspot(null)
            }}
          >
            新建空场景
          </button>
          {status ? <p className={styles.mono} style={{ marginTop: 8 }}>{status}</p> : null}
        </div>
      </div>

      <div className={styles.stage}>
        <canvas ref={canvasRef} className={styles.canvas} />
        <svg
          className={styles.overlay}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          {/*
            整块透明底板。没有它，空白处的指针事件不一定会落到 <svg> 上
            （根 svg 没有填充时命中测试不可靠），涂色与放置走位点就会"点了没反应"。
          */}
          <rect x={0} y={0} width="100%" height="100%" fill="transparent" />

          {/* 地面四角与投影网格 */}
          {draft.ground ? (
            <>
              <polygon
                points={draft.ground.corners.map(([x, y]) => toScreen(x, y).join(',')).join(' ')}
                fill="none"
                stroke="#7cc8ff"
                strokeWidth={2}
              />
              {homography
                ? Array.from({ length: 5 }, (_, i) => i / 4).flatMap((t) =>
                    [0, 1].map((edge) => {
                      const a = project(homography, t, edge === 0 ? 0 : 1)
                      const b = project(homography, t, edge === 0 ? 1 : 0)
                      const [ax, ay] = toScreen(a[0], a[1])
                      const [bx, by] = toScreen(b[0], b[1])
                      return <line key={`v${t}-${edge}`} x1={ax} y1={ay} x2={bx} y2={by} stroke="#7cc8ff" strokeOpacity={0.25} />
                    }),
                  )
                : null}
              {homography
                ? Array.from({ length: 5 }, (_, i) => i / 4).map((t) => {
                    const a = project(homography, 0, t)
                    const b = project(homography, 1, t)
                    const [ax, ay] = toScreen(a[0], a[1])
                    const [bx, by] = toScreen(b[0], b[1])
                    return <line key={`h${t}`} x1={ax} y1={ay} x2={bx} y2={by} stroke="#7cc8ff" strokeOpacity={0.25} />
                  })
                : null}
              {draft.ground.corners.map(([x, y], i) => {
                const [sx, sy] = toScreen(x, y)
                return (
                  <circle
                    key={i}
                    cx={sx}
                    cy={sy}
                    r={7}
                    fill="#0b0a09"
                    stroke="#7cc8ff"
                    strokeWidth={2}
                    style={{ ...pointerEventsFor(tool === 'select' || tool === 'ground'), cursor: 'grab' }}
                    onPointerDown={(event) => {
                      event.stopPropagation()
                      dragRef.current = { kind: 'ground', index: i }
                    }}
                  />
                )
              })}
            </>
          ) : null}

          {/* 热点 */}
          {draft.hotspots.map((hotspot) => {
            const selected = hotspot.id === selectedHotspot
            const stroke = selected ? '#d9a566' : 'rgba(217,165,102,0.5)'
            if (hotspot.shape.type === 'rect') {
              const [x, y] = toScreen(hotspot.shape.x, hotspot.shape.y)
              return (
                <g key={hotspot.id}>
                  <rect
                    x={x}
                    y={y}
                    width={hotspot.shape.w * viewport.w}
                    height={hotspot.shape.h * viewport.h}
                    fill={selected ? 'rgba(217,165,102,0.14)' : 'transparent'}
                    stroke={stroke}
                    strokeWidth={1.5}
                    style={{ ...pointerEventsFor(tool === 'select'), cursor: 'move' }}
                    onPointerDown={(event) => {
                      event.stopPropagation()
                      setSelectedHotspot(hotspot.id)
                      dragRef.current = { kind: 'hotspot', index: draft.hotspots.indexOf(hotspot) }
                    }}
                  />
                  <text x={x + 4} y={y + 14} fill={stroke} fontSize={12} style={{ pointerEvents: 'none' }}>
                    {hotspot.id}
                  </text>
                </g>
              )
            }
            if (hotspot.shape.type === 'circle') {
              const [cx, cy] = toScreen(hotspot.shape.cx, hotspot.shape.cy)
              return (
                <g key={hotspot.id}>
                  <circle
                    cx={cx}
                    cy={cy}
                    r={hotspot.shape.r * viewport.w}
                    fill={selected ? 'rgba(217,165,102,0.14)' : 'transparent'}
                    stroke={stroke}
                    strokeWidth={1.5}
                    style={{ ...pointerEventsFor(tool === 'select'), cursor: 'move' }}
                  />
                  <text x={cx} y={cy} fill={stroke} fontSize={12} style={{ pointerEvents: 'none' }}>
                    {hotspot.id}
                  </text>
                </g>
              )
            }
            return (
              <polygon
                key={hotspot.id}
                points={hotspot.shape.points.map(([x, y]) => toScreen(x, y).join(',')).join(' ')}
                fill="transparent"
                stroke={stroke}
                strokeWidth={1.5}
              />
            )
          })}

          {/* 走位点 */}
          {draft.hotspots.map((hotspot, index) =>
            hotspot.approach ? (
              <rect
                key={`ap-${hotspot.id}`}
                x={toScreen(hotspot.approach[0], hotspot.approach[1])[0] - 5}
                y={toScreen(hotspot.approach[0], hotspot.approach[1])[1] - 5}
                width={10}
                height={10}
                transform={`rotate(45 ${toScreen(hotspot.approach[0], hotspot.approach[1])[0]} ${toScreen(hotspot.approach[0], hotspot.approach[1])[1]})`}
                fill="#7bd88f"
                stroke="#0b0a09"
                style={{ ...pointerEventsFor(tool === 'select'), cursor: 'move' }}
                onPointerDown={(event) => {
                  event.stopPropagation()
                  setSelectedHotspot(hotspot.id)
                  dragRef.current = { kind: 'approach', index }
                }}
              />
            ) : null,
          )}

          {/* 出生点与身高标尺 */}
          {actor && spawnScreen ? (
            <>
              <line
                x1={spawnScreen[0] - 9}
                y1={spawnScreen[1]}
                x2={spawnScreen[0] + 9}
                y2={spawnScreen[1]}
                stroke="#ff5a8a"
                strokeWidth={2}
              />
              <line
                x1={spawnScreen[0]}
                y1={spawnScreen[1]}
                x2={spawnScreen[0]}
                y2={sizeScreen![1]}
                stroke="#ff5a8a"
                strokeWidth={2}
                strokeDasharray="4 3"
                style={{ ...pointerEventsFor(tool === 'select' || tool === 'size'), cursor: 'ns-resize' }}
                onPointerDown={(event) => {
                  event.stopPropagation()
                  dragRef.current = { kind: 'size', index: 0 }
                }}
              />
              <circle
                cx={spawnScreen[0]}
                cy={sizeScreen![1]}
                r={6}
                fill="#0b0a09"
                stroke="#ff5a8a"
                strokeWidth={2}
                style={{ ...pointerEventsFor(tool === 'select' || tool === 'size'), cursor: 'ns-resize' }}
                onPointerDown={(event) => {
                  event.stopPropagation()
                  dragRef.current = { kind: 'size', index: 0 }
                }}
              />
              <circle
                cx={spawnScreen[0]}
                cy={spawnScreen[1]}
                r={5}
                fill="#0b0a09"
                stroke="#ff5a8a"
                strokeWidth={2}
                style={{ ...pointerEventsFor(tool === 'select' || tool === 'size'), cursor: 'move' }}
                onPointerDown={(event) => {
                  event.stopPropagation()
                  dragRef.current = { kind: 'spawn', index: 0 }
                }}
              />
            </>
          ) : null}
        </svg>
        <div className={styles.hint}>
          {draft.id} · 工具：{TOOL_LABELS[tool]}
          {homography && Math.abs(homography.m[6]) + Math.abs(homography.m[7]) < 1e-6
            ? ' · 当前为矩形地面（正交退化）'
            : ' · 当前为透视地面'}
        </div>
      </div>
    </div>
  )
}

/** 从草稿的单应矩阵反解地面平面坐标。 */
function pointerEventsFor(active: boolean): { pointerEvents: 'auto' | 'none' } {
  return { pointerEvents: active ? 'auto' : 'none' }
}

function HotspotEditor({
  scene,
  hotspotId,
  onChange,
  onKnotFocus,
}: {
  scene: Scene
  hotspotId: string
  onChange: (updater: (scene: Scene) => Scene) => void
  onKnotFocus: () => void
}): React.ReactElement | null {
  const hotspot = scene.hotspots.find((h) => h.id === hotspotId)
  if (!hotspot) return null
  const update = (next: Partial<typeof hotspot>): void =>
    onChange((current) => ({
      ...current,
      hotspots: current.hotspots.map((h) => (h.id === hotspotId ? { ...h, ...next } : h)),
    }))

  /** 旧字段合成出来的交互也要显示出来，否则老场景打开像是"没有交互"。 */
  const effective = resolveInteractions(hotspot)
  const usingLegacy = hotspot.interactions.length === 0 && effective.length > 0

  const updateInteraction = (index: number, next: Partial<Interaction>): void => {
    const list = (hotspot.interactions.length > 0 ? hotspot.interactions : effective).map((item, i) =>
      i === index ? { ...item, ...next } : item,
    )
    // 一旦编辑就落成新形态，旧字段清空，避免两套并存
    update({ interactions: list, onClick: null, acceptsItem: null, onUse: null })
  }

  const removeInteraction = (index: number): void => {
    const list = (hotspot.interactions.length > 0 ? hotspot.interactions : effective).filter(
      (_, i) => i !== index,
    )
    update({ interactions: list, onClick: null, acceptsItem: null, onUse: null })
  }

  const addInteraction = (): void => {
    const list = hotspot.interactions.length > 0 ? hotspot.interactions : effective
    update({ interactions: [...list, emptyInteraction()], onClick: null, acceptsItem: null, onUse: null })
  }

  const states = Object.entries(hotspot.visualStates)

  const setStateEntry = (name: string, image: string): void =>
    update({ visualStates: { ...hotspot.visualStates, [name]: image } })

  const removeState = (name: string): void => {
    const next = { ...hotspot.visualStates }
    delete next[name]
    update({ visualStates: next, initialState: hotspot.initialState === name ? null : hotspot.initialState })
  }

  return (
    <>
      <div className={styles.row}>
        <span className={styles.label}>id</span>
        <input className={styles.input} value={hotspot.id} onChange={(e) => update({ id: e.target.value })} />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>标签</span>
        <input className={styles.input} value={hotspot.label} onChange={(e) => update({ label: e.target.value })} />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>显示条件</span>
        <input
          className={styles.input}
          placeholder="ink 函数名"
          value={hotspot.visibleWhen ?? ''}
          onChange={(e) => update({ visibleWhen: e.target.value || null })}
        />
      </div>

      {/* ── 外观：有图才会被画出来；没有图就是纯命中区 ── */}
      <div className={styles.sectionTitle}>外观（可选）</div>
      <div className={styles.row}>
        <span className={styles.label}>图片</span>
        <input
          className={styles.input}
          placeholder="如 photo/frame.avif"
          value={hotspot.image ?? ''}
          onChange={(e) => update({ image: e.target.value || null })}
        />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>高度</span>
        <input
          className={styles.input}
          type="number"
          step={0.01}
          value={hotspot.height}
          onChange={(e) => update({ height: Number(e.target.value) || 0.3 })}
        />
        <span className={styles.label}>深度 v</span>
        <input
          className={styles.input}
          type="number"
          step={0.01}
          value={hotspot.v}
          onChange={(e) => update({ v: Number(e.target.value) })}
        />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>锚点</span>
        <input
          className={styles.input}
          type="number"
          step={0.1}
          value={hotspot.anchor[0]}
          onChange={(e) => update({ anchor: [Number(e.target.value), hotspot.anchor[1]] })}
        />
        <input
          className={styles.input}
          type="number"
          step={0.1}
          value={hotspot.anchor[1]}
          onChange={(e) => update({ anchor: [hotspot.anchor[0], Number(e.target.value)] })}
        />
        <button type="button" className={styles.button} onClick={() => update({ position: null })}>
          位置归位
        </button>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>影子</span>
        <input
          type="checkbox"
          checked={hotspot.shadow}
          onChange={(e) => update({ shadow: e.target.checked })}
        />
        <span className={styles.label}>动效</span>
        <select
          className={styles.input}
          value={hotspot.anim.type}
          onChange={(e) => update({ anim: { ...hotspot.anim, type: e.target.value as typeof hotspot.anim.type } })}
        >
          <option value="none">无</option>
          <option value="float">浮动</option>
          <option value="sway">摇摆</option>
          <option value="pulse">呼吸</option>
        </select>
      </div>

      {/* ── 视觉状态：抽屉开/关、相框亮/暗 ── */}
      <div className={styles.sectionTitle}>视觉状态</div>
      {states.map(([name, image]) => (
        <div key={name} className={styles.row}>
          <input
            className={styles.input}
            value={name}
            onChange={(e) => {
              const next = { ...hotspot.visualStates }
              delete next[name]
              next[e.target.value] = image
              update({
                visualStates: next,
                initialState: hotspot.initialState === name ? e.target.value : hotspot.initialState,
              })
            }}
          />
          <input className={styles.input} value={image} onChange={(e) => setStateEntry(name, e.target.value)} />
          <button type="button" className={styles.button} onClick={() => removeState(name)}>
            删
          </button>
        </div>
      ))}
      <div className={styles.row}>
        <button type="button" className={styles.button} onClick={() => setStateEntry(`state_${states.length + 1}`, '')}>
          加状态
        </button>
        <span className={styles.label}>初始</span>
        <select
          className={styles.input}
          value={hotspot.initialState ?? ''}
          onChange={(e) => update({ initialState: e.target.value || null })}
        >
          <option value="">（用基础图）</option>
          {states.map(([name]) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      {/* ── 交互：一个物件可以挂多条，按动词 + 条件筛选 ── */}
      <div className={styles.sectionTitle}>
        交互{usingLegacy ? '（当前由旧字段合成，编辑后转为新格式）' : ''}
      </div>
      {effective.map((interaction, index) => (
        <div key={index} className={styles.card}>
          <div className={styles.row}>
            <select
              className={styles.input}
              value={interaction.verb}
              onChange={(e) => updateInteraction(index, { verb: e.target.value as Interaction['verb'] })}
            >
              <option value="inspect">inspect 点击</option>
              <option value="use">use 用物品</option>
              <option value="drag">drag 拖放</option>
              <option value="hold">hold 长按（未实现）</option>
              <option value="sequence">sequence 顺序（未实现）</option>
            </select>
            <input
              className={styles.input}
              placeholder="ink knot"
              value={interaction.action}
              onChange={(e) => updateInteraction(index, { action: e.target.value })}
              onFocus={onKnotFocus}
            />
            <button type="button" className={styles.button} onClick={() => removeInteraction(index)}>
              删
            </button>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>条件</span>
            <input
              className={styles.input}
              placeholder="ink 函数名（可空）"
              value={interaction.when ?? ''}
              onChange={(e) => updateInteraction(index, { when: e.target.value || null })}
            />
          </div>
          {interaction.verb === 'use' ? (
            <div className={styles.row}>
              <span className={styles.label}>物品</span>
              <input
                className={styles.input}
                value={interaction.item ?? ''}
                onChange={(e) => updateInteraction(index, { item: e.target.value || null })}
              />
            </div>
          ) : null}
          {interaction.verb === 'drag' ? (
            <div className={styles.row}>
              <span className={styles.label}>接受</span>
              <input
                className={styles.input}
                placeholder="物品 id，逗号分隔"
                value={interaction.accepts.join(',')}
                onChange={(e) =>
                  updateInteraction(index, {
                    accepts: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </div>
          ) : null}
          <div className={styles.row}>
            <span className={styles.label}>切状态</span>
            <select
              className={styles.input}
              value={interaction.setState ?? ''}
              onChange={(e) => updateInteraction(index, { setState: e.target.value || null })}
            >
              <option value="">（不改）</option>
              {states.map(([name]) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <span className={styles.label}>事件名</span>
            <input
              className={styles.input}
              placeholder="默认 id_verb"
              value={interaction.emit ?? ''}
              onChange={(e) => updateInteraction(index, { emit: e.target.value || null })}
            />
          </div>
        </div>
      ))}
      <div className={styles.row}>
        <button type="button" className={styles.button} onClick={addInteraction}>
          加交互
        </button>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>走位点</span>
        <span className={styles.mono}>
          {hotspot.approach ? `${hotspot.approach[0].toFixed(3)}, ${hotspot.approach[1].toFixed(3)}` : '无（角色不参与）'}
        </span>
        <button type="button" className={styles.button} onClick={() => update({ approach: null })}>
          清空
        </button>
      </div>
    </>
  )
}
