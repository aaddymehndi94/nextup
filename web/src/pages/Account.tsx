import { useCallback, useEffect, useRef, useState } from 'react'
import { LogOut, RefreshCw, X } from 'lucide-react'
import { type AccountStatus, api, getActiveProfile, type LanStatus, setActiveProfile } from '../api.ts'
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

function SignedOut ({ status, onStatus }: { status: AccountStatus; onStatus: (s: AccountStatus) => void }) {
  const [mode, setMode] = useState<'signin' | 'create'>('signin')
  const [form, setForm] = useState({ email: '', password: '', displayName: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const create = mode === 'create'
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [k]: e.target.value }))
  const ready = form.email.trim() && form.password && (!create || [...form.password].length >= 8)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      const next = create
        ? await api.signup({ email: form.email.trim(), password: form.password, displayName: form.displayName.trim() || undefined })
        : await api.login(form.email.trim(), form.password)
      await adoptProfiles(next)
      toast(create ? 'Account created. You’re signed in.' : 'Signed in')
      onStatus(next)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <>
      {status.notice && <p className="account-notice" role="status">{status.notice}</p>}
      <div className="account-tabs" role="group" aria-label="Sign in or create an account">
        <button type="button" className="chip" aria-pressed={!create} onClick={() => { setMode('signin'); setError(null) }}>Sign in</button>
        <button type="button" className="chip" aria-pressed={create} onClick={() => { setMode('create'); setError(null) }}>Create account</button>
      </div>
      <form className="account-form" onSubmit={submit} aria-label={create ? 'Create account' : 'Sign in'}>
        <label className="field">
          <span className="field-label">Email</span>
          <input type="email" value={form.email} onChange={set('email')} autoComplete="email" spellCheck={false} required />
        </label>
        <label className="field">
          <span className="field-label">{create ? 'Choose a password (8 or more characters)' : 'Password'}</span>
          <input type="password" value={form.password} onChange={set('password')} autoComplete={create ? 'new-password' : 'current-password'} minLength={create ? 8 : undefined} maxLength={256} required />
        </label>
        {create && (
          <label className="field">
            <span className="field-label">Your name <span className="field-hint">(optional)</span></span>
            <input value={form.displayName} onChange={set('displayName')} autoComplete="nickname" maxLength={40} />
          </label>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="actions">
          <button type="submit" className="button primary" disabled={!ready || busy}>
            {busy && <span className="spinner" aria-hidden />}
            {busy ? (create ? 'Creating your account…' : 'Signing in…') : create ? 'Create account' : 'Sign in'}
          </button>
        </div>
      </form>
      <p className="fine-print account-fine">
        {create ? 'It’s free, and anyone can make one.' : 'Made your account on nexttupp.com? Sign in with it here. New to nexttupp? Choose Create account. It’s free.'}
        {' '}Only profiles, ratings, My List, watch progress and taste settings sync, by title id. What you search for and stream stays on this computer.
      </p>
    </>
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
      toast('Removed. It can connect again from nexttupp.com/watch.')
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
            Films play on a phone on the same Wi-Fi, streamed from this computer. For a TV, press Cast in the player.
          </span>
        </span>
        <input type="checkbox" role="switch" className="switch" checked={lan.enabled} disabled={busy} onChange={e => { void save({ enabled: e.target.checked }) }} />
      </label>
      {lan.enabled && (
        <>
          <div className="phone-qr">
            <img src="/watch-qr.svg" alt="QR code for nexttupp.com/watch" width={132} height={132} />
            <p className="account-note">
              On your phone, scan this with the camera or go to <strong className="phone-qr-url">nexttupp.com/watch</strong>,
              and sign in with this account. Add it to the home screen, and it opens straight to this computer next time.
            </p>
          </div>
          <label className="field lan-name">
            <span className="field-label">This computer’s name, as your phone shows it</span>
            <input value={name} maxLength={40} placeholder={lan.defaultName} onChange={e => setName(e.target.value)} onBlur={saveName}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
          </label>
          {lan.urls.length === 0 && <p className="fine-print">Not on a home network right now.</p>}
        </>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <h3 className="lan-list-title">Connected phones</h3>
      {lan.clients.length === 0
        ? <p className="account-note">None yet.</p>
        : (
          <ul className="device-list" aria-label="Connected phones">
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
