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
