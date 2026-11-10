import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { type CloudAccount, CloudClient, CloudError, type CloudInvite, parseInviteCode } from './cloud.ts'
import { ackPush, applyPull, collectPush, dropOutbox, linkProfiles, pendingCount } from './local.ts'

// Optional sign-in and background taste sync. Signed out, nothing here touches the network and the app
// works as before. Signed in, it pushes this device's changes and pulls the account's: on start-up, about
// a minute apart, and a couple of seconds after a like, list change or profile edit. Offline is normal:
// changes wait in the outbox and the next attempt backs off up to 5 minutes. Nothing here blocks a request
// except sign-in itself.
//
// The session token lives in <data>/account.json (mode 0600), never in the browser.

export type SyncState = 'idle' | 'syncing' | 'synced' | 'offline' | 'error'

export interface AccountStatus {
  signedIn: boolean
  /** Where accounts live (NEXTTUPP_CLOUD_URL). */
  cloudUrl: string
  account?: { email: string; displayName: string | null; role: 'admin' | 'member' }
  sync?: { state: SyncState; lastSyncAt: number | null; error: string | null; pending: number; retryAt: number | null }
  /** Why this device was signed out, when it wasn't the person's doing ("Your session ended…"). */
  notice?: string
}

interface Session {
  v: 1
  cloudUrl: string
  token: string
  expiresAt: number
  account: Pick<CloudAccount, 'id' | 'email' | 'displayName' | 'role'>
  /** This device's profiles have been matched to the account's (once per sign-in, after the first pull). */
  linked: boolean
}

export interface SyncOptions {
  db: DatabaseSync
  /** Told when pulled rows change a profile, so recommendations refresh. */
  store: { markChanged (profileId: string): void }
  dataDir: string
  cloudUrl: string
  log?: (msg: string) => void
  fetch?: typeof fetch
  now?: () => number
  intervalMs?: number
  debounceMs?: number
}

const CURSOR_KEY = 'cloud_cursor'
const MAX_BACKOFF_MS = 5 * 60_000

export class SyncService {
  readonly cloud: CloudClient
  private readonly db: DatabaseSync
  private readonly store: SyncOptions['store']
  private readonly file: string
  private readonly log: (msg: string) => void
  private readonly now: () => number
  private readonly intervalMs: number
  private readonly debounceMs: number
  private session: Session | null = null
  private notice: string | null = null
  private state: SyncState = 'idle'
  private lastSyncAt: number | null = null
  private error: string | null = null
  private failures = 0
  private retryAt: number | null = null
  private running: Promise<void> | null = null
  private again = false
  private timers: { interval?: NodeJS.Timeout; debounce?: NodeJS.Timeout; retry?: NodeJS.Timeout } = {}
  /** Local profile → account profile, from the last sign-in's merge. */
  lastMerge: Record<string, string> = {}

  constructor (opts: SyncOptions) {
    this.db = opts.db
    this.store = opts.store
    this.file = join(opts.dataDir, 'account.json')
    this.cloud = new CloudClient(opts.cloudUrl, opts.fetch)
    this.log = opts.log ?? (() => {})
    this.now = opts.now ?? Date.now
    this.intervalMs = opts.intervalMs ?? 60_000
    this.debounceMs = opts.debounceMs ?? 2000
    this.session = this.readSession()
  }

  // ---- Lifecycle ---------------------------------------------------------------------

  /** Syncs shortly after start-up, then about once a minute while signed in. */
  start (): void {
    this.stop()
    this.timers.interval = setInterval(() => {
      if (this.session && !(this.retryAt && this.now() < this.retryAt)) void this.syncNow()
    }, this.intervalMs)
    this.timers.interval.unref()
    if (this.session) this.later('debounce', 1500)
  }

  stop (): void {
    clearInterval(this.timers.interval)
    clearTimeout(this.timers.debounce)
    clearTimeout(this.timers.retry)
    this.timers = {}
  }

  /** Something changed locally: sync soon, unless we're waiting out an outage. */
  nudge (): void {
    if (!this.session || (this.retryAt && this.now() < this.retryAt)) return
    this.later('debounce', this.debounceMs)
  }

  private later (which: 'debounce' | 'retry', ms: number): void {
    clearTimeout(this.timers[which])
    this.timers[which] = setTimeout(() => { void this.syncNow() }, ms)
    this.timers[which].unref()
  }

