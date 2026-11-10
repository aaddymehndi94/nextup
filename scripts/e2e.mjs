// End-to-end smoke test in real Chrome: search → title → play → seek, plus a transcode stream.
// Uses a public-domain film (Night of the Living Dead, 1968) so testing streams nothing copyrighted.
//
//   node scripts/e2e.mjs [outDir]       (server must be running on :4545 with a built web app)
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.BASE ?? 'http://127.0.0.1:4545'
const OUT = process.argv[2] ?? 'e2e-out'
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome'
mkdirSync(OUT, { recursive: true })

const results = []
const t0 = Date.now()
const log = (step, ok, detail = '') => {
  results.push({ step, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? `  (${detail})` : ''}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900 },
})
const page = await browser.newPage()
const consoleErrors = []
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', e => consoleErrors.push(String(e)))

const shot = name => page.screenshot({ path: join(OUT, `${name}.png`) })

/** Waits until the player's video has advanced `secs` of playback; returns ms taken or -1. */
async function waitForPlayback (secs, timeoutMs) {
  const start = Date.now()
  try {
    await page.waitForFunction(s => {
      const v = document.querySelector('video')
      if (!v || v.paused || v.readyState < 3) return false
      window.__first ??= v.currentTime
      return v.currentTime - window.__first >= s
    }, { timeout: timeoutMs, polling: 250 }, secs)
    return Date.now() - start
  } catch { return -1 }
}

const playerTime = () => page.evaluate(() => document.querySelector('.time')?.firstChild?.textContent?.trim())
const toSec = s => s.split(':').map(Number).reduce((a, b) => a * 60 + b, 0)

try {
  // 1. Home
  await page.goto(BASE, { waitUntil: 'networkidle2' })
  const posters = await page.$$eval('.row .poster', els => els.length)
  log('home shows popular rows', posters > 10, `${posters} posters`)
  await shot('1-home')

  // 2. Search
  await page.type('.search input', 'night of the living dead')
  await page.waitForSelector('.results .grid .poster', { timeout: 15000 })
  const first = await page.$eval('.results .poster', a => a.getAttribute('href'))
  log('search returns results', first === '/title/movie/tt0063350', first)
  await shot('2-search')

  // 3. Title page with ranked sources and live health
  await page.click('.results .poster')
  await page.waitForSelector('.hero-content', { timeout: 15000 })
  await page.waitForSelector('.source', { timeout: 30000 })
  const sources = await page.$$eval('.source', els => els.length)
  await page.waitForFunction(() => /live from trackers/.test(document.querySelector('.source-legend')?.textContent ?? ''), { timeout: 15000 }).catch(() => {})
  const legend = await page.$eval('.source-legend', el => el.textContent)
  log('title page lists sources', sources > 5, `${sources} rows; ${legend.trim()}`)
  await shot('3-title')

  // 4. Play the recommended source
  const playStart = Date.now()
  await page.click('.hero-actions .button.primary')
  await page.waitForSelector('video')
  const ms = await waitForPlayback(3, 150000)
  log('recommended source plays', ms >= 0, `first 3s of playback after ${((Date.now() - playStart) / 1000).toFixed(1)}s`)
  await page.mouse.move(700, 450)
  await shot('4-playing')

  // 5. Seek to ~50% with the scrubber
  const bar = await page.$('.scrubber')
  const box = await bar.boundingBox()
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2)
  const seekStart = Date.now()
  await page.mouse.down(); await page.mouse.up()
  await page.evaluate(() => { window.__first = undefined })
  const seekMs = await waitForPlayback(2, 120000)
  const after = await playerTime()
  const duration = await page.evaluate(() => document.querySelector('.time .muted')?.textContent?.replace('/', '').trim())
  const near = after && duration && Math.abs(toSec(after) - toSec(duration) / 2) < 60
  log('seek to middle resumes playback', seekMs >= 0 && near, `resumed in ${((Date.now() - seekStart) / 1000).toFixed(1)}s at ${after} of ${duration}`)
  await page.mouse.move(600, 400)
  await shot('5-seeked')

} catch (err) {
  log('unexpected error', false, err.message)
  await shot('error').catch(() => {})
}

