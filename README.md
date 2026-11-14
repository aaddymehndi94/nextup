# nexttupp

Search any film or series, see it like a streaming service shows it, pick a torrent (with live seeds and
peers), and watch it in the browser within seconds. Files the browser can't play (MKV, HEVC, AC3/DTS, HDR)
are converted on the fly, on the GPU when there is one. Anything can be kept for offline viewing. Films and
episodes are deleted from the computer once they've been watched to the end, streamed data after a day
without playing, and kept downloads after 30 days without playing, unless they're kept forever.

## Run it

Needs Node 24 (`nvm use`), and `ffmpeg` + `ffprobe` on the PATH.

```bash
npm install
npm run build      # build the web app
npm start          # http://localhost:4545
```

For development, `npm run dev` runs the server with reload plus Vite on http://localhost:5173.

To watch on a phone or a TV, see [Phones and TVs](#phones-and-tvs) below.

| Env var | Default | |
|---|---|---|
| `PORT` | `4545` | |
| `HOST` | `127.0.0.1` | the main listener; phones get their own listener on the home-network address (below). With `0.0.0.0`, other devices still need the phone cookie |
| `NEXTTUPP_DATA` | `./data` | downloads, saved torrent metadata, library, taste database (`nexttupp.db`) |
| `NEXTTUPP_LANGS` | `en` | preferred audio/subtitle languages, e.g. `en,hi` |
| `NEXTTUPP_IDLE_MIN` | `15` | minutes before an unused torrent is stopped (and a watched file in it deleted) |
| `NEXTTUPP_TORRENTIO` | `https://torrentio.strem.fun` | can include Torrentio options |
| `NEXTTUPP_CLOUD_URL` | `https://api.nexttupp.com` | the accounts and sync service (`cloud/`); nothing is sent there until someone signs in |
| `NEXTTUPP_CAST_DEVICES` | | extra TVs to cast to that discovery can't see, `Name@host[:port],…` (testing: `scripts/fake-tv.ts`) |

The old `NEXTUP_*` names still work as fallbacks.

## Desktop app

`desktop/` packages the server, web app and ffmpeg as an Electron app for people who shouldn't need a
terminal. `cd desktop && npm install && npm run dist:linux` builds the AppImage and .deb (after `npm install`
at the root). The server's `NEXTTUPP_WEB_DIR`, `NEXTTUPP_FFMPEG`/`NEXTTUPP_FFPROBE`, `NEXTTUPP_ENCODER` and
`NEXTTUPP_VAAPI_DEVICE` overrides come from there.

The app keeps itself up to date from GitHub Releases. It downloads a new version in the background and checks
it against the release's checksums. A card then offers **Restart now** (a .deb asks for the computer's
password). Details: [`docs/adr/0005`](docs/adr/0005-desktop-app.md).

## Accounts and sync (optional)

Everything works without an account. Signing in (profile menu → Account) keeps profiles, likes, My List,
Continue watching and taste settings the same on every computer you use. Only those sync, by IMDb id:
never what you search for, sources, torrents or file names. (Phones, below, also tell the cloud about the
computer itself: its name and home-network addresses.) Anyone can create an account, on the same page under
Create account or on the website at nexttupp.com/account; no invite is needed. The cloud limits sign-ups to 5 an
hour from one network.

The password never leaves this computer: the local server stretches it with PBKDF2-SHA256 (600,000
rounds) and sends only the derived key. The session token is kept in `<NEXTTUPP_DATA>/account.json`
(readable only by you), never in the browser. Sync runs in the background: at start-up, every minute and
a couple of seconds after a change. Offline, changes wait and go out when the service is back. Signing
out keeps everything on the computer. The service itself is in [`cloud/`](cloud/README.md); the design is
[ADR 0004](docs/adr/0004-accounts-and-sync.md).

The public website (nexttupp.com) lives in [`site/`](site/README.md).

## Phones and TVs

