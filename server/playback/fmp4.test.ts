import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { declareLength } from './fmp4.ts'

const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(8 + body.length)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, body])
}
const u32 = (...n: number[]) => Buffer.concat(n.map(x => { const b = Buffer.alloc(4); b.writeInt32BE(x | 0); return b }))
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b }

// As ffmpeg writes a converted stream with delay_moov: each track's start (film time) as an empty edit.
const elst = (startMs: number) => box('elst', u32(0, 2, startMs, -1, 0x10000, 0, 1280, 0x10000))
const track = (startMs: number, mdhd: Buffer) => box('trak',
  box('tkhd', u32(3, 0, 0, 1, 0, 0), Buffer.alloc(60)),
  box('edts', elst(startMs)),
  box('mdia', mdhd, box('hdlr', Buffer.alloc(24))))
const mdhdV0 = (scale: number) => box('mdhd', u32(0, 0, 0, scale, 0, 0))
const mdhdV1 = (scale: number) => box('mdhd', Buffer.from([1, 0, 0, 0]), u64(0), u64(0), u32(scale), u64(0), u32(0))
const moov = box('moov',
  box('mvhd', u32(0, 0, 0, 1000, 0), Buffer.alloc(80)),
  track(30_005, mdhdV0(16_000)),
  track(37_278, mdhdV1(48_000)),
  box('mvex', box('trex', Buffer.alloc(24))))
const head = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\u0002\0isomiso6mp41', 'latin1')), moov])
const media = Buffer.concat([box('moof', Buffer.alloc(40)), box('mdat', Buffer.alloc(500, 7))])

async function through (input: Buffer, seconds: number, chunk = 7): Promise<Buffer> {
  const parts: Buffer[] = []
  for (let i = 0; i < input.length; i += chunk) parts.push(input.subarray(i, i + chunk))
  const out: Buffer[] = []
  for await (const c of Readable.from(parts).pipe(declareLength(seconds))) out.push(c as Buffer)
  return Buffer.concat(out)
}

const at = (b: Buffer, type: string, nth = 0) => {
  let i = -1
  for (let n = 0; n <= nth; n++) i = b.indexOf(type, i + 1, 'latin1')
  return i - 4
}

describe('declareLength', () => {
  it('writes the film’s length into the header, every track ending that long after the first starts', async () => {
    const out = await through(Buffer.concat([head, media]), 5400)
    expect(out.length).toBe(head.length + media.length)
    expect(out.readUInt32BE(at(out, 'mvhd') + 24)).toBe(5_400_000)
    // The picture starts first (30.005 s): it runs the whole length; the sound starts 7.273 s later.
    expect(out.readUInt32BE(at(out, 'tkhd', 0) + 28)).toBe(5_400_000)
    expect(out.readUInt32BE(at(out, 'mdhd', 0) + 24)).toBe(5400 * 16_000)
    expect(out.readUInt32BE(at(out, 'tkhd', 1) + 28)).toBe(5_392_727)
    expect(Number(out.readBigUInt64BE(at(out, 'mdhd', 1) + 32))).toBe(Math.round(5392.727 * 48_000))
    // Everything after the header passes untouched.
    expect(out.subarray(head.length).equals(media)).toBe(true)
  })

  it('passes a stream through as it is when it has no header before its media', async () => {
    const odd = Buffer.concat([box('ftyp', Buffer.alloc(8)), media, moov])
    expect((await through(odd, 100, 3)).equals(odd)).toBe(true)
  })
})
