// Invites from a phone, end to end on this machine: a phone-emulated Chrome signs in on nexttupp.com/invite
// (the local site), makes a group link, two friends join with it, the page lists them, the link is stopped
// and a third friend is turned away. Then a one-person invite is made and cancelled, and /watch shares the
// sign-in.
//
// Needs, all local (never a deployed service):
//   cd cloud && npm run db:migrate:local && npx wrangler dev --local --port 8799 --var PUBLIC_URL:http://127.0.0.1:8787
//   cd site && ../cloud/node_modules/.bin/wrangler dev --port 8787 --var DEV_CONNECT_SRC:http://127.0.0.1:8799
//   node cloud/scripts/bootstrap-invite.ts --local   (run the INSERT it prints; pass the code as BOOTSTRAP)
//
//   BOOTSTRAP=nxi_… node scripts/invite-e2e.mjs 'http://127.0.0.1:8787?api=http://127.0.0.1:8799' out/
import { pbkdf2Sync, randomBytes } from 'node:crypto'
import puppeteer, { KnownDevices } from 'puppeteer-core'

const [siteArg, out] = process.argv.slice(2)
const { BOOTSTRAP } = process.env
if (!siteArg || !out || !BOOTSTRAP) { console.error('usage: BOOTSTRAP=nxi_… node scripts/invite-e2e.mjs <site?api=…> <out-dir>'); process.exit(2) }
const siteUrl = new URL(siteArg)
const API = siteUrl.searchParams.get('api')
const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`) }

const b64url = b => Buffer.from(b).toString('base64url')
/** The app's real key stretching, so the website can sign in with the same password. */
function credential (password) {
  const salt = randomBytes(16)
  return { salt: b64url(salt), iterations: 600_000, key: b64url(pbkdf2Sync(password.normalize('NFC'), salt, 600_000, 32, 'sha256')) }
}
async function accept (token, email, displayName, password = 'a friend’s password') {
  const res = await fetch(`${API}/v1/invites/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, email, displayName, ...credential(password) }) })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const stamp = Date.now()
const EMAIL = `owner-${stamp}@example.test`
const PASSWORD = 'correct horse battery'
const admin = await accept(BOOTSTRAP, EMAIL, 'Owner', PASSWORD)
if (admin.status !== 201) { console.error('bootstrap sign-up failed', admin); process.exit(1) }

