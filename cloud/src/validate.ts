import { fromB64url, KDF_ITERATIONS, KEY_BYTES, SALT_BYTES } from './crypto.ts'
import { bad } from './errors.ts'

// Field validators shared by the account and sync endpoints. Each takes the value and a path for the
// error message (`events[3].itemId: …`) and returns the value narrowed, or throws a 400.

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const IMDB_ID = /^tt\d{1,10}$/
/** A movie (`tt123`) or an episode (`tt123:season:episode`), exactly as the local store keys progress. */
export const STREAM_ID = /^(tt\d{1,10})(?::(\d{1,4}):(\d{1,5}))?$/

export function str (v: unknown, path: string): string {
  if (typeof v !== 'string') throw bad(`${path}: must be a string`)
  return v
}

export function int (v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad(`${path}: must be an integer from ${min} to ${max}`)
  return v
}

export function num (v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw bad(`${path}: must be a number from ${min} to ${max}`)
  return v
}

export function oneOf<T extends string | number> (v: unknown, path: string, allowed: readonly T[]): T {
  if (!allowed.includes(v as T)) throw bad(`${path}: must be one of ${allowed.map(a => JSON.stringify(a)).join(', ')}`)
  return v as T
}

export function match (v: unknown, path: string, re: RegExp, what: string): string {
  if (typeof v !== 'string' || !re.test(v)) throw bad(`${path}: must be ${what}`)
  return v
}

// Things that have no business in a name, a note or a feature key: control and bidi-override characters,
// and anything shaped like torrent data. A 40-hex or 32-base32 info hash is one unbroken alphanumeric
// run of 32+ characters; magnet links, btih URNs, URLs and video file names are matched by name.
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/
const LONG_RUN = /[0-9A-Za-z]{32,}/
const TORRENTISH = /magnet:|btih|:\/\/|\.torrent\b|\.(mkv|mp4|m4v|avi|mov|wmv|webm|flv|iso|m2ts|srt)\b/i

/** Short human text (names, notes): trimmed, 1..max characters, nothing that looks like torrent data. */
export function plainText (v: unknown, path: string, max: number): string {
  const s = str(v, path)
  const chars = [...s].length
  if (s !== s.trim() || chars < 1 || chars > max) throw bad(`${path}: must be 1–${max} characters without leading or trailing spaces`)
  if (CONTROL.test(s)) throw bad(`${path}: contains control characters`)
  if (LONG_RUN.test(s) || TORRENTISH.test(s)) throw bad(`${path}: looks like a hash, link or file name, which can't be stored`)
  return s
}

/** Millisecond timestamps: not before 2020, not more than an hour ahead of the server clock. */
export const MIN_TIME = Date.UTC(2020, 0, 1)
export const MAX_SKEW_MS = 3600_000

export function time (v: unknown, path: string, now: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < MIN_TIME) throw bad(`${path}: must be a millisecond timestamp after 2020-01-01`)
  if (v > now + MAX_SKEW_MS) throw bad(`${path}: is more than an hour in the future (check the device clock)`)
  return v
}

export function nullable<T> (v: unknown, f: (x: unknown) => T): T | null {
  return v === null ? null : f(v)
}

export function object (v: unknown, path: string, required: string[], optional: string[] = []): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw bad(`${path}: must be an object`)
  const o = v as Record<string, unknown>
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) throw bad(`${path}: unknown field "${k}"`)
  for (const k of required) if (!(k in o)) throw bad(`${path}: missing field "${k}"`)
  return o
}

export function email (v: unknown, path = 'email'): string {
  const s = str(v, path).trim().toLowerCase()
  if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || CONTROL.test(s)) throw bad(`${path}: must be an email address`)
  return s
}

/**
 * A client-derived login key: PBKDF2-SHA256(password, salt, KDF_ITERATIONS), 32 bytes in base64url.
 * Anything else (a raw password, say) is rejected, so a buggy client can't send the password itself.
 */
export function authKey (v: unknown, path = 'key'): Uint8Array {
  const s = str(v, path)
  const bytes = /^[A-Za-z0-9_-]{43}$/.test(s) ? fromB64url(s) : null
  if (!bytes || bytes.byteLength !== KEY_BYTES) throw bad(`${path}: must be the 32-byte PBKDF2 key in base64url (43 characters), never the password`)
  return bytes
}

/** A new credential (sign-up, reset, password change): the client's salt, its iteration count and the key. */
export function credential (o: Record<string, unknown>): { salt: Uint8Array; iterations: number; key: Uint8Array } {
  const s = str(o.salt, 'salt')
  const salt = /^[A-Za-z0-9_-]{22}$/.test(s) ? fromB64url(s) : null
  if (!salt || salt.byteLength !== SALT_BYTES) throw bad('salt: must be 16 random bytes in base64url (22 characters)')
  if (o.iterations !== KDF_ITERATIONS) throw bad(`iterations: must be ${KDF_ITERATIONS} (update nexttupp)`)
  return { salt, iterations: KDF_ITERATIONS, key: authKey(o.key) }
}

export function displayName (v: unknown, path = 'displayName'): string | null {
  if (v === undefined || v === null) return null
  return plainText(str(v, path).trim().replace(/\s+/g, ' '), path, 40)
}
