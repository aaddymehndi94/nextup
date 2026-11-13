# 0011: Trailers behind the hero

Date: 2026-11-13 · Status: accepted (first version)

## Context

The title page and the home billboard showed a still backdrop. A muted trailer playing behind the text makes
a title easier to judge at a glance. Cinemeta already lists each title's trailers as YouTube ids, and the
music tab already runs yt-dlp on this computer (ADR 0010). The owner's line is slow (about 0.25 MB/s), so a
trailer can take minutes to arrive the first time. YouTube's embedded player isn't an option: it brings
YouTube's controls, tracking and autoplay rules, and it can't sit quietly under the hero's shade.

## Decisions

- **Downloaded once, played from the computer.** `GET /api/trailer/:type/:id` answers `ready` (with the
  file's URL), `preparing`, or `none`. The first ask queues a download. The page asks again every 4 s while
  it's preparing and gives up after 3 minutes. The download keeps going, so the next visit plays at once.
  The file is served with HTTP Range (`/api/trailer/video/:ytId`, the music tab's `sendFile`).
- **Which video:** Cinemeta's `trailers` with type "Trailer" first, then the other ids. If one fails (old
  trailers are often gone from YouTube), the next ask tries the next id. A failed id waits an hour.
- **The music helper, no new download code.** `YoutubeSource.saveVideo` uses the music video's format (H.264
  + AAC, at most 720p) and adds `--match-filters "duration <= 300 & !is_live"`, so nothing over 5 minutes is
  fetched. Without the helper ("Set up music"), there are no trailers. `NEXTTUPP_TRAILER_SOURCE=fake` makes an
  ffmpeg test pattern instead, for tests and demos.
- **One download at a time, the page on screen first.** On a slow line two at once would both take twice as
  long. Waiting downloads are picked by the most recent ask, and one nobody has asked about for a minute is
  dropped (its page was left). A download that has started finishes.
- **Cache:** `data/trailers/<ytId>.mp4`, 1 GB by default (`NEXTTUPP_TRAILER_CACHE_MB`). Least recently
  shown go first; the file's modification time is the "last shown" mark, so no database table is needed.
- **Private mode** starts no download, because a file named after the trailer would record what was looked
  at. A trailer that's already saved still plays, and the files are sent with `cache-control: no-store`.
- **On the page** (`web/src/components/Trailer.tsx`, `web/src/trailer.css`): the video is muted, looping and
  `playsInline`. It sits where the backdrop is, under the shade, and fades in after `canplay` and 1.5 s after
  the backdrop has loaded. It fades back to the picture whenever it pauses: when scrolled out of view, when
  the tab is hidden, or while music plays. A round button in the action row turns the sound on and off.
  With `prefers-reduced-motion` it doesn't start on its own; the Trailer button (the quick view, below) still
  plays it.
  Leaving the page removes the video's source, which stops its download. Remote playback and
  picture-in-picture are off, so Android doesn't overlay its own cast button. Phones get the trailer on the
  title page but not on the home billboard, which shows the poster there.

## Consequences

- When there's no trailer, it isn't ready yet, or anything fails, the viewer sees only the backdrop. There's
  never a spinner or an error.
- A trailer download shares the line with a film that starts while it's running. That's at most one
  download of tens of MB, and only for pages the viewer opened.
- Letterboxed trailers (2.39:1 inside 16:9) keep thin bars under the hero's top and bottom gradients.
  Cropping them (ffmpeg `cropdetect`) is possible later.

## Update, 2026-11-13: the quick view

Downloaded trailers sit behind the hero, but browsing needs more than that. The owner wants to click any title
while scrolling, see its trailer, and carry on scrolling. On this line the first download takes minutes, so a
download can't serve a click.

- **Clicking a poster opens a popup** (`web/src/components/Preview.tsx`), not the title page. It's a modal
  `<dialog>` with the trailer at the top and the gist under it: logo, year, runtime, genres, IMDb, plot,
  **Watch** (to the title page), My List, Like and Dislike. Ctrl-click or middle-click on a poster still opens
  the title page. The title page and the home billboard have a Trailer button that opens it as just the
  trailer.
- **Here YouTube's own player is right** (the reason against it above was a muted loop under the hero). The
  viewer asked for this trailer, with sound and controls, and YouTube starts it in a second or two at a
  quality the line can carry. It's the iframe API (`web/src/youtube.ts`) on `youtube-nocookie.com`, loaded
  the first time it's needed. Resting the pointer on a poster for a moment fetches the title's details and
  warms up YouTube, so the click opens straight into the trailer.
- **Which video:** Cinemeta's ids first. If YouTube won't play one (removed, or not allowed on other sites),
  the next one plays; one that failed isn't tried again in the session. When they run out,
  `GET /api/trailer/:type/:id/search` asks yt-dlp to search YouTube for "<title> <year> official trailer". It
  keeps videos up to 5 minutes, puts ones titled trailer or teaser first, and remembers the answer for a day.
  Without the music helper, the search finds nothing. When nothing plays, the popup says so over the picture.
- **History:** the popup is a history entry of its own over the page beneath (`router.ts`), so Back closes
  it, which matters on phones. Escape, the X, and a click outside also close it. Watch replaces the popup's
  entry, so Back from the title page returns to the list, not to the popup.
- **Quiet underneath:** while the popup is open, the hero and billboard trailers pause. A song playing on
  this device pauses and goes on when the popup closes; music cast to a TV is left alone.
- **Keeping your place:** ADR 0012.