  status (): AccountStatus {
    const s = this.session
    if (!s) return { signedIn: false, cloudUrl: this.cloud.baseUrl, ...(this.notice ? { notice: this.notice } : {}) }
    return {
      signedIn: true,
      cloudUrl: this.cloud.baseUrl,
      account: { email: s.account.email, displayName: s.account.displayName, role: s.account.role },
      sync: { state: this.state, lastSyncAt: this.lastSyncAt, error: this.error, pending: pendingCount(this.db), retryAt: this.retryAt },
    }
  }

  // ---- Account -----------------------------------------------------------------------

  async login (email: string, password: string): Promise<AccountStatus> {
    const r = await this.cloud.login(email.trim(), password)
    return this.begin(r)
  }

  /** Sign up with an invite code (or a link holding one), then sign in. */
  async join (code: string, email: string, password: string, displayName?: string): Promise<AccountStatus> {
    const token = parseInviteCode(code)
    if (!token) throw new CloudError(400, 'invalid_code', 'That isn’t an invite code or link. Paste the whole thing you were sent.')
    const mail = email.trim()
    const { key } = await this.cloud.accept(token, mail, password, displayName?.trim() || undefined)
    return this.begin(await this.cloud.loginWithKey(mail, key))
  }

  private async begin (r: { token: string; expiresAt: number; account: CloudAccount }): Promise<AccountStatus> {
    const previous = this.session
    if (previous && previous.token !== r.token) void this.cloud.logout(previous.token).catch(() => {})
    const { id, email, displayName, role } = r.account
    this.session = { v: 1, cloudUrl: this.cloud.baseUrl, token: r.token, expiresAt: r.expiresAt, account: { id, email, displayName, role }, linked: false }
    this.writeSession()
    this.setCursor('0')
    this.notice = null
    this.lastMerge = {}
    this.failures = 0
    this.retryAt = null
    this.lastSyncAt = null
    this.error = null
    this.log(`sync: signed in as ${email}`)
    // The first sync matches this device's profiles to the account's. Wait for it a while, so the app can
    // show the merged profiles straight away; a big account keeps going in the background.
    await Promise.race([this.syncNow(), new Promise(resolve => setTimeout(resolve, 20_000).unref())])
    return this.status()
  }

  /** Pushes what's pending (briefly), ends the session and forgets the token. Local data stays. */
  async logout (): Promise<AccountStatus> {
    const s = this.session
    if (!s) return this.status()
    await Promise.race([this.syncNow(), new Promise(resolve => setTimeout(resolve, 8000).unref())])
    await this.cloud.logout(s.token).catch(() => {})
    this.end(null)
    return this.status()
  }

  private end (notice: string | null): void {
    this.session = null
    this.notice = notice
    this.state = 'idle'
    this.error = null
    this.retryAt = null
    this.failures = 0
    clearTimeout(this.timers.retry)
    clearTimeout(this.timers.debounce)
    rmSync(this.file, { force: true })
    this.db.prepare('DELETE FROM sync_state WHERE key = ?').run(CURSOR_KEY)
  }

  private token (): string {
    if (!this.session) throw new CloudError(401, 'signed_out', 'Sign in first')
    return this.session.token
  }

  async createInvite (note?: string): Promise<{ code: string; url: string; invite: CloudInvite }> {
    const r = await this.authed(t => this.cloud.createInvite(t, note?.trim() || undefined))
    return { code: r.token, url: r.url, invite: r.invite }
  }

  async invites (): Promise<CloudInvite[]> {
    return (await this.authed(t => this.cloud.listInvites(t))).invites
  }

