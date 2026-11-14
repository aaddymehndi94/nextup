# 0006: Watch at home (phones and TVs)

Date: 2026-11-11 · Status: accepted (cloud and site live; casting tested on a real Chromecast, see the 0.5.2 update)

## Context

nexttupp runs on a computer ([0005](0005-desktop-app.md)), and streaming stays there. People also want to
watch on a phone on the sofa, or on the TV. Before this, the only way was `HOST=0.0.0.0` and typing the
computer's IP address, with no login at all: anyone on the network could use the server, Account page
included. Two goals:

- **Phone:** sign in on the phone and watch, with no QR code, pairing code or IP address to type.
- **TV:** a Cast button in the player, for the Chromecasts and Google TVs most homes have.

The account ([0004](0004-accounts-and-sync.md)) already links a person's computers, so it is the natural
way for a phone to find "my computer at home" and prove it belongs to the same person.

## Decisions

### Phones: a handoff through the account

```
phone ── nexttupp.com/watch: sign in (PBKDF2 in the browser) ──► cloud: GET /v1/devices
      ◄── "Watch on Laptop (Linux)" (seen < 2 min ago, same network) ──
      ── POST /v1/devices/:id/handoff ──► { code: nxh_…, lanUrls }  (60 s, single use)
      ── top-level navigation to http://192.168.1.20:4545/handoff?code=nxh_… ──► computer
                                  computer ── POST /v1/handoff/redeem { code, deviceId } (its own session) ──► cloud
      ◄── Set-Cookie nexttupp_lan=nxl_… (HttpOnly) + redirect to / ──
```

**The computer registers itself as a device** (cloud migration `0003_devices.sql`), riding the sync loop:
at sign-in, then about every minute after each push/pull, never failing the sync. A device is a random id
(kept in `<data>/lan.json`), a name ("Laptop (Linux)", "Computer (Windows)", "Mac"; renamable, never
the hostname, which often contains a person's name), the OS family, whether phones are on, and up to four
LAN URLs (the default-route address first, from a UDP `connect` to a public address that sends nothing;
virtual interfaces such as Docker, VPNs and VirtualBox are skipped). The cloud adds `last_seen_at` and
`net_hash`, an HMAC (the D1 server key) of the caller's `CF-Connecting-IP`, or its /64 for IPv6. The
phone's listing marks a device `sameNetwork` when the hashes match, so the cloud never stores an IP
address. Limits: 20 devices per account, deleted after 90 days unseen, and a device seen more than 2
minutes ago is offline. Signing out deletes the device first.

**Handoff codes** are 256-bit random (`nxh_…`), stored only as hashes, bound to the account and the
device, valid for 60 seconds, and single-use: redeeming is `DELETE … RETURNING`, so two concurrent redeems
can't both win. At most 10 are pending per account. A code is only issued for a device that is online with
phones on. The computer redeems with its own session token, so a code issued for one account or computer
can't open another.

**The LAN cookie** (`nexttupp_lan=nxl_<256-bit random>`) is HttpOnly, SameSite=Lax, host-only and lasts 400
days. It can't be `Secure`, because the LAN origin is plain http (there is no certificate for a private
address). The computer stores only its SHA-256, in `lan.json` (mode 0600), with a label from the
User-Agent ("Android phone · Chrome") and when it was last used. The Account page lists these as "Phones
and TVs that can watch on this computer", each removable.

**The gate** (`server/lan/routes.ts`) runs before every route:

- Loopback requests must carry `Host: localhost` or `127.0.0.1` (with any port), otherwise 403. This
  stops DNS rebinding: another website can't point a name at 127.0.0.1 and talk to the server.
- Every non-loopback request needs a valid cookie, and phones must be on. The exceptions are
  `/handoff` (rate-limited to 10 a minute, and checked with the cloud) and `/cast/<token>/…` (the TV
  has no cookie; see below). Without a cookie, a page says "Open nexttupp.com on this phone and sign in
  to connect." (401; JSON for `/api`).
- Phones can't change the account or the LAN settings: non-GET requests to `/api/account*` and `/api/lan*`
  from the LAN get 403. So a phone can't sign the computer out, turn phones off, or remove other phones.

**A second listener, not `HOST=0.0.0.0`.** The main listener stays on 127.0.0.1, which is what the desktop
app expects, so `desktop/src/main.ts` needed no change. `LanService` binds one extra http server per home
address on the same port, and serves it with Fastify's own router (`app.routing`), so every route and the
gate behave identically. It rebinds when addresses change (checked every minute), unbinds when phones are
turned off or the account signs out, and is held open while casting. With `HOST=0.0.0.0` there is no second
listener, but the same gate applies, so other devices now need the cookie there too.

