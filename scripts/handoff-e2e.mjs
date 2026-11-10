// Watch at home, end to end on this machine: a phone-emulated Chrome signs in on nexttupp.com/watch (the
// local site), taps "Watch on <computer>", and lands on a nexttupp server through its LAN address with the
// LAN cookie set. Then: the cookie is HttpOnly, the phone can't sign the computer out, a browser without the
// cookie is refused, and the computer's Account page lists the phone.
//
// Needs, all local (never the real data dir or a deployed service):
//   cd cloud && npx wrangler dev --local --port 8799                       (with an account; see cloud/README.md)
//   cd site && npx wrangler dev --port 8787 --var DEV_CONNECT_SRC:http://127.0.0.1:8799
//   NEXTTUPP_DATA=<scratch dir> NEXTTUPP_CLOUD_URL=http://127.0.0.1:8799 PORT=4552 npm start   (signed in, phones on)
//
//   EMAIL=… PASSWORD=… node scripts/handoff-e2e.mjs 'http://127.0.0.1:8787?api=http://127.0.0.1:8799' <lan-ip> 4552 out/
//
// With a fresh data dir, so this phone is the only one connected.
import puppeteer, { KnownDevices } from 'puppeteer-core'

const [siteArg, lanIp, port, out] = process.argv.slice(2)
const { EMAIL, PASSWORD } = process.env
if (!siteArg || !lanIp || !port || !out || !EMAIL || !PASSWORD) { console.error('usage: EMAIL=… PASSWORD=… node scripts/handoff-e2e.mjs <site[?api=…]> <lan-ip> <port> <out-dir>'); process.exit(2) }
const siteUrl = new URL(siteArg)
const site = siteUrl.origin
const query = siteUrl.search
const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`) }

const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', headless: true, args: ['--no-first-run', '--no-default-browser-check'] })
try {
  const page = await browser.newPage()
  await page.emulate(KnownDevices['Pixel 5'])
  page.on('console', m => console.log('  [console]', m.text()))
  page.on('requestfailed', r => console.log('  [failed]', r.url(), r.failure()?.errorText))
  await page.goto(`${site}/watch${query}`, { waitUntil: 'networkidle0' })
  check('sign-in form shows', await page.$eval('[data-view="signin"]', el => !el.hidden))
  await page.screenshot({ path: `${out}/1-signin.png` })

  await page.type('input[name=email]', EMAIL)
  await page.type('input[name=password]', PASSWORD)
  const t0 = Date.now()
  await page.click('[data-submit]')
  await page.waitForSelector('[data-primary] button', { timeout: 30_000 }).catch(async e => {
    console.log('  error line:', await page.$eval('[data-error]', el => el.textContent), '| status:', await page.$eval('[data-status]', el => el.textContent), '| lede:', await page.$eval('[data-lede]', el => el.textContent))
    await page.screenshot({ path: `${out}/debug.png` })
    throw e
  })
  check('signed in and found the laptop', true, `${Date.now() - t0} ms incl. PBKDF2`)
  const label = await page.$eval('[data-primary] button', b => b.textContent.trim())
  check('one big Watch button', /^Watch on /.test(label), label)
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('nexttupp:cloud') || 'null'))
  check('cloud session kept in localStorage', Boolean(stored?.token?.startsWith('nxs_')))
  await page.screenshot({ path: `${out}/2-devices.png` })

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30_000 }),
    page.click('[data-primary] button'),
  ])
  const url = page.url()
  check('landed on the laptop via its LAN address', url === `http://${lanIp}:${port}/`, url)
  const cookies = await browser.cookies()
  const lan = cookies.find(c => c.name === 'nexttupp_lan')
  check('LAN cookie set, HttpOnly, host-only', Boolean(lan && lan.httpOnly && lan.domain === lanIp && lan.sameSite === 'Lax'), lan ? `${lan.domain} httpOnly=${lan.httpOnly} sameSite=${lan.sameSite}` : 'missing')
  check('cookie not readable by script', await page.evaluate(() => !document.cookie.includes('nexttupp_lan')))
  const health = await page.evaluate(() => fetch('/api/health').then(r => r.status))
  check('app API works from the phone', health === 200, String(health))
  const lanStatus = await page.evaluate(() => fetch('/api/lan').then(r => r.json()))
  check('the laptop lists this phone', lanStatus.clients.length === 1 && lanStatus.clients[0].current && lanStatus.local === false, lanStatus.clients.map(c => c.label).join(', '))
  await new Promise(r => setTimeout(r, 1500))
  await page.screenshot({ path: `${out}/3-app-on-phone.png` })

  const blocked = await page.evaluate(() => fetch('/api/account/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(r => r.status))
  check('a phone can’t sign the laptop out', blocked === 403, String(blocked))

  await page.goto(`http://${lanIp}:${port}/account`, { waitUntil: 'networkidle0' })
  await new Promise(r => setTimeout(r, 800))
  await page.screenshot({ path: `${out}/4-account-on-phone.png`, fullPage: true })

  // A fresh browser profile without the cookie is refused.
  const ctx = await browser.createBrowserContext()
  const stranger = await ctx.newPage()
  await stranger.emulate(KnownDevices['Pixel 5'])
  const res = await stranger.goto(`http://${lanIp}:${port}/`)
  check('another phone without the cookie is refused', res.status() === 401 && (await stranger.content()).includes('Open nexttupp.com on this phone'), String(res.status()))
  await stranger.screenshot({ path: `${out}/5-not-connected.png` })
  await ctx.close()

  // The laptop's own Account page shows the phone.
  const laptop = await browser.newPage()
  await laptop.setViewport({ width: 1280, height: 1000 })
  await laptop.goto(`http://127.0.0.1:${port}/account`, { waitUntil: 'networkidle0' })
  await laptop.waitForSelector('.lan-row', { timeout: 10_000 })
  check('laptop Account page lists the phone', (await laptop.$eval('.lan-row', el => el.textContent)).includes('Android phone'))
  await laptop.screenshot({ path: `${out}/6-account-on-laptop.png`, fullPage: true })
} finally {
  await browser.close()
}
const failed = checks.filter(c => !c.ok).length
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
