import { useEffect } from 'react'
import { useUi } from '../state/store.ts'
import styles from './ui.module.css'

export function Toasts(): React.ReactElement | null {
  const toasts = useUi((state) => state.toasts)
  const dismiss = useUi((state) => state.dismissToast)

  useEffect(() => {
    if (toasts.length === 0) return
    const timers = toasts.map((toast) =>
      window.setTimeout(() => dismiss(toast.id), toast.level === 'error' ? 7000 : 3600),
    )
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [toasts, dismiss])

  if (toasts.length === 0) return null
  return (
    <div className={styles.toasts} role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`${styles.toast} ${toast.level === 'error' ? styles.toastError : ''}`}
          onClick={() => dismiss(toast.id)}
        >
          {toast.message}
        </div>
      ))}
    </div>
  )
}
