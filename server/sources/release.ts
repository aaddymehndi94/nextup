import type { ReleaseInfo, Resolution, Source } from '../../shared/types.ts'

// Release-name parsing. Pure functions only: everything here is unit tested.

const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|webm|mov|ts|m2ts|wmv|mpg|mpeg|flv)$/i

/** Tokenise on the separators release names use, keeping things like "HDR10+" and "DDP5.1". */
function tokens (s: string): string[] {
  return s.split(/[\s._\-[\]()/|,+]+/).filter(Boolean).map(t => t.toLowerCase())
}

export function parseRelease (name: string, fileName?: string): ReleaseInfo {
  const text = `${name} ${fileName ?? ''}`
  const lower = text.toLowerCase()
  const tok = new Set(tokens(text))
  const has = (...words: string[]) => words.some(w => tok.has(w))

  let resolution: Resolution = 'unknown'
  if (/\b(2160p|4k|uhd)\b/i.test(text)) resolution = '2160p'
  else if (/\b1080[pi]\b/i.test(text)) resolution = '1080p'
  else if (/\b720p\b/i.test(text)) resolution = '720p'
  else if (/\b(480p|576p|360p|dvdrip|sd)\b/i.test(text)) resolution = '480p'

  let source: string | undefined
  if (/remux/i.test(text)) source = 'REMUX'
  else if (/blu-?ray|bdrip|brrip|bdremux/i.test(text)) source = 'BluRay'
  else if (/web-?dl|\bweb\b|amzn|nf\b|dsnp|hmax|atvp/i.test(text) && !/webrip/i.test(text)) source = 'WEB-DL'
  else if (/webrip|web-rip/i.test(text)) source = 'WEBRip'
  else if (/hdtv/i.test(text)) source = 'HDTV'
  else if (/dvdrip|dvd/i.test(text)) source = 'DVD'
  else if (/hdrip/i.test(text)) source = 'HDRip'

  const lowQuality =
    has('cam', 'hdcam', 'camrip', 'ts', 'hdts', 'telesync', 'tc', 'hdtc', 'telecine', 'scr', 'screener', 'dvdscr', 'pdvd', 'predvd') ||
    /\b(hd-?cam|hd-?ts|tele-?sync|tele-?cine|dvd-?scr)\b/i.test(text)
  if (lowQuality) source = 'CAM'

  let videoCodec: string | undefined
  if (has('av1')) videoCodec = 'av1'
  else if (has('x265', 'h265', 'hevc') || /h\.265/i.test(text)) videoCodec = 'hevc'
  else if (has('x264', 'h264', 'avc') || /h\.264|bdrip-avc/i.test(text)) videoCodec = 'h264'
  else if (has('xvid', 'divx')) videoCodec = 'xvid'
  else if (has('vp9')) videoCodec = 'vp9'

  const hdr: string[] = []
  if (has('dv', 'dovi') || /dolby\s?vision/i.test(text)) hdr.push('DV')
  if (/hdr10\+|hdr10plus/i.test(text)) hdr.push('HDR10+')
  else if (/hdr10\b/i.test(text)) hdr.push('HDR10')
  else if (/\bhdr\b/i.test(text)) hdr.push('HDR')

  const tenBit = /10.?bit|hi10p/i.test(lower)

  const audio: string[] = []
  if (/truehd/i.test(text)) audio.push('truehd')
  if (/atmos/i.test(text)) audio.push('atmos')
  if (/dts-?hd|dts-?x|\bdts\b/i.test(text)) audio.push('dts')
  if (/\bddp|dd\+|e-?ac-?3|eac3/i.test(text)) audio.push('eac3')
  else if (/\bdd5|\bdd2|\bac-?3|\bdd\b|dolby\s?digital/i.test(text)) audio.push('ac3')
  if (has('aac')) audio.push('aac')
  if (has('opus')) audio.push('opus')
  if (has('flac')) audio.push('flac')
  if (has('mp3')) audio.push('mp3')

  const container = (fileName?.match(VIDEO_EXT) ?? name.match(VIDEO_EXT))?.[1]?.toLowerCase()

  return { resolution, source, videoCodec, hdr, tenBit, audio, lowQuality, container }
}

