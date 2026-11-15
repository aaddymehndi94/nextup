import { useEffect, useState } from 'react'
import { CircleArrowUp, Megaphone, Smartphone, X } from 'lucide-react'
import type { DesktopUpdate } from '../../../shared/desktop.ts'
import { api, type AccountStatus, type LanStatus } from '../api.ts'
import { navigate } from '../router.ts'
import { toast } from '../toast.ts'
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
  if (!u || !desktop || later === laterKey(u)) return <CloudNotice />
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

const SEEN_KEY = 'nexttupp:notice-seen'
const readSeen = () => { try { return localStorage.getItem(SEEN_KEY) } catch { return null } }

/**
 * What the cloud last told this computer. It's read from the computer, never the cloud, so reading it often costs
 * the cloud nothing: at start, a few seconds later (the first sync is just after start), every minute, and on focus.
 */
function useCloudWord (): Pick<AccountStatus, 'announcement' | 'updateRequired'> {
  const [word, setWord] = useState<Pick<AccountStatus, 'announcement' | 'updateRequired'>>({})
  useEffect(() => {
    const read = () => {
      if (document.hidden) return
      api.account().then(s => setWord(w => w.announcement === s.announcement && w.updateRequired === s.updateRequired
        ? w
        : { announcement: s.announcement, updateRequired: s.updateRequired }), () => {})
    }
    read()
    const soon = setTimeout(read, 4000)
    const every = setInterval(read, 60_000)
    window.addEventListener('focus', read)
    return () => { clearTimeout(soon); clearInterval(every); window.removeEventListener('focus', read) }
  }, [])
  return word
}

/**
 * The cloud's word to every app, set by its owner (cloud/src/index.ts): "Update needed" when this version is too
 * old to sync, which comes back each start until the update; or a one-line notice, which goes once read. A newer version that's
 * downloading or ready (above) takes the spot first.
 */
let updateLater = false // "Later" hides Update needed until the app starts again

function CloudNotice () {
  const { announcement, updateRequired } = useCloudWord()
  const [seen, setSeen] = useState(readSeen)
  const [later, setLater] = useState(updateLater)
  if (updateRequired && !later) {
    return (
      <aside className="update-banner" aria-labelledby="update-title">
        <CircleArrowUp className="update-icon" aria-hidden />
        <div className="update-text">
          <p className="update-title" id="update-title">Update needed</p>
          <p className="update-body" role="status">{updateRequired} Your likes and lists are kept on this computer meanwhile.</p>
          <div className="update-actions">
            {desktop
              ? <button type="button" className="button primary" onClick={() => void desktop!.checkForUpdate()}>Get the update</button>
              : <a className="button primary" href="https://nexttupp.com" target="_blank" rel="noreferrer">Get the update</a>}
            <button type="button" className="link" onClick={() => { updateLater = true; setLater(true) }}>Later</button>
          </div>
        </div>
      </aside>
    )
  }
  if (!announcement || seen === announcement) return <HomeNotice />
  const dismiss = () => {
    setSeen(announcement)
    try { localStorage.setItem(SEEN_KEY, announcement) } catch { /* storage unavailable */ }
  }
  return (
    <aside className="update-banner" aria-label="From nexttupp">
      <Megaphone className="update-icon" aria-hidden />
      <div className="update-text">
        <p className="update-body update-notice" role="status">{announcement}</p>
      </div>
      <button type="button" className="icon-button update-close" aria-label="Dismiss" data-tip="Dismiss" onClick={dismiss}><X aria-hidden /></button>
    </aside>
  )
}

const HOME_SEEN_KEY = 'nexttupp:home-notice-seen'

/** Most VPNs keep phones out of the computer they're on (server/lan/net.ts activeVpn). */
export const vpnAdvice = (vpn: string) =>
  `${vpn === 'a VPN' ? 'A VPN' : vpn} is on, and most VPNs keep phones out. In its settings, turn on LAN access (it may be called Local network sharing or Allow local network), or pause it while you watch.`

/**
 * Phones can't reach this computer, and it can tell why: Windows Firewall, or a VPN. Said once per problem, here,
 * since nobody looks in Account until a phone has already failed; Account's "Watch on your phone" keeps saying it.
 */
function HomeNotice () {
  const [problem, setProblem] = useState<{ kind: 'firewall' } | { kind: 'vpn'; vpn: string } | null>(null)
  const [asking, setAsking] = useState(false)
  const [seen, setSeen] = useState(() => { try { return localStorage.getItem(HOME_SEEN_KEY) } catch { return null } })
  useEffect(() => {
    let live = true
    void (async () => {
      const lan: LanStatus = await api.lan()
      if (!lan.local || !lan.phonesEnabled || !lan.listening) return
      if (lan.platform === 'windows' && (await api.firewall()).state === 'blocked') { if (live) setProblem({ kind: 'firewall' }); return }
      if (lan.vpn && live) setProblem({ kind: 'vpn', vpn: lan.vpn })
    })().catch(() => {})
    return () => { live = false }
  }, [])
  if (!problem) return null
  const key = problem.kind === 'vpn' ? `vpn:${problem.vpn}` : 'firewall'
  if (seen === key) return null
  const dismiss = () => {
    setSeen(key)
    try { localStorage.setItem(HOME_SEEN_KEY, key) } catch { /* storage unavailable */ }
  }
  const letIn = async () => {
    setAsking(true)
    let state = 'unknown'
    try { state = (await api.letPhonesIn()).state } catch { /* see Account */ }
    setAsking(false)
    if (state === 'open') { toast('Phones can reach this computer now.'); setProblem(null); return }
    navigate('/account#phones')
  }
  return (
    <aside className="update-banner" aria-labelledby="home-title">
      <Smartphone className="update-icon" aria-hidden />
      <div className="update-text">
        <p className="update-title" id="home-title">{problem.kind === 'firewall' ? 'Phones can’t reach this computer' : 'Your VPN may keep phones out'}</p>
        <p className="update-body" role="status">
          {problem.kind === 'firewall'
            ? 'Windows Firewall is blocking nexttupp on this network, so phones find this computer but never connect.'
            : vpnAdvice(problem.vpn)}
        </p>
        {problem.kind === 'firewall' && (
          <div className="update-actions">
            <button type="button" className="button secondary" disabled={asking} aria-busy={asking || undefined} onClick={() => { void letIn() }}>
              {asking ? 'Choose Yes in Windows’ prompt…' : 'Let phones in'}
            </button>
          </div>
        )}
      </div>
      <button type="button" className="icon-button update-close" aria-label="Not now" data-tip="Not now" onClick={dismiss}><X aria-hidden /></button>
    </aside>
  )
}
