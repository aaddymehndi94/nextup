# 0005: Desktop app

Date: 2026-11-10 · Status: accepted for Linux; Windows configured but unbuilt; macOS not started

## Context

Like Stremio, everyone (the owner and their friends) installs nexttupp on their own computer, and all
torrenting, conversion and playback happen there. Friends must not need a terminal, a separate server or
any setup. Windows, macOS and Linux come first; Android and TV later. This ADR covers packaging the existing
server and web app as that desktop app. Scope for this round: the Linux AppImage working end to end.

## Decisions

**Electron 44.9.3 + electron-builder 26.18.1** (`desktop/`, its own package.json and lockfile). Electron gives
the same Chromium, with H.264/AAC, on every OS, so the web app's codec detection and the server's
direct-play/remux/transcode choice behave the same everywhere. Versions were at least two weeks old when
picked (44.9.3: 21 Oct; electron-builder 26.18.1: 26 Oct). Electron 44 bundles Node 24.22.0 and Chromium 152.

**The server runs in an Electron utility process, bundled to one ES module.** `utilityProcess.fork` runs
`build/server/server.mjs` (esbuild: the server, Fastify, WebTorrent and all dependencies, 3.5 MB) with
Electron's own Node, so no second runtime ships. Checked in Electron 44's Node:

- `node:sqlite` works, unflagged (SQLite 3.53.4). The Node-sidecar fallback wasn't needed.
- TypeScript type stripping isn't needed: esbuild compiles it.
- `fetch` is there.

A separate process rather than the main process, so a synchronous stall in the server (the content index
rebuild, up to ~200 ms per 0003) never freezes the window, and a server crash can be reported instead of
taking the app down.

**WebTorrent's native dependencies are left out; the app is TCP-only** (0001):

- `webrtc-polyfill` (static import of libdatachannel via `node-datachannel`) is aliased to a stub that
  exports no `RTCPeerConnection`. simple-peer then reports no WebRTC support, and WebTorrent skips
  WebSocket trackers.
- `utp-native` is stubbed too (uTP is off anyway).
- `bufferutil`, `utf-8-validate` and `fs-native-extensions` stay external. Each is loaded in a try/catch
  with a JavaScript fallback. `fs-chunk-store` never asks `random-access-file` for sparse files or locks,
  so nothing is lost.

The installer ships no `node_modules`.

**Lifecycle** (`desktop/src/main.ts`):

- Single-instance lock: a second launch focuses the window.
- The server listens on 127.0.0.1 on a port remembered in `<userData>/desktop.json`. A fresh free port is
  picked only if that one is taken. The port must stay stable because the web app keeps the chosen profile
  and player settings in localStorage, which belongs to the origin (host and port).
- Main polls `/api/health`, then opens the window.
- Quitting posts `shutdown` to the utility process. A small bridge replays it as the `SIGTERM` the server
  already handles: kill ffmpeg, close Fastify, destroy torrents, close the database. A message is used
  rather than a signal because on Windows `kill()` is TerminateProcess, which would orphan ffmpeg. After
  8 s the process is killed.
- Closing the window while a library download is unfinished hides it instead. The app stays in the tray
  (one notification), and quits by itself once downloads finish.
- Links to anything but the local app open in the system browser.

**Data in the OS app-data directory.** Server data goes to `app.getPath('userData')/data`:

| OS | Path |
|---|---|
| Linux | `~/.config/nexttupp/data` |
| macOS | `~/Library/Application Support/nexttupp/data` |
| Windows | `%APPDATA%\nexttupp\data` |

Server logs go to `<userData>/logs/server.log`, rotated at 5 MB. Electron's own Chromium profile lives
alongside, in `userData`.

**CF model as an optional resource.** When the build is given one (`CF_BIN=… npm run build`), `cf.bin` ships
in `resources/reco/`. On start, main copies it to `<data>/reco/cf.bin`, where `loadCf` already looks, if
it's missing or the bundled file changed (size and mtime stamp). Copying rather than linking works on
Windows too, and `server/reco/cf.ts` needed no change. Without one, the recommender runs content-only (0003).

**Web app.** Built with the root's Vite into `desktop/build/web` (never the root `dist/`). Served by the
bundled server via `NEXTTUPP_WEB_DIR`.

**ffmpeg and ffprobe ship with the app.** `scripts/fetch-ffmpeg.mjs` pins the URL and SHA-256 of each build,
verifies the archive before extracting, and keeps only ffmpeg, ffprobe and their shared libraries in
`desktop/vendor/ffmpeg/<platform>-<arch>/` (gitignored). The server takes their paths from
`NEXTTUPP_FFMPEG` / `NEXTTUPP_FFPROBE` and falls back to `PATH` when a configured file is missing.

