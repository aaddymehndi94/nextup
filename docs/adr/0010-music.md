# 0010: Music, played from the computer at home

Date: 2026-11-12 · Status: accepted (first version)

## Context

The owner wanted a Music tab that is better than YouTube Music and Spotify where it matters to them:
recommendations that fit, songs they actually listen to (largely Hindi and Punjabi), and casting with lyrics
and moving artwork on the TV. It should work without AI and get better with it, and the phone's lock screen
should control it. Several music sources aren't reachable from the owner's network (see the ISP notes in
ADR 0009's context). Like films, playback stays on the home network: the computer fetches and serves every
song, and nothing goes through the cloud.

## Decisions

- **Catalog: names, not one provider's ids.** Song, artist and album metadata comes from two keyless APIs:
  - **iTunes Search** (`country` from `NEXTTUPP_MUSIC_COUNTRY`, else guessed from the time zone, then the
    locale) for song search, artist pages and albums. It allows about 20 requests a minute, so one `Pacer`
    spaces calls at 18 a minute, with requests someone is waiting on first.
  - **Deezer** for what iTunes lacks: related artists, artist radio, mood playlists and charts. In India,
    Deezer hides track search, top tracks and albums, but artists, related, radio and playlists still answer.
    Deezer has several artists with the same name, so we take the one with the most fans. A duet entity
    ("A & B") counts as A, and placeholder pictures are dropped.
  - Ids are made from normalised names: a song is `t` + 16 hex of sha1("first artist|title without
    (feat …) or - Remastered"), and an artist is `a` + 12 hex. So the same song from iTunes, Deezer and an
    AI answer is one song, and taste carries across sources. Albums keep the provider's id (`it…`, `dz…`).
- **Audio: yt-dlp, on the computer, for the person at home.** The computer finds each song with a YouTube
  Music "Songs" search, falling back to a plain search. `pickUpload` takes the result with the same title,
  within 15 s of the song's length, that isn't a version the song isn't (live, cover, remix, slowed…). It
  favours the artist's own or "- Topic" channel and, after that, the search order. It downloads the m4a stream once into an LRU cache (`data/music`, 3 GB by default,
  `NEXTTUPP_MUSIC_CACHE_MB`), at most two at a time, and remembers failures for 10 minutes. The cached file
  is then served with Range support. Video for TV casting works the same way, cached separately.
  - yt-dlp is found at `NEXTTUPP_YTDLP`, then `data/bin`, then PATH. **Set up music** downloads the official
    release from GitHub and checks it against the release's SHA2-256SUMS before using it. When a fetch
    fails, it updates itself, at most once a day.
  - YouTube changes often and this can break. It's for personal use at home: nothing is shared or
    re-hosted. `NEXTTUPP_MUSIC_SOURCE=fake` swaps in generated chords for tests.
- **Lyrics: LRCLIB.** It gives synced LRC lyrics with no key. We try an exact match first, then a search
  filtered by title, artist and length (±4 s). The phone shows them in time and you can tap a line to jump.
- **Recommendations without AI** (`server/music/engine.ts`):
  - **Taste** is a score per artist and per song, built from:
    - listens: *complete* (the song ended, or 80% of it played), *partial*, or *skip* (skipped in the
      first 30 s);
    - hearts, "Not for me" and artist picks.
    
    Everything decays with a 60-day half-life. A new profile picks a few artists from the current chart
    before its first mixes.
  - **Candidates** come from the listener's liked and played songs and Deezer radio of their top artists.
    Discover adds radio from related artists they haven't played. The chart is used only before there's any
    taste.
  - **Score** combines fit, artist affinity, popularity and a penalty for songs played recently, plus a
    little jitter so Refresh changes things.
  - **`arrange`** caps songs per artist and keeps a gap between songs by the same artist.
  - **Mixes:**
    - Your daily mix, three artist mixes, Discover (artists new to you, close to what you play) and On
      repeat;
    - radio from any song or artist;
    - mood mixes from Deezer playlists.
    
    When three songs are left, the queue carries on with similar songs.
- **Recommendations with AI.** When AI is connected (ADR 0009), typing a mood makes an AI mix:
  - The prompt holds the listener's top artists, liked songs and recent skips by name. The model returns
    names checked against a strict schema.
  - Each name is matched through the store, then LRCLIB, then iTunes; names that can't be found are
    dropped. Album art is filled in afterwards.
  - It's only called when asked, saved, and never in private mode.
  
  Without AI, the same box makes a mood mix instead.
- **Playing: one queue, three places.**
  - **Phone or browser:** one shared `<audio>` element with Media Session, so the lock screen has
    play/pause and next/previous. The queue is saved locally and the next two songs are fetched ahead.
  - **Casting:** the TV gets a private, short-lived link per song, bound to its IP. The **server** holds
    the queue and moves on when the TV reports the song finished, so the phone can sleep. The phone
    becomes a remote. Three modes:
    - **Song:** the m4a with music metadata (cover, title, artist).
    - **Lyrics:** a live video ffmpeg renders as it streams. It shows a slowly drifting, blurred cover
      with the sharp cover and the synced lyrics drawn by libass (720p24, x264 veryfast).
    - **Music video:** the downloaded video.
    
    Without synced lyrics or a video, a mode falls back to the next one, with a note. Only one cast runs at
    a time across films and music.
- **Fades.** Locally, songs crossfade. The page keeps two `<audio>` elements and starts the next song on the
  second one. Its volume rises along an equal-power curve while the old one falls. The crossfade length is
  set in the player (off, 3, 6 or 10 seconds; 6 by default). There's no crossfade:
  - between songs of the same album (gapless albums stay intact);
  - for songs under 45 seconds;
  - while casting.
  
  A skip uses a quarter-second fade, and pause and resume fade too. iOS ignores an element's volume, so on
  iPhones there are no fades and the setting is hidden.
- **Closing.** The bar's X stops the music (on the TV too, when cast) and empties the queue. With no song
  loaded, the bar goes, and so does the phone's lock-screen notification. A toast offers Undo, which brings
  the queue back, paused where it was. The media session's `stop` action does the same.
- **Storage.** Migration 4 adds local tables:
  - `music_tracks`, `music_artists` (what's been seen);
  - `music_listens`, `music_ratings` (taste, per profile);
  - `music_mixes` (saved mixes);
  - `music_files` (the cache index).
  
  Since migration 5, likes, listens and the mixes someone asked for (AI and mood) sync to the account,
  with the songs and artists they name ([0004](0004-accounts-and-sync.md), "Update: music"). The engine's
  mixes and `music_files` stay on each computer. Private mode records no listens and allows no ratings or AI,
  and plays a mood mix without saving it.

## Consequences

- The first version works with no keys and no accounts. The first play of a song waits for its download
  (a few seconds), after that it's instant.
- Taste is per profile and, when signed in, follows the account to every computer; songs still play
  from each computer's own downloads.
- Without AI, mood mixes lean English (Deezer's playlists); artist and daily mixes don't.
- Names like "Earth, Wind & Fire" are split into several artists. Music videos play only on the TV for now.
- If YouTube changes in a way yt-dlp can't follow, songs stop playing until yt-dlp catches up. Mixes, search
  and lyrics keep working.
