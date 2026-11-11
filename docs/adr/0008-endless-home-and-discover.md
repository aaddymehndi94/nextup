# 0008: Endless home, discover rows and fresher picks

Date: 2026-11-11 · Status: accepted

## Context

The owner asked for new and popular titles to show up more, for rows to keep going when scrolled, and for a
way to try new kinds of titles so the recommendations learn more. A look at their own feed also found
children's cartoons (Scooby-Doo, SpongeBob) in an adult profile's Top picks and "Something different", a
film and its later series both on screen, and no way to tell which row a play came from (150 titles shown,
none played from home, and no record of where the plays did come from).

## Decisions

- **Home pages.** `buildHome` builds every row at once: the first screen, then up to six rounds of a discover
  row, another "Because you liked" and another genre from the likes. The service caches the whole list and
  serves the first screen from `/api/me/home` (`more: true` when rows follow) and the rest three at a time
  from `/api/me/home/more?from=`. Each page counts as shown when it is served. A genre already on screen in
  any form (films, series or both) isn't repeated lower down.
- **Rows go on.** A row scrolled to within a screen of its end asks `/api/me/row?id=&have=` for more in the same
  spirit (`moreForRow`: the row id says how it was built), skipping what it has and their families, up to
  120 titles per row.
- **Discover rows.** Genres, genre mixes and countries the likes don't touch (fewer than two likes, not the
  usual few genres, not the US or UK), with at least ten well-made titles, rotating with the seed. Each has
  "More like this" and "Not for me", which are the existing feature preferences (+1 boosts and adds a "More …"
  row; −1 removes the feature everywhere), so the Taste page shows and undoes them.
- **Freshness.** Up to +0.1 on every score for a title out in the last few months (fading over about half a
  year, none under IMDb 6), more for talked-about ones. "New & popular" moves up to just below Top picks (on a
  new profile, just below rating), leans further towards the newest, and is titled for the tab.
- **Cartoons.** Genres can't tell Scooby-Doo from Rick and Morty, so for a profile with five or more likes and
  under 5% of them animated, animation is marked down in the shape fit (series and family titles most), and
  animated series and family animation are left out of "Something different". Liking a couple lifts it, and
  discover can offer "Animation" as a row to opt into.
- **Where plays come from.** A title opened from a home row, search or "More like this" notes that in the
  window's session storage; the player sends it with progress, and the play event keeps it (`context.from`).
- **Next episode.** In the last 40 seconds of an episode the player offers the next one (not specials, not
  unreleased); when the episode ends it starts it after 8 seconds unless dismissed. It prefers the same torrent
  (a season pack) and otherwise takes the best source, as Play does.
- **No request log lines** in normal mode either; `LOG_REQUESTS=1` brings them back for debugging (never in
  private mode, [0007](0007-private-mode.md)).

## Consequences

- The first home response is no slower (about 0.1 s on a 3,800-title cache); a row's next titles take ~20 ms.
- Pages come from the cached list, so a like between two pages can shift rows; the client skips rows it has.
- "Not for me" is strong: it removes every title with that genre, mix or country. It is shown as such and can
  be undone from the toast or the Taste page.
