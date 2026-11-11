# 0007: Private mode

Date: 2026-11-11 · Status: accepted

## Context

People want to watch or browse something without it staying anywhere: not in Continue watching, not in
their taste, not on disk, not in a log. The owner's words: "Nothing should stay in incognito mode. No
logs, no history, nothing."

Before this, using nexttupp left traces in several places, some of them easy to miss:

- **Database:** progress (Continue watching), likes, My List, dismissals, taste tuning, events, and the
  "shown on home" impressions. Most of these also sync to the account ([0004](0004-accounts-and-sync.md)).
- **Disk:** every streamed torrent's data in `downloads/<info hash>/<file name>`, kept so re-opening is
  instant, and its metadata in `torrents/<info hash>.torrent`.
- **The metadata cache** (`items`): opening a title fetched it and its neighbours into the cache.
- **Logs:** the packaged app writes the server's log to a file, with one line per request: search terms,
  title ids, session ids (info hashes), stream URLs.
- **The browser:** playback positions and the subtitle language in localStorage, trackers in
  sessionStorage, and poster images and API responses in Chromium's disk cache.

## Decisions

- **Per window, like a browser's private window.** A switch in the profile menu. While it's on, a
  "Private" label sits beside the avatar. It lives in that window's sessionStorage (so a reload keeps it,
  and closing the window ends it), and each phone tab has its own. Recommendations still use your taste:
  private mode reads, it never writes.
- **One header carries it.** Every request from a private window sends `x-nexttupp-private: 1`
  (`web/src/api.ts`). The `<video>` element can't send headers, so a stream counts as private when its
  session is private (`engine.isPrivate`), and a cast URL when its session is.
- **Refuse, don't pretend.** Likes, My List, dismissals, taste tuning, profile changes and downloads
  answer 409 with "Private mode is on, so nothing is saved…", shown as a toast. Accepting them and quietly
  throwing them away would look saved and then not be. Progress isn't even sent.
- **Video in a folder that doesn't outlive playback.** A private session's torrent goes to
  `private/<random uuid>/` (not even the folder name says what it was), its metadata isn't saved, and the
  folder is deleted when the session closes, goes idle, or the server stops. The whole `private/` folder
  is wiped at every start, for a crash or power cut. A torrent that a normal session already has open is
  shared as is; its data was being kept anyway.
- **No log lines.** Fastify's `LogController` skips the request lines for private requests, and the
  request's logger is set to `silent`, which covers errors and ffmpeg warnings too. Engine messages that
  name a torrent aren't written for private ones.
- **Nothing for the browser to keep.** Private responses (API and video) carry `Cache-Control: no-store`.
  Images go through `/api/img`, a relay limited to Cinemeta's image hosts (https only, no redirects), which
  also answers `no-store`; API responses have their image URLs rewritten to it, and the few image URLs the
  app builds itself use `imageUrl()`. What storage.ts would write is kept in memory instead.
- **No cache writes on its behalf.** Home doesn't record impressions, and "More like this" uses only
  titles already in the cache instead of fetching new ones.

## Consequences

- `scripts/private-e2e.mjs` checks all of this against a real torrent from a local tracker: 32 checks,
  including the folder surviving `kill -9` and being gone after the next start.
- "More like this" can be empty in private mode for a title nexttupp has never seen.
- What stays outside nexttupp's reach: the phone browser's own history (the address of each page), and the
  operating system. On a phone, use the browser's private tab as well. In-memory caches (search results
  for an hour, probe results) last until the app quits; they are never written to disk.
- Keeping a title you're watching privately (after switching private mode off) starts its download afresh
  in the downloads folder, so the kept copy isn't deleted along with the private one.
