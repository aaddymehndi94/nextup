# nexttupp

Search any film or series, see it like a streaming service shows it, pick a torrent (with live seeds and
peers), and watch it in the browser within seconds. Files the browser can't play (MKV, HEVC, AC3/DTS, HDR)
are converted on the fly, on the GPU when there is one. Anything can be kept for offline viewing.

## Run it

Needs Node 24 (`nvm use`), and `ffmpeg` + `ffprobe` on the PATH.

```bash
npm install
npm run build      # build the web app
npm start          # http://localhost:4545
```

For development, `npm run dev` runs the server with reload plus Vite on http://localhost:5173.

To use it from a phone or TV on the same network: `HOST=0.0.0.0 npm start`, then open
`http://<this-machine's-ip>:4545`. There's no login yet, so only do that on a network you trust.

| Env var | Default | |
|---|---|---|
| `PORT` | `4545` | |
| `HOST` | `127.0.0.1` | `0.0.0.0` to allow other devices |
| `NEXTTUPP_DATA` | `./data` | downloads, saved torrent metadata, library, taste database (`nexttupp.db`) |
| `NEXTTUPP_LANGS` | `en` | preferred audio/subtitle languages, e.g. `en,hi` |
| `NEXTTUPP_IDLE_MIN` | `15` | minutes before an unused torrent is stopped |
| `NEXTTUPP_TORRENTIO` | `https://torrentio.strem.fun` | can include Torrentio options |

The old `NEXTUP_*` names still work as fallbacks.

## Desktop app

`desktop/` packages the server, web app and ffmpeg as an Electron app for people who shouldn't need a
terminal. `cd desktop && npm install && npm run dist:linux` builds the AppImage and .deb (after `npm install`
at the root). The server's `NEXTTUPP_WEB_DIR`, `NEXTTUPP_FFMPEG`/`NEXTTUPP_FFPROBE`, `NEXTTUPP_ENCODER` and
`NEXTTUPP_VAAPI_DEVICE` overrides come from there. Details: [`docs/adr/0005`](docs/adr/0005-desktop-app.md).

## How it works

```
web (React)  ──►  server (Node 24, Fastify)
                   ├─ catalog     Cinemeta: search, details, episodes (no API key)
                   ├─ sources     Torrentio + apibay → merged, ranked; live UDP tracker scrape
                   ├─ engine      WebTorrent, TCP only; StreamReader prioritises the newest read
                   ├─ playback    ffprobe → direct play | remux (copy video) | transcode (NVENC/x264)
                   ├─ subtitles   OpenSubtitles via the Stremio addon
                   ├─ library     downloads kept for offline viewing, resumed on restart
                   ├─ taste       profiles, likes, My List, progress → SQLite (nexttupp.db), sync-ready
                   └─ reco        content + CF ranking → personalised home rows, each with a reason
```

Decisions and the measurements behind them: [`docs/adr/`](docs/adr/).

## Tests

```bash
npm test                                   # unit tests
npm run typecheck
node scripts/e2e.mjs out/                  # real Chrome: search → title → play → seek (server on :4545)
node scripts/seek-bench.mjs <infoHash> 0   # seek latency into undownloaded parts of a file
node scripts/reco-sanity.mjs http://127.0.0.1:<port> quiet action   # throwaway profiles → home rows with reasons
```

The end-to-end and seek scripts use a public-domain film (*Night of the Living Dead*, 1968).
