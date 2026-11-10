// Smoke test of a packaged desktop app, on any OS (used by .github/workflows/release.yml after packaging):
//
//   1. the bundled ffmpeg and ffprobe run, and have the encoders and filters the server relies on;
//   2. the bundled server runs on the packaged Electron as Node (ELECTRON_RUN_AS_NODE=1), /api/health reports an
//      encoder, the web app is served, and the CF model loads when one ships;
//   3. a real conversion through the server's own argument builder (server/playback/plan.ts): a synthetic
//      HEVC 10-bit HDR clip with AC-3 audio → H.264 + AAC via libx264, and via the hardware encoder when the
//      server picked one;
//   4. with --app, the real app starts (main process, utility process, first-run copy of the CF model), answers
//      /api/health, and quits cleanly when asked.
//
//   node scripts/smoke.mjs <app> [--app] [--expect-cf]
//
// <app> is the directory with the executable (release/linux-unpacked, an extracted AppImage, the Windows install
// directory) or a macOS .app bundle (or a directory holding one). On Linux run it under xvfb-run for --app.
// --app on macOS and Windows uses the real per-user app-data directory, so it only runs in CI (or with --force).
// Failures are printed as GitHub Actions ::error:: annotations, with the relevant log tail.
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const target = args.find(a => !a.startsWith('--'))
if (!target) { console.error('usage: node scripts/smoke.mjs <app dir or .app> [--app] [--expect-cf]'); process.exit(2) }
const expectCf = flag('--expect-cf')
const os = process.platform
const EXE = os === 'win32' ? '.exe' : ''
const GHA = !!process.env.GITHUB_ACTIONS
const scratch = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'nexttupp-smoke-'))

