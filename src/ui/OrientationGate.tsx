import styles from './ui.module.css'
import { tryLockLandscape } from './useOrientation.ts'
import type { Orientation } from '../content/project.rules.ts'

/**
 * 竖屏引导。
 *
 * 这个游戏以**横屏为主要形态**。竖屏时不隐藏内容、不报错，而是明确告诉
 * 玩家把手机转过来 —— 总比让人对着一个被压扁的布局猜"是不是坏了"好。
 *
 * 显示与否交给 CSS（`@media (orientation: portrait)`）：首帧就是对的，
 * 不会先闪一下再盖住，也没有 resize 监听器要清理。
 * 暂停游戏是 useOrientationBlocked 的事。
 */
export function OrientationGate({ required }: { required: Orientation }): React.ReactElement | null {
  if (required === 'auto') return null

  return (
    <div className={styles.orientationGate} data-orientation-gate data-required-orientation={required}>
      <div className={styles.orientationCard}>
        <div className={styles.orientationIcon} aria-hidden="true">
          <span className={styles.orientationPhone} />
        </div>
        <p className={styles.orientationTitle}>{required === 'landscape' ? '请把手机横过来' : '请把手机竖过来'}</p>
        <p className={styles.orientationHint}>{required === 'landscape' ? '这个内容是按横屏设计的。' : '这个内容是按竖屏设计的。'}</p>
        {required === 'landscape' ? <button
          type="button"
          className={styles.ghostButton}
          onClick={() => {
            void tryLockLandscape()
          }}
        >
          全屏并尝试锁定横屏
        </button> : null}
      </div>
    </div>
  )
}
