// Password hashing, opaque tokens and constant-time comparison, on WebCrypto only so the same code runs
// in the Worker and in Node (scripts/bootstrap-invite.ts).

/** Workers' WebCrypto rejects PBKDF2 above 100,000 iterations, so this is the most it allows. */
export const PBKDF2_ITERATIONS = 100_000
const SALT_BYTES = 16
const HASH_BYTES = 32
const enc = new TextEncoder()

export function b64url (bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64url (s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
    return Uint8Array.from(bin, c => c.charCodeAt(0))
  } catch {
    return null
  }
}

async function pbkdf2 (password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, HASH_BYTES * 8)
  return new Uint8Array(bits)
}

/** `pbkdf2-sha256$<iterations>$<salt>$<hash>` (base64url), so the cost can change later per hash. */
export async function hashPassword (password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const hash = await pbkdf2(password, salt, iterations)
  return `pbkdf2-sha256$${iterations}$${b64url(salt)}$${b64url(hash)}`
}

export async function verifyPassword (password: string, stored: string): Promise<boolean> {
  const [scheme, iter, saltS, hashS] = stored.split('$')
  const iterations = Number(iter)
  const salt = fromB64url(saltS ?? '')
  const expected = fromB64url(hashS ?? '')
  if (scheme !== 'pbkdf2-sha256' || !Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS || !salt || !expected) return false
  const actual = await pbkdf2(password, salt, iterations)
  return timingSafeEqual(actual, expected)
}

/**
 * A valid hash of a random password nobody knows. Logins for unknown emails verify against it, so they
 * cost the same as real ones and don't reveal which emails have accounts.
 */
export const DUMMY_HASH = 'pbkdf2-sha256$100000$RlnZ4fd3sB7RSGikAUp-MA$W4s6V-Y8ACWlihgXbv0yF82beDSQOyeMCoKlpK-E7uI'

export function timingSafeEqual (a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (x: ArrayBufferView, y: ArrayBufferView) => boolean }
  if (typeof subtle.timingSafeEqual === 'function') return subtle.timingSafeEqual(a, b)
  let diff = 0
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** An opaque bearer secret: a type prefix plus 256 random bits. Only its SHA-256 is ever stored. */
export function randomToken (prefix: 'nxs_' | 'nxi_' | 'nxr_'): string {
  return prefix + b64url(crypto.getRandomValues(new Uint8Array(32)))
}

export const TOKEN = /^nx[sir]_[A-Za-z0-9_-]{43}$/

export async function sha256Hex (s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))
  let out = ''
  for (const b of d) out += b.toString(16).padStart(2, '0')
  return out
}