| Platform | Build | Source |
|---|---|---|
| Linux x64 | BtbN FFmpeg-Builds n7.1.5-1-g7d0e842004, GPL, shared | `autobuild-2026-06-30-13-34`, `ffmpeg-n7.1.5-1-g7d0e842004-linux64-gpl-shared-7.1.tar.xz`, SHA-256 `d1726e0a7b3a31f6cc1f77dbc43c7198e83a1d27d362aa333e6b71df62bbbcf2` |
| Windows x64 (untested) | same, `win64-gpl-shared-7.1.zip` | SHA-256 `1d0de885a7c8b2aadc3beb25c4bb836dc5b8a8bc82eba2f48e7f3aace7275b71` |

The source:

- Releases at `https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/<tag>/<file>` (the
  repository moved from `BtbN/FFmpeg-Builds`, which redirects; ffmpeg.org's download page still links the
  old name).
- GPL builds include NVENC, VAAPI, QSV (libvpl), AMF and zimg (needed for the HDR tone-map).
- Month-end autobuilds are kept long-term, so the pinned URLs keep working.
- "Shared" means ffmpeg and ffprobe share one set of libraries instead of each embedding them: 160 MiB
  unpacked instead of about twice that.

Why 7.1 and not the newest (9.0.2): BtbN compiles each branch against a different NVENC SDK, and an encoder
built for a newer SDK refuses older drivers:

