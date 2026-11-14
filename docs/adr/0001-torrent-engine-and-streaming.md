# 0001: Torrent engine and streaming path

Date: 2026-11-10 · Status: accepted

## Context

The product promise is "pick a source and it plays, and seeking doesn't stall". Browsers can't speak
BitTorrent (browser WebTorrent only reaches WebRTC peers, which almost no swarm has), so a server process
does the torrenting and serves HTTP to thin clients (browser now; phone/TV later).

## Decisions

**WebTorrent 3 in-process, uTP disabled.** On a legal, very well-seeded torrent (Ubuntu 24.04.3 ISO,
magnet-only, cold start) on the owner's ~30 Mbps line:

| | uTP on | TCP only |
|---|---|---|
| metadata | 5.7 s | 4.4 s |
| first 4 MiB | 30.0 s | 6.7 s |
| 4 MiB at 70 % (seek) | 12.0 s | 2.7 s |
| sustained | 2.1 MB/s | 19.7 MB/s |

All 34 peers in the uTP run were uTP and throughput collapsed. TCP peers are plentiful.
A sidecar engine (rqbit, TorrServer) was considered but not benchmarked in this session.

**Our own `StreamReader` instead of WebTorrent's file iterator.** The stock iterator selects "from here to
end of file" and the piece picker serves selections in insertion order, so a stale read (ffmpeg's
header connection, a cancelled browser range) occupied every peer while the seek target waited. The reader
keeps a 48 MB urgent window ahead of the read position plus a background-priority tail, demotes older
readers when a newer one starts, and is cancelled by the response's AbortSignal (an async generator stuck
on `await` can't otherwise be cancelled). Range responses also flush headers immediately so clients drop
their old connection at once. Measured with `scripts/seek-bench.mjs`:

| | before | after |
|---|---|---|
| direct play seek (1080p MP4, 0.5 MiB pieces), median | 2.7 s (max 13.0 s) | 1.5 s (max 1.8 s) |
| 4K HEVC transcode seek (4 MiB pieces), warm swarm, median | 9.4 s (max 37.7 s) | 5.8 s (max 17.1 s) |

This uses WebTorrent internals (`_select`/`_deselect`), so the version is pinned exactly.

**Least-work playback.** ffprobe the file over our own range endpoint, then: direct play if the browser
decodes it natively; otherwise remux (copy video, convert audio) to fragmented MP4; otherwise transcode
with NVENC (libx264 fallback), downscaled to ≤1080p and tone-mapped from HDR. Seeking a converted stream
starts a new ffmpeg at the new time.

**Clock origin for copied video.** Stream copy can only cut on a keyframe (often 2–10 s before the
requested time), and the MP4 muxer restarts timestamps at 0 even with `-copyts`. The server looks up the
real start with `ffprobe -read_intervals`, which matched ffmpeg's `-ss` to the millisecond in testing,
and the player uses it as its clock origin so position and subtitles stay correct.

## Consequences

- A home server is required. iOS and Android TV clients later only need an HTTP player; Android TV's
  ExoPlayer can direct-play MKV/HEVC/AC3, so most conversion disappears there.
- Seeks shortly after a torrent is added are slow (tens of seconds) while peers connect; warm seeks are not.
- Torrents with large pieces (4–16 MiB) seek slower, since a whole piece must arrive before any byte plays.

## Update, 2026-11-13: watched and unplayed downloads are deleted

Data kept under `downloads/<info hash>/` made reopening instant, but it was never deleted, and a film is
several GB. The owner: "if content is watched it should be removed. not songs, but movies and series."

- **Watched** means what Continue watching already uses: the progress row is finished (`isCompleted`: at the end
  after real playback, not a seek to the credits) and this ping is at the end (`atEnd`: the last 10 % or 3
  minutes). Requiring the end on each ping means a re-watch of something finished long ago only counts once it
  reaches the end again. `POST /api/me/progress` reports it (`TasteHooks.onFinished`).
- **Which files:** the player now sends the stream id (`tt…` or `tt…:season:episode`) when it opens a session,
  so every non-private session of that title is matched, and every kept download ("Download to watch later")
  of it. A kept one leaves the Downloads list at once and stops downloading. Private sessions are skipped:
  their folder is deleted when they close (0007), and `unload` never touches a private torrent.
