import { useCallback, useEffect, useRef, useState } from 'react'
import { desktop } from '../desktop.ts'
import { AlertTriangle, LogOut, RefreshCw, Tv, X } from 'lucide-react'
import { vpnAdvice } from '../components/UpdateBanner.tsx'
import { type AccountStatus, api, type FirewallState, getActiveProfile, type LanStatus, setActiveProfile } from '../api.ts'
import { useDocumentTitle } from '../hooks.ts'
import { chooseProfile, loadProfiles } from '../profiles.ts'
import { toast } from '../toast.ts'
import { TopBar } from '../components/TopBar.tsx'

// Optional sign-in, so likes, My List and Continue watching follow you between computers. Signed out:
// sign in, or create an account (anyone can). Signed in: a quiet sync line, phones, sign out. The session
// itself stays in this computer's nexttupp server, never in the browser.

type Load = { state: 'loading' } | { state: 'ok'; status: AccountStatus } | { state: 'error'; message: string }

export function Account () {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  useDocumentTitle('Account')

  const refresh = useCallback(() => api.account().then(status => setLoad({ state: 'ok', status })), [])
  useEffect(() => {
    refresh().catch(err => setLoad({ state: 'error', message: (err as Error).message }))
    const t = setInterval(() => { void refresh().catch(() => {}) }, 10_000)
    return () => clearInterval(t)
  }, [refresh])

  return (
    <main className="account-page">
      <TopBar solid />
      <div className="account-body">
        <header className="account-head">
          <h1 className="account-title">Account</h1>
          {load.state === 'ok' && !load.status.signedIn && (location.hash === '#phones'
            ? (
              <p className="account-lede">
                To watch on your phone, sign in here, or create a free account. Then go to nexttupp.com/watch on your phone
                and sign in with the same account.
              </p>
              )
            : (
              <p className="account-lede">
                Sign in, or create a free account, to keep your profiles, likes, My List and Continue watching the same on
                every computer you use, and to watch on your phone. nexttupp works just as well without one.
              </p>
              ))}
        </header>
        {load.state === 'loading' && <div aria-busy="true"><div className="skeleton-line" style={{ width: '50%', height: '1.25rem' }} /></div>}
        {load.state === 'error' && <p className="notice" role="alert">{load.message}</p>}
        {load.state === 'ok' && (load.status.signedIn
          ? <SignedIn status={load.status} onStatus={status => setLoad({ state: 'ok', status })} />
          : <SignedOut status={load.status} onStatus={status => setLoad({ state: 'ok', status })} />)}
        <p className="fine-print account-foot">
          nexttupp hosts no films or music: what you play is your call. <a className="inline-link" href="https://nexttupp.com/terms" target="_blank" rel="noreferrer">Terms of use</a>
        </p>
      </div>
    </main>
  )
}

// ---- Signed out -----------------------------------------------------------------------

/** After sign-in: follow a profile that was merged into the account's, and refresh the profile list. */
async function adoptProfiles (status: AccountStatus) {
  const current = getActiveProfile()
  const target = (current && status.merged?.[current]) ?? current
  if (target) setActiveProfile(target)
  await loadProfiles()
  if (target) chooseProfile(target)
}

/**
 * Signing in, which also makes the account the first time: with Google, in the computer's own browser (Google
 * doesn't allow sign-in inside an app's window). The browser comes back to this computer, which signs in; this
 * page notices within a couple of seconds and carries on.
 */
