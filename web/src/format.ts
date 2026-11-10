export function bytes (n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

export const speed = (bps: number) => `${bytes(bps)}/s`

export function clock (sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

export const RES_LABEL: Record<string, string> = { '2160p': '4K', '1080p': '1080p', '720p': '720p', '480p': 'SD', unknown: '?' }

export const LANG_NAME: Record<string, string> = {
  en: 'English', hi: 'Hindi', fr: 'French', es: 'Spanish', it: 'Italian', ru: 'Russian', de: 'German', pt: 'Portuguese',
  uk: 'Ukrainian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', pl: 'Polish', tr: 'Turkish', multi: 'Multi-audio', dual: 'Dual audio',
}
