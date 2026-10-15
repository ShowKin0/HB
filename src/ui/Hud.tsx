import styles from './ui.module.css'

export interface HudProps {
  panel: string
  onTogglePanel: (panel: 'settings' | 'saves' | 'debug' | 'credits') => void
  inventory: string[]
  selectedItem: string | null
  onSelectItem: (itemId: string | null) => void
  itemLabel: (itemId: string) => string
}

export function Hud({
  panel,
  onTogglePanel,
  inventory,
  selectedItem,
  onSelectItem,
  itemLabel,
}: HudProps): React.ReactElement {
  return (
    <>
      <div className={styles.hud} data-hud>
        <button
          type="button"
          className={`${styles.hudButton} ${panel === 'saves' ? styles.hudButtonActive : ''}`}
          onClick={(event) => {
            event.stopPropagation()
            onTogglePanel('saves')
          }}
          aria-label="存档"
        >
          存档
        </button>
        <button
          type="button"
          className={`${styles.hudButton} ${panel === 'settings' ? styles.hudButtonActive : ''}`}
          onClick={(event) => {
            event.stopPropagation()
            onTogglePanel('settings')
          }}
          aria-label="设置"
        >
          设置
        </button>
        <button
          type="button"
          className={`${styles.hudButton} ${panel === 'debug' ? styles.hudButtonActive : ''}`}
          onClick={(event) => {
            event.stopPropagation()
            onTogglePanel('debug')
          }}
          aria-label="调试"
        >
          调试
        </button>
      </div>

      {inventory.length > 0 ? (
        <div className={styles.inventory} role="list" aria-label="物品栏">
          {inventory.map((itemId) => (
            <button
              key={itemId}
              type="button"
              role="listitem"
              className={`${styles.item} ${selectedItem === itemId ? styles.itemSelected : ''}`}
              onClick={(event) => {
                event.stopPropagation()
                onSelectItem(selectedItem === itemId ? null : itemId)
              }}
            >
              {itemLabel(itemId)}
            </button>
          ))}
        </div>
      ) : null}
    </>
  )
}