**The phone page is nexttupp.com/watch** (`site/public/watch.html`, `watch.js`): the same prelogin, PBKDF2
(600,000 rounds, WebCrypto) and login as the app, then a poll of `/v1/devices` every 5 seconds. With exactly
one same-network device online, it shows one big "Watch on <name>" button. The cloud session is kept in
`localStorage` on nexttupp.com. This is the one place a browser holds a session token (0004 kept it on the
computer); it is the site's own origin, and "Sign out on this phone" ends it. The page navigates the whole
window to the LAN address. A fetch from an https page to a private http address would be blocked as mixed
content and by Chrome's local-network rules; a top-level navigation is not. The site's CSP allows
`connect-src https://api.nexttupp.com` (and, for local development only, a `DEV_CONNECT_SRC` localhost URL).

**Playback on the phone** uses the existing capability detection: Android Chrome direct-plays or gets the
same remuxed or transcoded fMP4 as a desktop browser.

### TVs: Cast v2 from the computer

**The computer is the sender.** The player asks its server (`/api/cast*`), which discovers TVs and talks to
them. So casting works the same from the computer and from a connected phone, and needs no Cast SDK in the
page (the Web Sender SDK only works in Chrome, from an https origin).

**Discovery:** mDNS `_googlecast._tcp`, with `multicast-dns` 7.2.5 (published May 2022, about 19 million
weekly downloads; its three small dependencies are pinned in the lockfile). The socket opens when the Cast
panel asks, and closes after a minute idle. `NEXTTUPP_CAST_DEVICES="Name@host:port,…"` adds TVs that
discovery can't see, and is how the tests point at a fake receiver.

**Control: Cast v2 written in-house** (`server/cast/protocol.ts`, about 400 lines with the media client): TLS
to port 8009, length-prefixed protobuf `CastMessage` frames encoded by hand (a handful of string fields), JSON payloads on the
`tp.connection`, `tp.heartbeat`, `receiver` and `media` namespaces. It LAUNCHes the Default Media Receiver
(`CC1AD845`), CONNECTs to its transport, and then sends LOAD, PLAY, PAUSE, SEEK, GET_STATUS, SET_VOLUME,
EDIT_TRACKS_INFO and STOP. The well-known `castv2`/`castv2-client` packages were last published in 2019 and 2016, and `castv2`
loads `cast_channel.proto` from its own directory at run time, which breaks the desktop app's single-file
esbuild bundle. The protocol surface needed is small and stable.

**The stream: a tokenised link on the computer's LAN address.** Each cast gets a random 256-bit token,
valid for 12 hours, revoked on stop, and accepted only from the TV's own address (or loopback, for tests).
After a reload, the previous token gets 30 seconds' grace. The routes are `/cast/<token>/raw` (direct
play), `/cast/<token>/play.mp4?t=` (converted) and `/cast/<token>/subs.vtt`, with
`Access-Control-Allow-Origin: *`, which the receiver needs for subtitles. LOAD carries at most three of the
player's subtitles as text tracks, each with its own token: the one showing and others in its language. It
always sets `activeTrackIds`, so the receiver can't pick one by its own language setting. (0.5.0 sent all of
them, up to 40. An LG TV fetched every track at once; the subtitle service refused the burst with HTTP 429, and
within two minutes the TV stopped answering the computer and was left buffering.) Subtitle files are downloaded
once and kept; a TV whose track can't be downloaded gets an empty one, never an error.

**A "cast" capability profile** (`castPlan` in `server/playback/plan.ts`): H.264 8-bit + AAC/MP3 in MP4.
Compatible MP4 direct-plays. Compatible video in MKV is remuxed to fragmented MP4. HEVC, 10-bit and HDR are
transcoded to H.264 SDR, and 4K is brought down to 1080p even when it could be copied, because first-generation
Chromecasts can't decode it. AC3/EAC3/DTS become AAC. Seeking: SEEK on the TV for direct play; for a converted stream,
reload with `?t=` (from the keyframe before it when the video is copied).

**Position:** a converted stream for a TV carries film time and the film's length. ffmpeg's `delay_moov`
writes each track's start into an edit list. `declareLength` (`server/playback/fmp4.ts`) writes the length into
the header as the stream passes. So the TV's own clock and seek bar show where the film is. (Before 0.5.2 the
TV's bar started at 0:00 after every seek or resume, and its end was however much had loaded.) A TV that restarts
its clock at 0 anyway is spotted on its first reading (`clockBase`). Until then, the position is where the cast
started. The phone's own player still gets a stream whose clock starts at 0, plus the keyframe lookup.