const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', headless: true, args: ['--no-first-run', '--no-default-browser-check'] })
try {
  const page = await browser.newPage()
  await page.emulate(KnownDevices['Pixel 5'])
  page.on('console', m => console.log('  [console]', m.text()))
  page.on('pageerror', e => console.log('  [pageerror]', e.message))
  const visible = sel => page.$eval(sel, el => !el.hidden && el.offsetParent !== null).catch(() => false)
  const text = sel => page.$eval(sel, el => el.textContent.trim())
  const rows = () => page.$$eval('[data-list] li', lis => lis.map(li => li.innerText.replace(/\s+/g, ' ').trim()))

  await page.goto(`${siteUrl.origin}/invite${siteUrl.search}`, { waitUntil: 'networkidle0' })
  check('sign-in form shows', await visible('[data-view="signin"]'))
  await page.type('input[name=email]', EMAIL)
  await page.type('input[name=password]', 'wrong password')
  await page.click('[data-submit]')
  await page.waitForFunction(() => document.querySelector('[data-error]').textContent.length > 0, { timeout: 30_000 })
  check('wrong password is refused', (await text('[data-error]')) === 'Wrong email or password.')
  await page.$eval('input[name=password]', el => { el.value = '' })
  await page.type('input[name=password]', PASSWORD)
  await page.click('[data-submit]')
  await page.waitForSelector('[data-view="invites"]:not([hidden])', { timeout: 30_000 })
  check('signed in shows the two choices', await visible('[data-make="one"]') && await visible('[data-make="group"]'))
  check('no invites listed yet', !(await visible('[data-list-title]')))
  await page.screenshot({ path: `${out}/1-choices.png`, fullPage: true })

  await page.click('[data-make="group"]')
  await page.waitForSelector('[data-made]:not([hidden])', { timeout: 15_000 })
  const link = await text('[data-made-url]')
  const code = new URL(link).searchParams.get('code')
  check('group link made', /^nxi_[A-Za-z0-9_-]{43}$/.test(code ?? ''), link)
  check('labelled as a group link', (await text('[data-made-label]')) === 'Group link · up to 10 people')
  const shareShown = await visible('[data-share]')
  const hasShare = await page.evaluate(() => typeof navigator.share === 'function')
  check('Share button only where the browser can share', shareShown === hasShare, `navigator.share=${hasShare}`)
  check('copy is the main button when there is no share', hasShare || (await page.$eval('[data-copy]', b => b.className)).includes('primary'))
  await page.waitForFunction(() => document.querySelectorAll('[data-list] li').length === 1)
  check('the new link is listed', /Group link .*0 of 10 joined · expires in 7 days/.test((await rows())[0]), (await rows())[0])
  await page.screenshot({ path: `${out}/2-made.png`, fullPage: true })

  const a = await accept(code, `ann-${stamp}@example.test`, 'Ann')
  const b = await accept(code, `bo-${stamp}@example.test`, 'Bo')
  check('two friends join with the same link', a.status === 201 && b.status === 201, `${a.status} ${b.status}`)

  await page.click('[data-again]')
  check('Make another goes back to the choices', await visible('[data-make="group"]'))
  // The list refreshes when the page comes back into view; here, reload it.
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForFunction(() => document.querySelectorAll('[data-list] li').length === 1)
  const row = (await rows())[0]
  check('list shows 2 of 10 joined, with names', /2 of 10 joined/.test(row) && /Ann, Bo/.test(row), row)
  await page.screenshot({ path: `${out}/3-joined.png`, fullPage: true })

  await page.click('[data-list] li button')
  await page.waitForFunction(() => /Stopped/.test(document.querySelector('[data-list] li').innerText), { timeout: 15_000 })
  check('stopping the group link', /Stopped · 2 of 10 joined/.test((await rows())[0]), (await rows())[0])
  const c = await accept(code, `cy-${stamp}@example.test`, 'Cy')
  check('a third friend is turned away after it is stopped', c.status === 400 && c.body?.error === 'invalid_invite', String(c.status))

  await page.click('[data-make="one"]')
  await page.waitForSelector('[data-made]:not([hidden])')
  check('one-person link labelled', (await text('[data-made-label]')) === 'Link for one person')
  await page.waitForFunction(() => document.querySelectorAll('[data-list] li').length === 2)
  check('one-person invite listed first', /^Invite .*Not used yet · expires in 7 days.*Cancel$/.test((await rows())[0]), (await rows())[0])
  await page.click('[data-list] li button')
  await page.waitForFunction(() => /Cancelled/.test(document.querySelector('[data-list] li').innerText), { timeout: 15_000 })
  check('cancelling it', /Cancelled/.test((await rows())[0]))
  await page.screenshot({ path: `${out}/4-list.png`, fullPage: true })

  await page.goto(`${siteUrl.origin}/watch${siteUrl.search}`, { waitUntil: 'networkidle0' })
  check('/watch is signed in too', await visible('[data-view="devices"]'))
  check('/watch links to invites', await page.$eval('a[href="/invite"]', () => true).catch(() => false))
  await page.click('[data-signout]')
  await page.waitForSelector('[data-view="signin"]:not([hidden])')
  await page.goto(`${siteUrl.origin}/invite${siteUrl.search}`, { waitUntil: 'networkidle0' })
  check('signing out on /watch signs out /invite', await visible('[data-view="signin"]'))

  const wide = await browser.newPage()
  await wide.setViewport({ width: 1280, height: 900 })
  await wide.goto(`${siteUrl.origin}/invite${siteUrl.search}`, { waitUntil: 'networkidle0' })
  check('no horizontal scroll on desktop', await wide.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  check('no horizontal scroll on the phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
} finally {
  await browser.close()
}
const failed = checks.filter(c => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
process.exit(failed.length ? 1 : 0)
