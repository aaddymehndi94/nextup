/** Parses a single-range HTTP Range header. Returns null for a full-body response, 'invalid' for 416. */
export function parseRange (header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null
  const m = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid'
  let start: number
  let end: number
  if (m[1] === '') {
    // Suffix range: last N bytes.
    const n = Number(m[2])
    if (n === 0) return 'invalid'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return 'invalid'
  return { start, end }
}

const TYPES: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', mov: 'video/quicktime', ts: 'video/mp2t' }

export function contentType (fileName: string): string {
  return TYPES[fileName.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}
