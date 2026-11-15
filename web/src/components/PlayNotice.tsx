import { useEffect, useRef, useSyncExternalStore } from 'react'

// Before the first source plays on this device (computer or phone): where sources come from and whose call it
// is to play one, once. See nexttupp.com/terms. The answer stays in this browser, so a phone asks once too.

const KEY = 'nexttupp:sources-ok'
let pending: Array<(ok: boolean) => void> = []
let okThisVisit = false // when storage is blocked, "I understand" still holds until the page reloads
const listeners = new Set<() => void>()
const changed = () => { for (const l of listeners) l() }

export function playAcknowledged (): boolean {
  if (okThisVisit) return true
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

/** Resolves true straight away once acknowledged; otherwise asks first, and resolves with the answer. */
export function askToPlay (): Promise<boolean> {
  if (playAcknowledged()) return Promise.resolve(true)
  return new Promise(resolve => { pending.push(resolve); changed() })
}

function answer (ok: boolean) {
  if (ok) {
    okThisVisit = true
    try { localStorage.setItem(KEY, '1') } catch { /* asks again next visit */ }
  }
  const waiting = pending
  pending = []
  changed()
  for (const r of waiting) r(ok)
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const asking = () => pending.length > 0

export function PlayNotice () {
  const open = useSyncExternalStore(subscribe, asking)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (!open) return
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.showModal()
    dialog.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true })
    return () => back?.focus()
  }, [open])
  if (!open) return null
  return (
    <dialog
      ref={dialog}
      className="preview play-notice"
      aria-labelledby="play-notice-title"
      onCancel={e => { e.preventDefault(); answer(false) }}
      onClick={e => { if (e.target === e.currentTarget) answer(false) }}
    >
      <div className="preview-card play-notice-card">
        <h2 id="play-notice-title" className="play-notice-title">Before you play</h2>
        <p>nexttupp doesn’t host anything. It finds this on BitTorrent, a public file-sharing network, and plays it on your computer, which shares pieces with others while it plays.</p>
        <p>Much of what’s shared there is copyrighted, and the rules differ by country. What you play is your call: play only what you have the right to.</p>
        <div className="play-notice-actions">
          <button type="button" className="button primary" data-autofocus onClick={() => answer(true)}>I understand</button>
          <button type="button" className="button secondary" onClick={() => answer(false)}>Not now</button>
          <a className="inline-link" href="https://nexttupp.com/terms" target="_blank" rel="noreferrer">Read the terms</a>
        </div>
      </div>
    </dialog>
  )
}
