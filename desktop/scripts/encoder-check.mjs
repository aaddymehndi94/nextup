// Real encodes on this machine through the server's own argument builder: for each encoder, the detection
// test encode, then a 10 s transcode of a synthetic 4K HEVC 10-bit HDR (PQ) clip with the full filter chain
// (downscale, tone-map, upload) started at t=3 s, checked with ffprobe (H.264, 1080p, yuv420p, keyframe ≤ 2 s).
//
//   NEXTTUPP_FFMPEG=vendor/ffmpeg/linux-x64/bin/ffmpeg NEXTTUPP_FFPROBE=… node scripts/encoder-check.mjs [nvenc vaapi …]
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../../server/config.ts'
import { detectEncoder, parseProbe, testEncoder } from '../../server/playback/ffmpeg.ts'
import { buildFfmpegArgs, choosePlan, encoderCandidates } from '../../server/playback/plan.ts'

const dir = mkdtempSync(join(process.env.VERIFY_TMP ?? tmpdir(), 'nexttupp-enc-'))
const src = join(dir, 'hdr4k.mkv')
console.log(`ffmpeg ${config.ffmpeg}`)
execFileSync(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=3840x2160:r=24:d=14', '-f', 'lavfi', '-i', 'sine=d=14',
  '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-x265-params', 'log-level=error:keyint=48:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
  '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-c:a', 'ac3', src])
const probe = parseProbe(JSON.parse(execFileSync(config.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', src], { encoding: 'utf8' })), src)
const caps = { h264: true, hevc: false, hevc10: false, av1: false, vp9: false, aac: true, ac3: false, eac3: false, opus: false, mp3: true, flac: false }
const plan = choosePlan(probe, caps, ['en'])
console.log(`source: ${probe.video.codec} ${probe.video.width}x${probe.video.height} ${probe.video.pixFmt} hdr=${probe.video.hdr}; plan ${plan.mode}`)

const nodes = readdirSync('/dev/dri').filter(f => f.startsWith('renderD')).map(f => `/dev/dri/${f}`)
const want = process.argv.slice(2)
const all = encoderCandidates('linux', nodes)
for (const c of all.filter(c => !want.length || want.includes(c.encoder))) {
  const name = c.device ? `${c.encoder} ${c.device}` : c.encoder
  const t = Date.now()
  const ok = await testEncoder(c)
  const testMs = Date.now() - t
  if (!ok) { console.log(`${name.padEnd(28)} test encode FAILED (${testMs} ms)`); continue }
  const out = join(dir, `${c.encoder}-${(c.device ?? '').replace(/\W/g, '')}.mp4`)
  const args = buildFfmpegArgs({ input: src, startSec: 3, probe, plan, encoder: c.encoder, hwDevice: c.device })
  args[args.length - 1] = out
  args.splice(args.indexOf('-i'), 0, '-t', '10')
  const began = Date.now()
  const r = spawnSync(config.ffmpeg, args, { encoding: 'utf8' })
  const ms = Date.now() - began
  if (r.status !== 0 || !existsSync(out)) { console.log(`${name.padEnd(28)} test ok, transcode FAILED: ${r.stderr.trim().split('\n').slice(-2).join(' | ')}`); continue }
  const s = JSON.parse(execFileSync(config.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,pix_fmt', '-print_format', 'json', out], { encoding: 'utf8' })).streams[0]
  const keys = execFileSync(config.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim().split('\n').map(l => Number.parseFloat(l))
  const gap = Math.max(...keys.slice(1).map((k, i) => k - keys[i]))
  const good = s.codec_name === 'h264' && s.width === 1920 && s.height === 1080 && s.pix_fmt === 'yuv420p' && gap <= 2.05
  console.log(`${name.padEnd(28)} ${good ? 'OK  ' : 'BAD '} test ${testMs} ms; 10 s of 4K HDR → ${s.codec_name} ${s.width}x${s.height} ${s.pix_fmt} in ${(ms / 1000).toFixed(1)} s (${(10000 / ms).toFixed(1)}x realtime), ${keys.length} keyframes, max gap ${gap.toFixed(2)} s`)
}
const t = Date.now()
const picked = await detectEncoder({ forced: config.encoder, vaapiDevice: config.vaapiDevice, log: m => console.log(`  detect: ${m}`) })
console.log(`detectEncoder → ${picked.encoder}${picked.device ? ` (${picked.device})` : ''} in ${Date.now() - t} ms${config.encoder ? ` (forced ${config.encoder})` : ''}`)
