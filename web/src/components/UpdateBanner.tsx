import { useState } from 'react'
import { CircleArrowUp, X } from 'lucide-react'
import type { DesktopUpdate } from '../../../shared/desktop.ts'
import { desktop, useDesktopUpdate } from '../desktop.ts'

const LATER_KEY = 'nexttupp:update-later'
/** "Later" lasts until the app restarts, and a finished download asks again. */
const laterKey = (u: DesktopUpdate) => `${u.version}:${u.state === 'ready' ? 'ready' : 'before'}`
const readLater = () => { try { return sessionStorage.getItem(LATER_KEY) } catch { return null } }

/**
 * A newer nexttupp (desktop app only): it downloads by itself, then one click installs it and restarts. Shown on
 * every launch until updated; "Later" hides it until the next launch or until the download finishes.
 */
export function UpdateBanner () {
  const u = useDesktopUpdate()
  const [later, setLater] = useState(readLater)
  if (!u || !desktop || later === laterKey(u)) return null
  const dismiss = () => {
    const key = laterKey(u)
    setLater(key)
    try { sessionStorage.setItem(LATER_KEY, key) } catch { /* storage unavailable */ }
  }
  const pct = Math.round((u.progress ?? 0) * 100)
  const news = <a className="link" href={u.url} target="_blank" rel="noreferrer">What’s new</a>

  let title: string
  let body: string
  let actions = null
  switch (u.state) {
    case 'available':
      title = `nexttupp ${u.version} is out`
      body = `You have ${u.current}. Download the new version from its release page.`
      actions = <><button type="button" className="button primary" onClick={() => desktop!.installUpdate()}>Download</button>{news}</>
      break
    case 'downloading':
      title = `Getting nexttupp ${u.version}`
      body = pct > 0 ? `Downloading in the background: ${pct}%.` : 'Downloading in the background.'
      break
    case 'ready':
      title = `nexttupp ${u.version} is ready`
      body = u.error ?? `Restart to update. It takes a few seconds${u.needsPassword ? ', and your computer will ask for your password' : ''}.`
      actions = <><button type="button" className="button primary" onClick={() => desktop!.installUpdate()}>Restart now</button>{news}</>
      break
    case 'installing':
      title = `Installing nexttupp ${u.version}`
      body = u.needsPassword ? 'Type your computer’s password if it asks. nexttupp restarts by itself.' : 'nexttupp restarts by itself.'
      break
    case 'failed':
      title = `Couldn’t get nexttupp ${u.version}`
      body = `${u.error ? `${u.error[0].toUpperCase()}${u.error.slice(1)}.` : ''} You can also download it yourself.`
      actions = <><button type="button" className="button primary" onClick={() => void desktop!.checkForUpdate()}>Try again</button><a className="link" href={u.url} target="_blank" rel="noreferrer">Release page</a></>
      break
  }

  return (
    <aside className="update-banner" aria-labelledby="update-title">
      <CircleArrowUp className="update-icon" aria-hidden />
      <div className="update-text">
        <p className="update-title" id="update-title">{title}</p>
        <p className="update-body" role="status">{body}</p>
        {u.state === 'downloading' && (
          <span className="update-bar" role="progressbar" aria-label="Download" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${Math.max(2, pct)}%` }} />
          </span>
        )}
        {actions && <div className="update-actions">{actions}</div>}
      </div>
      {u.state !== 'installing' && (
        <button type="button" className="icon-button update-close" aria-label="Later" data-tip="Later" onClick={dismiss}><X aria-hidden /></button>
      )}
    </aside>
  )
}
