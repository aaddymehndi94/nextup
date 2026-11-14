import { spawn } from 'node:child_process'
import type { ProbeResult } from '../../shared/types.ts'
import { config } from '../config.ts'
import { HDR_TONEMAP } from './plan.ts'

// Stills for the quick look at a source (the Preview button on the title page). Each is one keyframe, read
// straight from the torrent: ffmpeg seeks to the keyframe at or before the moment and decodes only that, so only
// the piece or two around it download. That's what makes several of them, from across the film, faster than
// starting to play.

export function frameArgs ({ input, t, probe, width = 1280 }: { input: string; t: number; probe: ProbeResult; width?: number }): string[] {
  const v = probe.video
  if (!v) throw new Error('No picture in this file')
  const filters = [...(v.hdr ? HDR_TONEMAP : []), `scale=${width}:-2`, 'format=yuvj420p']
  return [
    '-hide_banner', '-loglevel', 'error',
    // Decode keyframes only, and give back the keyframe itself instead of decoding on up to `t`.
    '-skip_frame', 'nokey', '-ss', t.toFixed(2), '-noaccurate_seek',
    ...(input.startsWith('http') ? ['-rw_timeout', String(45_000_000)] : []),
    '-i', input,
    '-map', `0:v:${v.index}`, '-frames:v', '1', '-vf', filters.join(','), '-q:v', '3', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1',
  ]
}

/** Runs ffmpeg with `frameArgs` and resolves with the JPEG. */
export function grabFrame (args: string[], timeoutMs = 50_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(config.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let err = ''
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Timed out waiting for that part of the file')) }, timeoutMs)
    p.stdout.on('data', (d: Buffer) => out.push(d))
    p.stderr.on('data', d => { err = (err + d).slice(-500) })
    p.on('error', e => { clearTimeout(timer); reject(e) })
    p.on('close', code => {
      clearTimeout(timer)
      const jpeg = Buffer.concat(out)
      if (code === 0 && jpeg.length > 0) resolve(jpeg)
      else reject(new Error(`No picture there${err ? `: ${err.trim().split('\n').at(-1)}` : ''}`))
    })
  })
}
