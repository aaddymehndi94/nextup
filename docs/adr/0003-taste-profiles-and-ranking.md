# 0003: Taste profiles and ranking

Date: 2026-11-10 · Status: accepted

## Context

The owner's main complaint about Netflix, YouTube and YouTube Music is their recommendations. The failure
modes we design against:

- engagement bait
- one accidental watch hijacking the feed
- no way to say "not this"
- opaque reasons
- the same few titles forever
- family members polluting each other's taste

This ADR covers the per-profile taste layer and the recommender behind the personalised home screen. The
MovieLens collaborative-filtering model it blends in is [0002](0002-collaborative-filtering.md).

## Storage: `node:sqlite`, local-first and sync-ready

All state lives in `<NEXTTUPP_DATA>/nexttupp.db`:

- built-in `DatabaseSync`, no dependency
- WAL mode
- migrations are an append-only list in `server/db.ts`, tracked by `PRAGMA user_version`

`library.json` is not migrated.

| Table | Syncs | Purpose |
|---|---|---|
| `profiles` | yes | "Who's watching". UUIDv7 id, nullable `account_id` for future login, tombstone `deleted_at` |
| `events` | yes | Every taste signal, immutable and append-only: UUIDv7 id, profile, item id/type, kind, value, context JSON, timestamp |
| `ratings` | yes | Current like/dislike. Clearing writes `value = 0`, never a delete |
| `my_list` | yes | `in_list` 0/1 tombstone, `added_at` |
| `progress` | yes | One row per movie or episode (`tt…:s:e`): position, duration, max position, `watched_sec`, `completed_at`, `hidden`, `forgotten` |
| `dismissals` | yes | `not_interested` / `seen`. Undo = `reason NULL` |
| `feature_prefs` | yes | "More of this" / "never show this" on a genre, person, era. 0 = cleared |
| `impressions` | no | How often a title was on screen without being acted on |
| `items`, `catalog_pages` | no | Cinemeta metadata cache and fetched catalog/search pages, with TTLs |
| `sync_state` | n/a | Key/value: the sync cursor ([0004](0004-accounts-and-sync.md)) |

**Sync shape.** Each user runs nexttupp locally, and streaming never leaves their machine. Accounts and taste
sync to a small cloud service, Workers + D1, which is also SQLite ([0004](0004-accounts-and-sync.md)). To make
that trivial:

- Everything that syncs has a globally unique key: UUIDv7, or profile id + IMDb/stream id. Nothing uses
  autoincrement.
- Events are immutable, so pushing them is idempotent.
- Every materialised row carries `updated_at` for last-write-wins merging.
- Removal is always a tombstone row, never a delete.
- Progress counters (`max_position`, `watched_sec`) are monotonic, so a merge can take the max.
- No torrent info hash, file name or source name is ever written to a synced table or event. The progress
  API accepts only IMDb/stream ids, and a test checks event contexts and column names.
- The store sits behind the `TasteStore` interface (`server/store.ts`), so a sync layer can wrap it.
- Deleting a profile is a tombstone. Purging its rows and events is left to the sync/account layer.

Events log milestones, not every 10-second player ping: a play (new, or resumed after 30 minutes), the
25/50/75 % marks, and completion. Ratings, list changes, dismissals, forgets and preference changes are
logged too. The log is the training data for re-weighting or a learned model later.

## Pure ranker, I/O adapters

`server/reco/` is pure apart from the CF loader (`cf.ts`, owned by 0002):

- `signals.ts`, `content.ts`, `rank.ts`, `home.ts`, `taste.ts` and `labels.ts`
- no `node:*` imports, fetches, DB calls, clock or randomness
- callers pass `now` and a rotation seed
- CF results arrive as plain data (`CfData`: scores, known ids, neighbour lists)

All of this can therefore run in a Cloudflare Worker or a browser. A test enforces it.

The I/O lives in `server/taste/`:

