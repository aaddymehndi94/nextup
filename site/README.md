# nexttupp.com

The public landing page: plain HTML, CSS and a little vanilla JS, served by one Cloudflare Worker with static
assets (`nexttupp-site`). No build step, no framework, and no external requests (fonts, images and scripts are
all served from `public/`).

| Path | File | |
|---|---|---|
| `/` | `public/index.html` | hero with the OS-aware download, four feature sections, invite note, FAQ, all downloads |
| `/join?code=<code>` | `public/join.html` + `join.js` | invite landing page. Also accepts `/join#<code>`, which keeps the code out of server logs |
| `/watch` | `public/watch.html` + `watch.js` | Watch at home: sign in on a phone, find the computer running nexttupp on the same Wi-Fi, and open it (below) |
| anything else | `public/404.html` | served with a 404 status (`not_found_handling`) |

`public/site.js` picks the download for the visitor's OS. Mac defaults to Apple Silicon with the Intel link
beside it, because the browser can't reliably tell the two apart. The download links point at GitHub Releases
`latest/download/<stable file name>`; the names are listed in `site.js` (`FILES`) and in the "Get nexttupp"
section of `index.html`.

`src/worker.js` runs before the assets. It does two things: it redirects `www.nexttupp.com` to the apex with a
301, keeping the path and query, and it adds security headers (a strict CSP, `no-referrer`, and so on) and a
one-week cache for `/fonts` and `/img`.

**Watch at home (`/watch`).** The only page that talks to anything: it signs in to `https://api.nexttupp.com`
(CSP `connect-src` allows exactly that origin) with the same client-side PBKDF2 as the app (WebCrypto, 600,000
rounds; the password never leaves the page) and keeps the session token in this site's `localStorage`
(`nexttupp:cloud`). It lists the account's computers seen in the last two minutes; the API marks those whose last
call came from the phone's network. With exactly one there, one big "Watch on <name>" button. Tapping asks the API
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

Needs Wrangler 4 (tested with 4.153). On localhost, `/watch` talks to a local cloud Worker at
`http://127.0.0.1:8799` (`cd ../cloud && npm run dev`), or `?api=http://127.0.0.1:<port>`; the CSP needs to allow
it too, so start the preview with `npx wrangler dev --var DEV_CONNECT_SRC:http://127.0.0.1:8799`. That var isn't
in `wrangler.jsonc`, so a deploy never allows anything but `https://api.nexttupp.com`.

To try the www redirect locally:
`npx wrangler dev --local-upstream www.nexttupp.com`, then any path returns a 301 to `https://nexttupp.com`.

## Deploying

Nothing has been deployed. These steps change the Cloudflare account and DNS, so the owner runs them.

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
