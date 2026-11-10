import { useCallback, useEffect, useState } from 'react'
import { Copy, LogOut, RefreshCw, X } from 'lucide-react'
import { type AccountStatus, api, getActiveProfile, type Invite, type LanStatus, setActiveProfile } from '../api.ts'
import { useDocumentTitle } from '../hooks.ts'
import { chooseProfile, loadProfiles } from '../profiles.ts'
import { toast } from '../toast.ts'
import { TopBar } from '../components/TopBar.tsx'

// Optional sign-in, so likes, My List and Continue watching follow you between computers. Signed out:
// sign in, or join with an invite code. Signed in: a quiet sync line, invites, sign out. The session
// itself stays in this computer's nexttupp server, never in the browser.

type Load = { state: 'loading' } | { state: 'ok'; status: AccountStatus } | { state: 'error'; message: string }

export function Account ({ code }: { code?: string | null }) {
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
          {load.state === 'ok' && !load.status.signedIn && (
            <p className="account-lede">
              Sign in to keep your profiles, likes, My List and Continue watching the same on every computer you use.
              nexttupp works just as well without an account.
            </p>
          )}
        </header>
        {load.state === 'loading' && <div aria-busy="true"><div className="skeleton-line" style={{ width: '50%', height: '1.25rem' }} /></div>}
        {load.state === 'error' && <p className="notice" role="alert">{load.message}</p>}
        {load.state === 'ok' && (load.status.signedIn
          ? <SignedIn status={load.status} onStatus={status => setLoad({ state: 'ok', status })} />
          : <SignedOut status={load.status} code={code} onStatus={status => setLoad({ state: 'ok', status })} />)}
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

function SignedOut ({ status, code, onStatus }: { status: AccountStatus; code?: string | null; onStatus: (s: AccountStatus) => void }) {
  const [mode, setMode] = useState<'signin' | 'join'>(code ? 'join' : 'signin')
  const [form, setForm] = useState({ email: '', password: '', code: code ?? '', displayName: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const join = mode === 'join'
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [k]: e.target.value }))
  const ready = form.email.trim() && form.password && (!join || (form.code.trim() && [...form.password].length >= 8))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      const next = join
        ? await api.join({ code: form.code.trim(), email: form.email.trim(), password: form.password, displayName: form.displayName.trim() || undefined })
        : await api.login(form.email.trim(), form.password)
      await adoptProfiles(next)
      toast(join ? 'Account created. You’re signed in.' : 'Signed in')
      onStatus(next)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <>
      {status.notice && <p className="account-notice" role="status">{status.notice}</p>}
      <div className="account-tabs" role="group" aria-label="Sign in or join">
        <button type="button" className="chip" aria-pressed={!join} onClick={() => { setMode('signin'); setError(null) }}>Sign in</button>
        <button type="button" className="chip" aria-pressed={join} onClick={() => { setMode('join'); setError(null) }}>Join with an invite</button>
      </div>
      <form className="account-form" onSubmit={submit} aria-label={join ? 'Join with an invite' : 'Sign in'}>
        {join && (
          <label className="field">
            <span className="field-label">Invite code or link</span>
            <input value={form.code} onChange={set('code')} autoComplete="off" spellCheck={false} placeholder="nxi_… or https://nexttupp.com/join?code=…" required />
          </label>
        )}
        <label className="field">
          <span className="field-label">Email</span>
          <input type="email" value={form.email} onChange={set('email')} autoComplete="email" spellCheck={false} required />
        </label>
        <label className="field">
          <span className="field-label">{join ? 'Choose a password (8 or more characters)' : 'Password'}</span>
          <input type="password" value={form.password} onChange={set('password')} autoComplete={join ? 'new-password' : 'current-password'} minLength={join ? 8 : undefined} maxLength={256} required />
        </label>
        {join && (
          <label className="field">
            <span className="field-label">Your name <span className="field-hint">(optional, shown to people you invite)</span></span>
            <input value={form.displayName} onChange={set('displayName')} autoComplete="nickname" maxLength={40} />
          </label>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="actions">
          <button type="submit" className="button primary" disabled={!ready || busy}>
            {busy && <span className="spinner" aria-hidden />}
            {busy ? (join ? 'Creating your account…' : 'Signing in…') : join ? 'Create account' : 'Sign in'}
          </button>
        </div>
      </form>
      <p className="fine-print account-fine">
        {join
          ? 'Invites come from people who already use nexttupp. Each one works once, for 7 days.'
          : 'Accounts are invite-only. If someone sent you an invite, choose Join with an invite.'}
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
          <p className="account-note">You’re watching on <strong>{lan.name}</strong>. Account settings, invites and connected phones are changed on that computer.</p>
        </section>
      )}
      {lan?.local && <PhonesAndTvs lan={lan} onLan={setLan} />}
      {lan?.local !== false && <Invites />}
      {lan?.local !== false && <section className="account-section" aria-labelledby="leave-h">
        <h2 id="leave-h" className="sr-only">Sign out</h2>
        <button type="button" className="text-button" onClick={signOut} disabled={leaving}><LogOut aria-hidden />{leaving ? 'Signing out…' : 'Sign out'}</button>
        <p className="fine-print">Your profiles and history stay on this computer. They sync again when you sign back in.</p>
      </section>}
    </>
  )
}

