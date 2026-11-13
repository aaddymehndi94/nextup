# 0012: Back keeps your place

Date: 2026-11-13 · Status: accepted

## Context

Opening a title from Home and coming back started Home again: rows were fetched anew (the picks could
change), the skeletons flashed, and the scroll and each row's sideways scroll were gone. Browsing a long feed
became a chore. The browser can't restore the scroll itself, because the page is drawn by script after the
data arrives.

## Decisions

- **Every history entry has a key** (`history.state.key`, `web/src/router.ts`). Pages are told apart by entry,
  not by address, and the scroll is remembered per entry as the viewer scrolls. `history.scrollRestoration`
  is `manual`.
- **List pages stay alive.** Home, Films, Series and Music stay mounted after they're left: the last three, by
  entry (`web/src/main.tsx`). A hidden page has `content-visibility: hidden` and is `inert`. It takes no space
  and can't be reached, and its rows keep their sideways scroll. Back to that entry shows it as it was, and
  its scroll is put back at once. Going to Home by a link (not Back) is a new entry, so it starts fresh.
- **A page told it's hidden** (`PageActive`, `usePageActive()` in `hooks.ts`) doesn't set the tab title,
  listen for its keyboard shortcuts, page in more rows, or play its billboard trailer.
- **Shown again, Home swaps only Continue watching and My List** for fresh ones. A film just watched or a
  title just added shows up, and the picks stay where they were.
- **Other pages** (a title, an artist) are drawn again on Back. Their scroll is put back as they grow, for up
  to 3 seconds, unless the viewer scrolls first. Title details are cached in the page for 30 minutes
  (`api.title`), so a title seen in the quick view opens at once.

## Consequences

- Up to three list pages stay in memory with their images. That's fine on a computer or a phone.
- A kept Home doesn't refresh its picks on its own; a reload does.
