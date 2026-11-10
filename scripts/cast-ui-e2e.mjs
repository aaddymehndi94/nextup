// Casting, the player side, against scripts/fake-tv.ts (never a real TV): the computer's player casts and
// becomes a remote (pause, play, keys, scrubber, volume), keeps reporting progress, survives a reload; then a
// phone, connected through a handoff made with the computer's own cloud session, opens the same title as a
// remote, pauses the TV and stops casting, and the computer's page notices.
//
//   node scripts/cast-ui-e2e.mjs http://127.0.0.1:4552 http://<lan-ip>:4552 <scratch-data-dir> tv.log hashes.json out/
//
// Same setup as scripts/cast-e2e.mjs, with the server signed in to a local Worker (phones on).
import { readFileSync } from 'node:fs'
import puppeteer, { KnownDevices } from 'puppeteer-core'

const [server, lanUrl, dataDir, tvLog, hashesFile, out] = process.argv.slice(2)
const hashes = JSON.parse(readFileSync(hashesFile, 'utf8'))
const checks = []
const check = (name, ok, detail = '') => { checks.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`) }
const tvEvents = () => readFileSync(tvLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200) } return null }
const castLine = page => page.$eval('.cast-line', el => el.textContent).catch(() => null)

const watchPath = `/watch?ih=${hashes['cast-h264-ac3.mkv']}&f=0&type=movie&id=tt0063350&s=tt0063350&n=${encodeURIComponent('Test film')}`
// Start from nothing casting (a previous run may have stopped half way).
await fetch(`${server}/api/cast/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {})
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
try {
  // ---- Laptop ----
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 760 })
  const progress = []
  page.on('request', r => { if (r.url().includes('/api/me/progress') && r.method() === 'POST') progress.push(JSON.parse(r.postData() || '{}')) })
  page.on('pageerror', e => console.log('  [pageerror]', e.message))
  await page.goto(server + watchPath, { waitUntil: 'domcontentloaded' })
  const playingHere = await until(() => page.evaluate(() => { const v = document.querySelector('video'); return v && v.currentTime > 1 && !v.paused }), 60_000)
  check('plays on the laptop first', Boolean(playingHere))

  await page.mouse.move(640, 400)
  await page.click('[aria-label="Cast to a TV"]')
  const found = await until(() => page.$$eval('.panel .panel-item-label', els => els.map(e => e.textContent)).then(l => l.includes('Fake TV')))
  check('Cast panel lists the TV', Boolean(found))
  await page.screenshot({ path: `${out}/cast-1-panel.png` })

  const before = tvEvents().length
  const [btn] = await page.$$('xpath/.//button[.//span[text()="Fake TV"]]')
  await btn.click()
  const line = await until(async () => { const l = await castLine(page); return l?.startsWith('Playing on') ? l : null })
  check('remote mode: "Playing on Fake TV"', line === 'Playing on Fake TV', line)
  const load = tvEvents().slice(before).find(e => e.type === 'LOAD')
  const t = Number(/t=([\d.]+)/.exec(load?.media?.contentId ?? '')?.[1])
  check('the TV got the film from where the laptop was', t > 1 && t < 30, String(t))
  check('the laptop stopped playing itself', await page.evaluate(() => { const v = document.querySelector('video'); return v.paused && !v.getAttribute('src') }))
  await sleep(1500)
  await page.screenshot({ path: `${out}/cast-2-remote.png` })

  let mark = tvEvents().length
  await page.click('.controls .icon-button.play')
  check('pause button → PAUSE on the TV', Boolean(await until(() => tvEvents().slice(mark).some(e => e.type === 'PAUSE'))))
  check('shows "Paused on Fake TV"', Boolean(await until(async () => (await castLine(page)) === 'Paused on Fake TV')))
  mark = tvEvents().length
  await page.click('.controls .icon-button.play')
  check('play button → PLAY', Boolean(await until(() => tvEvents().slice(mark).some(e => e.type === 'PLAY'))))

  mark = tvEvents().length
  await page.keyboard.press('ArrowRight')
  const reload = await until(() => tvEvents().slice(mark).find(e => e.type === 'LOAD'))
  check('→ key seeks the TV (reload with ?t=)', Boolean(reload), reload?.media?.contentId?.replace(/cast\/[^/]+/, 'cast/<token>'))

  mark = tvEvents().length
  await page.keyboard.press('ArrowUp')
  const vol = await until(() => tvEvents().slice(mark).find(e => e.type === 'SET_VOLUME'))
  check('↑ key sets the TV volume', Boolean(vol), JSON.stringify(vol?.volume))

  const scrub = await page.$('.scrubber')
  const box = await scrub.boundingBox()
  mark = tvEvents().length
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2)
  const mid = await until(() => tvEvents().slice(mark).find(e => e.type === 'LOAD'))
  const tMid = Number(/t=([\d.]+)/.exec(mid?.media?.contentId ?? '')?.[1])
  check('scrubber seeks the TV', tMid > 40 && tMid < 50, String(tMid))
  const shown = await until(() => page.$eval('.time', el => el.textContent).then(x => (/^0:4\d/.test(x) ? x : null)))
  check('the time follows the TV', Boolean(shown), shown)

  const n = progress.length
  await sleep(11_000)
  const rep = progress.slice(n).at(-1)
  check('keeps reporting progress while casting', Boolean(rep && rep.position > 40), JSON.stringify(rep))

  await page.reload({ waitUntil: 'domcontentloaded' })
  const again = await until(async () => (await castLine(page))?.includes('Fake TV'), 60_000)
  check('after a reload it is still the remote', Boolean(again))
  check('and does not play here as well', await page.evaluate(() => !document.querySelector('video').getAttribute('src')))

  // ---- Phone: connect through a handoff, then the same player is a remote ----
  const account = JSON.parse(readFileSync(`${dataDir}/account.json`, 'utf8'))
  const lan = JSON.parse(readFileSync(`${dataDir}/lan.json`, 'utf8'))
  const h = await fetch(`${account.cloudUrl}/v1/devices/${lan.deviceId}/handoff`, { method: 'POST', headers: { authorization: `Bearer ${account.token}` } }).then(r => r.json())
  const phone = await browser.newPage()
  await phone.emulate(KnownDevices['Pixel 5'])
  phone.on('pageerror', e => console.log('  [phone pageerror]', e.message))
  await phone.goto(`${lanUrl}/handoff?code=${h.code}`, { waitUntil: 'domcontentloaded' })
  await phone.goto(lanUrl + watchPath, { waitUntil: 'domcontentloaded' })
  const onPhone = await until(async () => (await castLine(phone))?.includes('Fake TV'), 60_000)
  check('the phone opens the same title as a remote', Boolean(onPhone), await castLine(phone))
  await sleep(1200)
  await phone.screenshot({ path: `${out}/cast-3-phone.png` })
  mark = tvEvents().length
  await phone.tap('.cast-transport .play')
  check('the phone remote pauses the TV', Boolean(await until(() => tvEvents().slice(mark).some(e => e.type === 'PAUSE'))))
  mark = tvEvents().length
  await phone.$$eval('button', bs => bs.find(b => b.textContent === 'Stop casting')?.click())
  check('Stop casting on the phone → STOP on the TV', Boolean(await until(() => tvEvents().slice(mark).some(e => e.type === 'STOP'))))
  const back = await until(() => phone.evaluate(() => { const v = document.querySelector('video'); return v.getAttribute('src') && v.paused ? true : null }))
  check('the phone carries on locally, paused at the same place', Boolean(back), await phone.$eval('.time', el => el.textContent))
  await page.bringToFront() // a background tab doesn't poll
  const laptopBack = await until(() => page.evaluate(() => document.querySelector('.cast-screen') ? null : true), 10_000)
  check('the laptop notices and leaves remote mode', Boolean(laptopBack))
  await phone.screenshot({ path: `${out}/cast-4-phone-after.png` })
} finally {
  await browser.close()
}
const failed = checks.filter(c => !c).length
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