// 6. Transcode path: 4K HEVC 10-bit MKV, which Chrome on Linux cannot decode natively.
if (process.env.HEVC_HASH) {
  try {
    await page.evaluate(() => { window.__first = undefined })
    const q = new URLSearchParams({ ih: process.env.HEVC_HASH, f: '0', type: 'movie', id: 'tt0063350', s: 'tt0063350', n: 'Night of the Living Dead (4K HEVC test)' })
    await page.evaluate(() => ['nexttupp:', 'nextup:'].forEach(p => localStorage.removeItem(p + 'progress:tt0063350')))
    const start = Date.now()
    await page.goto(`${BASE}/watch?${q}`, { waitUntil: 'domcontentloaded' })
    const ms = await waitForPlayback(3, 180000)
    log('HEVC source plays via transcode', ms >= 0, `after ${((Date.now() - start) / 1000).toFixed(1)}s`)
    // Seek to 40:00 and check the clock maps to film time.
    await page.mouse.move(700, 450)
    const bar = await page.$('.scrubber')
    const box = await bar.boundingBox()
    const target = 2400 / 5801
    await page.mouse.move(box.x + box.width * target, box.y + box.height / 2)
    await page.evaluate(() => { window.__first = undefined })
    const seekStart = Date.now()
    await page.mouse.down(); await page.mouse.up()
    const seekMs = await waitForPlayback(2, 150000)
    const after = await playerTime()
    const v = await page.evaluate(() => { const el = document.querySelector('video'); return { currentTime: el.currentTime, src: el.currentSrc.replace(location.origin, '') } })
    log('HEVC seek lands at film time', seekMs >= 0 && after && Math.abs(toSec(after) - 2400) < 20, `resumed in ${((Date.now() - seekStart) / 1000).toFixed(1)}s, clock ${after}, video.currentTime ${v.currentTime.toFixed(1)}, ${v.src}`)
    await page.mouse.move(600, 400)
    await shot('6-hevc')
  } catch (err) {
    log('HEVC path error', false, err.message)
  }
}

// 7. Remux path: H.264 MKV with Italian + English AC3 tracks. Video is copied, audio converted, and the
//    English track should be picked. After a seek the clock must show film time (keyframe-corrected).
if (process.env.REMUX_HASH) {
  try {
    const q = new URLSearchParams({ ih: process.env.REMUX_HASH, f: '0', type: 'movie', id: 'tt0063350', s: 'tt0063350', n: 'Night of the Living Dead (MKV remux test)' })
    await page.evaluate(() => ['nexttupp:', 'nextup:'].forEach(p => localStorage.removeItem(p + 'progress:tt0063350')))
    await page.evaluate(() => { window.__first = undefined })
    const start = Date.now()
    await page.goto(`${BASE}/watch?${q}`, { waitUntil: 'domcontentloaded' })
    const ms = await waitForPlayback(3, 180000)
    const plan = await page.evaluate(async () => {
      const id = new URL(document.querySelector('video').currentSrc).pathname.split('/')[2]
      const r = await fetch(`/api/sessions/${id}/probe?caps=h264,aac,mp3,opus,flac,av1,vp9`).then(r => r.json())
      return { mode: r.plan.mode, audio: r.probe.audio[r.plan.audioTrack]?.language, tracks: r.probe.audio.map(a => a.language).join('/') }
    })
    log('MKV source plays via remux', ms >= 0 && plan.mode === 'remux', `after ${((Date.now() - start) / 1000).toFixed(1)}s, ${plan.mode}, audio ${plan.audio} of ${plan.tracks}`)
    await page.mouse.move(700, 450)
    const bar = await page.$('.scrubber')
    const box = await bar.boundingBox()
    const target = 1500
    const total = await page.evaluate(() => document.querySelector('.time .muted')?.textContent?.replace('/', '').trim())
    await page.mouse.move(box.x + box.width * (target / toSec(total)), box.y + box.height / 2)
    await page.evaluate(() => { window.__first = undefined })
    const seekStart = Date.now()
    await page.mouse.down(); await page.mouse.up()
    const seekMs = await waitForPlayback(2, 150000)
    await new Promise(r => setTimeout(r, 1500))
    const clock = await playerTime()
    const v = await page.evaluate(async () => {
      const el = document.querySelector('video')
      const u = new URL(el.currentSrc)
      const id = u.pathname.split('/')[2]
      const t = Number(u.searchParams.get('t'))
      const ss = await fetch(`/api/sessions/${id}/stream-start?t=${t.toFixed(2)}`).then(r => r.json())
      return { t, currentTime: el.currentTime, start: ss.start, exact: ss.exact }
    })
    const expected = v.start + v.currentTime
    const ok = seekMs >= 0 && v.exact && Math.abs(toSec(clock) - expected) <= 1.5 && v.start <= v.t
    log('remux seek clock uses the real keyframe', ok, `resumed in ${((Date.now() - seekStart) / 1000).toFixed(1)}s; requested ${v.t.toFixed(1)}s, stream starts at keyframe ${v.start.toFixed(2)}s (${(v.t - v.start).toFixed(1)}s earlier), clock ${clock}`)
    await page.mouse.move(600, 400)
    await shot('7-remux')
  } catch (err) {
    log('remux path error', false, err.message)
  }
}

if (consoleErrors.length) console.log('console errors:\n  ' + consoleErrors.slice(0, 10).join('\n  '))
await browser.close()
const failed = results.filter(r => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