function SignedOut ({ status, onStatus }: { status: AccountStatus; onStatus: (s: AccountStatus) => void }) {
  const [waiting, setWaiting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    // In a plain browser tab, a window opened after a fetch gets blocked: open it now, point it at Google next.
    // The desktop app sends any outside link to the system browser instead.
    const tab = desktop ? null : window.open('about:blank', '_blank')
    if (tab) tab.opener = null // the pages it goes to can't reach back into this one
    try {
      const { url } = await api.googleLink()
      if (tab) tab.location.href = url
      else window.open(url, '_blank', 'noopener')
      setWaiting(true)
    } catch (err) {
      tab?.close()
      setError((err as Error).message)
    }
    setBusy(false)
  }

  // While the browser is out at Google, look every 2 s (this computer, not the cloud) and on coming back here.
  useEffect(() => {
    if (!waiting) return
    let done = false
    let seen = 0
    const look = async () => {
      const next = await api.account().catch(() => null)
      if (done || !next?.signedIn) return
      // The first sync matches this computer's profiles to the account's: let it finish (20 s at most).
      seen ||= Date.now()
      if (next.sync?.state === 'syncing' && Date.now() - seen < 20_000) return
      done = true
      await adoptProfiles(next)
      toast('You’re signed in')
      onStatus(next)
    }
    const t = setInterval(() => { void look() }, 2000)
    window.addEventListener('focus', look)
    return () => { done = true; clearInterval(t); window.removeEventListener('focus', look) }
  }, [waiting, onStatus])

  return (
    <>
      {status.notice && <p className="account-notice" role="status">{status.notice}</p>}
      <div className="account-form" aria-label="Sign in" role="group">
        {waiting && (
          <p className="account-sent" role="status">
            Finish signing in with Google in your browser. This page carries on by itself once you have.
          </p>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="actions">
          {!waiting
            ? (
              <button type="button" className="button google-button" disabled={busy} onClick={() => { void open() }}>
                {busy ? <span className="spinner" aria-hidden /> : <GoogleMark />}
                {busy ? 'Opening your browser…' : 'Continue with Google'}
              </button>
              )
            : (
              <>
                <button type="button" className="button secondary" disabled={busy} onClick={() => { void open() }}>
                  {busy && <span className="spinner" aria-hidden />}
                  {busy ? 'Opening your browser…' : 'Open the browser again'}
                </button>
                <button type="button" className="inline-link" onClick={() => setWaiting(false)}>Cancel</button>
              </>
              )}
        </div>
        <p className="fine-print">By continuing, you agree to the <a className="inline-link" href="https://nexttupp.com/terms" target="_blank" rel="noreferrer">terms</a>.</p>
      </div>
      <p className="fine-print account-fine">
        Already have an account? Pick the Google account with the same email, and it’s all there. New to nexttupp? This
        makes your free account. Only profiles, ratings, My List, watch progress and taste settings sync, by title id.
        What you search for and stream stays on this computer.
      </p>
    </>
  )
}

/** Google's "G", in its own colours: the one mark Google asks sign-in buttons to carry. */
export function GoogleMark () {
  return (
    <svg className="google-mark" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}

// ---- Signed in ------------------------------------------------------------------------

function ago (ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export function syncLine (sync: NonNullable<AccountStatus['sync']>, now = Date.now()): string {
  const waiting = sync.pending > 0 ? ` · ${sync.pending === 1 ? '1 change' : `${sync.pending} changes`} waiting` : ''
  switch (sync.state) {
    case 'syncing': return 'Syncing…'
    case 'offline': return `Offline, will retry${waiting}`
    case 'error': return `Couldn’t sync${sync.error ? `: ${sync.error.replace(/\.$/, '')}` : ''}. Will retry`
    default: return sync.lastSyncAt ? `Synced ${ago(sync.lastSyncAt, now)}` : 'Not synced yet'
  }
}

function SignedIn ({ status, onStatus }: { status: AccountStatus; onStatus: (s: AccountStatus) => void }) {
  const [syncing, setSyncing] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [lan, setLan] = useState<LanStatus | null>(null)
  const account = status.account!
  const sync = status.sync!

  const refreshLan = useCallback(() => api.lan().then(setLan).catch(() => {}), [])
  useEffect(() => {
    void refreshLan()
    const t = setInterval(() => { void refreshLan() }, 15_000)
    return () => clearInterval(t)
  }, [refreshLan])

  const syncNow = async () => {
    setSyncing(true)
    try {
      onStatus(await api.syncNow())
      await loadProfiles()
    } catch (err) { toast(`Couldn’t sync. ${(err as Error).message}`) }
    setSyncing(false)
  }

  const signOut = async () => {
    setLeaving(true)
    try { onStatus(await api.logout()) } catch (err) { toast(`Couldn’t sign out. ${(err as Error).message}`); setLeaving(false) }
  }

  return (
    <>
      <section className="account-who" aria-label="Signed in">
        <p className="account-email">{account.displayName ? <>{account.displayName} <span className="quiet">· {account.email}</span></> : account.email}</p>
        <p className="account-sync" role="status">
          <span>{syncing ? 'Syncing…' : syncLine(sync)}</span>
          <button type="button" className="text-button" onClick={syncNow} disabled={syncing}><RefreshCw aria-hidden />Sync now</button>
        </p>
      </section>
      {lan && !lan.local && (
        <section className="account-section" aria-label="This phone">
          <p className="account-note">This phone is connected to <strong>{lan.name}</strong>. Account settings are changed on that computer.</p>
          <a className="text-button" href="https://nexttupp.com/watch?choose">Switch computer</a>
        </section>
      )}
      {lan?.local && <Phones lan={lan} onLan={setLan} />}
      {lan?.local !== false && <section className="account-section" aria-labelledby="leave-h">
        <h2 id="leave-h" className="sr-only">Sign out</h2>
        <button type="button" className="text-button" onClick={signOut} disabled={leaving}><LogOut aria-hidden />{leaving ? 'Signing out…' : 'Sign out'}</button>
        <p className="fine-print">Your profiles and history stay on this computer. They sync again when you sign back in.</p>
      </section>}
    </>
  )
}

// ---- Watch on your phone ------------------------------------------------------------------

/**
 * Windows Firewall can keep phones out without a word: the phone just waits (server/lan/firewall.ts). Shown only
 * when it does, with the fix: Windows asks the person to confirm (UAC), then it's checked again.
 */
function FirewallNotice () {
  const [state, setState] = useState<FirewallState | 'declined' | 'asking'>('unknown')
  const [tried, setTried] = useState(false)
  useEffect(() => { api.firewall().then(r => setState(r.state), () => {}) }, [])
  const letIn = async () => {
    setState('asking')
    let next: FirewallState | 'declined' = 'unknown'
    try { next = (await api.letPhonesIn()).state } catch { /* stays unknown */ }
    setTried(true)
    setState(next)
    if (next === 'open') toast('Phones can reach this computer now.')
  }
  if (state === 'open' || state === 'n/a' || (state === 'unknown' && !tried)) return null
  const text = state === 'declined'
    ? 'Windows didn’t get the go-ahead. Choose Let phones in, then Yes.'
    : tried && state !== 'asking'
      ? 'That didn’t take. In Windows Security, open Firewall & network protection, then Allow an app through firewall, and tick Private and Public for nexttupp.'
      : 'Windows Firewall is keeping phones out on this network. They’ll find this computer but never connect.'
  return (
    <div className="lan-firewall">
      <p className="note warn" role="status"><AlertTriangle aria-hidden />{text}</p>
      <button type="button" className="button secondary" disabled={state === 'asking'} aria-busy={state === 'asking' || undefined} onClick={() => { void letIn() }}>
        {state === 'asking' ? 'Choose Yes in Windows’ prompt…' : 'Let phones in'}
      </button>
    </div>
  )
}

/**
 * "Add a TV": a 4-digit code for the nexttupp TV app. While it shows, this page asks this computer (never the
 * cloud) every 2 seconds whether a new phone or TV has joined, and names the one that did.
 */
function AddTv ({ clients, onLan }: { clients: string[]; onLan: (l: LanStatus) => void }) {
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [expired, setExpired] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const before = useRef(new Set(clients))
  // The pressed button goes away when the code arrives, and Cancel when it goes: keep keyboard focus in this block.
  const add = useRef<HTMLButtonElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const hadFocus = useRef(false)
  const close = (next: { expired?: boolean } = {}) => {
    hadFocus.current = document.activeElement === cancel.current
    setCode(null)
    setExpired(Boolean(next.expired))
  }
  useEffect(() => {
    if (code) cancel.current?.focus()
    else if (hadFocus.current) { add.current?.focus(); hadFocus.current = false }
  }, [code])

  const start = async () => {
    setBusy(true); setError(null); setExpired(false)
    try {
      before.current = new Set(clients)
      setCode(await api.tvCode())
    } catch (err) { setError((err as Error).message) }
    setBusy(false)
  }

  useEffect(() => {
    if (!code) return
    const id = setInterval(() => {
      if (Date.now() > code.expiresAt) { close({ expired: true }); return }
      api.lan().then(l => {
        const joined = l.clients.find(c => !before.current.has(c.id))
        if (!joined) return
        close()
        onLan(l)
        toast(`${joined.label} is connected.`)
      }).catch(() => {})
    }, 2000)
    return () => clearInterval(id)
  }, [code, onLan])

  const where = <strong className="phone-qr-url">nexttupp.com/tv</strong>
  return (
    <div className="tv-pair" aria-live="polite">
      <h3 className="lan-list-title">On your TV</h3>
      {code
        ? (
          <>
            <p className="tv-code"><span aria-hidden>{code.code}</span><span className="sr-only">Code {code.code.split('').join(' ')}</span></p>
            <p className="account-note">Type this in the nexttupp app on your TV (get it at {where}). It works once, for 10 minutes.</p>
            <div className="tv-waiting">
              <span className="tv-waiting-line"><span className="spinner" aria-hidden />Waiting for the TV…</span>
              <button type="button" ref={cancel} className="inline-link" onClick={() => close()}>Cancel</button>
            </div>
          </>
          )
        : (
          <>
            <p className="account-note">
              {expired
                ? 'That code ran out. Get a new one when the TV is ready.'
                : <>Get the app on an Android TV or Google TV at {where}, open it on the same Wi-Fi, and it asks for a code.</>}
            </p>
            <button type="button" ref={add} className="button secondary" disabled={busy} onClick={() => { void start() }}>
              {busy ? <span className="spinner" aria-hidden /> : <Tv aria-hidden />}{busy ? 'Getting a code…' : expired ? 'Get a new code' : 'Add a TV'}
            </button>
          </>
          )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  )
}

function Phones ({ lan, onLan }: { lan: LanStatus; onLan: (l: LanStatus) => void }) {
  const [name, setName] = useState(lan.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setName(lan.name) }, [lan.name])

  const save = async (body: { enabled?: boolean; name?: string }) => {
    setBusy(true)
    setError(null)
    try { onLan(await api.setLan(body)) } catch (err) { setError((err as Error).message) }
    setBusy(false)
  }
  const saveName = () => { if (name.trim() !== lan.name) void save({ name: name.trim() }) }
  const remove = async (id: string) => {
    try {
      await api.removeLanClient(id)
      onLan({ ...lan, clients: lan.clients.filter(c => c.id !== id) })
      toast('Removed.')
    } catch (err) { toast(`Couldn’t remove it. ${(err as Error).message}`) }
  }

  // Arrived from "Watch on your phone" in the profile menu.
  const section = useRef<HTMLElement>(null)
  useEffect(() => { if (location.hash === '#phones') section.current?.scrollIntoView({ block: 'start' }) }, [])

  const now = Date.now()
  return (
    <section className="account-section" id="phones" ref={section} aria-labelledby="lan-h">
      <h2 id="lan-h" className="section-title">Watch on your phone</h2>
      <label className="switch-row">
        <span className="switch-text">
          <span className="switch-label">Let phones play from this computer</span>
          <span className="account-note">
            Films play on a phone or TV on the same Wi-Fi, streamed from this computer. You can also press Cast in the player.
          </span>
        </span>
        <input type="checkbox" role="switch" className="switch" checked={lan.enabled} disabled={busy} onChange={e => { void save({ enabled: e.target.checked }) }} />
      </label>
      {lan.enabled && (
        <>
          {lan.platform === 'windows' && lan.listening && <FirewallNotice />}
          {lan.vpn && <p className="note warn lan-vpn" role="status"><AlertTriangle aria-hidden />{vpnAdvice(lan.vpn)}</p>}
          <div className="phone-qr">
            <img src="/watch-qr.svg" alt="QR code for nexttupp.com/watch" width={132} height={132} />
            <p className="account-note">
              On your phone, scan this with the camera or go to <strong className="phone-qr-url">nexttupp.com/watch</strong>,
              and sign in with this account. Add it to the home screen, and it opens straight to this computer next time.
            </p>
          </div>
          <label className="field lan-name">
            <span className="field-label">This computer’s name, as your phone or TV shows it</span>
            <input value={name} maxLength={40} placeholder={lan.defaultName} onChange={e => setName(e.target.value)} onBlur={saveName}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
          </label>
          {lan.urls.length === 0 && <p className="fine-print">Not on a home network right now.</p>}
          <AddTv clients={lan.clients.map(c => c.id)} onLan={onLan} />
        </>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <h3 className="lan-list-title">Connected phones and TVs</h3>
      {lan.clients.length === 0
        ? <p className="account-note">None yet.</p>
        : (
          <ul className="device-list" aria-label="Connected phones and TVs">
            {lan.clients.map(c => (
              <li key={c.id} className="device-row lan-row">
                <span className="lan-client">
                  <span>{c.label}</span>
                  <span className="device-state">Connected {new Date(c.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · used {ago(c.lastUsedAt, now)}</span>
                </span>
                <button type="button" className="text-button" onClick={() => { void remove(c.id) }} aria-label={`Remove ${c.label}`}><X aria-hidden />Remove</button>
              </li>
            ))}
          </ul>
          )}
      <p className="fine-print">
        While this is on, this computer’s name and its address on your home network go to nexttupp’s service, so your phone can
        find it. Nothing plays through the service: the video goes straight from this computer to your phone.
      </p>
    </section>
  )
}