**Phones.** Signed in, the computer also answers on its home-network address. On the phone, open
**nexttupp.com/watch**, sign in with the same account and tap **Connect to <computer>**: the phone lands on
the computer's own address (`http://192.168.x.y:4545`) and can bookmark it or add it to the home screen.
The film still streams from the computer, over the home network; nothing goes through the cloud. The
setting is **Let phones play from this computer** on the Account page (on by default once signed in), with the
computer's name, its address for bookmarking, and the connected phones, each removable.

How it stays private: every request from another device needs a random, HttpOnly cookie that only a
handoff sets. A handoff code comes from the cloud, works once, within 60 seconds, for that account and that
computer, and the computer checks it with the cloud using its own session. Phones can't sign the computer
out or change its settings. Requests to `localhost` must say `localhost` or `127.0.0.1`, so another website
can't reach the server through DNS rebinding. Signing out turns phones off.

**TVs.** The Cast button in the player lists the Chromecasts and Google TVs on the network. The computer
sends the TV a private, short-lived link to the film on its own address (the link only works for that TV)
and converts what the TV can't play: MKV is repackaged as MP4, HEVC, 10-bit and HDR video become H.264
(4K comes down to 1080p), and AC3/EAC3/DTS sound becomes AAC. Subtitles go along as WebVTT. The player becomes the remote
(play, pause, seek, volume, stop) and Continue watching keeps up; it works the same from a connected phone.
Details and limits: [ADR 0006](docs/adr/0006-watch-at-home.md).

**What this sends to the cloud.** While signed in, the computer registers itself: a random device id, its
name (like "Laptop (Linux)"; renamable, never the computer's hostname), its OS family, and when it was last
seen, plus a keyed hash of its public IP address so the phone can tell it's on the same network (the IP
itself isn't stored). While the setting is on, also its home-network addresses (like
`http://192.168.1.20:4545`), so the phone knows where to go. Signing out removes the device.

## AI picks (optional)

**AI settings** in the profile menu connects a model of the viewer's own: **Sign in with ChatGPT** (uses a Plus or
Pro plan, no key, no extra bill), a **Claude API key** or an **OpenAI API key**. Then home offers **Get AI
picks** (a row chosen from your taste, each with its reason) and search offers **Ask AI** for questions like
"a cosy 90s sitcom". A model is asked only when you press one of those buttons; answers are saved (picks until
Refresh, searches for 14 days), every title it names is checked against Cinemeta and dropped if it isn't
there, and titles you've already rated or watched never come back. The default model is the cheapest, newest
one (Claude Haiku, or the newest GPT "luna"); a set of picks costs well under a cent. There's a daily request
cap (50 by default), and the page shows use and cost. Keys stay in a file on this computer only you can read;
they're never synced. Private mode never uses AI. Details: [ADR 0009](docs/adr/0009-ai-picks-and-search.md).

## Music

