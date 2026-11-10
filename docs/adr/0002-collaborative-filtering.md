# 0002: Collaborative filtering for movies

Date: 2026-11-10 · Status: accepted

## Context

Recommendations are the product's long-term differentiator, and the owner's main complaint about Netflix and
YouTube. A single profile's history can't support collaborative filtering on its own, so nexttupp borrows the
taste structure of a public dataset: which films the same people love. This ADR covers that piece only,
`server/reco/cf.ts`, a model trained offline and queried in-process. Blending it with content features,
signals and rows belongs to the per-profile recommender.

The contract is fixed: `loadCf(dataDir)` gives `null` until a model is built, otherwise `size`, `has(id)`,
`neighbors(id, k)` (item to item) and `score(seeds, k)` (a weighted taste profile; negative weight means
disliked; unknown ids are ignored; seeds are never returned).

Data: [MovieLens 32M](https://grouplens.org/datasets/movielens/32m/), with 32,000,204 ratings (0.5 to 5 stars)
of 87,585 movies by 200,948 users, January 1995 to 12 October 2023. Every movie has an IMDb id in
`links.csv`, mapped to `tt` + 7 digits.

## Decision

**EASE** (Steck 2019, *Embarrassingly Shallow Autoencoders for Sparse Data*) **with dropout regularisation**
(EDLAE, Steck 2020, *Autoencoders that don't overfit towards the Identity*): a closed-form item×item linear
model. With X the user×movie interaction matrix and G = XᵀX, P = (G + Λ)⁻¹ and B = I − P·diag(1/diag P), a
profile's score for movie j is Σᵢ wᵢ·Bᵢⱼ. Plain EASE uses Λ = λI. EDLAE adds p/(1−p)·diag(G), which is the
closed form of training with a fraction p of each profile dropped. That makes the weights work for a profile
of three films as well as for one of three hundred.

It beat the alternatives on every test group (tables below): item-kNN and RP3beta by 18–39% and a tuned
iALS by 1–4%. It needs no iterative training, and it becomes a sparse item×item table that a few lines of
TypeScript can query.

Shipped settings (`SHIP` in `scripts/build-cf.py`):

| | |
|---|---|
| movies | the 18,797 liked (≥ 4★) by at least 10 MovieLens users. The dense inverse needs n² floats (1.4 GB here), and a larger catalogue didn't score better: 13k, 17k and 19k movies all gave 0.474 Recall@20 on validation |
| training weights | liked (≥ 4★) **1**, middling (2.5–3.5★) **0.5**, disliked (≤ 2★) **0** |
| recency | a rating's weight halves every **20 years** before October 2023 |
| regularisation | λ = **100**, dropout p = **0.5** (Λ = 100·I + diag(G)) |
| served form | each row keeps its top **300** entries by magnitude (negatives kept): 5.6M weights |
| `neighbors()` | the 50 strongest **partial correlations** per movie, ρᵢⱼ = −Pᵢⱼ/√(PᵢᵢPⱼⱼ), read off the same model |
| file | `data/reco/cf.bin`, 37.8 MiB: ids, CSR weights, neighbour table |
| serving | loads in ~40 ms and adds ~47 MB RSS (108 MB for a bare Node process with it loaded). `score()` with 200 seeds takes under 1 ms; `neighbors()` about 1 µs |

**What to pass to `score()`:** liked = 1. Leave middling ratings and plain "watched" out (weight 0). Disliked
= −0.5 is optional: it costs 2% of recall and removes 28% of the recommendations the user would rate ≤ 2
(dislikes table). The evaluation below scores profiles this way unless a row says otherwise.

`score()` divides by Σ|w|, so its scale doesn't depend on profile size, and it returns only positive scores.
`neighbors()` returns partial correlations, which are symmetric and comparable across movies, so "which of my
likes is this closest to" works without per-seed normalisation. Both are small numbers: a sequel typically
scores 0.1–0.2, a good neighbour 0.02–0.05. Normalise within a query; don't compare against fixed thresholds.

## Evaluation

All numbers come from `python3 -I scripts/build-cf.py eval` (results also in `data/reco/eval.json`), except
where a row says *exploratory*.

**Protocol.** Users are held out entirely (strong generalisation; seed 0). From users with at least 5 liked
(≥ 4★) ratings the script draws 10,000 *validation* and 10,000 *test* users at random. It also draws
5,000 + 10,000 *modern* users, those whose first rating came after October 2013 and who therefore look
most like a 2026 viewer. Models train on the remaining 171k users (26.1M ratings; 16,817 movies pass the
support threshold on this subset). For each held-out user, 20% of their liked ratings are hidden (at least
one). Two variants decide which 20%:

- **random**: any 20% of their likes. The rest of their ratings are the profile. This is the standard protocol
  (Liang et al. 2018), but it leaks: MovieLens users rate in bursts, so the profile contains films rated in the
  same session as the hidden ones.
- **time-ordered**: their *last* 20% of likes. The profile is only what they rated before the first hidden
  one. This is closer to "what will they like next", and it is the one to believe when the two disagree.

Everything in the profile is excluded from the ranking, because a recommender should never suggest something
already seen. **Recall@20** is hits / min(20, #hidden). **NDCG@20** uses binary relevance. A hidden movie
missing from a model's catalogue counts as a miss. Hyperparameters are picked on validation users (modern
validation users for the recency question). Tables report the untouched test groups. The standard error of
Recall@20 is about 0.0026 (random), 0.0023 (modern) and 0.0022 (time-ordered), so differences under ~0.005
are noise (comparisons between rows share users, so they are a little tighter than that). *Coverage* is the share of the model's movies that appear in anyone's top 20. *Pop. rank* is the
median popularity rank of recommended movies (0 = the most-liked film).

### Methods

Profiles are liked films only. The baselines are each tuned on validation users (cosine: shrinkage, neighbours
kept; RP3beta: α, β; EASE: λ). *Plain EASE* is Steck's original: liked ratings, no decay, no dropout.

| method | random | modern | time-ordered | time-ordered, modern | random NDCG@20 | coverage | pop. rank |
|---|---:|---:|---:|---:|---:|---:|---:|
| Popularity | 0.180 | 0.195 | 0.102 | 0.090 | 0.166 | 0% | 15 |
| Item-kNN cosine (shrink 0, k 1000) | 0.320 | 0.329 | 0.167 | 0.158 | 0.307 | 8% | 40 |
| RP3beta (α 1, β 0.6, k 300) | 0.360 | 0.347 | 0.184 | 0.170 | 0.327 | 40% | 75 |
| iALS (d 256, reg 0.003, α₀ 0.1; *exploratory*, `eval --als`) | 0.441 | 0.437 | – | – | 0.413 | 15% | 153 |
| Plain EASE (λ 1000) | 0.446 | 0.450 | 0.225 | 0.217 | 0.423 | 16% | 112 |
| **Shipped** (EDLAE, as above, top 300 per row) | **0.445** | **0.456** | **0.218** | **0.214** | **0.424** | 18% | 89 |

Recall@20 in the first four columns. On full profiles the shipped model ties plain EASE: within noise on random
users, +1.3% on modern ones, −1.4% to −3% on the time-ordered split (half of that is the top-300 sparsification).
It ships because it is much better on the short profiles a new nexttupp user has (dropout table), and because
its recommendations are less popular (pop. rank 89 against 112) at no cost in recall.

### What goes in (shipped λ, dropout and decay; Recall@20)

Training weights and profile weights are (liked, middling, disliked).

| training | profile | random | modern | time-ordered | time-ordered, modern |
|---|---|---:|---:|---:|---:|
| (1, 0, 0) | (1, 0, 0) | 0.442 | 0.455 | 0.221 | 0.216 |
| (1, 0, 0) | (1, 0.5, 0) | 0.459 | 0.467 | 0.220 | 0.210 |
| (1, 1, 1) "watched" | (1, 0, 0) | 0.445 | 0.451 | 0.216 | 0.208 |
| (1, 1, 1) | (1, 1, 1) | 0.447 | 0.447 | 0.194 | 0.186 |
| (1, 0.5, −0.5) | (1, 0, 0) | 0.446 | 0.457 | 0.221 | 0.216 |
| (1, 0.5, −0.5) | (1, 0.5, −0.5) | 0.457 | 0.465 | 0.219 | 0.211 |
| **(1, 0.5, 0)** | **(1, 0, 0)** | **0.448** | **0.458** | **0.221** | **0.215** |
| (1, 0.5, 0) | (1, 0.5, 0) | 0.466 | 0.470 | 0.219 | 0.209 |

Training on middling ratings at 0.5 is slightly better on random users and level on the time-ordered split.
Putting middling ratings into the *profile* looks like +4% on the random split, but on the time-ordered split
it is level or −3% for modern users. That gain is the session leak, so profiles are liked films only. Treating
everything watched as a like (1, 1, 1) costs 10–12% on the time-ordered split.

### Recency (Recall@20; λ tuned on modern validation users)

| training ratings | random | modern | time-ordered | time-ordered, modern |
|---|---:|---:|---:|---:|
| all, equal weight (λ 300) | 0.454 | 0.452 | 0.222 | 0.211 |
| last 10 years only (λ 300) | 0.374 | 0.457 | 0.191 | 0.217 |
| half-life 10 years (λ 100) | 0.432 | 0.458 | 0.214 | 0.218 |
| **half-life 20 years** (λ 100) | **0.448** | **0.458** | **0.221** | **0.215** |

Down-weighting old ratings helps modern users (+1.3% to +3%) and costs older ones. A 20-year half-life gets
most of the gain for modern users while losing 1.3% on random users; a 10-year half-life or a hard cutoff
gives modern users a little more and costs everyone else 5–18%.

### Dropout against profile length (Recall@20, random / time-ordered)

Short profiles keep 10 or 3 random liked films. In the last column only the seeds are excluded from the
ranking, as for a new user whose other viewing we don't know.

| | full profile | 10 films | 3 films | 3 films, seeds-only exclusion |
|---|---:|---:|---:|---:|
| λ 300, no dropout | 0.443 / 0.220 | 0.298 / 0.166 | 0.200 / 0.119 | 0.152 / 0.087 |
| λ 300, p 0.25 | 0.450 / 0.221 | 0.315 / 0.172 | 0.214 / 0.125 | 0.162 / 0.090 |
| **λ 100, p 0.5** | **0.448 / 0.221** | **0.330 / 0.177** | **0.229 / 0.131** | **0.170 / 0.091** |
| λ 300, p 0.75 | 0.433 / 0.213 | 0.345 / 0.183 | 0.248 / 0.140 | 0.181 / 0.093 |

p = 0.5 is free on full profiles and gains 11% / 7% at 10 films and 14% / 10% at 3. p = 0.75 gains a further
5–8% on short profiles but costs 2–3% on full ones.

### Short profiles against the baselines (Recall@20, random / time-ordered)

| | 3 films | 3 films, seeds-only exclusion | 10 films | full profile |
|---|---:|---:|---:|---:|
| Popularity | 0.180 / 0.102 | 0.126 / 0.071 | 0.180 / 0.102 | 0.180 / 0.102 |
| Item-kNN cosine | **0.264 / 0.147** | **0.183 / 0.096** | 0.307 / 0.163 | 0.320 / 0.167 |
| RP3beta | 0.251 / 0.139 | 0.174 / 0.087 | 0.313 / 0.168 | 0.360 / 0.184 |
| Shipped | 0.228 / 0.131 | 0.169 / 0.091 | **0.329 / 0.176** | **0.445 / 0.218** |

From about 10 liked films the shipped model is best. With 3, item-kNN cosine is 10–15% ahead, mostly by
recommending popular films (pop. rank 64 against 196). See Known weaknesses.

### Sparsification (Recall@20)

| B kept per row | random | modern | time-ordered | time-ordered, modern | file |
|---|---:|---:|---:|---:|---:|
| dense | 0.448 | 0.458 | 0.221 | 0.215 | 1.4 GB |
| **top 300 by magnitude** | **0.445** | **0.456** | **0.218** | **0.214** | **38 MiB** |
| top 100 by magnitude | 0.434 | 0.449 | 0.214 | 0.210 | |
| top 300, positive only | 0.429 | 0.443 | 0.211 | 0.207 | |

Keeping 300 entries costs 0.4–1.4%. The negative weights matter: dropping them costs more than keeping only 100.

### Item to item (one liked film as the only seed)

| | random R@20 | time-ordered R@20 | coverage | pop. rank |
|---|---:|---:|---:|---:|
| Item-kNN cosine | 0.177 | 0.106 | 51% | 187 |
| EASE row (= `score()` with one seed) | 0.158 | 0.097 | 36% | 244 |
| **Partial correlation** (`neighbors()`) | 0.124 | 0.081 | 58% | 503 |

Predicting what a user will like next from one film rewards popular answers, and cosine wins that. A "because
you liked X" row needs films that are *about* X, and partial correlation removes what popularity and the rest
of the catalogue already explain. The sanity lists below show the difference, so `neighbors()` uses it
despite the lower recall. Callers who want "safe" picks for one seed can call `score()` with that seed.

### Dislikes as negative weights (all ratings of held-out users hidden; "rated ≤ 2" is the share of the top 20 that the user went on to rate 2★ or lower)

| disliked weight in the profile | Recall@20 | NDCG@20 | rated ≤ 2 |
|---|---:|---:|---:|
| 0 | 0.432 | 0.408 | 0.58% |
| −0.25 | 0.429 | 0.405 | 0.47% |
| −0.5 | 0.423 | 0.400 | 0.42% |
| −1 | 0.412 | 0.391 | 0.35% |

Dislikes are already rare in a top 20. A −0.5 weight removes 28% of them for 2% of recall.

## Neighbours: sanity check

The top 10 of `neighbors()` from the shipped model, with partial correlations:

| film | `neighbors()` top 10 (partial correlation) |
|---|---|
| Before Sunrise | Before Sunset 0.20 · Before Midnight 0.14 · Boyhood · Waking Life · (500) Days of Summer · Once · Vicky Cristina Barcelona · Blue Valentine · Reality Bites · Closer (0.01–0.02) |
| Die Hard | Die Hard 2 0.06 · The Terminator · Die Hard with a Vengeance · Terminator 2 · Indiana Jones and the Last Crusade (0.05) · Aliens · Lethal Weapon · Raiders of the Lost Ark · Live Free or Die Hard · Back to the Future (0.03) |
| Spirited Away | Howl's Moving Castle 0.10 · My Neighbor Totoro 0.07 · Princess Mononoke 0.07 · Amélie · Castle in the Sky · Kiki's Delivery Service · Pan's Labyrinth (0.03) · WALL·E · Nausicaä · Grave of the Fireflies (0.02) |
| Arrival | Blade Runner 2049 0.05 · Interstellar 0.05 · The Martian · Ex Machina · Get Out (0.04) · Rogue One · Logan · Annihilation · Dunkirk (0.03) · Edge of Tomorrow 0.02 |
| The Godfather | The Godfather Part II 0.17 · Goodfellas 0.05 · Schindler's List · The Shawshank Redemption · The Usual Suspects (0.04) · The Godfather Part III · One Flew Over the Cuckoo's Nest · Pulp Fiction · The Silence of the Lambs · Fight Club (0.03) |
| Mean Girls | Easy A · Legally Blonde (0.05) · The Devil Wears Prada · Bridesmaids (0.04) · Pitch Perfect · Clueless · Freaky Friday · The Notebook · 10 Things I Hate About You (0.03) · Bring It On 0.02 |

All six are what a film fan would say. Sequels lead where they exist (Before Sunset, Die Hard 2, Godfather
Part II), then films from the same director, studio or audience: the Ghibli catalogue for Spirited Away,
2014–2018 cerebral sci-fi for Arrival, and 2000s–2010s teen and female-led comedies for Mean Girls. The same model
scoring short profiles (`score()`, 2–3 liked films):

| liked | `score()` top 8 |
|---|---|
| Before Sunrise + Spirited Away | Before Sunset · Before Midnight · Howl's Moving Castle · Princess Mononoke · My Neighbor Totoro · Amélie · Eternal Sunshine of the Spotless Mind · WALL·E |
| Mean Girls + Easy A | The Devil Wears Prada · Pitch Perfect · Legally Blonde · Clueless · 10 Things I Hate About You · Juno · Bridesmaids · Crazy, Stupid, Love. |
| Arrival + Ex Machina + Blade Runner 2049 | Interstellar · The Martian · Blade Runner · Mad Max: Fury Road · Her · Logan · Edge of Tomorrow · Moon |
| The Godfather + Goodfellas | The Godfather Part II · Pulp Fiction · The Shawshank Redemption · The Usual Suspects · The Silence of the Lambs · Schindler's List · Fight Club · One Flew Over the Cuckoo's Nest |
| …and Pulp Fiction disliked (−1) | The Godfather Part II · The Usual Suspects · One Flew Over the Cuckoo's Nest · Schindler's List · Scarface · The Departed · The Shawshank Redemption · Casino |
| Paddington 2 alone | Paddington · Hunt for the Wilderpeople · Toy Story 4 · Incredibles 2 · Coco · Wonder · Connected · Mission: Impossible – Fallout |

**Popularity bias.** The neighbour lists are specific because partial correlation discounts what popularity
explains. `score()` is more popular, as it should be for recall. It reaches into the canon when a profile
points there: Godfather + Goodfellas brings back Shawshank and Schindler's List, which are crime-adjacent at
best. Dividing scores by popularity^γ (*exploratory*, λ 500, every rating weight 1, validation users) gave:

| γ | random R@20 | modern R@20 | coverage | pop. rank |
|---|---:|---:|---:|---:|
| 0 | 0.474 | 0.463 | 20% | 131 |
| 0.1 | 0.471 | 0.461 | 26% | 189 |
| 0.2 | 0.451 | 0.441 | 36% | 284 |
| 0.3 | 0.407 | 0.398 | 48% | 522 |

γ = 0.1 is close to free, but the change in what people see is small, and beyond it every step costs real
recall. The model ships unbiased. Freshness and diversity belong in the ranker, which knows what is already on
screen and can use `neighbors()` for "because you liked X" rows that are naturally less popular.

## Coverage

- **Movies only, ratings up to October 2023.** Series aren't in MovieLens. Films released after mid-2023, and
  films fewer than 10 MovieLens users liked, are unknown to the model (`has()` is false). The recommender
  ranks those on content features alone, so they are never penalised for being absent.
- 18,797 of MovieLens' 87,585 movies are in the model, and they carry 98.7% of all ratings (99.4% of likes).
  The model's tastes are those of MovieLens raters, a self-selected group of film enthusiasts. Half of the
  ratings predate 2010 (8% predate 1999; 15% are from 2020 or later), which is why older ratings are
  down-weighted.

## Known weaknesses

- **Frozen in 2023, films only.** Everything newer, and all series, depend on content features. Barbie and
  Oppenheimer (July 2023) made it in with about 1,000 ratings each; Dune: Part Two did not.
- **Whose taste.** MovieLens raters are cinephiles, mostly English-speaking. The best-known Indian, Korean and
  Japanese films are in and have sensible neighbours (3 Idiots → Taare Zameen Par, PK, Dangal; Your Name →
  Weathering with You), but on a few hundred raters each, against tens of thousands for Hollywood hits.
  Deeper regional catalogues are mostly absent (Gangs of Wasseypur isn't in).
- **Canonical pull** (above): a profile of acclaimed films drifts toward the IMDb top 250.
- **Very short profiles.** With 1–3 liked films, item-kNN cosine scores 10–15% higher than the shipped
  model, mostly by recommending popular films. A stronger dropout (0.75) closes most of that gap but costs
  full profiles 2–3%; a second, cold-start matrix would avoid the trade if it matters. Until then the
  recommender should lean on content and popularity for new profiles.
- **Rare films are noisy.** A movie liked by 10–30 raters has few, small weights. `has()` is true, so the
  recommender treats it as CF-scored, but its CF score will be near zero. The ranker should not read that as
  "not for you".
- **Offline numbers overstate.** The random split leaks same-session ratings; on the time-ordered split recall
  roughly halves for every method. The ranking of methods holds under both, but absolute numbers mean little.
- **Signals are coarse.** MovieLens has stars; nexttupp has likes, dislikes and viewing. Neither middling ratings (0.5) nor "watched" helped as profile input on the time-ordered split, so profiles hold only what the user liked.
  Whether a nexttupp "watched to the end" behaves like a MovieLens like is untested.

## Consequences

- `server/reco/cf.ts` serves a 38 MiB file with no dependencies; startup and memory cost are negligible.
- The recommender blends `score()` with content similarity and treats unknown ids as content-only. It should
  give likes weight 1 and optionally dislikes −0.5, and normalise CF scores per query (they are small and
  unevenly scaled across profiles).
- Rebuilding is a manual step on the owner's machine (below), not part of `npm install`. If nexttupp ever
  gathers enough first-party likes, they can be appended to the training rows of the same pipeline.
- The licence (below) limits nexttupp to non-commercial use while this model is in it.

## Rebuilding

```bash
npm run build:cf                          # downloads ml-32m.zip (239 MB) if missing, md5-checks, unzips, trains,
                                          # writes data/reco/cf.bin and prints neighbour sanity lists
python3 -I scripts/build-cf.py eval       # every number in this ADR (~40 min; add --als for iALS, +30 min)
python3 -I scripts/build-cf.py fixture    # regenerates server/reco/__fixtures__/tiny-cf.bin for the tests
```

Needs Python 3 with numpy, scipy (OpenBLAS) and pandas, about 5 GB of free RAM, and about 75 s to train (plus
the download on first run). The raw data and caches live in `data/reco/` (gitignored); the model file is never
committed. `-I` matters: the CSVs are untrusted input, and isolated mode keeps their directory off Python's
import path. The CSV parser accepts only numeric ids. The server loads `<NEXTTUPP_DATA>/reco/cf.bin` at start;
rebuilding means restarting.

To refresh with a newer MovieLens release, change `ML_URL`/`ML_MD5`/`ML_DIR` at the top of the script, run
`eval` and check that the numbers still hold, then `build`.

## Licence

MovieLens is licensed for **research use**. The terms ask that we don't imply endorsement by the University
of Minnesota or GroupLens, that we cite the dataset in publications, that we redistribute it (or
transformations of it) only under the same terms, and that **no commercial or revenue-bearing use** happens
without GroupLens' permission. The trained model is a transformation of the data.

For a personal, non-commercial home server this is fine. **Revisit before any commercial use**: paid plans,
ads or selling the app. The options then are to ask GroupLens for permission, or to retrain on first-party
interaction data. Citation: F. Maxwell Harper and Joseph A. Konstan. 2015. The MovieLens Datasets: History and
Context. ACM TiiS 5, 4: 19:1–19:19. <https://doi.org/10.1145/2827872>
