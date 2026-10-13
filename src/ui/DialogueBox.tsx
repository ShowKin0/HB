import type { DialogueLine } from '../engine/game.ts'
import styles from './ui.module.css'

/**
 * 对话框。
 *
 * 外层 .dialogueLayer **始终渲染**，高度固定为 --dialogue-band。两个原因：
 *
 *   1. 它是绝对定位到视口底部的锚点。少了它，对话框会掉进 .root 的 flex 列布局，
 *      被顶到页面左上角 —— 而且 toBeVisible 之类的断言依然会通过，
 *      只有截图能发现。这个坑踩过一次了。
 *   2. 它的高度会被引擎读走，作为场景 letterbox 时底部预留的空间，
 *      于是角色走到房间最前排也不会被对话框盖住。
 */
export function DialogueBox({ line }: { line: DialogueLine | null }): React.ReactElement {
  return (
    <div className={styles.dialogueLayer} data-dialogue-band>
      {line ? (
        <div className={styles.dialogue} role="log" aria-live="polite">
          {line.speaker ? <div className={styles.speaker}>{line.speaker}</div> : null}
          <p className={styles.text}>{line.text}</p>
          <div className={styles.advanceHint}>点击继续</div>
        </div>
      ) : null}
    </div>
  )
}