- `items.ts`: the Cinemeta cache, rate-limited (4 in flight, one start per 150 ms)
- `service.ts`: reads the store and cache, calls the CF model, invokes the ranker, and runs background warming
- `routes.ts`: the HTTP API

## Signals

`computeSignals` turns a profile's state into one weight per title.

| Signal | Weight | Notes |
|---|---|---|
| Like / dislike | +1.0 / −1.0 | Onboarding taps × 0.8. A dislike overrides any watching; a like gains at most +0.25 from also finishing |
| Finished | +0.6 | Reached ≥ 90 % (or ≤ 3 min left) after real playback of min(30 % of runtime, 20 min). Seeking to the credits doesn't count. × 0.75 if under half was played here |
| Series episodes | +0.35, +0.08 per further finished episode, max 0.85 | One episode, then nothing for 3 weeks = "tried it", +0.1 |
| Stopped early | −0.3 | Real attempt (≥ 2 min), under 25 % in, no progress for 7 days. 25–50 % = −0.12 |
| Not interested | −0.5 | Also excluded from recommendations |
| My List add | +0.25 | Intent, not experience |
| Watching now | +0.08 + 0.25 × fraction | Becomes "stopped early" or "finished" later |
| Short play | +0.03 | Under 2 minutes of real playback, or skipped straight to the end |
| Already seen | 0 | Excluded from recommendations, but not a taste signal |

`watched_sec` counts only forward movement no faster than the wall clock between pings, so seeks add
nothing.

Decay is exponential towards a floor:

| Signal type | Half-life | Floor | Reason |
|---|---|---|---|
| Explicit (ratings, not interested) | 365 days | 35 % | A like from three years ago still counts for something |
| Implicit (everything else) | 90 days | 10 % | Old behaviour mostly stops mattering |

**Never shown:** rated titles (likes included: you've seen it), dismissed, finished, already started (those
belong in Continue watching), muted features, and junk. Junk means:

- unreleased, or "Untitled …"
- talk, reality and game shows
- films under 40 minutes
- IMDb rating under 5
- no rating and negligible popularity

## Candidates

- **Cinemeta catalogs.** Popular movies (10 pages) and series (6), plus every genre: 4–6 pages for films,
  2 for series. Also the "featured" lists. About 134 pages and roughly 3,700 titles; the crawl takes about
  60 s, runs on startup and twice a day, and skips pages within their 24 h TTL.
- **Content neighbours beyond the catalogs.** After a profile changes, a background job searches Cinemeta
  for the directors, series creators and leads of up to 12 liked titles (Cinemeta search matches people) and
  fetches those titles. This is how Wong Kar-wai's *Happy Together* or Kathryn Bigelow's *Strange Days*
  reach a pool built from popularity lists.
- **CF.** The top 150 CF scores and the neighbours of liked movies get their metadata fetched. Titles without
  metadata are skipped until they have it.

## Scoring

**Content model.** Each title becomes a TF-IDF vector over these feature groups:

| Group | Weight |
|---|---|
| Genre | 0.8 |
| Genre pair (the mix, e.g. Drama+Romance) | 0.7 |
| Genre × decade | 0.35 |
| Director | 1.0 |
| Writer | 0.6 |
| Cast (billing-weighted) | 0.75 |
| Country | 0.4 |
| Decade (neighbouring decades at 0.35) | 0.35 |
| Description terms (BM25-saturated, df 2 to 8 %) | 0.7 |
| Movie/series | 0.45 |

How the groups combine:

- Each group is normalised on its own and multiplied by its weight, so a long synopsis can't outvote a
  shared director.
- A smoothing constant (2 IDF units) is added to every group's norm. Without it, a title whose only genre is
  the very common "Drama" took the whole genre budget, and "both 2020s dramas" scored higher than "same
  director". With it, a shared director is about 0.5 cosine and a shared common genre about 0.17.