| FFmpeg | NVENC SDK | Minimum NVIDIA driver |
|---|---|---|
| 9.x | 13.1 | 610 (this laptop has 595: 9.0.2's NVENC failed here) |
| 8.x | 13.0 | 570 |
| 7.1 | 11.1 | 470 |

7.1.5 is a maintained point release, and NVENC works with it here.

The 7.1 shared build's RPATH is broken (`-Wl:../lib`, resolved against the working directory). Rather than
patch verified binaries, the app sets `LD_LIBRARY_PATH=<resources>/ffmpeg/lib` for the server process on
Linux, and ffmpeg inherits it. Only libav* libraries are in there, which Electron doesn't use.

macOS (not done): Martin Riedl's build server (ffmpeg.martin-riedl.de) has signed FFmpeg 9.0.2 release
builds for arm64 and x64, with VideoToolbox and zimg, and publishes SHA-256 sums. evermeet.cx (linked from
ffmpeg.org) is x64-only. Riedl stops x64 release builds in January 2027.

**Hardware encoders** (`server/playback/plan.ts`, `ffmpeg.ts`). At startup the server tries, in order:

| OS | Encoders |
|---|---|
| macOS | VideoToolbox |
| Windows | NVENC, QSV, AMF |
| Linux | NVENC, VAAPI on each `/dev/dri/renderD*`, QSV |

libx264 is the last resort. Each candidate gets a one-second test encode through the same global options,
filter tail and encoder settings as real playback (`encoderArgs`), so "listed but unusable" encoders are
skipped. The shared filter chain (downscale to ≤1080p, zscale/tonemap HDR→SDR) runs on the CPU for every
encoder. Decoded frames stay in system memory (no `-hwaccel_output_format`), and each encoder's tail hands
them over:

| Encoder | Hand-over |
|---|---|
| NVENC | `format=yuv420p`, with CUDA decode |
| VAAPI | `format=nv12,hwupload`, with VAAPI decode and `-init_hw_device vaapi=va:<node>`. Rate control is constant QP, the only mode every VA driver (including Intel's free iHD driver) offers |
| QSV, AMF, VideoToolbox | `format=nv12` |
| libx264 | `format=yuv420p` |

`NEXTTUPP_ENCODER` forces one (it's used even if its test fails), and `NEXTTUPP_VAAPI_DEVICE` picks the
render node. `/api/health` reports the choice.

## Measurements (this laptop: i7-11800H, RTX 3060 Laptop on driver 595.99, Intel UHD on iHD 24.1, Ubuntu 24.04)

Encoders, `desktop/scripts/encoder-check.mjs`: a synthetic 4K HEVC 10-bit PQ clip, 10 s transcoded from
t = 3 s through `buildFfmpegArgs`. Output checked with ffprobe: H.264 1920×1080 yuv420p, keyframes ≤ 2 s apart.

| Encoder | Bundled ffmpeg 7.1.5 | System ffmpeg 6.1.1 |
|---|---|---|
| NVENC | OK, test 0.6 s, 12.2 s for 10 s (0.8× real time) | OK, 23.7 s |
| VAAPI renderD128 (Intel) | test fails: build needs libva ≥ 2.21 (`vaMapBuffer2`); Ubuntu 24.04 has 2.20 | OK, 46.0 s |
| VAAPI renderD129 (NVIDIA, no VA driver) | test fails, skipped | test fails, skipped |
| QSV | test fails: no oneVPL GPU runtime (`libmfx-gen`) installed | test fails |
| libx264 | OK, 10.4 s (1.0× real time) | OK, 20.0 s |

Detection picks NVENC in about 1.9 s. With `NEXTTUPP_ENCODER=vaapi` it picks VAAPI on renderD128, and
with `=x264` it picks libx264. The 4K HDR path is bound by the CPU tone-map, not the encoder.

**AppImage end to end** (`desktop/scripts/verify-appimage.mjs`). The packaged app runs under Xvfb with a
throwaway `XDG_CONFIG_HOME`, driven over Chromium's remote debugging port with puppeteer-core. Final run:

| Check | Result |
|---|---|
| Server up, `/api/health` answers | 6.2 s after launch, encoder `nvenc`. About 4 s is the AppImage mount, Electron start and the first-run copy of the 38 MiB CF model; 2.1 s is server boot (encoder test, database, CF load) |
| Window shows the web app | 7.5 s after launch |
| Search "night of the living dead" | 40 results, first *Night of the Living Dead* (1968) |
| Play tt0063350 through the UI | 3 s of playback 8.3 s after clicking Play (15.0 s on the first run, cold swarm). `currentTime` 3.2 → 8.2 over 5 s, direct play of the 1080p MP4 |
| Converted stream (`caps=aac,mp3`, t = 600) | `x-playback-mode: transcode` through `resources/ffmpeg/bin/ffmpeg` with NVENC. First bytes after 3.3 s, 4 MiB after 4.0 s |
| Data location | `<userData>/data`: `nexttupp.db` (+ WAL), `torrents/`, `downloads/`, `reco/cf.bin`; logs in `<userData>/logs/server.log` |
| Close the window mid-transcode | App exits 0 in 1.1 s. Utility process gone, ffmpeg gone (1 before, 0 after), no leftover processes, port closed |

Sizes:

| Artifact | Size |
|---|---|
| AppImage | 217.2 MiB (227.7 MB) |
| .deb | 176.7 MiB, 485 MiB installed |

Both include the 38 MiB CF model. Unpacked, the app is 486 MiB: ffmpeg 160, Electron about 280, CF 38,
app code 4.3.

## Consequences

- Friends on Ubuntu 24.04 (libva 2.20) get no VAAPI from the bundled ffmpeg: every current BtbN build
  calls `vaMapBuffer2` when uploading frames. Detection skips it, and they get NVENC if they have an NVIDIA
  GPU, else libx264. Newer distributions (libva ≥ 2.21) are unaffected. A later fix could fall back to a
  system ffmpeg on PATH for hardware encoding.
- QSV and AMF arguments are written from the ffmpeg 7.1 option lists but never encoded with here. The test
  encode protects playback if they're wrong.
- The AppImage is about 85 % ffmpeg and Electron. Downloads go to app data (`%APPDATA%` is the roaming
  profile on Windows), so a "download location" setting is worth adding before friends keep many films.
- The server has no authentication and listens on 127.0.0.1, so other local programs can reach it, as with
  `npm start` today.
- Chromium's sandbox can't run in an AppImage where unprivileged user namespaces are restricted (Ubuntu
  24.04+). electron-builder's AppRun then adds `--no-sandbox`. The window only ever loads our local app,
  and navigation elsewhere opens the system browser.
- Not done this round: macOS, an actual Windows build, CI, auto-update (electron-updater) and code signing.

## Building

```bash
npm install                         # at the repo root: the server and web dependencies get bundled
cd desktop && npm install           # Electron, electron-builder, esbuild
npm run dist:linux                  # fetch + verify ffmpeg, build, AppImage + .deb in desktop/release/
CF_BIN=../data/reco/cf.bin npm run dist:linux   # …with the CF model
npm run verify                      # headless end-to-end check of the AppImage (Xvfb)
```

All downloads (the Electron zip, electron-builder's AppImage/deb tools, ffmpeg) are cached under
`desktop/vendor/`.