// ---- Reporting ------------------------------------------------------------------------------------------------
const results = []
const notes = []
const t0 = Date.now()
const esc = s => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
/** A failed check fails the run; with soft = true it is only a warning (something a CI machine may lack). */
function check (step, ok, detail = '', log = '', soft = false) {
  if (!soft) results.push({ step, ok })
  const label = ok ? 'PASS' : soft ? 'WARN' : 'FAIL'
  console.log(`${label}  ${step}${detail ? `  (${detail})` : ''}  [${((Date.now() - t0) / 1000).toFixed(1)} s]`)
  if (!ok) {
    if (log) console.log(log)
    if (GHA) console.log(`::${soft ? 'warning' : 'error'} title=smoke ${os}-${process.arch}: ${esc(step)}::${esc(`${detail}\n${tail(log, 25)}`.trim())}`)
  }
  if (soft) notes.push(`${step}: ${ok ? 'yes' : 'no'}`)
  return ok
}
const tail = (s, n) => String(s ?? '').trim().split(/\r?\n/).slice(-n).map(l => l.slice(0, 240)).join('\n')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- Layout -------------------------------------------------------------------------------------------------
const root = resolve(target)
let appRoot = root
if (os === 'darwin' && !root.endsWith('.app')) appRoot = join(root, readdirSync(root).find(f => f.endsWith('.app')) ?? 'nexttupp.app')
const exe = os === 'darwin' ? join(appRoot, 'Contents', 'MacOS', 'nexttupp') : join(appRoot, `nexttupp${EXE}`)
const resources = os === 'darwin' ? join(appRoot, 'Contents', 'Resources') : join(appRoot, 'resources')
const appDir = join(resources, 'app', 'build')
const ffDir = join(resources, 'ffmpeg')
const ffmpeg = join(ffDir, 'bin', `ffmpeg${EXE}`)
const ffprobe = join(ffDir, 'bin', `ffprobe${EXE}`)
const cfBundled = join(resources, 'reco', 'cf.bin')
// The Linux ffmpeg build needs its libraries on the loader path, as main.ts sets for the server.
const ffEnv = { ...process.env }
if (os === 'linux') ffEnv.LD_LIBRARY_PATH = [join(ffDir, 'lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')

console.log(`app ${appRoot}\nexe ${exe}\nscratch ${scratch}`)
const files = [exe, join(appDir, 'main.cjs'), join(appDir, 'server', 'server.mjs'), join(appDir, 'web', 'index.html'), ffmpeg, ffprobe]
const missing = files.filter(f => !existsSync(f))
check('packaged files present', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${files.length} files`)
if (expectCf) check('CF model bundled', existsSync(cfBundled) && statSync(cfBundled).size > 1 << 20, existsSync(cfBundled) ? `${(statSync(cfBundled).size / 1048576).toFixed(1)} MiB` : `${cfBundled} missing`)
if (missing.length) finish()

// ---- 1. ffmpeg / ffprobe --------------------------------------------------------------------------------------
const run = (bin, a, opts = {}) => spawnSync(bin, a, { env: ffEnv, encoding: 'utf8', maxBuffer: 64 << 20, timeout: 120_000, ...opts })
for (const bin of [ffmpeg, ffprobe]) {
  const r = run(bin, ['-version'])
  const first = (r.stdout ?? '').split('\n')[0]
  if (check(`${bin.endsWith(`ffprobe${EXE}`) ? 'ffprobe' : 'ffmpeg'} -version`, r.status === 0, first || `exit ${r.status} ${r.error?.message ?? ''}`, r.stderr)) notes.push(first)
}
const wantEncoders = { darwin: ['libx264', 'h264_videotoolbox'], win32: ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf'], linux: ['libx264', 'h264_nvenc', 'h264_vaapi', 'h264_qsv'] }[os] ?? ['libx264']
const encList = run(ffmpeg, ['-hide_banner', '-encoders']).stdout ?? ''
const noEnc = wantEncoders.filter(e => !new RegExp(`\\s${e}\\s`).test(encList))
check('ffmpeg has the encoders the server tries', noEnc.length === 0, noEnc.length ? `missing ${noEnc.join(', ')}` : wantEncoders.join(', '))
const filterList = run(ffmpeg, ['-hide_banner', '-filters']).stdout ?? ''
const noFilter = ['zscale', 'tonemap', 'scale', 'format'].filter(f => !new RegExp(`\\s${f}\\s`).test(filterList))
check('ffmpeg has the HDR tone-map filters (zimg)', noFilter.length === 0, noFilter.length ? `missing ${noFilter.join(', ')}` : 'zscale, tonemap')

// ---- 2. Server on the packaged Electron as Node ----------------------------------------------------------------
const nodeData = join(scratch, 'node-data')
mkdirSync(join(nodeData, 'reco'), { recursive: true })
if (expectCf && existsSync(cfBundled)) copyFileSync(cfBundled, join(nodeData, 'reco', 'cf.bin')) // as main.ts does
const port = await freePort()
const base = `http://127.0.0.1:${port}`
let serverOut = ''
const server = spawn(exe, [join(appDir, 'server', 'server.mjs')], {
  env: {
    ...ffEnv,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: '127.0.0.1',
    NEXTTUPP_DATA: nodeData,
    NEXTTUPP_WEB_DIR: join(appDir, 'web'),
    NEXTTUPP_FFMPEG: ffmpeg,
    NEXTTUPP_FFPROBE: ffprobe,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', d => { serverOut += d })
server.stderr.on('data', d => { serverOut += d })
const serverExit = new Promise(r => server.once('exit', code => r(code)))
const health = await waitHealth(base, 90_000, serverExit)
let encoder = health?.encoder
if (check('server runs on Electron as Node; /api/health reports an encoder', !!health?.ok && !!encoder, health ? `encoder ${encoder}` : 'no answer within 90 s', serverOut)) {
  notes.push(`encoder ${encoder}`)
  const page = await fetch(`${base}/`).then(async r => ({ status: r.status, text: await r.text() }), e => ({ status: 0, text: e.message }))
  check('web app served', page.status === 200 && /<script/i.test(page.text), `GET / → ${page.status}, ${page.text.length} bytes`)
  if (expectCf) {
    await sleep(500)
    const failed = /CF model not loaded[^"\n]*/.exec(serverOut)
    check('CF model loads', !failed, failed ? failed[0] : 'no load warning', serverOut)
  }
}
await stop(server, serverExit)

// ---- 3. A real conversion through the server's argument builder --------------------------------------------------
const plan = await import('../../server/playback/plan.ts')
const { parseProbe } = await import('../../server/playback/ffmpeg.ts')
const clip = join(scratch, 'hdr.mkv')
const gen = run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=2048x1152:r=24:d=3', '-f', 'lavfi', '-i', 'sine=d=3',
  '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-x265-params', 'log-level=error:keyint=24:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
  '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-c:a', 'ac3', clip])
if (check('make a 2K HEVC 10-bit HDR test clip', gen.status === 0 && existsSync(clip), `exit ${gen.status}`, gen.stderr)) {
  const probed = run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', clip])
  const probe = parseProbe(JSON.parse(probed.stdout), clip)
  const caps = { h264: true, hevc: false, hevc10: false, av1: false, vp9: false, aac: true, ac3: false, eac3: false, opus: false, mp3: true, flac: false }
  const p = plan.choosePlan(probe, caps, ['en'])
  // libx264 always; the hardware encoder the server picked (its test encode passed, so it must work for real);
  // on macOS VideoToolbox even when not picked, as a warning only: CI's virtual Macs may have no encoder for it.
  const hw = encoder && encoder !== 'x264' ? encoder.split(' ')[0] : null
  const soft = os === 'darwin' && !hw ? ['videotoolbox'] : []
  for (const enc of ['x264', ...(hw ? [hw] : []), ...soft]) {
    const out = join(scratch, `out-${enc}.mp4`)
    const a = plan.buildFfmpegArgs({ input: clip, startSec: 1, probe, plan: p, encoder: enc, hwDevice: /\((.+)\)/.exec(encoder ?? '')?.[1] })
    a[a.length - 1] = out
    a.splice(a.indexOf('-i'), 0, '-t', '2')
    const began = Date.now()
    const r = run(ffmpeg, a)
    const s = r.status === 0 && existsSync(out)
      ? JSON.parse(run(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,pix_fmt', '-print_format', 'json', out]).stdout).streams
      : []
    const v = s.find(x => x.codec_type === 'video')
    const au = s.find(x => x.codec_type === 'audio')
    const good = p.mode === 'transcode' && v?.codec_name === 'h264' && v.pix_fmt === 'yuv420p' && v.height <= 1080 && au?.codec_name === 'aac'
    check(`HDR → H.264 conversion with ${enc}`, good,
      `plan ${p.mode}; ${v ? `${v.codec_name} ${v.width}x${v.height} ${v.pix_fmt}` : 'no video'} + ${au?.codec_name ?? 'no audio'} in ${((Date.now() - began) / 1000).toFixed(1)} s`,
      `ffmpeg ${a.join(' ')}\n${r.stderr}`, soft.includes(enc))
  }
}

// ---- 4. The real app ---------------------------------------------------------------------------------------------
if (flag('--app')) await appCheck()
finish()

async function appCheck () {
  if (os !== 'linux' && !process.env.CI && !flag('--force')) {
    console.log('skipping --app: it uses the real app-data directory on this OS; pass --force to run it anyway')
    return
  }
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  let userData, logDir
  if (os === 'linux') {
    env.XDG_CONFIG_HOME = join(scratch, 'config')
    userData = join(env.XDG_CONFIG_HOME, 'nexttupp')
    logDir = join(userData, 'logs')
  } else if (os === 'darwin') {
    userData = join(homedir(), 'Library', 'Application Support', 'nexttupp')
    logDir = join(homedir(), 'Library', 'Logs', 'nexttupp')
  } else {
    userData = join(process.env.APPDATA, 'nexttupp')
    logDir = join(userData, 'logs')
  }
  // Chromium's sandbox needs a setuid helper or unprivileged user namespaces, neither of which CI runners give.
  const appArgs = os === 'linux' ? ['--no-sandbox'] : []
  const launched = Date.now()
  let out = ''
  const child = spawn(exe, appArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { out += d })
  const exited = new Promise(r => child.once('exit', code => r(code)))
  let gone = false
  exited.then(() => { gone = true })
  let appBase = ''
  let h = null
  while (Date.now() - launched < 90_000 && !h && !gone) {
    try {
      appBase = `http://127.0.0.1:${JSON.parse(readFileSync(join(userData, 'desktop.json'), 'utf8')).port}`
      h = await waitHealth(appBase, 1000, exited)
    } catch { await sleep(250) }
  }
  const log = () => `${out}\n--- server.log ---\n${existsSync(join(logDir, 'server.log')) ? readFileSync(join(logDir, 'server.log'), 'utf8') : '(none)'}`
  if (!check('app starts: main → utility-process server → /api/health', !!h?.ok, h ? `${appBase}, encoder ${h.encoder}, ${((Date.now() - launched) / 1000).toFixed(1)} s after launch` : 'no answer within 90 s', log())) {
    await stop(child, exited)
    return
  }
  if (expectCf) {
    const installed = join(userData, 'data', 'reco', 'cf.bin')
    check('app installs the CF model into its data directory', existsSync(installed) && statSync(installed).size === statSync(cfBundled).size, installed)
    await sleep(500)
    const failed = /CF model not loaded[^"\n]*/.exec(log())
    check('CF model loads in the app', !failed, failed ? failed[0] : 'no load warning', log())
  }
  // Quit the way a user would: SIGTERM is handled as app.quit() on Linux and macOS; on Windows, close the main
  // window (WM_CLOSE, as its close button does). Either way main asks the server to shut down before exiting. On
  // Windows this is only a warning: a runner without an interactive desktop may have no window to close.
  const quitAt = Date.now()
  if (os === 'win32') {
    const ps = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${child.pid}).CloseMainWindow()`], { encoding: 'utf8' })
    console.log(`CloseMainWindow → ${(ps.stdout ?? '').trim() || ps.error?.message}`)
    if (!/True/.test(ps.stdout ?? '')) spawnSync('taskkill', ['/PID', String(child.pid), '/T'], { stdio: 'ignore' })
  } else child.kill('SIGTERM')
  const code = await Promise.race([exited, sleep(20_000).then(() => 'timeout')])
  if (code === 'timeout') await stop(child, exited)
  await sleep(500)
  const closed = await fetch(`${appBase}/api/health`, { signal: AbortSignal.timeout(2000) }).then(() => false, () => true)
  check('app quits cleanly and stops the server', code !== 'timeout' && closed,
    `${code === 'timeout' ? 'did not exit within 20 s, killed' : `exit ${code} in ${((Date.now() - quitAt) / 1000).toFixed(1)} s`}; port ${closed ? 'closed' : 'still open'}`,
    log(), os === 'win32' && code === 'timeout')
}

// ---- Helpers ------------------------------------------------------------------------------------------------------
async function waitHealth (url, ms, exited) {
  const deadline = Date.now() + ms
  let gone = false
  exited.then(() => { gone = true })
  while (Date.now() < deadline && !gone) {
    const h = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok ? r.json() : null, () => null)
    if (h) return h
    await sleep(250)
  }
  return null
}

async function stop (child, exited) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (os === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGTERM')
  if (await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)])) return
  if (os === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGKILL')
  await Promise.race([exited, sleep(2000)])
}

function freePort () {
  return new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => res(p)) })
  })
}

function finish () {
  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  if (GHA && !failed.length) console.log(`::notice title=smoke ${os}-${process.arch}::${esc(`${results.length} checks passed. ${notes.join('; ')}`)}`)
  process.exit(failed.length ? 1 : 0)
}
