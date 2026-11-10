# Product

<!-- impeccable:product-schema 1 -->

> Inferred from the owner's written brief (2026-11-10) without an interview, at the owner's request
> not to be stopped for subjective questions. Items marked *(assumption)* are unconfirmed.

## Platform

web

## Users

The owner first: one person who watches films and series across a laptop, phone and TV, currently using
Stremio + Torrentio, and frustrated by it. Later: the owner's household and invited users (login is planned,
not built). *(assumption: viewing happens mostly in the evening, in low ambient light.)*

## Product Purpose

nextup finds any film or episode, shows it the way a streaming service would (artwork, synopsis, cast), lists
every torrent that can play it with live swarm health, and plays the chosen one in the browser within seconds.
Success: search → pick → watching, with no technical knowledge needed and no stalls.

## Positioning

A Stremio + Torrentio replacement that owns the whole path: its own source ranking (health, language, quality
and *whether this device can play it without conversion*), live peer counts instead of stale indexer numbers,
server-side conversion so any release plays in a plain browser, and full downloads for offline viewing.
Long term, its own recommendation engine is the differentiator: the owner wants to stop depending on
YouTube/Netflix-style recommendation.

## Operating Context

- A home server process (Node) does torrenting and conversion; clients are thin players on the same network.
- Laptop browser now; phone, TV (Android TV), and music (YouTube links/embeds) are planned.
- The owner's ISP blocks TMDB, YTS and EZTV; Cinemeta, Torrentio, apibay and OpenSubtitles (Stremio addon) work.

## Capabilities and Constraints

- Built: search, title details with episodes, ranked sources with live seeds/peers, streaming with direct play /
  remux / NVENC transcode, OpenSubtitles, pin-to-download.
- Not built yet: accounts, recommendations, continue-watching sync, music, native apps.
- Torrent payload is never hosted by nextup; it links the user to swarms.

## Brand Commitments

Name: **nextup** (lowercase). Formerly "afterglow" in an earlier brief; that name is retired.

## Evidence on Hand

Real metadata and artwork from Cinemeta/metahub. No testimonials, users or press exist; do not fabricate any.

## Product Principles

1. It has to actually play. A beautiful screen that stalls is a failure.
2. One obvious action per screen: the best source is one click away; the full list is there for when it matters.
3. Tell the truth about sources: live health, real sizes, honest notes ("Dubbed: French", "Large, likely to buffer").
4. Hide the plumbing (codecs, magnets, trackers) until someone asks for it.
5. Own the data: history and taste stay with the owner, for the recommendation engine to come.
