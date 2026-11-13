import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { MusicTrack } from '../../shared/music.ts'

// Where a song's sound comes from. The real one is YouTube through yt-dlp (youtube.ts); the fake one makes
// a few seconds of chords with ffmpeg, so tests and demos never touch YouTube (NEXTTUPP_MUSIC_SOURCE=fake).

export interface Fetched {
  /** Where it came from (a YouTube video id), kept for the record. */
  ref: string
  /** Seconds, when the source knows. */
  duration?: number
}

export interface SourceStatus {
  helper: 'ok' | 'missing' | 'installing' | 'error'
  message?: string
  /** While installing: how much of the helper has downloaded, from 0 to 1, when its size is known. */
  progress?: number
}

export interface AudioSource {
  readonly kind: 'youtube' | 'fake'
  status (): SourceStatus
  /** Saves the song as AAC in an MP4 container (.m4a) at `dest`. */
  fetchAudio (track: MusicTrack, dest: string): Promise<Fetched>
  /** Saves the song's music video (H.264 + AAC, at most 720p) at `dest`, or null when there isn't one. */
  fetchVideo (track: MusicTrack, dest: string): Promise<Fetched | null>
  /** Gets the helper program onto this computer (the "Set up music" button). */
  install? (): Promise<void>
}

export function run (bin: string, args: string[], opts: { timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: opts.timeoutMs, maxBuffer: 32 * 1024 * 1024, env: opts.env ?? process.env, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr || err.message).trim().split('\n').filter(Boolean).slice(-3).join(' · ')
        reject(Object.assign(new Error(tail || err.message), { code: (err as NodeJS.ErrnoException).code }))
      } else resolve(String(stdout))
    })
  })
}

/** Chords made by ffmpeg, a different one per song. Songs last `seconds` (or their real length if shorter). */
export class FakeSource implements AudioSource {
  readonly kind = 'fake' as const
  private readonly ffmpeg: string
  private readonly seconds: number

  constructor (ffmpeg: string, seconds = 20) {
    this.ffmpeg = ffmpeg
    this.seconds = seconds
  }

  status (): SourceStatus { return { helper: 'ok' } }

  private tones (track: MusicTrack): number[] {
    const n = createHash('sha1').update(track.id).digest()[0]
    const root = 196 + (n % 12) * 11
    return [root, root * 1.26, root * 1.5]
  }

  private length (track: MusicTrack): number {
    return Math.max(4, Math.min(this.seconds, track.duration || this.seconds))
  }

  async fetchAudio (track: MusicTrack, dest: string): Promise<Fetched> {
    const d = this.length(track)
    const inputs = this.tones(track).flatMap(f => ['-f', 'lavfi', '-i', `sine=frequency=${f.toFixed(1)}:duration=${d}`])
    await run(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...inputs,
      '-filter_complex', 'amix=inputs=3:normalize=0,volume=0.25,afade=t=in:d=0.3,afade=t=out:st=' + (d - 0.5) + ':d=0.5',
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-f', 'mp4', dest], { timeoutMs: 60_000 })
    return { ref: `fake:${track.id}`, duration: d }
  }

  async fetchVideo (track: MusicTrack, dest: string): Promise<Fetched> {
    const d = this.length(track)
    const [f] = this.tones(track)
    await run(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=24:duration=${d}`, '-f', 'lavfi', '-i', `sine=frequency=${f}:duration=${d}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', '-f', 'mp4', dest], { timeoutMs: 120_000 })
    return { ref: `fake-video:${track.id}`, duration: d }
  }
}
