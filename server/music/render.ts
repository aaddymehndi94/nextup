import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LyricLine, MusicTrack } from '../../shared/music.ts'
import { artSize } from '../../shared/music.ts'
import { run } from './source.ts'

// The lyrics picture for the TV: the song's cover, blurred and drifting slowly behind, the cover itself on
// the left with the title and artist under it, and the words on the right. Every line is the same size, as in
// the app's own lyrics, so nothing reflows: the line being sung is white and stays at one height, the one
// before and the two after are faded, and each new line slides up into place. ffmpeg draws it live (libass,
// in Mona Sans when the app's font is at hand) as H.264 in fragmented MP4, so the TV can play it while it's
// made.

export const W = 1280
export const H = 720
const ART = 400
const ART_X = 96
/** The cover with the title and artist under it sits in the middle of the screen's height. */
const ART_Y = 112

const assTime = (s: number) => {
  const cs = Math.max(0, Math.round(s * 100))
  const h = Math.floor(cs / 360000)
  const m = Math.floor(cs / 6000) % 60
  const sec = Math.floor(cs / 100) % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}

/** Text as ASS shows it literally: no override blocks, no line breaks. */
const assText = (s: string) => s.replace(/[{}]/g, m => (m === '{' ? '(' : ')')).replace(/\\/g, '/').replace(/\s+/g, ' ').trim()

const FONT = 'Mona Sans'
/** The words' column: right of the cover, to the screen's safe margin. */
const COL_X = ART_X + ART + 80
const SAFE = 96
const SIZE = 46
/** Space between lines: an empty line this tall. */
const GAP = 22
/** Where the top of the line being sung sits: level with the middle of the cover. */
const NOW_Y = ART_Y + ART / 2 - 44
/** How far, and for how long, a new line slides up (about one line). */
const RISE = Math.round(SIZE * 1.3 + GAP)
const SLIDE_MS = 260
const BRIGHT = '00'
const FADED = '9C'
const GONE = 'C8'

/**
 * The words as an ASS script. `from` is where the picture's clock starts in the song (after a seek).
 * Without timed lines it shows the title and artist large instead.
 */
