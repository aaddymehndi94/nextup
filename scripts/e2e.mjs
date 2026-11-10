// End-to-end test in real Chrome: search → title → play → seek, plus a transcode stream, and the personal
// layer: cold start, likes, My List, reasons, "Not interested", progress → Continue watching → resume, and
// profiles. Uses a public-domain film (Night of the Living Dead, 1968) so testing streams nothing copyrighted.
//
//   node scripts/e2e.mjs [outDir]       (server must be running on :4545 with a built web app)
//   BASE=http://127.0.0.1:5174 node scripts/e2e.mjs out/    (against a Vite dev server instead)
//
// It works in throwaway profiles ("e2e …") and deletes them at the end (E2E_KEEP_PROFILES=1 keeps them).
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.BASE ?? 'http://127.0.0.1:4545'
const OUT = process.argv[2] ?? 'e2e-out'
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome'
const NOTLD = 'tt0063350'
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
  // A mouse, as on a laptop (headless otherwise reports no hover and no fine pointer).
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--window-size=1440,900',
    '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'],
  defaultViewport: { width: 1440, height: 900 },
})
const page = await browser.newPage()
const consoleErrors = []
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', e => consoleErrors.push(String(e)))

const shot = (name, p = page) => p.screenshot({ path: join(OUT, `${name}.png`) })
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Waits until the player's video has advanced `secs` of playback; returns ms taken or -1. */
async function waitForPlayback (secs, timeoutMs, p = page) {
  const start = Date.now()
  try {
    await p.waitForFunction(s => {
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

/** The API as the page's active profile sees it. */
const call = (path, method = 'GET', body, p = page) => p.evaluate(async (path, method, body) => {
  // A JSON content type with no body is a 400 from the server, so it's only sent with a body.
  const headers = body ? { 'content-type': 'application/json' } : {}
  const id = localStorage.getItem('nexttupp:profile')
  if (id) headers['x-nexttupp-profile'] = id
  const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: await r.json().catch(() => null) }
}, path, method, body)

const created = new Set()
/** Makes `id` the active profile in this tab (as if picked) and reloads `path`. */
async function useProfile (id, path = '/') {
  await page.evaluate(id => { localStorage.setItem('nexttupp:profile', id); sessionStorage.setItem('nexttupp:profile-picked', '1') }, id)
  await page.goto(BASE + path, { waitUntil: 'networkidle2' })
}

const stamp = new Date().toISOString().slice(11, 19)
let profileA = null

// ---- 1. Home, cold start, reasons, "Not interested" --------------------------------------------
try {
  await page.goto(BASE, { waitUntil: 'networkidle2' })
  const made = await call('/api/profiles', 'POST', { name: `e2e ${stamp}` })
  profileA = made.body
  created.add(profileA.id)
  await useProfile(profileA.id)

  await page.waitForSelector('.row .poster', { timeout: 30000 })
  const posters = await page.$$eval('.row .poster', els => els.length)
  log('home shows popular rows', posters > 10, `${posters} posters`)

  // A new profile is asked to rate a few, with likes counted towards the target.
  await page.waitForSelector('.row-onboarding .rate-card', { timeout: 15000 })
  const meter = await page.$eval('.row-onboarding .meter-text', el => el.textContent)
  log('new profile starts with "Rate a few to get started"', meter === '0 of 3 likes', meter)
  await shot('8-cold-start')

  const likes = await page.$$('.row-onboarding .rate-button[aria-label^="Like "]')
  for (const b of likes.slice(0, 3)) {
    await b.click()
    await sleep(350)
  }
  const after = await page.$eval('.row-onboarding .meter-text', el => el.textContent).catch(() => '(row already gone)')
  await page.waitForSelector('.row-kind-top .card', { timeout: 30000 })
  const coldNow = await call('/api/me/home')
  const rowTitles = await page.$$eval('.row-title', els => els.map(e => e.textContent))
  log('after 3 likes, cold start switches to personalised rows', !coldNow.body.coldStart && rowTitles.includes('Top picks for you') && !rowTitles.includes('Rate a few to get started'),
    `meter "${after}"; rows: ${rowTitles.slice(0, 5).join(' / ')}…`)

  // Warming refetches settle; then every recommendation card says why it is there.
  await sleep(5000)
  const cards = await page.$$eval('.row-rec .card', els => els.map(el => ({
    name: el.querySelector('.poster-name')?.textContent ?? '',
    note: el.querySelector('.poster-note')?.textContent?.trim() ?? '',
  })))
  const withReason = cards.filter(c => c.note).length
  const samples = [...new Set(cards.map(c => c.note))].filter(n => /liked|from|with|fans|different|you/i.test(n)).slice(0, 3)
  log('home rows show reasons', cards.length > 20 && withReason === cards.length, `${withReason}/${cards.length} cards with a reason, e.g. ${samples.map(s => `"${s}"`).join(', ')}`)
  const billboard = await page.$eval('.billboard .meta-strong', el => el.textContent).catch(() => null)
  log('billboard features the top pick with its reason', !!billboard && billboard !== 'Popular now', `"${billboard}"`)
  await shot('9-personalised')

  // "Not interested" straight from a card, by keyboard: Tab from the poster reaches the button.
  const victim = await page.$eval('.row-kind-top .card .poster', a => ({ href: a.getAttribute('href'), name: a.querySelector('.poster-name').textContent }))
  await page.focus(`.row-kind-top .card .poster[href="${victim.href}"]`)
  await page.keyboard.press('Tab')
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))
  await page.keyboard.press('Enter')
  await page.waitForFunction(h => !document.querySelector(`.row-kind-top .poster[href="${h}"]`), { timeout: 5000 }, victim.href)
  const toast = await page.$eval('.snackbar', el => el.textContent).catch(() => '')
  await shot('10-not-interested')
  await sleep(500)
  await page.reload({ waitUntil: 'networkidle2' })
  await page.waitForSelector('.row-kind-top .card', { timeout: 30000 })
  const stillThere = await page.$$eval(`.row .poster[href="${victim.href}"]`, els => els.length)
  const [, type, id] = victim.href.split('/').slice(1)
  const state = await call(`/api/me/state/${type}/${id}`)
  log('"Not interested" from a card removes the title', focused === `Not interested: ${victim.name}` && stillThere === 0 && state.body.dismissed === 'not_interested',
    `keyboard focus "${focused}"; toast "${toast.replace('Undo', ' [Undo]')}"; after reload ${stillThere} copies`)
} catch (err) {
  log('home / taste flow error', false, err.message)
  await shot('error-home').catch(() => {})
}

// ---- 2. Search, title page, like, My List, More like this ---------------------------------------
try {
  await page.goto(BASE, { waitUntil: 'networkidle2' })
  await page.type('.search input', 'night of the living dead')
  await page.waitForSelector('.results .grid .poster', { timeout: 15000 })
  const first = await page.$eval('.results .poster', a => a.getAttribute('href'))
  log('search returns results', first === `/title/movie/${NOTLD}`, first)
  await shot('2-search')

  await page.click('.results .poster')
  await page.waitForSelector('.hero-content', { timeout: 15000 })
  await page.waitForSelector('.source', { timeout: 30000 })
  const sources = await page.$$eval('.source', els => els.length)
  await page.waitForFunction(() => /live from trackers/.test(document.querySelector('.source-legend')?.textContent ?? ''), { timeout: 15000 }).catch(() => {})
  const legend = await page.$eval('.source-legend', el => el.textContent)
  log('title page lists sources', sources > 5, `${sources} rows; ${legend.trim()}`)
  await shot('3-title')

  const like = '.hero-actions button[aria-label="Like"]'
  await page.waitForSelector(`${like}:not([disabled])`)
  const saved = page.waitForResponse(r => r.url().includes(`/api/me/rating/movie/${NOTLD}`) && r.request().method() === 'PUT')
  await page.click(like)
  const pressedAtOnce = await page.$eval(like, b => b.getAttribute('aria-pressed'))
  await saved
  await page.reload({ waitUntil: 'networkidle2' })
  await page.waitForSelector(`${like}:not([disabled])`)
  const pressedAfterReload = await page.$eval(like, b => b.getAttribute('aria-pressed'))
  log('like a title, then reload: the state persists', pressedAtOnce === 'true' && pressedAfterReload === 'true', `pressed at once: ${pressedAtOnce}, after reload: ${pressedAfterReload}`)

  const listed = page.waitForResponse(r => r.url().includes(`/api/me/list/movie/${NOTLD}`))
  await page.click('.hero-actions button[aria-label^="Add "]')
  await listed
  const inList = await page.$eval('.hero-actions button[aria-label^="Remove "]', b => b.getAttribute('aria-pressed')).catch(() => null)
  log('add to My List from the title page', inList === 'true')

  await page.waitForSelector('#more-like-this ~ * .card, .title-more .card', { timeout: 20000 })
  const similar = await page.$$eval('.title-more .card', els => els.map(e => e.querySelector('.poster-note')?.textContent ?? ''))
  log('"More like this" shows reasons', similar.length >= 6 && similar.every(Boolean), `${similar.length} titles, e.g. "${similar[0]}"`)
} catch (err) {
  log('title flow error', false, err.message)
  await shot('error-title').catch(() => {})
}

// ---- 3. Play, seek, progress → Continue watching → resume ------------------------------------
try {
  const playStart = Date.now()
  await page.click('.hero-actions .button.primary')
  await page.waitForSelector('video')
  const ms = await waitForPlayback(3, 150000)
  log('recommended source plays', ms >= 0, `first 3s of playback after ${((Date.now() - playStart) / 1000).toFixed(1)}s`)
  await page.mouse.move(700, 450)
  await shot('4-playing')

  // Seek to ~50% with the scrubber
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

  // Keep watching: Continue watching needs two minutes of real playback (seeks don't count).
  const watchStart = Date.now()
  let home = null
  while (Date.now() - watchStart < 240000) {
    await sleep(10000)
    if (Date.now() - watchStart < 110000) continue
    home = await call('/api/me/home')
    if (home.body.rows.some(r => r.kind === 'continue')) break
  }
  const server = await call(`/api/me/state/movie/${NOTLD}`)
  const clockNow = toSec(await playerTime())
  const pos = server.body.progress?.position ?? -1
  log('progress reaches the server in film time', pos > 0 && Math.abs(pos - clockNow) <= 15 && server.body.progress.streamId === NOTLD,
    `server ${Math.round(pos)}s vs player clock ${clockNow}s, every ~10 s for ${Math.round((Date.now() - watchStart) / 1000)}s`)

  // Leave the player, go home.
  await page.mouse.move(700, 450)
  await page.click('.player-top .round-button')
  await page.waitForSelector('.hero-content', { timeout: 15000 })
  await sleep(500)
  const left = await call(`/api/me/state/movie/${NOTLD}`)
  const leftAt = left.body.progress.position
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' })
  await page.waitForSelector('.row-continue .continue-card', { timeout: 20000 })
  const cont = await page.$$eval('.row-continue .continue-card', els => els.map(e => ({
    href: e.querySelector('a').getAttribute('href'),
    status: e.querySelector('.download-status')?.textContent,
    bar: e.querySelector('.download-progress span')?.style.width,
  })))
  const card = cont.find(c => c.href.includes(NOTLD))
  log('playing for a bit, then going home, shows Continue watching', !!card, card ? `"${card.status}", progress bar ${card.bar}` : JSON.stringify(cont))
  const listRow = await page.$$eval(`.row-list .poster[href="/title/movie/${NOTLD}"]`, els => els.length)
  log('add to My List, and it appears in the My List row', listRow === 1)
  await shot('11-continue')

  // One click resumes, from the server's position (clear this browser's own copy to prove it).
  await page.evaluate(id => ['nexttupp:', 'nextup:'].forEach(p => localStorage.removeItem(`${p}progress:${id}`)), NOTLD)
  await page.evaluate(() => { window.__first = undefined })
  const resumeStart = Date.now()
  await page.click(`.row-continue a[href^="/title/movie/${NOTLD}"]`)
  await page.waitForFunction(() => location.pathname === '/watch', { timeout: 60000 })
  await waitForPlayback(1, 150000)
  const toastText = await page.$eval('.toast', el => el.textContent).catch(() => '')
  const resumedClock = toSec(await playerTime())
  log('clicking Continue watching resumes where it left off', Math.abs(resumedClock - leftAt) < 20 && /Resumed at/.test(toastText),
    `left at ${Math.round(leftAt)}s, playing at ${resumedClock}s after ${((Date.now() - resumeStart) / 1000).toFixed(1)}s; "${toastText.replace('Start over', '')}"`)
  await page.mouse.move(700, 450)
  await shot('12-resumed')
  await page.click('.player-top .round-button')
  await page.waitForFunction(() => location.pathname === '/', { timeout: 10000 })
  log('Back from a resumed title returns home', true)
} catch (err) {
  log('playback / progress error', false, err.message)
  await shot('error-playback').catch(() => {})
}

// ---- 4. Profiles: create, switch, separate state, Who's watching, deleted profile ------------
try {
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' })
  await page.click('.avatar-button')
  await page.waitForSelector('.menu')
  await shot('13-profile-menu')
  await Promise.all([page.waitForFunction(() => location.pathname === '/profiles'), page.click('.menu a[href="/profiles"]')])
  await page.click('.profile-tile.is-add')
  await page.waitForSelector('.profile-form input')
  const nameB = `e2e ${stamp} B`
  await page.type('.profile-form input', nameB)
  await shot('14-add-profile')
  await page.click('.profile-form button[type="submit"]')
  await page.waitForSelector('.profile-grid')
  const tiles = await page.$$eval('.profile-grid .profile-name', els => els.map(e => e.textContent))
  const b = (await call('/api/profiles')).body.find(p => p.name === nameB)
  if (b) created.add(b.id)
  log('create a profile', tiles.includes(nameB), `${tiles.length - 1} profiles`)
  await page.click('.profiles-actions .button.primary')

  // Switch to B from the menu, on the title page: nothing of A's shows.
  await page.goto(`${BASE}/title/movie/${NOTLD}`, { waitUntil: 'networkidle2' })
  await page.click('.avatar-button')
  await page.waitForSelector('.menu')
  const items = await page.$$('.menu-group [role="menuitem"]')
  for (const it of items) if ((await it.$eval('.menu-label', e => e.textContent)) === nameB) { await it.click(); break }
  await page.waitForFunction(n => document.querySelector('.avatar-button')?.getAttribute('aria-label') === `Profile: ${n}`, { timeout: 5000 }, nameB)
  await page.waitForSelector('.hero-actions button[aria-label="Like"]:not([disabled])')
  const bLike = await page.$eval('.hero-actions button[aria-label="Like"]', e => e.getAttribute('aria-pressed'))
  const bList = await page.$eval('.hero-actions button[aria-label^="Add "]', e => e.getAttribute('aria-pressed')).catch(() => 'missing')
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' })
  const bCold = await page.waitForSelector('.row-onboarding', { timeout: 15000 }).then(() => true).catch(() => false)

  // And back to A: the like is still there.
  await page.click('.avatar-button')
  await page.waitForSelector('.menu')
  for (const it of await page.$$('.menu-group [role="menuitem"]')) if ((await it.$eval('.menu-label', e => e.textContent)) === profileA.name) { await it.click(); break }
  await page.waitForFunction(n => document.querySelector('.avatar-button')?.getAttribute('aria-label') === `Profile: ${n}`, { timeout: 5000 }, profileA.name)
  await page.goto(`${BASE}/title/movie/${NOTLD}`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('.hero-actions button[aria-label="Like"]:not([disabled])')
  const aLike = await page.$eval('.hero-actions button[aria-label="Like"]', e => e.getAttribute('aria-pressed'))
  log('switch profiles: their states are separate', bLike === 'false' && bList === 'false' && bCold && aLike === 'true',
    `B: like ${bLike}, list ${bList === 'false' ? 'off' : bList}, cold start ${bCold}; back on A: like ${aLike}`)

  // A new browser session with several profiles asks who's watching.
  const ctx = await browser.createBrowserContext()
  const fresh = await ctx.newPage()
  await fresh.setViewport({ width: 1440, height: 900 })
  await fresh.goto(BASE + '/', { waitUntil: 'networkidle2' })
  await fresh.waitForSelector('.profile-grid', { timeout: 10000 })
  const heading = await fresh.$eval('.profiles-title', e => e.textContent)
  await shot('15-whos-watching', fresh)
  await fresh.evaluate(n => [...document.querySelectorAll('.profile-tile')].find(t => t.querySelector('.profile-name')?.textContent === n)?.click(), nameB)
  await fresh.waitForSelector('.row-onboarding', { timeout: 15000 })
  const who = await fresh.$eval('.avatar-button', e => e.getAttribute('aria-label'))
  log('"Who\'s watching" when there is more than one profile', heading === 'Who’s watching?' && who === `Profile: ${nameB}`, `${heading} → ${who}`)

  // That profile is deleted elsewhere: the next request sends the viewer back to the picker.
  await call(`/api/profiles/${b.id}`, 'DELETE')
  await fresh.evaluate(() => { history.pushState(null, '', '/taste'); dispatchEvent(new PopStateEvent('popstate')) })
  await fresh.waitForSelector('.profile-grid', { timeout: 10000 })
  const note = await fresh.$eval('.profiles-note', e => e.textContent).catch(() => '')
  log('a deleted profile sends the viewer back to the picker', /deleted/.test(note), `"${note}"`)
  created.delete(b.id)
  await ctx.close()

  // Deleting goes through a confirmation; the last profile can't be deleted.
  const tmp = (await call('/api/profiles', 'POST', { name: `e2e ${stamp} C` })).body
  created.add(tmp.id)
  await page.goto(BASE + '/profiles', { waitUntil: 'networkidle2' })
  await page.evaluate(n => [...document.querySelectorAll('.profile-tile')].find(t => t.querySelector('.profile-name')?.textContent === n)?.click(), tmp.name)
  await page.waitForSelector('.profile-danger .text-button')
  await page.click('.profile-danger .text-button')
  await page.waitForSelector('.confirm .chip.danger')
  await shot('16-delete-confirm')
  await page.click('.confirm .chip.danger')
  await page.waitForSelector('.profile-grid')
  const names = await page.$$eval('.profile-grid .profile-name', els => els.map(e => e.textContent))
  if (!names.includes(tmp.name)) created.delete(tmp.id)
  log('delete a profile, with confirmation', !names.includes(tmp.name), `${names.length - 1} left`)
} catch (err) {
  log('profiles error', false, err.message)
  await shot('error-profiles').catch(() => {})
}

// ---- 5. The taste page ------------------------------------------------------------------------
try {
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' })
  await page.click('.avatar-button')
  await page.waitForSelector('.menu')
  await Promise.all([page.waitForFunction(() => location.pathname === '/taste'), page.click('.menu a[href="/taste"]')])
  await page.waitForSelector('.taste-summary', { timeout: 15000 })
  const summary = await page.$eval('.taste-summary', e => e.textContent)
  const features = await page.$$eval('.feature', els => els.length)
  const liked = await page.$$eval('.signal', els => els.map(e => e.querySelector('.signal-meta')?.textContent ?? ''))
  await shot('17-taste')
  // Boost the first feature, and undo a rating.
  const firstFeature = await page.$('.feature .chip')
  let boosted = 'none'
  if (firstFeature) {
    const done = page.waitForResponse(r => r.url().endsWith('/api/me/taste/feature'))
    await firstFeature.click()
    await done
    boosted = await firstFeature.evaluate(e => e.getAttribute('aria-pressed'))
  }
  const undo = await page.$('.signal .text-button')
  if (undo) { await undo.click(); await page.waitForSelector('.signal.is-undone', { timeout: 5000 }) }
  log('taste page explains and can be corrected', summary.length > 20 && liked.length >= 3 && (features === 0 || boosted === 'true') && !!undo,
    `"${summary}" · ${features} features, ${liked.length} signals; first feature boosted: ${boosted}`)
} catch (err) {
  log('taste page error', false, err.message)
  await shot('error-taste').catch(() => {})
}

// ---- 6. Transcode path: 4K HEVC 10-bit MKV, which Chrome on Linux cannot decode natively. --------
if (process.env.HEVC_HASH) {
  try {
    await page.evaluate(() => { window.__first = undefined })
    const q = new URLSearchParams({ ih: process.env.HEVC_HASH, f: '0', type: 'movie', id: NOTLD, s: NOTLD, n: 'Night of the Living Dead (4K HEVC test)' })
    await page.evaluate(() => ['nexttupp:', 'nextup:'].forEach(p => localStorage.removeItem(p + 'progress:tt0063350')))
    await call(`/api/me/progress/movie/${NOTLD}?forget=1`, 'DELETE')
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
    // The progress report uses film time too, not the converted stream's own clock.
    await page.click('.controls .play').catch(() => page.keyboard.press('k'))
    await sleep(1500)
    const p = (await call(`/api/me/state/movie/${NOTLD}`)).body.progress
    log('transcoded progress is reported in film time', !!p && Math.abs(p.position - toSec(await playerTime())) < 8 && p.position > 2300,
      `server ${p ? Math.round(p.position) : '—'}s, video.currentTime ${(await page.evaluate(() => document.querySelector('video').currentTime)).toFixed(1)}s`)
    await page.mouse.move(600, 400)
    await shot('6-hevc')
  } catch (err) {
    log('HEVC path error', false, err.message)
  }
}

// ---- 7. Remux path: H.264 MKV with Italian + English AC3 tracks. Video is copied, audio converted, and the
//         English track should be picked. After a seek the clock must show film time (keyframe-corrected).
if (process.env.REMUX_HASH) {
  try {
    const q = new URLSearchParams({ ih: process.env.REMUX_HASH, f: '0', type: 'movie', id: NOTLD, s: NOTLD, n: 'Night of the Living Dead (MKV remux test)' })
    await page.evaluate(() => ['nexttupp:', 'nextup:'].forEach(p => localStorage.removeItem(p + 'progress:tt0063350')))
    await call(`/api/me/progress/movie/${NOTLD}?forget=1`, 'DELETE')
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
    await sleep(1500)
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

// ---- Clean up the throwaway profiles ---------------------------------------------------------
if (!process.env.E2E_KEEP_PROFILES) {
  for (const id of created) await call(`/api/profiles/${id}`, 'DELETE').catch(() => {})
}

// The Vite dev server's HMR socket and aborted image loads aren't app errors.
const appErrors = consoleErrors.filter(e => !/\[vite\]|net::ERR_ABORTED|Failed to load resource/.test(e))
if (appErrors.length) console.log('console errors:\n  ' + appErrors.slice(0, 10).join('\n  '))
await browser.close()
const failed = results.filter(r => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
