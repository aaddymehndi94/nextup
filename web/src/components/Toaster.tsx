import { dismissToast, useToast } from '../toast.ts'

/** The current toast, at the foot of the screen. Announced politely to screen readers. */
export function Toaster () {
  const t = useToast()
  return (
    <div className="snackbar-region" role="status" aria-live="polite">
      {t && (
        <div className="snackbar" key={t.id}>
          <span className="snackbar-text">{t.text}</span>
          {t.action && (
            <button type="button" className="link" onClick={() => { t.action!.run(); dismissToast() }}>{t.action.label}</button>
          )}
        </div>
      )}
    </div>
  )
}
