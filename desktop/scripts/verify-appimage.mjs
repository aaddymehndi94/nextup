// End-to-end check of the packaged Linux app, headless under Xvfb (no window on the desktop):
// cold start → health → search → play Night of the Living Dead (public domain) → a converted stream through
// the bundled ffmpeg → data in the app-data directory → closing the window stops the server and ffmpeg.
//
//   node scripts/verify-appimage.mjs [release/nexttupp-linux-x86_64.AppImage]
//
// Uses a throwaway XDG_CONFIG_HOME, so app.getPath('userData') is <scratch>/config/nexttupp and the owner's
// real ~/.config is untouched. puppeteer-core resolves from the repo root's node_modules.
import puppeteer from 'puppeteer-core'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const DESKTOP = resolve(import.meta.dirname, '..')
const NOTLD = 'tt0063350'
const CDP_PORT = Number(process.env.CDP_PORT ?? 9333)
const appImage = resolve(process.argv[2] ?? join(DESKTOP, 'release', readdirSync(join(DESKTOP, 'release')).find(f => f.endsWith('.AppImage'))))
const scratch = mkdtempSync(join(process.env.VERIFY_TMP ?? tmpdir(), 'nexttupp-verify-'))
const userData = join(scratch, 'config', 'nexttupp')

const results = []
const t0 = Date.now()
const sec = ms => `${(ms / 1000).toFixed(1)} s`
const log = (step, ok, detail = '') => {
  results.push({ step, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? `  (${detail})` : ''}  [${sec(Date.now() - t0)}]`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Every process below `pid`, as { pid, args }. */
function descendants (pid) {
  const rows = execFileSync('ps', ['-e', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' }).trim().split('\n').map(l => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    return { pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }
  })
  const out = []
  const walk = p => { for (const r of rows) if (r.ppid === p) { out.push(r); walk(r.pid) } }
  walk(pid)
  return out
}
const isFfmpeg = p => /\/resources\/ffmpeg\/bin\/ff(mpeg|probe)\b/.test(p.args)

console.log(`AppImage ${appImage} (${(statSync(appImage).size / 1048576).toFixed(1)} MiB)`)
console.log(`userData ${userData}`)

// ---- Launch ---------------------------------------------------------------------------------------------
const launchedAt = Date.now()
const child = spawn('/usr/bin/xvfb-run', ['-a', '-s', '-screen 0 1440x900x24', appImage, `--remote-debugging-port=${CDP_PORT}`], {
  env: { ...process.env, XDG_CONFIG_HOME: join(scratch, 'config'), ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
let appOut = ''
child.stdout.on('data', d => { appOut += d })
child.stderr.on('data', d => { appOut += d })
const childExit = new Promise(r => child.once('exit', code => r(code)))

let base = ''
let healthMs = -1
while (Date.now() - launchedAt < 90_000) {
  try {
    const port = JSON.parse(readFileSync(join(userData, 'desktop.json'), 'utf8')).port
    const h = await fetch(`http://127.0.0.1:${port}/api/health`).then(r => r.json())
    if (h.ok) { base = `http://127.0.0.1:${port}`; healthMs = Date.now() - launchedAt; log('server starts and /api/health answers', true, `${base}, encoder ${h.encoder}, ${sec(healthMs)} after launch`); break }
  } catch { /* not yet */ }
  await sleep(100)
}
if (!base) { log('server starts', false, appOut.slice(-2000)); await finish(1) }

