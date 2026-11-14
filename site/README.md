# nexttupp.com

The public landing page: plain HTML, CSS and a little vanilla JS, served by one Cloudflare Worker with static
assets (`nexttupp-site`). No build step, no framework, and no external requests (fonts, images and scripts are
all served from `public/`), apart from the nexttupp API on the account pages.

Films never play on the website: they play in the app on a computer (or on a phone, from that computer). The site
says so plainly instead: the hero calls nexttupp a free app for your computer, the first “Anyone can join” step says
films play in the app and not on this website, the first question is “Can I watch on this website?”, and the
account pages lead to the app. (There is deliberately no search box: one that can't search would mislead.)

| Path | File | |
|---|---|---|
| `/` | `public/index.html` | hero with the OS-aware download, four feature sections, “Anyone can join” (three steps), FAQ, all downloads |
| `/account` | `public/account.html` + `account.js` | sign in or create an account; then what to do next (below). `/signin`, `/login` redirect here, and `/signup`, `/register` to `/account#create` |
| `/join` | `public/join.html` | how it works: download, make a free account (here or in the app), watch on a phone. Old invite links (`/join?code=…`) land here too, and `/invite` redirects here |
| `/watch` | `public/watch.html` + `watch.js` | Watch on this phone: sign in on a phone, find the computer running nexttupp on the same Wi-Fi, and open it (below) |
| anything else | `public/404.html` | served with a 404 status (`not_found_handling`) |

Phones and tablets (a touch-first screen, by CSS media query) see “Watch on this phone” where computers see
“Download”, through the `phone-only` and `computer-only` classes. Every masthead has “Sign in”, which reads
“Account” once this browser is signed in.

`public/site.js` picks the download for the visitor's OS. Mac defaults to Apple Silicon with the Intel link
beside it, because the browser can't reliably tell the two apart. The download links point at GitHub Releases
`latest/download/<stable file name>`; the names are listed in `site.js` (`FILES`) and in the "Get nexttupp"
section of `index.html`.

`src/worker.js` runs before the assets. It redirects `www.nexttupp.com` to the apex with a 301, keeping the path
and query; it redirects the addresses people guess (`/login`, `/signup` and so on) to `/account`; and it adds security headers (a strict CSP, `no-referrer`, and so on) and a
one-week cache for `/fonts` and `/img`.

**Signing in and creating an account (`cloud.js`).** `/account` and `/watch` are the only pages that talk to
anything: they call `https://api.nexttupp.com` (CSP `connect-src` allows exactly that origin). Both show the same
form, with **Sign in** and **Create account** tabs. Creating an account makes a random 16-byte salt and stretches
the password with PBKDF2-SHA256 (WebCrypto, 600,000 rounds), exactly as the app does, then calls
`/v1/auth/signup` and signs in; signing in calls `/v1/auth/prelogin` and `/v1/auth/login`. The password never
leaves the page. The session token is kept in this site's `localStorage` (`nexttupp:cloud`), so signing in on one
page signs in on the others. An email that already has an account switches the form to Sign in with a plain
message. The cloud allows 5 sign-ups an hour from one network.

**Your account (`/account`).** Once signed in, the page lists the account's computers (`/v1/devices`). None yet:
“Almost there.” and three steps (get the app, sign in to it with this email, start watching), with the download
button on a computer and “go to nexttupp.com on your laptop” on a phone; it checks every 5 seconds, so it moves
on by itself once the app signs in. At least one: “You’re all set.”, each computer with “Open now” or when it was
last open, and on a phone a big “Watch on this phone” button.

**Watch on this phone (`/watch`).** Signs in (or creates an account) as above. It lists the account's computers seen in the last two minutes; the API marks those whose last
call came from the phone's network. With no computer on the account yet, it says “Set up your computer first.” and
how; with computers but none open, “Open nexttupp on your computer.” With exactly one there, one big "Connect to <name>" button. Tapping asks the API
for a one-time code (60 s, single use, bound to that computer) and navigates the tab to
`http://<computer's LAN address>:<port>/handoff?code=…`. A page on https can't fetch an http address on the LAN
(mixed content), so a top-level navigation is the only way; the computer redeems the code with its own session and
sets a cookie for this phone. The API rejects any address that isn't a private IPv4, and so does the page.

Imagery: the hero is a real screenshot of the app showing *Charade* (1963). The other stills are from
*Metropolis*, *Scarlet Street*, *My Man Godfrey* and *Nosferatu*. All five films are public domain in the US.
Mona Sans ships unmodified with its licence at `public/fonts/OFL.txt`.

## Preview locally

```bash
cd site
npx wrangler dev            # http://localhost:8787, local only
```

Needs Wrangler 4 (tested with 4.153). On localhost, `/account` and `/watch` talk to a local cloud Worker at
`http://127.0.0.1:8799` (`cd ../cloud && npm run dev`), or `?api=http://127.0.0.1:<port>`; the CSP needs to allow
it too, so start the preview with `npx wrangler dev --var DEV_CONNECT_SRC:http://127.0.0.1:8799`. That var isn't
in `wrangler.jsonc`, so a deploy never allows anything but `https://api.nexttupp.com`.

To try the www redirect locally:
`npx wrangler dev --local-upstream www.nexttupp.com`, then any path returns a 301 to `https://nexttupp.com`.

## Deploying

Live since 2026-11. A deploy changes the owner's Cloudflare account, so each one waits for the owner's go-ahead. Steps 1 and 2 were the first deploy; later deploys are step 2's `npx wrangler deploy` alone (Node 24, from `site/`).

1. **Clear the parking records.** In Cloudflare, open the nexttupp.com zone, then DNS. Delete the GoDaddy
   parking records on `nexttupp.com` (the apex `A`/`AAAA`/`CNAME`) and on `www`. Wrangler won't attach a custom
   domain to a hostname that already has a record. Leave `MX`/`TXT` records alone if email uses them, and leave
   `api` alone (it belongs to `cloud/`, the `nexttupp-cloud` Worker).
2. **Deploy.**
   ```bash
   cd site
   npx wrangler login         # once
   npx wrangler deploy
   ```
   This creates the Worker and the custom domains `nexttupp.com` and `www.nexttupp.com`, with their DNS
   records and certificates. `workers_dev` and preview URLs are off.
3. **Check it.**
   ```bash
   curl -sI https://nexttupp.com/ | head -1                      # 200
   curl -sI "https://www.nexttupp.com/join?code=x" | grep -i location   # https://nexttupp.com/join?code=x
   curl -sI https://nexttupp.com/nope | head -1                  # 404
   ```

To update, edit `public/` and run `npx wrangler deploy` again. Because the Worker runs first, every request counts
as a Worker request: up to 100,000 a day on the free plan.

## As deployed (2026-11-11)

The site is served by **zone routes** (`nexttupp.com/*`, `www.nexttupp.com/*`), not custom domains: the zone
still holds the old parking records and the Wrangler login can't edit DNS. Those records are proxied, so the
route answers first and they go unused. To tidy up later: delete the apex and `www` A/CNAME records in the
Cloudflare dashboard, then switch the two routes back to `{ "pattern": "…", "custom_domain": true }` and deploy.