**The player becomes a remote.** Casting stops local playback. The page shows the backdrop, "Playing on
<TV>", play/pause, ±10 s, the scrubber, the TV's volume and "Stop casting". It polls `/api/cast` every
second and keeps reporting progress (every 10 s while playing, on seek and pause, on exit) from the TV's
position. A reload, or a phone opening the same title, finds the active cast and becomes its remote instead
of playing too. Stopping resumes locally, paused, at the TV's position. Changing the audio track reloads the
TV at the current position. Turning subtitles on, off or to another one sends EDIT_TRACKS_INFO, and the film
plays on. The TV reloads only for a subtitle it wasn't loaded with, or if it refuses the switch. Seeks that
queue up behind one in progress collapse into the newest. While a film plays on a TV, kept downloads seed at
most 256 KB/s, so their uploads don't take Wi-Fi time from the stream.

**Only the computer casts.** The player's `<video>` and music's `<audio>` set `disableRemotePlayback`. Without
it, Chrome on Android puts its own cast button on the video. A cast started from that button belongs to the
browser tab, so it ends when the phone's screen turns off or the tab is put away. Casting from nexttupp's own
button is held by the computer and carries on. Play and pause from the phone's lock screen go to the TV while
music is cast.

## Consequences

- **Privacy:** signed in, the cloud now knows the computer's device id, name, OS family, last-seen time and
  an HMAC of its public IP; with phones on, also its private LAN URLs. The README says so. Taste data rules
  from 0004 are unchanged.
- **`HOST=0.0.0.0` is no longer open:** other devices need the cookie, so they need an account and a
  handoff. Without an account there's no phone access (by design: there's nothing to log in with).
