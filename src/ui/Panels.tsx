import { useEffect } from 'react'
import { listActorRenderers } from '../actorRenderers/registry.ts'
import { listDirectives } from '../engine/directives/registry.ts'
import type { Game } from '../engine/game.ts'
import { AUTO_SLOT, MANUAL_SLOTS } from '../engine/save.ts'
import { listMiniGames } from '../minigames/registry.ts'
import { useAudioSettings, useUi, type PanelKind } from '../state/store.ts'
import styles from './ui.module.css'

export interface PanelsProps {
  game: Game | null
  onClose: () => void
  onLoadSlot: (slot: string) => void
  onRestart: () => void
}

export function Panels({ game, onClose, onLoadSlot, onRestart }: PanelsProps): React.ReactElement | null {
  const panel = useUi((state) => state.panel)
  if (panel === 'none') return null

  return (
    <div
      className={styles.backdrop}
      onClick={(event) => {
        event.stopPropagation()
        onClose()
      }}
    >
      <div className={styles.panel} onClick={(event) => event.stopPropagation()}>
        {panel === 'settings' ? <SettingsPanel /> : null}
        {panel === 'saves' ? <SavesPanel game={game} onLoadSlot={onLoadSlot} onRestart={onRestart} /> : null}
        {panel === 'debug' ? <DebugPanel game={game} /> : null}
        {panel === 'credits' ? <CreditsPanel /> : null}
      </div>
    </div>
  )
}

function SettingsPanel(): React.ReactElement {
  const audio = useAudioSettings((state) => state.audio)
  const setAudio = useAudioSettings((state) => state.setAudio)

  // 同步交给 GameShell（它总是挂载）；面板这里只负责读写设置本身
  const slider = (
    key: 'master' | 'bgm' | 'sfx' | 'vo',
    label: string,
  ): React.ReactElement => (
    <div className={styles.row} key={key}>
      <span className={styles.rowLabel}>{label}</span>
      <input
        className={styles.slider}
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={audio[key]}
        onChange={(event) => setAudio({ [key]: Number(event.target.value) })}
        aria-label={label}
      />
    </div>
  )

  return (
    <>
      <h2 className={styles.panelTitle}>设置</h2>
      {slider('master', '总音量')}
      {slider('bgm', '背景乐')}
      {slider('sfx', '音效')}
      {slider('vo', '配音')}
      <div className={styles.row}>
        <span className={styles.rowLabel}>静音</span>
        <button
          type="button"
          className={styles.ghostButton}
          onClick={() => setAudio({ muted: !audio.muted })}
        >
          {audio.muted ? '已静音' : '正常'}
        </button>
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>恢复默认</span>
        <button
          type="button"
          className={styles.ghostButton}
          onClick={() => setAudio({ master: 0.9, bgm: 0.55, sfx: 0.8, vo: 1, muted: false })}
        >
          重置
        </button>
      </div>
    </>
  )
}