const FLAG_LANG: Record<string, string> = {
  GB: 'en', US: 'en', AU: 'en', CA: 'en', RU: 'ru', UA: 'uk', FR: 'fr', ES: 'es', MX: 'es', IT: 'it', DE: 'de',
  PT: 'pt', BR: 'pt', IN: 'hi', JP: 'ja', KR: 'ko', CN: 'zh', TW: 'zh', HK: 'zh', PL: 'pl', NL: 'nl', TR: 'tr',
  SE: 'sv', DK: 'da', NO: 'no', FI: 'fi', GR: 'el', HU: 'hu', CZ: 'cs', RO: 'ro', IL: 'he', SA: 'ar', TH: 'th',
  VN: 'vi', ID: 'id', MY: 'ms', PH: 'tl', IR: 'fa', BD: 'bn', PK: 'ur',
}

/** Converts every flag emoji in a string to a language code. */
export function flagsToLanguages (s: string): string[] {
  const langs: string[] = []
  if (/multi audio/i.test(s)) langs.push('multi')
  if (/dual audio/i.test(s)) langs.push('dual')
  const re = /([\u{1F1E6}-\u{1F1FF}])([\u{1F1E6}-\u{1F1FF}])/gu
  for (const m of s.matchAll(re)) {
    const cc = String.fromCharCode(m[1].codePointAt(0)! - 0x1f1e6 + 65, m[2].codePointAt(0)! - 0x1f1e6 + 65)
    const lang = FLAG_LANG[cc] ?? cc.toLowerCase()
    if (!langs.includes(lang)) langs.push(lang)
  }
  return langs
}

const UNITS: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }

export function parseSize (s: string): number | undefined {
  const m = s.match(/([\d.,]+)\s*(TB|GB|MB|KB|B)\b/i)
  if (!m) return undefined
  return Math.round(parseFloat(m[1].replace(',', '')) * UNITS[m[2].toUpperCase()])
}

export interface TorrentioStream {
  name?: string
  title?: string
  infoHash?: string
  fileIdx?: number
  behaviorHints?: { filename?: string; bingeGroup?: string }
  sources?: string[]
}

type ParsedSource = Omit<Source, 'score' | 'notes'>

export function parseTorrentioStream (stream: TorrentioStream): ParsedSource | null {
  if (!stream.infoHash) return null
  const lines = (stream.title ?? '').split('\n').map(l => l.trim()).filter(Boolean)
  const statsIdx = lines.findIndex(l => l.includes('👤') || l.includes('💾'))
  const statsLine = statsIdx >= 0 ? lines[statsIdx] : ''
  const nameLines = statsIdx >= 0 ? lines.slice(0, statsIdx) : lines
  const afterStats = statsIdx >= 0 ? lines.slice(statsIdx + 1).join(' ') : ''

  const title = nameLines[0] ?? stream.behaviorHints?.filename ?? stream.infoHash
  const fileName = stream.behaviorHints?.filename ?? (nameLines[1]?.split('/').pop())
  const seeders = statsLine.match(/👤\s*(\d+)/)?.[1]
  const provider = statsLine.match(/⚙️\s*(.+)$/)?.[1]?.trim()
  // The second line of `name` carries Torrentio's own quality label, e.g. "4k HDR", which helps when the title lacks one.
  const qualityLabel = (stream.name ?? '').split('\n').slice(1).join(' ')

  const release = parseRelease(`${title} ${qualityLabel}`, fileName)

  return {
    infoHash: stream.infoHash.toLowerCase(),
    fileIdx: typeof stream.fileIdx === 'number' ? stream.fileIdx : undefined,
    fileName,
    title,
    sizeBytes: parseSize(statsLine),
    seeders: seeders ? Number(seeders) : undefined,
    providers: provider ? [provider] : [],
    languages: flagsToLanguages(afterStats),
    trackers: (stream.sources ?? []).filter(s => s.startsWith('tracker:')).map(s => s.slice('tracker:'.length)),
    release,
  }
}