let browser
for (let i = 0; i < 100 && !browser; i++) {
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}`, defaultViewport: null }).catch(() => null)
  if (!browser) await sleep(200)
}
let page
for (let i = 0; i < 100 && !page; i++) {
  page = (await browser.pages()).find(p => p.url().startsWith(base))
  if (!page) await sleep(200)
}
await page.waitForFunction(() => document.readyState === 'complete' && document.querySelector('#root, body')?.children.length > 0, { timeout: 30_000 })
log('window shows the web app (cold start)', true, `window loaded ${sec(Date.now() - launchedAt)} after launch; ${await page.title()}`)

const call = (path, method = 'GET', body) => page.evaluate(async (path, method, body) => {
  const headers = { 'content-type': 'application/json' }
  const id = localStorage.getItem('nexttupp:profile')
  if (id) headers['x-nexttupp-profile'] = id
  const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: await r.json().catch(() => null) }
}, path, method, body)

try {
  // ---- Search ---------------------------------------------------------------------------------------------
  const s = await call('/api/search?q=night%20of%20the%20living%20dead')
  log('search works', s.body?.[0]?.id === NOTLD, `${s.body?.length} results, first "${s.body?.[0]?.name} (${s.body?.[0]?.year})"`)

  // ---- Play through the UI ----------------------------------------------------------------------------------
  const profile = (await call('/api/profiles', 'POST', { name: 'verify' })).body
  await page.evaluate(id => { localStorage.setItem('nexttupp:profile', id); sessionStorage.setItem('nexttupp:profile-picked', '1') }, profile.id)
  await page.goto(`${base}/title/movie/${NOTLD}`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('.hero-actions .button.primary', { timeout: 60_000 })
  const playAt = Date.now()
  await page.click('.hero-actions .button.primary')
  await page.waitForSelector('video', { timeout: 60_000 })
  const firstFrame = await page.waitForFunction(() => {
    const v = document.querySelector('video')
    if (!v || v.paused || v.readyState < 3) return false
    window.__first ??= v.currentTime
    return v.currentTime - window.__first >= 3
  }, { timeout: 180_000, polling: 250 }).then(() => Date.now() - playAt, () => -1)
  const a = await page.evaluate(() => document.querySelector('video').currentTime)
  await sleep(5000)
  const b = await page.evaluate(() => ({ t: document.querySelector('video').currentTime, paused: document.querySelector('video').paused, src: document.querySelector('video').currentSrc }))
  const mode = /play\.mp4/.test(b.src) ? 'converted stream' : 'direct play'
  log('Night of the Living Dead plays (video currentTime advances)', firstFrame >= 0 && b.t - a > 3, `3 s of playback ${sec(firstFrame)} after clicking Play; currentTime ${a.toFixed(1)} → ${b.t.toFixed(1)} over 5 s; ${mode}`)
  await page.screenshot({ path: join(scratch, 'playing.png') })

  // ---- A converted stream through the bundled ffmpeg (a browser that can't decode H.264 forces a transcode) --
  const sessions = (await call('/api/sessions')).body
  const sid = sessions[0]?.id
  const tx = await page.evaluate(async sid => {
    const began = performance.now()
    window.__tx = new AbortController()
    const r = await fetch(`/stream/${sid}/play.mp4?t=600&caps=aac,mp3`, { signal: window.__tx.signal })
    const reader = r.body.getReader()
    let bytes = 0
    let firstMs = -1
    while (bytes < 4 << 20) {
      const { value, done } = await reader.read()
      if (done) break
      if (firstMs < 0) firstMs = performance.now() - began
      bytes += value.length
    }
    window.__txReader = reader // keep the stream (and ffmpeg) running for the shutdown check
    return { mode: r.headers.get('x-playback-mode'), bytes, firstMs: Math.round(firstMs), totalMs: Math.round(performance.now() - began) }
  }, sid)
  const ff = descendants(child.pid).filter(isFfmpeg)
  log('transcode runs through the bundled ffmpeg', tx.mode === 'transcode' && tx.bytes >= 4 << 20 && ff.length > 0,
    `mode ${tx.mode}, first bytes ${tx.firstMs} ms, 4 MiB in ${tx.totalMs} ms; ${ff.map(p => p.args.split(' ')[0].replace(/^.*\/resources\//, 'resources/')).join(', ')} running`)

  // ---- Data in the app-data directory -------------------------------------------------------------------------
  const data = join(userData, 'data')
  const files = readdirSync(data)
  const torrents = readdirSync(join(data, 'torrents'))
  log('data lands in the app-data directory', files.includes('nexttupp.db') && torrents.length > 0,
    `${data}: ${files.join(', ')}; ${torrents.length} saved torrent(s); log ${existsSync(join(userData, 'logs', 'server.log')) ? 'logs/server.log' : 'missing'}`)
} catch (err) {
  log('flow error', false, err.message)
  await page.screenshot({ path: join(scratch, 'error.png') }).catch(() => {})
}

// ---- Quit by closing the window -----------------------------------------------------------------------------
const before = descendants(child.pid)
const serverProc = before.find(p => /--type=utility/.test(p.args) && /nexttupp server|node\.mojom/i.test(p.args)) ?? before.find(p => /--type=utility/.test(p.args))
const ffBefore = before.filter(isFfmpeg)
const quitAt = Date.now()
await page.evaluate(() => window.close()).catch(() => {})
browser.disconnect()
const code = await Promise.race([childExit, sleep(20_000).then(() => 'timeout')])
const quitMs = Date.now() - quitAt
await sleep(500)
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const leftovers = [...before].filter(p => alive(p.pid) && !/xvfb|Xvfb/.test(p.args))
const portClosed = await fetch(`${base}/api/health`).then(() => false, () => true)
log('closing the window quits: server and ffmpeg stop', code !== 'timeout' && leftovers.length === 0 && portClosed,
  `exit ${code} in ${sec(quitMs)}; server ${serverProc ? `pid ${serverProc.pid} ${alive(serverProc.pid) ? 'ALIVE' : 'gone'}` : 'not found'}; ${ffBefore.length} ffmpeg/ffprobe before, ${leftovers.filter(isFfmpeg).length} after; ${leftovers.length} leftover processes; port ${portClosed ? 'closed' : 'OPEN'}`)
if (leftovers.length) console.log(leftovers.map(p => `  ${p.pid} ${p.args.slice(0, 160)}`).join('\n'))
const serverLog = readFileSync(join(userData, 'logs', 'server.log'), 'utf8')
console.log(`server.log tail:\n${serverLog.trim().split('\n').slice(-4).map(l => `  ${l.slice(0, 200)}`).join('\n')}`)
await finish(results.every(r => r.ok) ? 0 : 1)

async function finish (exitCode) {
  try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
  console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed; artefacts in ${scratch}`)
  process.exit(exitCode)
}