function SavesPanel({
  game,
  onLoadSlot,
  onRestart,
}: {
  game: Game | null
  onLoadSlot: (slot: string) => void
  onRestart: () => void
}): React.ReactElement {
  const slots = useUi((state) => state.slots)
  const setSlots = useUi((state) => state.setSlots)
  const refresh = (): void => setSlots(game?.saves.list() ?? [])

  useEffect(refresh, [game, setSlots])

  const formatTime = (timestamp: number): string => {
    if (!timestamp) return '—'
    const date = new Date(timestamp)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  const slotRow = (slot: string, label: string, manual: boolean): React.ReactElement => {
    const info = slots.find((entry) => entry.slot === slot)
    return (
      <div className={styles.row} key={slot}>
        <span className={styles.rowLabel}>
          {label}
          <br />
          <span className={styles.rowValue}>
            {info ? `${formatTime(info.updatedAt)} · ${Math.round(info.playMs / 1000)} 秒` : '空'}
          </span>
        </span>
        <span className={styles.toggleGroup}>
          {manual ? (
            <button
              type="button"
              className={styles.ghostButton}
              onClick={() => {
                game?.saveTo(slot, label)
                refresh()
              }}
            >
              保存
            </button>
          ) : null}
          <button
            type="button"
            className={styles.ghostButton}
            disabled={!info}
            onClick={() => onLoadSlot(slot)}
          >
            读取
          </button>
        </span>
      </div>
    )
  }

  return (
    <>
      <h2 className={styles.panelTitle}>存档</h2>
      {slotRow(AUTO_SLOT, '自动存档', false)}
      {MANUAL_SLOTS.map((slot) => slotRow(slot, `存档 ${slot}`, true))}
      <div className={styles.row}>
        <span className={styles.rowLabel}>从头开始</span>
        <button type="button" className={styles.ghostButton} onClick={onRestart}>
          重新开始
        </button>
      </div>
      <p className={styles.mono}>
        {game?.saves.available
          ? '进度会在每次剧情推进后自动保存，关掉浏览器再打开会接着上次继续。'
          : '当前浏览器不允许本地存储（可能是隐私模式），进度无法保存，但游戏仍可正常游玩。'}
      </p>
    </>
  )
}

function DebugPanel({ game }: { game: Game | null }): React.ReactElement {
  const debug = useUi((state) => state.debug)
  const flags = useUi((state) => state.debugFlags)
  const toggle = useUi((state) => state.toggleDebugFlag)

  const flagLabels: Record<keyof typeof flags, string> = {
    ground: '地面标定',
    mask: '可行走网格',
    paths: '角色路径',
    anchors: '角色锚点',
  }

  return (
    <>
      <h2 className={styles.panelTitle}>调试</h2>
      <div className={styles.toggleGroup} style={{ padding: '10px 0' }}>
        {(Object.keys(flagLabels) as (keyof typeof flags)[]).map((key) => (
          <button
            key={key}
            type="button"
            className={`${styles.ghostButton} ${flags[key] ? styles.hudButtonActive : ''}`}
            onClick={() => toggle(key)}
          >
            {flagLabels[key]}
          </button>
        ))}
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>帧率</span>
        <span className={styles.rowValue}>{debug ? debug.fps.toFixed(0) : '—'} fps</span>
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>场景</span>
        <span className={styles.rowValue}>{debug?.sceneId ?? '—'}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>角色平面坐标</span>
        <span className={styles.rowValue}>
          {debug ? `${debug.actorU.toFixed(3)}, ${debug.actorV.toFixed(3)}` : '—'}
        </span>
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>速度 / 相位</span>
        <span className={styles.rowValue}>
          {debug ? `${debug.speed.toFixed(2)}  ${((debug.phase / (Math.PI * 2)) * 100).toFixed(0)}%` : '—'}
        </span>
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>行走混合</span>
        <span className={styles.rowValue}>{debug ? debug.walkBlend.toFixed(2) : '—'}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>朝向</span>
        <span className={styles.rowValue}>{debug ? debug.facing.toFixed(2) : '—'}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>缺失素材</span>
        <span className={styles.rowValue}>
          {debug && debug.missingAssets.length > 0 ? debug.missingAssets.join(', ') : '无'}
        </span>
      </div>
      {/*
        剧情标记（`# flag:` / `# unlock:`）。
        它们一直会被写进存档并持久化，但此前**没有任何地方能看见** ——
        作者写了标记，游戏里看不出有没有生效，也无从调试。
      */}
      <div className={styles.row}>
        <span className={styles.rowLabel}>剧情标记</span>
        <span className={styles.rowValue}>
          {debug && Object.keys(debug.flags).length > 0
            ? Object.entries(debug.flags)
                .map(([key, value]) => `${key}=${String(value)}`)
                .join(', ')
            : '无'}
        </span>
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>已注册渲染器</span>
        <span className={styles.rowValue}>{listActorRenderers().join(', ') || '—'}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>已注册小游戏</span>
        <span className={styles.rowValue}>{listMiniGames().map((g) => g.id).join(', ') || '—'}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>可用演出指令</span>
        <span className={styles.rowValue}>{listDirectives().join(', ') || '—'}</span>
      </div>
      {debug && debug.warnings.length > 0 ? (
        <pre className={`${styles.mono} ${styles.errorText}`}>{debug.warnings.join('\n')}</pre>
      ) : null}
      {game ? (
        <p className={styles.mono}>
          当前场景使用的渲染器：
          {game.sceneRuntime?.actors.map((a) => `${a.spec.id}=${a.spec.renderer}`).join(', ') || '—'}
        </p>
      ) : null}
    </>
  )
}

function CreditsPanel(): React.ReactElement {
  return (
    <>
      <h2 className={styles.panelTitle}>素材来源</h2>
      <p className={styles.mono}>
        上线前请把每一份素材的来源与许可记录到项目根目录的 CREDITS.md 里。
        {'\n\n'}
        需要登记的至少包括：背景图与立绘的生成方式或作者、字体（思源宋体 / 霞鹜文楷均为 SIL OFL）、
        BGM 与音效的出处、以及任何第三方代码的许可。
      </p>
    </>
  )
}

export type { PanelKind }
