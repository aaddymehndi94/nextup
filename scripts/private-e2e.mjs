// Private mode, end to end on this machine: a scratch nexttupp server streams a real torrent (seeded here,
// found through a local tracker) for a private request, then everything that would normally be kept is
// checked: no log line, no saved metadata, nothing in downloads, no progress/likes/downloads/impressions
// in the database, no-store on every response, the video's folder deleted when playback stops, and a
// crashed private session's folder wiped at the next start. Then the app itself in headless Chrome: the
// switch, the label, images through the relay, nothing written to the page's storage.
//
//   node scripts/private-e2e.mjs <scratch-dir> <video-file> <out-dir>
//
// The scratch dir must be empty or absent; it becomes the server's NEXTTUPP_DATA. Never the real data dir.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Server as Tracker } from 'bittorrent-tracker'
import WebTorrent from 'webtorrent'
import puppeteer from 'puppeteer-core'

const [dataDir, video, out] = process.argv.slice(2)
if (!dataDir || !video || !out) { console.error('usage: node scripts/private-e2e.mjs <scratch-dir> <video-file> <out-dir>'); process.exit(2) }
if (existsSync(dataDir) && readdirSync(dataDir).length) { console.error(`${dataDir} is not empty`); process.exit(2) }
mkdirSync(dataDir, { recursive: true })
mkdirSync(out, { recursive: true })
const PORT = 4553
const BASE = `http://127.0.0.1:${PORT}`
const checks = []
const check = (name, ok, detail = '') => { checks.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PRIV = { 'x-nexttupp-private': '1' }
const logFile = join(out, 'server.log')

// ---- A seeder the server can find: a local tracker and a WebTorrent client seeding the file -------------
const tracker = new Tracker({ udp: false, ws: false, http: true })
await new Promise(r => tracker.listen(0, '127.0.0.1', r))
const announce = `http://127.0.0.1:${tracker.http.address().port}/announce`
const seeder = new WebTorrent({ dht: false, lsd: false, utp: false })
const seeded = await new Promise(r => seeder.seed(video, { announce: [announce], name: basename(video) }, r))
const infoHash = seeded.infoHash
console.log(`seeding ${basename(video)} as ${infoHash}`)

// ---- The server ------------------------------------------------------------------------------------------
let server
const logs = []
async function startServer () {
  server = spawn(process.execPath, ['server/index.ts'], {
    env: { ...process.env, NEXTTUPP_DATA: dataDir, PORT: String(PORT), HOST: '127.0.0.1', NEXTTUPP_CLOUD_URL: 'http://127.0.0.1:9' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', d => logs.push(String(d)))
  server.stderr.on('data', d => logs.push(String(d)))
  for (let i = 0; i < 120; i++) { if (await fetch(`${BASE}/api/health`).then(r => r.ok, () => false)) return; await sleep(250) }
  throw new Error('server did not start')
}
const call = async (method, path, { headers = {}, body } = {}) => {
  const res = await fetch(BASE + path, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers }
}
const dbCounts = () => {
  const db = new DatabaseSync(join(dataDir, 'nexttupp.db'), { readOnly: true })
  const n = t => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n
  const r = Object.fromEntries(['progress', 'ratings', 'my_list', 'events', 'impressions', 'dismissals'].map(t => [t, n(t)]))
  db.close()
  return r
}
const ls = d => existsSync(join(dataDir, d)) ? readdirSync(join(dataDir, d)) : []

try {
  await startServer()
  const profile = (await call('GET', '/api/profiles')).json[0]
  const P = { ...PRIV, 'x-nexttupp-profile': profile.id }
  // A normal home first, so impressions has its baseline (a fresh profile's first home records some).
  await call('GET', '/api/me/home', { headers: { 'x-nexttupp-profile': profile.id } })
  await sleep(300)
  const before = dbCounts()
  const logStart = logs.join('').length

  // ---- Stream privately ------------------------------------------------------------------------------
  const open = await call('POST', '/api/sessions', { headers: P, body: { infoHash, fileIdx: 0, trackers: [announce], title: 'Secret Film' } })
  check('private session opens', open.status === 200, `${open.status} ${open.json?.error ?? ''}`)
  const sid = open.json?.id
  check('the session response is not cacheable', open.headers.get('cache-control') === 'no-store')
  const range = await fetch(`${BASE}/stream/${sid}/raw`, { headers: { range: 'bytes=0-65535' } })
  const bytes = (await range.arrayBuffer()).byteLength
  check('video bytes stream from the seeder', range.status === 206 && bytes === 65536, `${range.status}, ${bytes} bytes`)
  check('the video response is not cacheable', range.headers.get('cache-control') === 'no-store')
  const priv = ls('private')
  check('its data is in one private folder with a random name', priv.length === 1 && !priv[0].includes(infoHash) && /^[0-9a-f-]{36}$/.test(priv[0]), priv.join(','))
  check('nothing in downloads', ls('downloads').length === 0, ls('downloads').join(','))
  check('no saved torrent metadata', ls('torrents').length === 0, ls('torrents').join(','))

  // ---- Everything that would save something is refused ---------------------------------------------
  const prog = await call('POST', '/api/me/progress', { headers: P, body: { type: 'movie', id: 'tt0111161', streamId: 'tt0111161', position: 600, duration: 5000 } })
  check('progress is refused', prog.status === 409 && /Private mode is on/.test(prog.json?.error ?? ''), String(prog.status))
  const like = await call('PUT', '/api/me/rating/movie/tt0111161', { headers: P, body: { value: 1 } })
  check('a like is refused', like.status === 409, String(like.status))
  const list = await call('PUT', '/api/me/list/movie/tt0111161', { headers: P, body: {} })
  check('My List is refused', list.status === 409, String(list.status))
  const keep = await call('POST', '/api/library', { headers: P, body: { sessionId: sid, type: 'movie', imdbId: 'tt0111161', streamId: 'tt0111161' } })
  check('a download is refused', keep.status === 409, String(keep.status))
  const newProfile = await call('POST', '/api/profiles', { headers: P, body: { name: 'Hidden' } })
  check('a new profile is refused', newProfile.status === 409, String(newProfile.status))
  const home = await call('GET', '/api/me/home', { headers: P })
  check('home still works in private mode', home.status === 200 && Array.isArray(home.json?.rows))
  await call('GET', '/api/search?q=matrix', { headers: P })
  await call('GET', `/api/title/movie/tt0133093/similar`, { headers: P })
  await sleep(500)
  const after = dbCounts()
  check('the database is unchanged', JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after))

  // ---- No log line about any of it ------------------------------------------------------------------
  const privLog = logs.join('').slice(logStart)
  const leaks = [infoHash, 'Secret Film', basename(video), 'matrix', 'tt0133093', 'tt0111161', '/stream/', '/api/me/']
    .filter(s => privLog.includes(s))
  check('no log line mentions the private session', leaks.length === 0, leaks.length ? `found: ${leaks.join(', ')}` : `${privLog.length} bytes logged meanwhile`)

  // ---- Stopping deletes it --------------------------------------------------------------------------
  const close = await call('DELETE', `/api/sessions/${sid}`, { headers: PRIV })
  check('closing the session', close.status === 204, String(close.status))
  await sleep(500)
  check('its folder is deleted on close', ls('private').length === 0, ls('private').join(','))
  check('still nothing in downloads or torrents', ls('downloads').length === 0 && ls('torrents').length === 0)

  // ---- A crash mid-stream leaves nothing past the next start ---------------------------------------
  const again = await call('POST', '/api/sessions', { headers: P, body: { infoHash, fileIdx: 0, trackers: [announce] } })
  await (await fetch(`${BASE}/stream/${again.json.id}/raw`, { headers: { range: 'bytes=0-65535' } })).arrayBuffer()
  const left = ls('private')
  server.kill('SIGKILL')
  await new Promise(r => server.once('exit', r))
  check('a killed server leaves its private folder behind…', left.length === 1 && ls('private').length === 1)
  await startServer()
  check('…and the next start deletes it', ls('private').length === 0, ls('private').join(','))

  // ---- The image relay ---------------------------------------------------------------------------------
  const img = await fetch(`${BASE}/api/img?u=${encodeURIComponent('https://images.metahub.space/poster/small/tt0111161/img')}`, { headers: PRIV })
  check('posters load through the relay, uncached', img.status === 200 && /^image\//.test(img.headers.get('content-type') ?? '') && img.headers.get('cache-control') === 'no-store', `${img.status} ${img.headers.get('content-type')}`)
  await img.arrayBuffer()
  const evil = await fetch(`${BASE}/api/img?u=${encodeURIComponent('https://example.com/x.png')}`)
  check('the relay fetches only poster hosts', evil.status === 400, String(evil.status))
  const local = await fetch(`${BASE}/api/img?u=${encodeURIComponent('http://127.0.0.1:4553/api/health')}`)
  check('…and never a local address', local.status === 400, String(local.status))

  // ---- A normal stream is unaffected -------------------------------------------------------------------
  const normal = await call('POST', '/api/sessions', { headers: { 'x-nexttupp-profile': profile.id }, body: { infoHash, fileIdx: 0, trackers: [announce] } })
  await (await fetch(`${BASE}/stream/${normal.json.id}/raw`, { headers: { range: 'bytes=0-65535' } })).arrayBuffer()
  await sleep(300)
  check('a normal stream goes to downloads as before', ls('downloads').includes(infoHash) && ls('private').length === 0)
  check('…and is logged as before', logs.join('').includes(`/stream/${normal.json.id}/raw`))
  await call('DELETE', `/api/sessions/${normal.json.id}`)

  // ---- The app in a browser ----------------------------------------------------------------------------
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', headless: true })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 800 })
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(BASE + '/', { waitUntil: 'networkidle2' })
    await page.evaluate(id => localStorage.setItem('nexttupp:profile', id), profile.id)
    await page.reload({ waitUntil: 'networkidle2' })
    const storageBefore = await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()))
    await page.click('.avatar-button')
    await page.waitForSelector('[role="menuitemcheckbox"]')
    await page.click('[role="menuitemcheckbox"]')
    await page.waitForSelector('.private-pill')
    check('the switch turns private mode on and shows the label', true)
    const sent = []
    page.on('request', r => { if (r.url().startsWith(BASE + '/api/')) sent.push({ url: r.url(), priv: r.headers()['x-nexttupp-private'] === '1' }) })
    await page.reload({ waitUntil: 'networkidle2' })
    check('private mode survives a reload of the window', Boolean(await page.$('.private-pill')))
    await page.waitForSelector('img', { timeout: 20_000 }).catch(() => {})
    await sleep(1500)
    const srcs = await page.$$eval('img', imgs => imgs.map(i => i.getAttribute('src') ?? ''))
    const direct = srcs.filter(s => s.startsWith('http'))
    check('every image loads through the relay', srcs.length > 0 && direct.length === 0, `${srcs.length} images, ${direct.length} direct`)
    const unmarked = sent.filter(r => !r.priv && !r.url.includes('/api/img'))
    check('every API request says private', sent.length > 0 && unmarked.length === 0, unmarked.slice(0, 3).map(r => r.url).join(' '))
    const storageAfter = await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()))
    check('nothing new in localStorage', storageAfter === storageBefore)
    await page.screenshot({ path: join(out, 'private-home.png') })
    await page.click('.private-pill')
    await page.waitForSelector('[role="menuitemcheckbox"][aria-checked="true"]')
    await page.click('[role="menuitemcheckbox"]')
    await page.waitForFunction(() => !document.querySelector('.private-pill'))
    check('turning it off removes the label', true)
    check('no page errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
  }
} finally {
  server?.kill('SIGTERM')
  await new Promise(r => setTimeout(r, 500))
  seeder.destroy()
  tracker.close()
  const { writeFileSync } = await import('node:fs')
  writeFileSync(logFile, logs.join(''))
}
const failed = checks.filter(ok => !ok).length
console.log(`\n${checks.length - failed}/${checks.length} passed (server log: ${logFile})`)
process.exit(failed ? 1 : 0)