export function lyricsAss (o: { lines: LyricLine[] | null; title: string; artist: string; duration: number; from: number }): string {
  const end = Math.max(o.duration, (o.lines?.at(-1)?.t ?? 0) + 5)
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Words,${FONT},${SIZE},&H00FFFFFF,&H00FFFFFF,&H00000000,&HA0000000,1,0,0,0,100,100,0,0,1,0,1.5,7,${COL_X},${SAFE},0,1
Style: Meta,${FONT},30,&H00FFFFFF,&H00FFFFFF,&H00000000,&HA0000000,1,0,0,0,100,100,0,0,1,0,1,7,${ART_X},${W - ART_X - ART},0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`
  const ev: string[] = []
  const add = (start: number, stop: number, style: string, text: string) => {
    const a = start - o.from
    const b = stop - o.from
    if (b <= 0.05) return
    ev.push(`Dialogue: 0,${assTime(Math.max(0, a))},${assTime(b)},${style},,0,0,0,,${text}`)
  }
  const line = (text: string, alpha: string) => `{\\fs${SIZE}\\alpha&H${alpha}&}${text}`
  const spacer = `\\N{\\fs${GAP}}\\h\\N`

  const lines = (o.lines ?? []).filter((l, i, all) => l.text || (i > 0 && all[i - 1].text))
  if (!lines.length) {
    // No timed words: the title and artist, large, where the words would be.
    add(0, end, 'Words', `{\\an4\\pos(${COL_X},${H / 2})\\fs56}${assText(o.title)}\\N{\\fs12}\\h\\N{\\fs30\\b0\\alpha&H50&}${assText(o.artist)}`)
    return head + ev.join('\n') + '\n'
  }
  // Under the cover: the title and artist, wrapped to the cover's width, all song long.
  add(0, end, 'Meta', `{\\pos(${ART_X},${ART_Y + ART + 26})}${assText(o.title).slice(0, 80)}\\N{\\fs8}\\h\\N{\\fs24\\b0\\alpha&H4D&}${assText(o.artist).slice(0, 80)}`)

  const show = (i: number) => (i >= 0 && i < lines.length ? assText(lines[i].text) || '♪' : '')
  // The line being sung, and the two after it, faded, slide up from where the line before stood.
  const block = (now: string, next: string[], slide: boolean) =>
    `{\\an7${slide ? `\\move(${COL_X},${NOW_Y + RISE},${COL_X},${NOW_Y},0,${SLIDE_MS})` : `\\pos(${COL_X},${NOW_Y})`}}` +
    [line(now, BRIGHT), ...next.filter(Boolean).map(t => line(t, FADED))].join(spacer)
  // Before the first line: a note, with the first lines waiting.
  if (lines[0].t > 0.5) add(0, lines[0].t, 'Words', block('♪', [show(0), show(1)], false))
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i].t
    const stop = i + 1 < lines.length ? lines[i + 1].t : end
    if (stop <= start) continue
    add(start, stop, 'Words', block(show(i), [show(i + 1), show(i + 2)], true))
    // The line just sung, above, fading as it goes up.
    const before = i > 0 ? show(i - 1) : lines[0].t > 0.5 ? '♪' : ''
    if (before) add(start, stop, 'Words', `{\\an1\\move(${COL_X},${NOW_Y - GAP + RISE},${COL_X},${NOW_Y - GAP},0,${SLIDE_MS})}${line(before, GONE)}`)
  }
  return head + ev.join('\n') + '\n'
}

/** The cover as two pictures: large, blurred and darkened (the moving background), and sharp at size. */
export async function prepareArt (ffmpeg: string, dir: string, track: MusicTrack): Promise<{ bg: string; art: string }> {
  mkdirSync(dir, { recursive: true })
  const bg = join(dir, `${track.id}-bg.jpg`)
  const art = join(dir, `${track.id}-art${ART}.jpg`)
  if (existsSync(bg) && existsSync(art)) return { bg, art }
  const url = artSize(track.album?.cover ?? track.artist.picture, 1000)
  let input: string[] = ['-f', 'lavfi', '-i', 'color=c=0x1b1b1e:size=1000x1000']
  if (url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch(() => null)
    if (res?.ok && /^image\//.test(res.headers.get('content-type') ?? '')) {
      const src = join(dir, `${track.id}-src`)
      writeFileSync(src, Buffer.from(await res.arrayBuffer()))
      input = ['-i', src]
    }
  }
  const tmp = (p: string) => `${p}.part.jpg`
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...input, '-frames:v', '1',
    '-vf', 'scale=1600:1600:force_original_aspect_ratio=increase,crop=1600:1600,gblur=sigma=60,eq=brightness=-0.2:saturation=1.3', '-q:v', '3', tmp(bg)], { timeoutMs: 30_000 })
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...input, '-frames:v', '1',
    '-vf', `scale=${ART}:${ART}:force_original_aspect_ratio=increase,crop=${ART}:${ART}`, '-q:v', '2', tmp(art)], { timeoutMs: 30_000 })
  renameSync(tmp(bg), bg)
  renameSync(tmp(art), art)
  return { bg, art }
}

/**
 * ffmpeg arguments for the lyrics picture from `from` seconds: run them with the working directory set to
 * where `lyrics.ass` is, and `fonts/` holding the app's font when `fonts` is set (relative names avoid escaping
 * a full path inside the filter).
 */
export function lyricsVideoArgs (o: { bg: string; art: string; audio: string; from: number; length: number; fonts?: boolean }): string[] {
  const fps = 24
  // The background drifts on two slow, unrelated cycles, so it never visibly repeats.
  const pan = `crop=${W}:${H}:x='(iw-${W})/2+((iw-${W})/2-8)*sin(t/13)':y='(ih-${H})/2+((ih-${H})/2-8)*sin(t/19+1)'`
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-loop', '1', '-framerate', String(fps), '-i', o.bg,
    '-loop', '1', '-framerate', String(fps), '-i', o.art,
    ...(o.from > 0 ? ['-ss', o.from.toFixed(2)] : []), '-i', o.audio,
    '-filter_complex', `[0:v]${pan},format=yuv420p[bg];[bg][1:v]overlay=${ART_X}:${ART_Y}:shortest=0,ass=lyrics.ass${o.fonts ? ':fontsdir=fonts' : ''},format=yuv420p[v]`,
    '-map', '[v]', '-map', '2:a',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-r', String(fps), '-g', String(fps * 2), '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-t', Math.max(1, o.length).toFixed(2),
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1',
  ]
}

/** Whether this ffmpeg can draw the words (it was built with libass). */
export async function canDrawLyrics (ffmpeg: string): Promise<boolean> {
  const out = await run(ffmpeg, ['-hide_banner', '-filters'], { timeoutMs: 10_000 }).catch(() => '')
  return /\bass\b\s+V->V/.test(out) && /\blibx264\b|libx264/.test(await run(ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 10_000 }).catch(() => ''))
}

