import { Transform } from 'node:stream'

// A converted stream is a fragmented MP4 written as it is made, so its header says nothing about the length.
// A TV's player then takes "as far as it has loaded" for the length, and its seek bar's end keeps moving.
// declareLength writes the film's length into the header as it streams past.

const MAX_HEADER = 4 << 20

interface Box { type: string; start: number; end: number }

function boxes (b: Buffer, start: number, end: number): Box[] | null {
  const out: Box[] = []
  for (let at = start; at < end;) {
    if (end - at < 8) return null
    let size = b.readUInt32BE(at)
    if (size === 1) size = end - at >= 16 ? Number(b.readBigUInt64BE(at + 8)) : 0
    if (size < 8 || at + size > end) return null
    out.push({ type: b.toString('latin1', at + 4, at + 8), start: at, end: at + size })
    at += size
  }
  return out
}

const child = (b: Buffer, parent: Box, type: string) => boxes(b, parent.start + 8, parent.end)?.find(x => x.type === type)

/** Duration field of an mvhd, tkhd or mdhd: [offset, 64-bit]. tkhd has a track id where the others have a timescale. */
function durationField (b: Buffer, box: Box): [number, boolean] {
  const v1 = b[box.start + 8] === 1
  if (box.type === 'tkhd') return v1 ? [box.start + 36, true] : [box.start + 28, false]
  return v1 ? [box.start + 32, true] : [box.start + 24, false]
}
const timescale = (b: Buffer, box: Box) => b.readUInt32BE(box.start + (b[box.start + 8] === 1 ? 28 : 20))
function writeDuration (b: Buffer, box: Box, value: number) {
  const [at, wide] = durationField(b, box)
  const v = Math.max(0, Math.round(value))
  if (wide) b.writeBigUInt64BE(BigInt(v), at)
  else b.writeUInt32BE(Math.min(v, 0xffffffff), at)
}

/** Where a track starts, in seconds: its edit list's leading empty edit (ffmpeg's delay_moov writes one). */
function trackStart (b: Buffer, trak: Box, movieScale: number): number {
  const edts = child(b, trak, 'edts')
  const elst = edts && child(b, edts, 'elst')
  if (!elst || b.readUInt32BE(elst.start + 12) === 0) return 0
  const v1 = b[elst.start + 8] === 1
  const e = elst.start + 16
  const empty = v1 ? b.readBigInt64BE(e + 8) === -1n : b.readInt32BE(e + 4) === -1
  if (!empty) return 0
  return (v1 ? Number(b.readBigUInt64BE(e)) : b.readUInt32BE(e)) / movieScale
}

/**
 * Sets the length in a moov box, in place. Chrome-based players (a Chromecast's too) take the latest track end
 * minus the earliest track start, so every track is made to end `seconds` after the earliest start.
 * Returns false when the box isn't laid out as expected (then it is left alone).
 */
export function patchMoov (b: Buffer, moov: Box, seconds: number): boolean {
  const mvhd = child(b, moov, 'mvhd')
  if (!mvhd) return false
  const movieScale = timescale(b, mvhd)
  if (!movieScale) return false
  const tracks = (boxes(b, moov.start + 8, moov.end) ?? []).filter(x => x.type === 'trak').map(trak => {
    const mdia = child(b, trak, 'mdia')
    return { tkhd: child(b, trak, 'tkhd'), mdhd: mdia && child(b, mdia, 'mdhd'), start: trackStart(b, trak, movieScale) }
  })
  if (!tracks.length || tracks.some(t => !t.tkhd || !t.mdhd || !timescale(b, t.mdhd))) return false
  const first = Math.min(...tracks.map(t => t.start))
  writeDuration(b, mvhd, seconds * movieScale)
  for (const t of tracks) {
    const length = Math.max(0, seconds + first - t.start)
    writeDuration(b, t.tkhd!, length * movieScale)
    writeDuration(b, t.mdhd!, length * timescale(b, t.mdhd!))
  }
  return true
}

/** Passes a fragmented MP4 through, with `seconds` written into its header as the length. */
export function declareLength (seconds: number): Transform {
  let held: Buffer[] = []
  let size = 0
  let done = false
  const flush = (t: Transform) => { done = true; for (const c of held) t.push(c); held = [] }
  return new Transform({
    transform (chunk: Buffer, _enc, cb) {
      if (done) return cb(null, chunk)
      held.push(chunk)
      size += chunk.length
      const b = held.length > 1 ? Buffer.concat(held) : held[0]
      held = [b]
      // Top-level boxes up to the moov (ftyp first); the header is small and comes before any media.
      for (let at = 0; at + 8 <= b.length;) {
        let len = b.readUInt32BE(at)
        const type = b.toString('latin1', at + 4, at + 8)
        if (len === 1) { if (at + 16 > b.length) break; len = Number(b.readBigUInt64BE(at + 8)) }
        if (len < 8 || type === 'moof' || type === 'mdat') { flush(this); return cb() }
        if (at + len > b.length) break
        if (type === 'moov') { patchMoov(b, { type, start: at, end: at + len }, seconds); flush(this); return cb() }
        at += len
      }
      if (size > MAX_HEADER) flush(this)
      cb()
    },
    flush (cb) { flush(this); cb() },
  })
}