  /** A call with the session token; a 401 or a disabled account signs this device out. */
  private async authed<T> (fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(this.token())
    } catch (err) {
      this.onAuthError(err)
      throw err
    }
  }

  private onAuthError (err: unknown): void {
    if (!(err instanceof CloudError) || !this.session) return
    if (err.status === 401) this.end('Your session ended. Sign in again to keep syncing.')
    else if (err.code === 'account_disabled') this.end('This account has been disabled.')
  }

  // ---- Sync --------------------------------------------------------------------------

  /** Runs one push-then-pull cycle now, or joins the one already running (and runs once more after it). */
  syncNow (): Promise<void> {
    if (!this.session) return Promise.resolve()
    if (this.running) { this.again = true; return this.running }
    this.running = this.cycle().finally(() => {
      this.running = null
      if (this.again && this.session) { this.again = false; this.later('debounce', 250) }
    })
    return this.running
  }

  private async cycle (): Promise<void> {
    const s = this.session!
    this.state = 'syncing'
    try {
      if (!s.linked) {
        await this.pullAll(s)
        this.lastMerge = linkProfiles(this.db, s.account.id, this.now())
        if (Object.keys(this.lastMerge).length) this.log(`sync: merged ${Object.keys(this.lastMerge).length} profile(s) into the account's profiles of the same name`)
        s.linked = true
        this.writeSession()
      }
      await this.pushAll(s)
      await this.pullAll(s)
      if (this.session !== s) return
      this.state = 'synced'
      this.lastSyncAt = this.now()
      this.error = null
      this.failures = 0
      this.retryAt = null
    } catch (err) {
      if (this.session !== s) return
      this.onAuthError(err)
      if (!this.session) return
      const e = err as CloudError
      const transient = !(e instanceof CloudError) || e.status === 0 || e.status === 429 || e.status >= 500
      this.state = e instanceof CloudError && e.status === 0 ? 'offline' : 'error'
      this.error = e.message
      this.failures++
      const wait = transient ? Math.min(MAX_BACKOFF_MS, 5000 * 2 ** (this.failures - 1)) : this.intervalMs
      this.retryAt = this.now() + wait
      this.later('retry', wait)
      if (this.failures <= 3 || !transient) this.log(`sync: ${e.message}; retrying in ${Math.round(wait / 1000)} s`)
    }
  }

  private async pushAll (s: Session): Promise<void> {
    let refused = 0
    for (let guard = 0; guard < 200; guard++) {
      const out = collectPush(this.db, s.account.id, this.now(), { log: this.log })
      if (!out) return
      try {
        await this.cloud.push(s.token, out.batch)
        ackPush(this.db, out.ids)
      } catch (err) {
        // One bad row fails the whole push and is named in the message ("ratings[3].itemId: …"): set it
        // aside and carry on, so it can't hold up everything behind it.
        const m = err instanceof CloudError && err.status === 400 ? /^(\w+)\[(\d+)\]/.exec(err.message) : null
        const id = m ? out.origin[m[1] as keyof typeof out.origin]?.[Number(m[2])] : undefined
        if (id === undefined || id === null || ++refused > 20) throw err
        this.log(`sync: the cloud refused a row, not syncing it: ${(err as Error).message}`)
        dropOutbox(this.db, id)
      }
    }
  }

  private async pullAll (s: Session): Promise<void> {
    let cursor = this.getCursor()
    for (let guard = 0; guard < 1000; guard++) {
      let page
      try {
        page = await this.cloud.pull(s.token, cursor)
      } catch (err) {
        if (err instanceof CloudError && err.code === 'cursor_ahead' && cursor !== '0') { cursor = '0'; continue }
        throw err
      }
      if (this.session !== s) return
      const changed = applyPull(this.db, s.account.id, page)
      cursor = page.cursor
      this.setCursor(cursor)
      for (const pid of changed) this.store.markChanged(pid)
      if (!page.more) return
    }
  }

  // ---- Persistence -------------------------------------------------------------------

  private getCursor (): string {
    const r = this.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(CURSOR_KEY) as { value: string } | undefined
    try {
      const c = r ? JSON.parse(r.value) as { accountId: string; cloudUrl: string; cursor: string } : null
      return c && c.accountId === this.session?.account.id && c.cloudUrl === this.cloud.baseUrl ? c.cursor : '0'
    } catch { return '0' }
  }

  private setCursor (cursor: string): void {
    const value = JSON.stringify({ accountId: this.session?.account.id, cloudUrl: this.cloud.baseUrl, cursor })
    this.db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(CURSOR_KEY, value)
  }

  private readSession (): Session | null {
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as Session
      // A session for another cloud (a dev server, say) doesn't apply here.
      return s.v === 1 && s.cloudUrl === this.cloud.baseUrl && typeof s.token === 'string' ? s : null
    } catch { return null }
  }

  private writeSession (): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.session), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.file)
  }
}
