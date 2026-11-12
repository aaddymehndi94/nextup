import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// <data>/lan.json (mode 0600): this computer's device id and name, the "Let phones play from this computer"
// setting, and the phones allowed in. A phone holds a random 256-bit token in an HttpOnly cookie; only its
// SHA-256 is kept here.

export const COOKIE = 'nexttupp_lan'
/** Chrome caps cookie lifetimes at 400 days. Each visit within that keeps the phone connected. */
export const COOKIE_MAX_AGE_S = 400 * 86_400
const TOKEN = /^nxl_[A-Za-z0-9_-]{43}$/
const TOUCH_MS = 3600_000
const MAX_CLIENTS = 50

export interface LanClient {
  id: string
  label: string
  createdAt: number
  lastUsedAt: number
}

interface StoredClient extends LanClient { hash: string }

interface LanFile {
  v: 1
  /** Random, per install; the cloud keys devices by (account, id). */
  deviceId: string
  /** Chosen in the Account page; null means the default ("Laptop (Linux)"). */
  name: string | null
  /** null: never chosen, which means on while signed in. */
  enabled: boolean | null
  clients: StoredClient[]
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** The value of one cookie from a Cookie header. */
export function readCookie (header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

export class LanStore {
  private readonly file: string
  private data: LanFile
  private readonly now: () => number

  constructor (dataDir: string, now: () => number = Date.now) {
    this.file = join(dataDir, 'lan.json')
    this.now = now
    this.data = this.read()
  }

  get deviceId (): string { return this.data.deviceId }
  get name (): string | null { return this.data.name }
  get enabled (): boolean | null { return this.data.enabled }

  setEnabled (on: boolean): void { this.data.enabled = on; this.write() }
  setName (name: string | null): void { this.data.name = name; this.write() }

  clients (): LanClient[] {
    return this.data.clients.map(({ hash: _h, ...c }) => c).sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  }

  /** Lets a new phone in. Returns the cookie value, shown to nobody but that phone. */
  add (label: string): { token: string; client: LanClient } {
    const token = `nxl_${randomBytes(32).toString('base64url')}`
    const at = this.now()
    const client: StoredClient = { id: randomUUID(), hash: sha256(token), label: label.slice(0, 60), createdAt: at, lastUsedAt: at }
    this.data.clients = [client, ...this.data.clients].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, MAX_CLIENTS)
    this.write()
    const { hash: _h, ...pub } = client
    return { token, client: pub }
  }

  remove (id: string): boolean {
    const before = this.data.clients.length
    this.data.clients = this.data.clients.filter(c => c.id !== id)
    if (this.data.clients.length === before) return false
    this.write()
    return true
  }

  /** The phone behind a Cookie header, if its token is one we issued and haven't removed. */
  verify (cookieHeader: string | undefined): LanClient | null {
    const token = readCookie(cookieHeader, COOKIE)
    if (!token || !TOKEN.test(token)) return null
    const hash = sha256(token)
    const c = this.data.clients.find(x => x.hash === hash)
    if (!c) return null
    const at = this.now()
    if (at - c.lastUsedAt > TOUCH_MS) { c.lastUsedAt = at; this.write() }
    const { hash: _h, ...pub } = c
    return pub
  }

  private read (): LanFile {
    try {
      const d = JSON.parse(readFileSync(this.file, 'utf8')) as LanFile
      if (d.v === 1 && typeof d.deviceId === 'string' && Array.isArray(d.clients)) return d
    } catch { /* first run, or unreadable: start fresh */ }
    const fresh: LanFile = { v: 1, deviceId: randomUUID(), name: null, enabled: null, clients: [] }
    this.data = fresh
    this.write()
    return fresh
  }

  private write (): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.file)
  }
}