- For series without directors, the creator (Cinemeta's `writer`) is weighted as a director.

**Personal content score.** For each candidate, take the top three weighted similarities to positive seeds,
combined as `c₁ + ½c₂ + ¼c₃`. Being very close to one liked title, or fairly close to several, both score
well, and a multi-modal taste isn't averaged into mush.

**Blend.** All parts are normalised to 0..1.

```
personal = (CF-known movie ? 0.5·CF + 0.5·content : content) × shapeFit − 0.8 · max(|w|·sim to a disliked title)
score    = confidence · (0.88·personal + 0.12·prior) + (1 − confidence) · prior
           + 0.2 per boosted feature (max 2) − fatigue (≤ 0.15) ± 0.02 rotation jitter
```

- **prior** = 0.7·rating + 0.3·log-popularity. Quality comes first, and its weight is small so hype can't
  win.
- **confidence** = √(min(1, positive weight / 3)). The ranking slides from popular-and-good to personal as
  signals accumulate.
- **CF.** Movies the CF model doesn't know (series, releases after 2023) use content alone, so they aren't
  penalised for being absent. When `loadCf` returns null, everything is content-only. CF seeds pass negative
  weights halved and clamped to −0.5, per 0002's offline results.
- **shapeFit** compares a title with what the profile likes in general:
  - typical IMDb rating: titles well below it are discounted, and unrated new releases get 0.45
  - mainstreamness (spread of log popularity)
  - films vs series
  - computed as (0.4 + 0.6·rating fit) × (0.65 + 0.35·popularity fit) × (0.6 + 0.4·type fit), applied from
    3 positive seeds up

  Genres and people can't tell *Past Lives* from a YA romance; this can, partly. It's what moved *Me Before
  You* and *Bridgerton* down for the quiet-drama profile without hurting 6.7-rated popcorn action for the
  action profile.

**Diversity and freshness:**

- Greedy MMR: λ = 0.75 for Top picks, 0.8 for "Because you liked", 0.7 for genre rows, 0.4–0.45 for
  exploration.
- A title family (`dupKey`: *Dune* = *Dune: Part Two*, *The Terminator* = *Terminator 2*) appears once per
  row and once across the visible screen. The first 8 titles of each row are held back from later rows.
- Every title in the first 8 of a recommendation row counts as one impression per hour. After 3 impressions
  without any action, it loses 0.03 per further showing, up to 0.15, for 21 days.
- A 6-hour rotation seed changes the "Because you liked X" seeds, exploration picks and near-tie order.

**Exploration** is bounded:

- Top picks: 2 of 24 slots (at most 1 in 10).
- A "Something different" row: titles with quality prior ≥ 0.55 whose main genre carries under 20 % of the
  profile's positive weight, that share no liked genre pair, and that aren't near anything disliked.
  Ranked as adjacent rather than random: 0.4 content + 0.3 quality + 0.3 shape fit.

**Reasons.** Every item carries one. The strongest is picked, and a row never repeats the same wording more
than two or three times (a shared person may repeat, being a specific fact):

| Reason | Example | Condition |
|---|---|---|
| Director | "More from John McTiernan" / "From the director of Arrival" | Director of 2+ / 1 liked title |
| Series creator | "From the creator of …" | Series without directors |
| Cast | "More with Keanu Reeves" | Actor in 2+ liked titles |
| CF | "Fans of The Godfather love this" | CF part dominant |
| Liked title | "Because you liked Before Sunrise" | One seed gives ≥ 40 % of the content score, sim × weight ≥ 0.15 |
| Genre affinity | "Romantic dramas you rate highly" / "… you often finish" | Lift ≥ 1.5 over the catalog, 2+ liked titles |
| Quality | "Highly rated · IMDb 8.4" | |
| Description | "Drama · Romance · 2024" | Fallback; never a made-up reason |

"Because you liked X" rows use seed-relative reasons: "Also from Kathryn Bigelow", "Another sci-fi thriller",
"More 90s action".

## Rows

| Row | Contents |
|---|---|
| Continue watching | Started (≥ 2 min real playback), unfinished, within 90 days; or the next episode after a finished one |
| My List | |
| Top picks for you | |
| Because you liked X | Two rows, seeds rotating among likes and finishes |
| "More …" | One per boosted feature |
| Genre rows | Up to 3, from features with high lift (genre pairs, genre × decade, genres). A row whose genres are a subset of another's is skipped ("Romance" next to "Romantic dramas"), as is one sharing over half its titles with another |
| Series for you / Films for you | When Top picks lean over 75 % one way |
| Something different | |
| New & popular | Last ~18 months, quality-gated, lightly personalised, honest reasons |

**Cold start** applies below 3 positive signals (weight ≥ 0.4, i.e. likes or finishes):

- an onboarding row: diverse, well-known titles rated ≥ 7, about 30 % series, MMR across genres
- "Because you liked X" for any likes so far
- popular films, popular series, acclaimed, and three rotating genre showcases, with films and series
  interleaved 2:1

## Controls

Every lever is available through `/api/me/*`:

- like / dislike / clear
- My List
- not interested / already seen, and undo
- remove from Continue watching, or "forget" a watch ("that wasn't me")
- boost or block any feature from the taste summary

The taste summary (`GET /api/me/taste`) explains what the system believes:

- a one-line description
- liked and disliked features, with the titles behind each
- the strongest signals with their current decayed weights
- CF coverage

## Performance

With about 3,800 titles:

- content index build: about 130–200 ms once the JIT is warm (about 650 ms the first time). It's built at
  start-up (`prewarm`, which also runs the ranker once) and after that only off the request path: when new
  titles arrive it waits for them to settle (2 s) and rebuilds at most every 5 s. Requests keep using the
  previous index until then.
- uncached `/api/me/home` build: 120–160 ms in the sanity runs, 40–130 ms in the bench
- cached (same profile and data, 5-minute TTL, invalidated on any change): 2–10 ms
- first home after a restart: about 70 ms
- `/similar`: 10–120 ms (it may wait up to 2.5 s once to expand a never-seen title)

The index build is synchronous. It's the one place a request can still stall, by up to about 200 ms, if one
arrives during a rebuild. Moving it to a worker would remove that if the catalogue grows a lot.

## Consequences and known weaknesses

- Without CF, series and post-2023 releases (and, today, everything) depend on Cinemeta's genre tags and its
  top-3 cast. Mood ("slow-burn", "quiet") isn't in the data. Rating, popularity and description terms are
  proxies. A Normal People fan still gets glossy romance series (*Sweet Magnolias*, *Maxton Hall*) next to
  the right ones (*Fellow Travelers*, *Heartstopper*).
- Bad genre tags propagate. *Dark* is tagged Crime/Drama/Mystery, so a sci-fi fan who likes it gets crime
  procedurals.
- TMDB "popularity" measures current trendiness, not lasting fame, so the popularity fit is a weak signal.
- Shared cast weighs the same whatever the film. *Gladiator II* still appears in "Because you liked
  Aftersun", via Paul Mescal, at a discount.
- Candidate expansion runs in the background, so the first home screen after a burst of likes is thinner.
  `warming: true` tells the client to refetch.
- Weights are hand-tuned on a few profiles. The event log is there to fit them properly later.

## Testing

```bash
npx vitest run server/store.test.ts server/reco server/taste
node scripts/reco-sanity.mjs http://127.0.0.1:<your port> quiet action hijack scifi cold
```

The sanity script creates a throwaway profile per taste on a running server (never the owner's), likes a
coherent set of titles, waits for warming, then prints:

- every row with its reasons
- the taste summary
- "more like this"
- for `hijack`: whether a 60 s play of a horror film changed anything
