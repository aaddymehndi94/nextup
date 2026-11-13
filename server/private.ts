import { HttpError } from './http.ts'

// Private mode. A window (or a phone's tab) in private mode sends this header on every request, and nothing
// it does is kept: no taste, progress or downloads, no log lines, no metadata cached on its behalf, and the
// video it streams lives in a folder that is deleted when playback stops (engine.ts). See docs/adr/0007.

export const PRIVATE_HEADER = 'x-nexttupp-private'

export const hasPrivateHeader = (req: { headers: Record<string, string | string[] | undefined> }): boolean =>
  req.headers[PRIVATE_HEADER] === '1'

/** Thrown for anything that would save something: likes, My List, profiles, downloads. */
export function refuseInPrivate (req: { headers: Record<string, string | string[] | undefined> }, what: string): void {
  if (hasPrivateHeader(req)) throw new HttpError(409, `Private mode is on, so nothing is saved. Turn it off to ${what}.`)
}

/** Image hosts the image relay fetches from: the posters, backgrounds and logos Cinemeta links to, and music covers. */
const IMAGE_HOSTS = [/(^|\.)metahub\.space$/, /^m\.media-amazon\.com$/, /^image\.tmdb\.org$/, /(^|\.)dzcdn\.net$/, /(^|\.)mzstatic\.com$/]

export function relayableImage (raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && IMAGE_HOSTS.some(h => h.test(u.hostname)) ? u : null
  } catch { return null }
}
