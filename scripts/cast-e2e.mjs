// Casting, the stream side, against scripts/fake-tv.ts (never a real TV): for a direct-play MP4, an H.264+AC3
// MKV (remux) and an HEVC 10-bit+AC3 MKV (transcode), start a cast, take the URL the "TV" was given, and
// check it with ffprobe (H.264 8-bit + AAC in MP4) and with headless Chrome (a Chromecast is Chromium);
// then seek, pause, volume, a wrong token, stop, and that the URL is dead afterwards.
//
//   node scripts/cast-e2e.mjs http://127.0.0.1:4552 http://<lan-ip>:4552 tv.log hashes.json out/
//
// hashes.json maps three 90-second test files to info hashes (scripts/seed-local-torrents.mjs, into the
// server's scratch NEXTTUPP_DATA before it starts). The server runs with
// NEXTTUPP_CAST_DEVICES='Fake TV@<lan-ip>:18009' and scripts/fake-tv.ts logs to tv.log. The files:
//
//   SRC='-f lavfi -i testsrc2=size=1920x1080:rate=24 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 90'
//   ffmpeg $SRC -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart cast-h264-aac.mp4
//   ffmpeg $SRC -c:v libx264 -pix_fmt yuv420p -c:a ac3 cast-h264-ac3.mkv
//   ffmpeg $SRC -c:v libx265 -pix_fmt yuv420p10le -c:a ac3 cast-hevc10-ac3.mkv
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const [server, lanUrl, tvLog, hashesFile, out] = process.argv.slice(2)
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const hashes = JSON.parse(readFileSync(hashesFile, 'utf8'))
const checks = []
const check = (name, ok, detail = '') => { checks.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`) }
const api = async (method, path, body) => {
  const r = await fetch(server + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  const j = await r.json().catch(() => null)
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`)
  return j
}
const tvEvents = () => readFileSync(tvLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
const lastLoad = () => tvEvents().filter(e => e.type === 'LOAD').at(-1)
const ffprobe = url => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name:stream=codec_type,codec_name,pix_fmt,profile,width,height,channels', '-of', 'json', url], { timeout: 60_000 }).toString())

const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
async function playsInChrome (url, label) {
  const page = await browser.newPage()
  page.on('console', m => console.log('  [console]', m.text()))
  // A page on the computer's LAN origin, like the TV's player app reaching a LAN address (an about:blank page
  // counts as public, and Chrome's local-network rules block it from loading a private address).
  await page.goto(new URL('/cast/none/raw', url).href)
  const r = await page.evaluate(src => new Promise(resolve => {
    const v = document.createElement('video')
    v.muted = true
    v.autoplay = true
    v.src = src
    document.body.append(v)
    const done = extra => resolve({ readyState: v.readyState, w: v.videoWidth, h: v.videoHeight, t: v.currentTime, error: v.error?.message ?? null, ...extra })
    v.addEventListener('error', () => done({ failed: true }))
    v.addEventListener('playing', () => { const t0 = v.currentTime; setTimeout(() => done({ advanced: v.currentTime - t0 }), 2500) }, { once: true })
    setTimeout(() => done({ timeout: true }), 45_000)
  }), url)
  await page.screenshot({ path: `${out}/cast-${label}.png` })
  await page.close()
  return r
}

try {
  const cases = [
    { file: 'cast-h264-aac.mp4', mode: 'direct' },
    { file: 'cast-h264-ac3.mkv', mode: 'remux' },
    { file: 'cast-hevc10-ac3.mkv', mode: 'transcode' },
  ]
  for (const c of cases) {
    console.log(`--- ${c.file}`)
    const s = await api('POST', '/api/sessions', { infoHash: hashes[c.file], fileIdx: 0 })
    const status = await api('POST', '/api/cast', { deviceId: 'static-0', sessionId: s.id, t: 30, title: `Test film · ${c.file}`, streamId: 'tt0063350' })
    check(`cast started, ${c.mode}`, status.active && status.mode === c.mode && status.device.name === 'Fake TV', `${status.mode} ${status.state}`)
    const load = lastLoad()
    const url = load.media.contentId
    check('the TV got a tokenised LAN URL', new RegExp(`^${escape(lanUrl)}/cast/[A-Za-z0-9_-]{43}/(raw|play\\.mp4\\?t=30\\.00)$`).test(url), url.replace(/cast\/[^/]+/, 'cast/<token>'))
    check('LOAD offset', c.mode === 'direct' ? load.currentTime === 30 : load.currentTime === 0, String(load.currentTime))
    const p = ffprobe(url)
    const v = p.streams.find(x => x.codec_type === 'video')
    const a = p.streams.find(x => x.codec_type === 'audio')
    check('ffprobe: H.264 8-bit + AAC/MP4 for the TV', /mp4/.test(p.format.format_name) && v.codec_name === 'h264' && v.pix_fmt === 'yuv420p' && a.codec_name === 'aac', `${p.format.format_name} ${v.codec_name} ${v.pix_fmt} ${v.width}x${v.height} ${a.codec_name} ${a.channels}ch`)
    const chrome = await playsInChrome(url, c.mode)
    check('headless Chrome plays it', !chrome.failed && !chrome.timeout && chrome.w > 0 && chrome.advanced > 1, JSON.stringify(chrome))

    // Seek: direct play seeks on the TV; a converted stream is reloaded with ?t=.
    const before = tvEvents().length
    const after = await api('POST', '/api/cast/control', { action: 'seek', t: 60 })
    const ev = tvEvents().slice(before)
    if (c.mode === 'direct') check('seek → SEEK on the TV', ev.some(e => e.type === 'SEEK' && e.currentTime === 60), `${after.position.toFixed(1)}`)
    else {
      const reload = ev.find(e => e.type === 'LOAD')
      check('seek → LOAD with ?t=60', Boolean(reload && /play\.mp4\?t=60\.00$/.test(reload.media.contentId)), `${after.position.toFixed(1)}`)
      const p2 = ffprobe(reload.media.contentId)
      check('reloaded stream probes', p2.streams.some(x => x.codec_name === 'h264'))
    }
    check('position follows the seek', after.position >= 55 && after.position <= 62, after.position.toFixed(2))
    await api('POST', '/api/cast/control', { action: 'pause' })
    check('pause', (await api('GET', '/api/cast')).state === 'paused')
    await api('POST', '/api/cast/control', { action: 'volume', level: 0.25 })
    check('volume', tvEvents().some(e => e.type === 'SET_VOLUME' && e.volume?.level === 0.25))

    const wrong = await fetch(url.replace(/cast\/[^/]+/, `cast/${'A'.repeat(43)}`))
    check('a wrong token is refused', wrong.status === 404, String(wrong.status))
    const subs = await fetch(url.replace(/(raw|play\.mp4.*)$/, 'subs.vtt'))
    check('no subtitle chosen → no subs.vtt', subs.status === 404, String(subs.status))
    const stopped = await api('POST', '/api/cast/stop', {})
    check('stop returns where it was', stopped.active === false && stopped.position > 50, stopped.position?.toFixed(1))
    const gone = await fetch(url)
    check('the URL is dead after stop', gone.status === 404, String(gone.status))
    check('STOP sent to the TV', tvEvents().at(-1).type === 'STOP')
    await api('DELETE', `/api/sessions/${s.id}`).catch(() => {})
  }
} finally {
  await browser.close()
}
const failed = checks.filter(c => !c).length
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