// ---- Phones and TVs at home -----------------------------------------------------------------

function PhonesAndTvs ({ lan, onLan }: { lan: LanStatus; onLan: (l: LanStatus) => void }) {
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
      toast('Removed. It can connect again through nexttupp.com.')
    } catch (err) { toast(`Couldn’t remove it. ${(err as Error).message}`) }
  }

  const now = Date.now()
  return (
    <section className="account-section" aria-labelledby="lan-h">
      <h2 id="lan-h" className="section-title">Phones and TVs</h2>
      <label className="switch-row">
        <span className="switch-text">
          <span className="switch-label">Watch on phones and TVs at home</span>
          <span className="account-note">Open nexttupp.com on a phone on the same Wi-Fi and sign in: it plays from this computer. The player can also cast to a TV.</span>
        </span>
        <input type="checkbox" role="switch" className="switch" checked={lan.enabled} disabled={busy} onChange={e => { void save({ enabled: e.target.checked }) }} />
      </label>
      {lan.enabled && (
        <>
          <label className="field lan-name">
            <span className="field-label">This computer’s name, as phones see it</span>
            <input value={name} maxLength={40} placeholder={lan.defaultName} onChange={e => setName(e.target.value)} onBlur={saveName}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
          </label>
          <p className="fine-print">
            {lan.urls.length
              ? <>Connected phones can also bookmark <span className="lan-url">{lan.urls[0]}</span>.</>
              : 'Not on a home network right now.'}
          </p>
        </>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <h3 className="lan-list-title">Phones and TVs that can watch on this computer</h3>
      {lan.clients.length === 0
        ? <p className="account-note">None yet.</p>
        : (
          <ul className="invite-list" aria-label="Connected phones">
            {lan.clients.map(c => (
              <li key={c.id} className="invite-row lan-row">
                <span className="lan-client">
                  <span>{c.label}</span>
                  <span className="invite-state">Connected {new Date(c.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · used {ago(c.lastUsedAt, now)}</span>
                </span>
                <button type="button" className="text-button" onClick={() => { void remove(c.id) }} aria-label={`Remove ${c.label}`}><X aria-hidden />Remove</button>
              </li>
            ))}
          </ul>
          )}
      <p className="fine-print">
        While this is on, this computer’s name and its address on your home network go to nexttupp’s service, so your phone can
        find it. Nothing plays through the service: the video goes straight from this computer to the phone or TV.
      </p>
    </section>
  )
}

function inviteState (i: Invite, now: number): string {
  if (i.status === 'used') return `Joined${i.usedBy ? `: ${i.usedBy.displayName ?? i.usedBy.email}` : ''}`
  if (i.status === 'revoked') return 'Cancelled'
  if (i.status === 'expired' || i.expiresAt <= now) return 'Expired'
  const days = Math.ceil((i.expiresAt - now) / 86_400_000)
  return `Waiting · ${days <= 1 ? 'expires within a day' : `expires in ${days} days`}`
}

async function copy (text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast(`${what} copied`)
  } catch {
    toast(`Couldn’t copy. Select the ${what.toLowerCase()} and copy it.`)
  }
}

function Invites () {
  const [invites, setInvites] = useState<Invite[] | null>(null)
  const [fresh, setFresh] = useState<{ code: string; url: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { api.invites().then(r => setInvites(r.invites)).catch(() => setInvites([])) }, [])

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.createInvite()
      setFresh({ code: r.code, url: r.url })
      setInvites(list => [r.invite, ...(list ?? [])])
    } catch (err) { setError((err as Error).message) }
    setBusy(false)
  }

  const now = Date.now()
  return (
    <section className="account-section" aria-labelledby="invite-h">
      <h2 id="invite-h" className="section-title">Invite a friend</h2>
      <p className="account-note">Send them a link. It works once, for 7 days, and gives them their own account.</p>
      {fresh
        ? (
          <div className="invite-box">
            <label className="field">
              <span className="field-label">Invite link</span>
              <input readOnly value={fresh.url} onFocus={e => e.currentTarget.select()} spellCheck={false} />
            </label>
            <div className="invite-actions">
              <button type="button" className="button secondary" onClick={() => copy(fresh.url, 'Link')}><Copy aria-hidden />Copy link</button>
              <button type="button" className="text-button" onClick={() => copy(fresh.code, 'Code')}>Copy code only</button>
            </div>
            <p className="fine-print">They can open the link, or paste the code into nexttupp under Account, Join with an invite. This is the only time the code is shown.</p>
          </div>
          )
        : (
          <div className="actions">
            <button type="button" className="button primary" onClick={create} disabled={busy}>
              {busy && <span className="spinner" aria-hidden />}{busy ? 'Creating…' : 'Create an invite'}
            </button>
          </div>
          )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {invites && invites.length > 0 && (
        <ul className="invite-list" aria-label="Your invites">
          {invites.slice(0, 8).map(i => (
            <li key={i.id} className="invite-row">
              <span>Invite from {new Date(i.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
              <span className="invite-state">{inviteState(i, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
