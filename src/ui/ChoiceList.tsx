import type { ChoiceView } from '../engine/ink/inkBridge.ts'
import styles from './ui.module.css'

export function ChoiceList({
  choices,
  onChoose,
}: {
  choices: ChoiceView[]
  onChoose: (index: number) => void
}): React.ReactElement | null {
  if (choices.length === 0) return null
  return (
    <div className={styles.choiceLayer}>
      <div className={styles.choiceList} role="group" aria-label="选择">
        {choices.map((choice) => (
          <button
            key={choice.index}
            type="button"
            className={styles.choice}
            onClick={(event) => {
              event.stopPropagation()
              onChoose(choice.index)
            }}
          >
            {choice.text}
          </button>
        ))}
      </div>
    </div>
  )
}
