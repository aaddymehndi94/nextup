import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { type CloudAccount, CloudClient, CloudError } from './cloud.ts'
import type { MusicSection } from '../../cloud/src/wire.ts'
import { ackPush, applyPull, collectPush, dropOutbox, linkProfiles, pendingCount } from './local.ts'
import { ackMusicPush, applyMusicPull, collectMusicPush, dropMusicOutbox, musicPendingCount, requeueProfiles } from './music.ts'

// Optional sign-in and background taste sync. Signed out, nothing here touches the network and the app
// works as before. Signed in, it pushes this device's changes and pulls the account's: on start-up, about
// a minute apart, and a couple of seconds after a like, list change or profile edit. Offline is normal:
// changes wait in the outbox and the next attempt backs off up to 5 minutes. Nothing here blocks a request
// except sign-in itself. Music likes, listens and asked-for mixes sync after the films, on their own
// endpoints, and only once the cloud says it syncs music (an older cloud leaves them waiting quietly).
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
  /** This computer as the cloud's device list shows it; registered on every sync (about once a minute). */
  device?: () => { id: string; name: string; platform: string; lan: boolean; lanUrls: string[] }
  /** Called after signing in or out. */
  onSignInChange?: () => void
}

const CURSOR_KEY = 'cloud_cursor'
const MUSIC_CURSOR_KEY = 'cloud_music_cursor'
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
  private readonly device?: SyncOptions['device']
  private readonly onSignInChange: () => void
  private deviceError: string | null = null
  /** The account's musicHead from the last film pull; null while the cloud doesn't sync music. */
  private musicHead: string | null = null
  private musicNoted = false
  private musicError: string | null = null
  /** Songs and artists the cloud refused in this run, left out of later pushes. */
  private readonly musicSkip = new Set<string>()
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
    this.device = opts.device
    this.onSignInChange = opts.onSignInChange ?? (() => {})
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
      sync: { state: this.state, lastSyncAt: this.lastSyncAt, error: this.error, pending: this.pending(), retryAt: this.retryAt },
    }
  }

  /** Changes waiting to upload; music counts once the cloud syncs it. */
  private pending (): number {
    return pendingCount(this.db) + (this.musicHead !== null ? musicPendingCount(this.db) : 0)
  }

  // ---- Account -----------------------------------------------------------------------

  async login (email: string, password: string): Promise<AccountStatus> {
    const r = await this.cloud.login(email.trim(), password)
    return this.begin(r)
  }

  /** Create an account, then sign in. */
  async signup (email: string, password: string, displayName?: string): Promise<AccountStatus> {
    const mail = email.trim()
    const { key } = await this.cloud.signup(mail, password, displayName?.trim() || undefined)
    return this.begin(await this.cloud.loginWithKey(mail, key))
  }

  private async begin (r: { token: string; expiresAt: number; account: CloudAccount }): Promise<AccountStatus> {
    const previous = this.session
    if (previous && previous.token !== r.token) void this.cloud.logout(previous.token).catch(() => {})
    const { id, email, displayName, role } = r.account
    this.session = { v: 1, cloudUrl: this.cloud.baseUrl, token: r.token, expiresAt: r.expiresAt, account: { id, email, displayName, role }, linked: false }
    this.writeSession()
    this.setCursor(CURSOR_KEY, '0')
    this.setCursor(MUSIC_CURSOR_KEY, '0')
    this.musicHead = null
    this.musicSkip.clear()
    this.notice = null
    this.lastMerge = {}
    this.failures = 0
    this.retryAt = null
    this.lastSyncAt = null
    this.error = null
    this.log(`sync: signed in as ${email}`)
    this.onSignInChange()
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
    // Phones should stop finding this computer.
    if (this.device) await this.cloud.deleteDevice(s.token, this.device().id).catch(() => {})
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
    this.db.prepare('DELETE FROM sync_state WHERE key IN (?, ?)').run(CURSOR_KEY, MUSIC_CURSOR_KEY)
    this.onSignInChange()
  }

  get signedIn (): boolean { return this.session !== null }

  /** A phone arrived with a handoff code from nexttupp.com: the cloud checks it is for this account and device. */
  async redeemHandoff (code: string, deviceId: string): Promise<void> {
    await this.authed(t => this.cloud.redeemHandoff(t, code, deviceId))
  }

  private token (): string {
    if (!this.session) throw new CloudError(401, 'signed_out', 'Sign in first')
    return this.session.token
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
      await this.music(s)
      if (this.session !== s) return
      await this.heartbeat(s)
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

  /** Registers this computer with the cloud (name, home-network addresses). Never fails the sync. */
  private async heartbeat (s: Session): Promise<void> {
    if (!this.device) return
    try {
      await this.cloud.putDevice(s.token, this.device())
      if (this.deviceError) this.log('sync: device registered again')
      this.deviceError = null
    } catch (err) {
      const message = (err as Error).message
      if (message !== this.deviceError) this.log(`sync: couldn’t register this device: ${message}`)
      this.deviceError = message
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
    let cursor = this.getCursor(CURSOR_KEY)
    for (let guard = 0; guard < 1000; guard++) {
      let page
      try {
        page = await this.cloud.pull(s.token, cursor)
      } catch (err) {
        if (err instanceof CloudError && err.code === 'cursor_ahead' && cursor !== '0') {
          // The cloud's counter went back: both cursors start over.
          cursor = '0'
          this.setCursor(MUSIC_CURSOR_KEY, '0')
          continue
        }
        throw err
      }
      if (this.session !== s) return
      const changed = applyPull(this.db, s.account.id, page)
      cursor = page.cursor
      this.setCursor(CURSOR_KEY, cursor)
      for (const pid of changed) this.store.markChanged(pid)
      this.musicHead = typeof page.musicHead === 'string' && /^\d{1,15}$/.test(page.musicHead) ? page.musicHead : null
      if (!page.more) return
    }
  }

  // ---- Music -------------------------------------------------------------------------

  /**
   * Music's push and pull, after the films and only on a cloud that syncs music (the film pull carries a
   * musicHead). An older cloud gets no music calls at all, and one log line per run. A music failure never
   * fails the sync: it's logged once per distinct message, and the rows wait in the music outbox.
   */
  private async music (s: Session): Promise<void> {
    if (this.musicHead === null) {
      if (!this.musicNoted) this.log('sync: the sync service doesn’t sync music yet; music likes and listens wait on this computer')
      this.musicNoted = true
      return
    }
    try {
      await this.pushMusic(s)
      await this.pullMusic(s)
      if (this.musicError) this.log('sync: music is syncing again')
      this.musicError = null
    } catch (err) {
      if (this.session !== s) return
      this.onAuthError(err)
      if (!this.session) return
      if (err instanceof CloudError && err.status === 404) {
        // Says it syncs music but has no music endpoints: treat it as an older cloud.
        if (!this.musicNoted) this.log('sync: the sync service doesn’t sync music yet; music likes and listens wait on this computer')
        this.musicNoted = true
        this.musicHead = null
        return
      }
      const message = (err as Error).message
      if (message !== this.musicError) this.log(`sync: music didn’t sync: ${message}`)
      this.musicError = message
    }
  }

  private async pushMusic (s: Session): Promise<void> {
    let refused = 0
    for (let guard = 0; guard < 200; guard++) {
      const out = collectMusicPush(this.db, s.account.id, this.now(), { log: this.log, skip: this.musicSkip })
      if (!out) return
      try {
        const r = await this.cloud.musicPush(s.token, out.batch)
        ackMusicPush(this.db, out.ids)
        if (typeof r?.musicHead === 'string' && /^\d{1,15}$/.test(r.musicHead)) this.musicHead = r.musicHead
      } catch (err) {
        if (err instanceof CloudError && err.code === 'unknown_profile') {
          // A profile isn't on the cloud yet: the next film push sends it, and these rows go after it.
          requeueProfiles(this.db, [...out.batch.ratings, ...out.batch.listens, ...out.batch.mixes].map(r => r.profileId))
          return
        }
        // As for films: set aside the one row the cloud names ("listens[3].played: …") and carry on. A song
        // or artist it refuses is left out of later pushes; the rows naming it still sync.
        const m = err instanceof CloudError && err.status === 400 ? /^(\w+)\[(\d+)\]/.exec(err.message) : null
        const section = m?.[1] as MusicSection | undefined
        const id = section ? out.origin[section]?.[Number(m![2])] : undefined
        const ref = section ? out.ref[section]?.[Number(m![2])] : undefined
        if ((id === undefined || id === null) && !ref) throw err
        if (++refused > 20) throw err
        this.log(`sync: the cloud refused a music row, not syncing it: ${(err as Error).message}`)
        if (id !== undefined && id !== null) dropMusicOutbox(this.db, id)
        else this.musicSkip.add(ref!)
      }
    }
  }

  private async pullMusic (s: Session): Promise<void> {
    let cursor = this.getCursor(MUSIC_CURSOR_KEY)
    // Nothing new since this computer's last music pull (its cursor is at or past the head).
    if (this.musicHead !== null && Number(cursor) >= Number(this.musicHead)) return
    for (let guard = 0; guard < 1000; guard++) {
      let page
      try {
        page = await this.cloud.musicPull(s.token, cursor)
      } catch (err) {
        if (err instanceof CloudError && err.code === 'cursor_ahead' && cursor !== '0') { cursor = '0'; continue }
        throw err
      }
      if (this.session !== s) return
      applyMusicPull(this.db, page, this.now())
      cursor = page.cursor
      this.setCursor(MUSIC_CURSOR_KEY, cursor)
      if (!page.more) return
    }
  }

  // ---- Persistence -------------------------------------------------------------------

  private getCursor (key: string): string {
    const r = this.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string } | undefined
    try {
      const c = r ? JSON.parse(r.value) as { accountId: string; cloudUrl: string; cursor: string } : null
      return c && c.accountId === this.session?.account.id && c.cloudUrl === this.cloud.baseUrl ? c.cursor : '0'
    } catch { return '0' }
  }

  private setCursor (key: string, cursor: string): void {
    const value = JSON.stringify({ accountId: this.session?.account.id, cloudUrl: this.cloud.baseUrl, cursor })
    this.db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
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