- **When:** the file is queued in `cleanup.json` and deleted (`server/cleanup.ts`, every minute, at start-up
  before kept downloads reopen, and at shutdown) once nothing can read its torrent: no stream open on it for
  the idle time (`NEXTTUPP_IDLE_MIN`, 15 min; a paused player or the credits), its metadata isn't still
  arriving, and it isn't playing on a TV. The torrent is stopped first (`engine.unload`), because a piece at
  a file boundary belongs to two files and Windows won't delete an open file. A failed delete is logged once
  and retried every minute, across restarts. Each deletion logs one line with the title and the space freed.
- **Season packs:** only the watched episode's file goes. Other kept downloads in the pack are reopened at
  once. The folder and the saved `.torrent` go only when no kept download uses the torrent and no other file
  in it holds more than two pieces (the edges that streaming a neighbour writes into it).
- **Not played:** the owner again: buffered data is temporary, "keep it minimum"; what was downloaded by
  choice "can stay for 14 days". `cleanup.json` records when each torrent was last played: opened by the
  player (`POST /api/sessions`, not in private mode) or streaming at a sweep (a long film, a TV). A torrent
  nobody kept and nobody played for a day is deleted whole, folder and `.torrent`. One with no record
  (streamed before this was recorded) goes by its newest file time. A kept download not played for 14 days,
  counted from when it was kept or last played, leaves the Downloads list and goes like a watched file; one
  kept before this rule got its 14 days from the update. Nothing in use or on a TV is touched.
- Not covered: titles finished on another computer (sync brings the progress, but deletion follows playback on
  this one). Music is separate (`data/music`, 0010) and never touched.

## Update, 2026-11-14: picture and sound start together after a seek

- **Copied video, converted audio** (an HEVC or H.264 file with AC3/EAC3/DTS sound on a phone that decodes the
  video) used to be out of sync after every seek or resume. The video started at the keyframe before the
  requested time. The audio, converted with accurate seeking, started exactly at that time.
  - The fragmented MP4 put both at 0, with the audio's first packet followed by a jump of up to ~10 s.
    Chrome stamps decoded audio by counting samples from the first packet and ignores that jump. So the sound
    played early by the distance to the keyframe, on the phone and on a TV.
  - ffmpeg's own decoder keeps the jump, which is why it didn't show in ffprobe checks.
  - Now `-noaccurate_seek` starts the converted audio at the keyframe too.
- **Converted video, copied audio** (HEVC with AAC on a computer) had the opposite: the audio started back at
  the keyframe, and the picture froze on its first frame until the requested time. From a seek point, the
  audio is now converted as well, so both start exactly there.
- Checked with a test film that flashes and beeps once at a known time. With each plan, picture and sound now
  start together and agree within 10 ms.
- **Music** paused only for the quick view's trailer, so a song left playing went on under a film. Starting a
  film, here or on a TV, now pauses the music on that device.

## Update, 2026-11-14: downloads you can pause, a folder you choose, and a Storage page

- **Pause.** A paused download (`paused` in `library.json`) stops downloading at once. Its torrent stops too
  (so it stops seeding), unless another kept file of the same torrent isn't paused, or something played it
  within the engine's idle time (a paused player may carry on). In that case it stops when the idle sweep
  finds it unused. The library records how far the file had got, and doesn't reopen it on
  start-up or on its retries until it's resumed. Playing a paused download still streams it.
- **The download folder** is chosen on the Storage page (`folders.json`, `server/folders.ts`). A new folder
  applies to what downloads from then on. Torrents already saved stay where they are and are still found
  there (`DownloadFolders.of`), so nothing is moved and nothing playing stops. An earlier folder is forgotten
  once it holds no torrent. Only the computer itself may change the folder; a phone sees it read-only.
  Cleanup and the library look in every folder, and delete only folders named by an info hash.
- **Storage** (`server/storage.ts`, `/storage`) lists everything nexttupp keeps on the computer and the
  space it takes, against the disk's free space:
  - kept downloads;
  - what streaming left (torrents nobody kept, deleted a day after their last play);
  - saved songs;
  - trailers;
  - nexttupp's own files.
  Any of these can be deleted one at a time, a group at once, or as "Clear cache" (everything except
  downloads). Nothing playing is deleted: a torrent streaming here or on a TV, or a song played in the last
  ten minutes, stays.
- **Back from a download, or from Continue watching, goes to the title's page.**
  - Continue watching opens the page at that episode, with Resume. It no longer starts the first-ranked
    source on its own, so the viewer can choose another source or episode.
  - Playing a download plays its own file, with the title's page left beneath the player in history.
