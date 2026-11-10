import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

export const config = {
  port: Number(process.env.PORT ?? 4545),
  host: process.env.HOST ?? '127.0.0.1',
  dataDir: resolve(process.env.NEXTUP_DATA ?? join(root, 'data')),
  webDist: join(root, 'dist'),
  preferredLanguages: (process.env.NEXTUP_LANGS ?? 'en').split(',').map(s => s.trim()).filter(Boolean),
  /** Minutes a torrent may sit unused before we stop it (data stays on disk). */
  idleMinutes: Number(process.env.NEXTUP_IDLE_MIN ?? 15),
  /** Torrentio base URL. Can include Torrentio config segments, e.g. https://torrentio.strem.fun/providers=yts,1337x */
  torrentioUrl: process.env.NEXTUP_TORRENTIO ?? 'https://torrentio.strem.fun',
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
