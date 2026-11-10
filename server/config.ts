import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/** `NEXTTUPP_*` env var, falling back to the pre-rebrand `NEXTUP_*` name. */
const env = (name: string): string | undefined => process.env[`NEXTTUPP_${name}`] ?? process.env[`NEXTUP_${name}`]

/** A configured binary (the desktop app's bundled ffmpeg) if it exists, otherwise the bare name, found on PATH. */
export function resolveBinary (configured: string | undefined, name: string, exists: (path: string) => boolean = existsSync): string {
  return configured && exists(configured) ? configured : name
}

export const config = {
  port: Number(process.env.PORT ?? 4545),
  host: process.env.HOST ?? '127.0.0.1',
  dataDir: resolve(env('DATA') ?? join(root, 'data')),
  /** The built web app. The desktop app points this at its own copy. */
  webDist: env('WEB_DIR') ? resolve(env('WEB_DIR')!) : join(root, 'dist'),
  ffmpeg: resolveBinary(env('FFMPEG'), 'ffmpeg'),
  ffprobe: resolveBinary(env('FFPROBE'), 'ffprobe'),
  /** Use this video encoder (nvenc, vaapi, qsv, amf, videotoolbox, x264) instead of the first that works. */
  encoder: env('ENCODER'),
  /** VAAPI render node to use, e.g. /dev/dri/renderD129. Default: the first one that encodes. */
  vaapiDevice: env('VAAPI_DEVICE'),
  preferredLanguages: (env('LANGS') ?? 'en').split(',').map(s => s.trim()).filter(Boolean),
  /** Minutes a torrent may sit unused before we stop it (data stays on disk). */
  idleMinutes: Number(env('IDLE_MIN') ?? 15),
  /** Torrentio base URL. Can include Torrentio config segments, e.g. https://torrentio.strem.fun/providers=yts,1337x */
  torrentioUrl: env('TORRENTIO') ?? 'https://torrentio.strem.fun',
  /** The optional accounts and sync service (cloud/). Nothing is sent there until someone signs in. */
  cloudUrl: (env('CLOUD_URL') ?? 'https://api.nexttupp.com').replace(/\/+$/, ''),
  cinemetaUrl: 'https://v3-cinemeta.strem.io',
  openSubtitlesUrl: 'https://opensubtitles-v3.strem.io',
}

/** Well-known open trackers appended to every magnet so peer discovery doesn't rely on one source. */
export const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.dler.org:6969/announce',
]