The **Music** tab plays songs from the computer, like films: it finds each song on YouTube with
[yt-dlp](https://github.com/yt-dlp/yt-dlp), keeps a copy (3 GB cache) and serves it to the browser or a phone
at home. Press **Set up music** once: it downloads yt-dlp into `data/bin` and checks its checksum (or set
`NEXTTUPP_YTDLP` to your own copy).

- **Mixes made for you** from what you finish, skip and heart: a daily mix, mixes of your top artists, Discover
  and On repeat, plus radio from any song or artist. A new profile starts by picking a few artists.
- **Ask for a mood** ("rainy evening", "workout"). With AI connected, the model builds the mix from your
  taste; without it, you get a mood mix from playlists.
- **Now Playing** with synced lyrics (from LRCLIB), the queue, and lock-screen controls on phones. In the
  desktop app, a quiet "Now playing" notification has a **Like** button.
- **Play on a TV** in three ways: the song with its cover, **lyrics** in time over moving artwork, or the
  **music video**. The computer keeps the queue going, so the phone can sleep.

Settings: `NEXTTUPP_MUSIC_CACHE_MB` (cache size, default 3000), `NEXTTUPP_MUSIC_COUNTRY` (store country,
e.g. `in`; guessed from the time zone otherwise), `NEXTTUPP_YTDLP` (path to yt-dlp). For tests,
`NEXTTUPP_MUSIC_SOURCE=fake` plays generated chords instead. Details: [ADR 0010](docs/adr/0010-music.md).

## Trailers

Clicking a poster opens a quick view: the trailer, streamed from YouTube, with the plot, Watch, My List and
Like/Dislike. Close it (Back, Escape, or a click outside) and you're where you were. When Cinemeta's trailer
won't play, nexttupp searches YouTube for one (with music set up). Back from a title also returns Home exactly
as you left it ([ADR 0012](docs/adr/0012-back-keeps-your-place.md)).

With music set up, a title page and the home billboard also play the title's trailer behind the backdrop. It's
muted and loops, and a round button turns the sound on. The computer downloads the trailer from YouTube once
with the same helper (at most 720p and 5 minutes; 1 GB cache, `NEXTTUPP_TRAILER_CACHE_MB`). On a slow line,
the first visit may show only the picture, and the next one plays the trailer. Private mode starts no
downloads. `NEXTTUPP_TRAILER_SOURCE=fake` plays a test pattern instead. Details:
[ADR 0011](docs/adr/0011-trailers.md).

## How it works

```
web (React)  ──►  server (Node 24, Fastify)
                   ├─ catalog     Cinemeta: search, details, episodes (no API key)
                   ├─ sources     Torrentio + apibay → merged, ranked; live UDP tracker scrape
                   ├─ engine      WebTorrent, TCP only; StreamReader prioritises the newest read
                   ├─ playback    ffprobe → direct play | remux (copy video) | transcode (NVENC/x264)
                   ├─ subtitles   OpenSubtitles via the Stremio addon
                   ├─ library     downloads kept for offline viewing, resumed on restart
                   ├─ cleanup     watched films and episodes deleted, and what isn't played (a day; 14 for kept); not music
                   ├─ taste       profiles, likes, My List, progress → SQLite (nexttupp.db), sync-ready
                   ├─ reco        content + CF ranking → personalised home rows, each with a reason
                   ├─ ai          optional: ChatGPT / Claude / OpenAI on the viewer's account → AI picks, Ask AI
                   ├─ music       iTunes + Deezer catalog, yt-dlp audio cache, LRCLIB lyrics, mixes, music casting
                   ├─ trailers    Cinemeta's YouTube trailer ids → yt-dlp, one at a time → 1 GB cache, Range
                   ├─ lan         phones at home: a cookie-gated listener on the home-network address
                   ├─ cast        Chromecast discovery (mDNS) and control (Cast v2), tokenised TV streams
                   └─ sync        optional sign-in; outbox push + pull ──►  cloud (Worker + D1, accounts and taste only)
```

Decisions and the measurements behind them: [`docs/adr/`](docs/adr/).

## Tests

```bash
npm test                                   # unit tests
npm run typecheck
node scripts/e2e.mjs out/                  # real Chrome: search → title → play → seek (server on :4545)
node scripts/seek-bench.mjs <infoHash> 0   # seek latency into undownloaded parts of a file
node scripts/reco-sanity.mjs http://127.0.0.1:<port> quiet action   # throwaway profiles → home rows with reasons
node scripts/sync-e2e.mjs                  # two local servers + a local Worker: sign-up, sign-in, sync both ways
node scripts/handoff-e2e.mjs …             # phone emulation: nexttupp.com/watch → handoff → the LAN cookie (see header)
node scripts/cast-e2e.mjs …                # casting to scripts/fake-tv.ts: direct, remux, transcode, ffprobe + Chrome
node scripts/cast-ui-e2e.mjs …             # the player as a remote, on the computer and a connected phone
```

The cast scripts never touch a real TV: they cast to `scripts/fake-tv.ts`, a fake receiver.

The end-to-end and seek scripts use a public-domain film (*Night of the Living Dead*, 1968).