- **Signing out turns phones off** (the listener closes and handoffs can't be redeemed). Phones that
  already have a cookie work again after signing back in.
- **iPhone:** Safari can't play fragmented MP4 from a progressive stream, so only direct-play files work on
  an iPhone. Remuxed and transcoded streams need HLS, which is a follow-up.
- **Same network detection** compares public IPs. A phone on mobile data, or a home where IPv4 and IPv6 take
  different routes, shows the computer as "Not confirmed on this Wi-Fi"; tapping it still works if the LAN
  address is reachable. Guest Wi-Fi and "AP isolation" block phones from reaching the computer at all.
- **Firewalls:** Windows and macOS ask the first time the server listens on the home address. Linux
  distributions with a firewall (ufw, firewalld) need the port opened. Windows and macOS binding is untested.
- **Chrome on Android** shows "Not secure" for the http LAN address, as for any router page.
- **Casting** needs the TV to load http media from a private address, as VLC, catt and others rely on.
  It has been tested only against a fake receiver (protocol, LOAD/SEEK/PAUSE/SET_VOLUME/STOP flow, and the
  streams themselves with ffprobe and headless Chrome), never a real TV. Subtitles on a real receiver
  are untested. Sessions on the TV end when the receiver reports IDLE (finished, error, or another app took
  over).
- One cast at a time per computer; starting another stops the first.

## Testing

```bash
npx vitest run server/lan server/cast    # gate, cookie, handoff, Host check; protocol, client, service, plan, discovery, WebVTT
cd cloud && npm test                     # devices, handoffs, same-network, single use, expiry, limits
node scripts/handoff-e2e.mjs …           # phone emulation against a local Worker and site (see the header)
node scripts/cast-e2e.mjs …              # scripts/fake-tv.ts: direct, remux, transcode; ffprobe + Chrome
node scripts/cast-ui-e2e.mjs …           # the player as a remote, on the computer and a connected phone
```

Results on 2026-11-11, all on one machine with a local Worker (`wrangler dev --local`): 100 cloud tests,
185 server tests, handoff E2E 12/12, cast stream E2E 44/44, cast UI E2E 20/20.

## Update, 2026-11-12: wording

"Watch at home" and "Watch on <computer>" read as if the film plays on the computer, and showed up on the
website for visitors on a computer too. The words now follow the phone: the page is "Watch on this phone",
its button is "Connect to <computer>", the app's setting is "Let phones play from this computer" under
"Watch on your phone", and the website shows the phone link only on touch-first screens (computers see
Download).

## Update, 2026-11-14: a cast that holds (0.5.2)

Checked on a real Chromecast (Google TV) from a phone-sized browser, with a second phone joining.

- **The computer holds the cast.**
  - If the link to the TV drops (Wi-Fi, a sleeping computer), the service joins the TV's running player
    again (`rejoinPlayer`, retried for about a minute) instead of ending the cast. The phone shows
    "Reconnecting to <TV>…".
  - If the TV finished meanwhile, the film counts as finished. If it stopped, the cast ends with "<TV>
    stopped playing".
  - Progress is saved by the computer every 15 s, on pause and at the end, so Continue watching is right
    even with the phone asleep. The phone no longer reports progress while casting.
  - The desktop app keeps the computer from sleeping while anything plays (`/api/awake`).
- **Next episode on the TV.**
  - At the end of an episode, the computer finds the next one (the same torrent when it has it), with
    subtitles in the same language, and plays it.
  - The phone shows "Next episode on <TV>" (play it now) with × (not now), and follows to the new episode.
  - A failure says what couldn't play.
- **Subtitles as on the phone.**
  - The phone's size (A−/A+) goes to the TV as `textTrackStyle.fontScale` and changes in place.
  - A timing change reloads the TV at its position, once the taps stop.
  - A track the TV got empty, because the subtitle service didn't answer, is fetched again in the
    background and reloaded once it downloads.
  - A phone that joins shows the TV's subtitle and size.
- **TV volume.**
  - The TV's own volume and mute come from receiver statuses only. Media statuses carry the stream's
    volume, always 1, which had been overwriting it.
  - Phones get a volume row on the remote.
- **Discovery** asks twice per browse, and a TV that isn't known yet is looked for again before a cast
  fails.
- **Film time and length** in converted streams, as above.

The fake receiver (`server/cast/cast.test.ts`) covers each of these. The real TV covered:
- cast from the phone's player;
- subtitle choice, size and timing;
- a second phone joining;
- mute;
- 30 s with the computer frozen (it rejoined and playback carried on);
- film time and length in converted streams.

Next episode has only been tested against the fake receiver.

## Update, 2026-11-14: the phone app (0.5.3)

Before this, a phone took four steps every time: open nexttupp.com, tap Watch on your phone, sign in, tap
Connect. Now **nexttupp.com/watch can be added to the home screen** and opens like an app.

- **Only /watch is the app.**
  - `watch.webmanifest` (scope and start URL `/watch`) is linked from watch.html alone.
  - `watch-sw.js`, registered with scope `/watch`, keeps the page, its CSS and JS, the font and an icon. It
    fetches network first, so a deploy shows at once. The cached copy is used only when the network fails.
    It never touches the API, another origin.
  - The rest of nexttupp.com stays an ordinary website. The CSP adds `worker-src 'self'`.
  - `watch-sw.js` is served with a CSP of its own (`connect-src 'self'`). A worker's fetches follow the
    CSP sent with its script, and the page CSP allows only the API, so with it the worker's install failed.
- **The install offer** is one quiet line at the end of /watch, on phones only, never inside the app:
  - Chrome on Android: `beforeinstallprompt`, shown as an "Add to home screen" button instead of Chrome's banner.
  - iOS: the Share → Add to Home Screen steps. iOS has no install prompt. Its home-screen apps also keep their
    own storage, so the app asks to sign in once more there.
- **Opened as the app** (display-mode standalone, or `navigator.standalone`):
  - Exactly one of the account's computers is online, on this Wi-Fi, with phones on: it connects by itself.
    It does this at most once per visit (sessionStorage), never after Back, and never with `?choose`.
  - More than one: it asks, with the last-used one first ("Last used · On this Wi‑Fi"). Auto-connect is then
    off for the visit, so one computer going offline can't pick for the person.
  - In a browser tab nothing connects by itself. The website behaves as before.
- **The last computer opened** (`nexttupp:last-computer` in localStorage: id, name, LAN URLs) gives a second
  way in that needs neither the session nor the internet. The phone's cookie on the computer is what lets
  it in. It is offered:
  - signed out by the service (session expired or revoked): "Or open <name> without signing in", under the
    sign-in form;
  - when the API can't be reached (no internet, or the service is down): "Can’t reach nexttupp right now",
    with Open <name> as the main button.

  Signing out on the phone on purpose forgets it. If the computer's address has changed, or the phone isn't
  on its Wi‑Fi, the browser can't open it. The page says so: sign in and connect again. Nothing can be
  checked first, because an https page can't fetch an http address.
- **Back to the list:** on a phone, the app's profile menu has "Switch computer"
  (`https://nexttupp.com/watch?choose`). The Account page has the same link.
- **The cookie now slides.** Any page load from a connected phone sets it again for 400 days, so a phone
  used at least once in 400 days stays connected. API calls and video requests don't renew it.
- **Finding it from the computer:** the profile menu has "Watch on your phone". It goes to Account's phones
  section, which shows a QR code for nexttupp.com/watch (generated once into `web/public/watch-qr.svg`; the
  address never changes) next to the address in words. Signed out, the Account page explains that signing
  in comes first.

Not done (phase 2, not needed yet): an https address for the computer, which would let the app stay in its
own window instead of opening the computer's http page.

