import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LyricLine, MusicTrack } from '../../shared/music.ts'
import { artSize } from '../../shared/music.ts'
import { run } from './source.ts'

// The lyrics picture for the TV: the song's cover, blurred and drifting slowly behind, the cover itself on
// the left, and the words on the right, the line being sung bright and large with the one before and the
// two after dimmed. ffmpeg draws it live (libass for the words) as H.264 in fragmented MP4, so the TV can
// play it while it's made.

export const W = 1280
export const H = 720
const ART = 440
const ART_X = 96
const ART_Y = 96

const assTime = (s: number) => {
  const cs = Math.max(0, Math.round(s * 100))
  const h = Math.floor(cs / 360000)
  const m = Math.floor(cs / 6000) % 60
  const sec = Math.floor(cs / 100) % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}

/** Text as ASS shows it literally: no override blocks, no line breaks. */
const assText = (s: string) => s.replace(/[{}]/g, m => (m === '{' ? '(' : ')')).replace(/\\/g, '/').replace(/\s+/g, ' ').trim()

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
Style: Words,Sans,46,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,0,2,4,${ART_X + ART + 72},80,0,1
Style: Meta,Sans,30,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,0,1,7,${ART_X},40,0,1
Style: Sub,Sans,24,&H00D6D6DC,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,0,1,7,${ART_X},40,0,1

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
  // Under the cover: the title and artist, all song long.
  const metaY = ART_Y + ART + 28
  add(0, end, 'Meta', `{\\pos(${ART_X},${metaY})\\q2}${assText(o.title).slice(0, 48)}`)
  add(0, end, 'Sub', `{\\pos(${ART_X},${metaY + 42})\\q2}${assText(o.artist).slice(0, 60)}`)

  const lines = (o.lines ?? []).filter((l, i, all) => l.text || (i > 0 && all[i - 1].text))
  if (!lines.length) {
    add(0, end, 'Words', `{\\an4\\pos(${ART_X + ART + 72},${H / 2})\\fs60}${assText(o.title)}\\N{\\fs34\\alpha&H60&\\b0}${assText(o.artist)}`)
    return head + ev.join('\n') + '\n'
  }
  const dim = (s: string) => `{\\fs32\\alpha&H9A&\\b0}${s}`
  const now = (s: string) => `{\\fs50\\alpha&H00&\\b1}${s}`
  const show = (i: number) => (i >= 0 && i < lines.length ? assText(lines[i].text) || '♪' : '')
  const x = ART_X + ART + 72
  // Before the first line: the first lines waiting, dimmed.
  if (lines[0].t > 0.5) add(0, lines[0].t, 'Words', `{\\an4\\pos(${x},${H / 2})}${now('♪')}\\N${dim(show(0))}\\N${dim(show(1))}`)
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i].t
    const stop = i + 1 < lines.length ? lines[i + 1].t : end
    if (stop <= start) continue
    const parts = [show(i - 1) ? dim(show(i - 1)) : '', now(show(i)), show(i + 1) ? dim(show(i + 1)) : '', show(i + 2) ? dim(show(i + 2)) : ''].filter(Boolean)
    add(start, stop, 'Words', `{\\an4\\pos(${x},${H / 2})\\fad(120,0)}${parts.join('\\N')}`)
  }
  return head + ev.join('\n') + '\n'
}

/** The cover as two pictures: large, blurred and darkened (the moving background), and sharp at size. */
export async function prepareArt (ffmpeg: string, dir: string, track: MusicTrack): Promise<{ bg: string; art: string }> {
  mkdirSync(dir, { recursive: true })
  const bg = join(dir, `${track.id}-bg.jpg`)
  const art = join(dir, `${track.id}-art.jpg`)
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
 * where `lyrics.ass` is (a relative name avoids escaping a full path inside the filter).
 */
export function lyricsVideoArgs (o: { bg: string; art: string; audio: string; from: number; length: number }): string[] {
  const fps = 24
  // The background drifts on two slow, unrelated cycles, so it never visibly repeats.
  const pan = `crop=${W}:${H}:x='(iw-${W})/2+((iw-${W})/2-8)*sin(t/13)':y='(ih-${H})/2+((ih-${H})/2-8)*sin(t/19+1)'`
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-loop', '1', '-framerate', String(fps), '-i', o.bg,
    '-loop', '1', '-framerate', String(fps), '-i', o.art,
    ...(o.from > 0 ? ['-ss', o.from.toFixed(2)] : []), '-i', o.audio,
    '-filter_complex', `[0:v]${pan},format=yuv420p[bg];[bg][1:v]overlay=${ART_X}:${ART_Y}:shortest=0,ass=lyrics.ass,format=yuv420p[v]`,
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
