// Login credentials, opaque tokens and constant-time comparison, on WebCrypto only so the same code runs
// in the Worker and in Node (scripts/bootstrap-invite.ts).
//
// The password never reaches the server. The client stretches it (Bitwarden's pattern):
//
//   key = PBKDF2-SHA256(password, salt, KDF_ITERATIONS), 32 bytes, sent as base64url
//
// with a random 16-byte salt the client picked at sign-up; POST /v1/auth/prelogin hands it back later.
// The server keeps only HMAC-SHA256(serverSalt, key) and compares in constant time, so a login costs
// microseconds of CPU (the free plan allows 10 ms), and a leaked database still needs 600,000 PBKDF2
// rounds per password guess, the same as if the server had stretched it.

export const KDF = 'pbkdf2-sha256'
/** OWASP's 2023 figure for PBKDF2-HMAC-SHA256. Every client must use exactly this (checked on write). */
export const KDF_ITERATIONS = 600_000
export const SALT_BYTES = 16
export const KEY_BYTES = 32
const SCHEME = 'nxk1'
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

async function hmac (key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  // Copies give plain ArrayBuffer-backed views, which every lib's BufferSource type accepts.
  const k = await crypto.subtle.importKey('raw', new Uint8Array(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new Uint8Array(data)))
}

/**
 * What the server stores for a client-derived key:
 * `nxk1$<iterations>$<client salt>$<server salt>$<HMAC-SHA256(server salt, key)>` (base64url).
 * The client's KDF parameters live in the same string, so prelogin reads them from one column.
 */
export async function makeVerifier (key: Uint8Array, clientSalt: Uint8Array, iterations: number): Promise<string> {
  const serverSalt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  return `${SCHEME}$${iterations}$${b64url(clientSalt)}$${b64url(serverSalt)}$${b64url(await hmac(serverSalt, key))}`
}

function parse (stored: string): { iterations: number; salt: string; serverSalt: Uint8Array; verifier: Uint8Array } | null {
  const [scheme, iter, salt, serverS, verS] = stored.split('$')
  const iterations = Number(iter)
  const serverSalt = fromB64url(serverS ?? '')
  const verifier = fromB64url(verS ?? '')
  if (scheme !== SCHEME || !Number.isInteger(iterations) || iterations < 1 || !salt || !serverSalt || !verifier) return null
  return { iterations, salt, serverSalt, verifier }
}

/** The KDF parameters the client must use for this account, or null for a value that isn't a verifier. */
export function kdfParams (stored: string): { iterations: number; salt: string } | null {
  const p = parse(stored)
  return p && { iterations: p.iterations, salt: p.salt }
}

export async function checkKey (key: Uint8Array, stored: string): Promise<boolean> {
  const p = parse(stored)
  if (!p) return false
  return timingSafeEqual(await hmac(p.serverSalt, key), p.verifier)
}

/**
 * A well-formed verifier nobody has a key for. Logins for unknown emails check against it, so they do
 * the same work as real ones and fail the same way.
 */
export const DUMMY_VERIFIER = 'nxk1$600000$-VTgvwoyWNcAEcWKFOUpYQ$znyDCYtkH5HpcpmMeBohGg$TEgM2j1IrfJmpBh6h3jRmC-Jghyn7KTO-WG7ZWJJwIw'

/**
 * The salt prelogin returns for an email that has no account: HMAC-SHA256(server key, email), cut to 16
 * bytes. Deterministic, so asking twice gives the same answer, as it would for a real account, and it
 * looks like any random salt. The server key is a random value in D1 (`server_keys`), so no deployed
 * secret is needed.
 */
export async function fakeSalt (serverKeyHex: string, email: string): Promise<string> {
  return b64url((await keyedHash(serverKeyHex, `prelogin-salt:${email}`)).slice(0, SALT_BYTES))
}

/** HMAC-SHA256 under the hex server key. Callers prefix the message with its purpose ("prelogin-salt:", "network:"). */
export async function keyedHash (serverKeyHex: string, message: string): Promise<Uint8Array> {
  const keyBytes = Uint8Array.from(serverKeyHex.match(/../g) ?? [], h => parseInt(h, 16))
  return hmac(keyBytes, enc.encode(message))
}

export function timingSafeEqual (a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (x: ArrayBufferView, y: ArrayBufferView) => boolean }
  if (typeof subtle.timingSafeEqual === 'function') return subtle.timingSafeEqual(a, b)
  let diff = 0
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** An opaque bearer secret: a type prefix plus 256 random bits. Only its SHA-256 is ever stored. */
export function randomToken (prefix: 'nxs_' | 'nxi_' | 'nxr_' | 'nxh_'): string {
  return prefix + b64url(crypto.getRandomValues(new Uint8Array(32)))
}

export const TOKEN = /^nx[sir]_[A-Za-z0-9_-]{43}$/
/** A phone handoff code (devices.ts): single-use, 60 seconds. */
export const HANDOFF_CODE = /^nxh_[A-Za-z0-9_-]{43}$/

export async function sha256Hex (s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))
  let out = ''
  for (const b of d) out += b.toString(16).padStart(2, '0')
  return out
}
