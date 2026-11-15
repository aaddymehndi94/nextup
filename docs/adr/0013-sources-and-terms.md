# 0013: Built-in sources, with terms and a notice

Date: 2026-11-15 · Status: accepted

## Context

nexttupp finds what you play on BitTorrent through indexers built into the app (ADR 0001). BitTorrent is a
lawful protocol, but much of what is shared on it is copyrighted. Open sign-up (ADR 0004) means people we don't
know now use the app.

Terms of use help, but they don't make an app lawful on their own. Courts have held a tool's maker liable when the
tool is built and promoted for infringement:
- MGM v. Grokster, US Supreme Court, 2005;
- Stichting Brein v. Wullems ("Filmspeler"), CJEU C-527/15, 2017: a player sold with add-ons that link to
  infringing streams.

The options were:
- **Remove the built-in sources.** People would add their own, as Kodi and Stremio do. The app would be much
  harder to use, against the "dummy-proof" goal.
- **Keep the built-in sources and add terms and a notice.**
- **Leave it as it was.**

## Decisions

- **The built-in sources stay, with terms and a notice** (the owner's choice).
- **The terms of use are at nexttupp.com/terms** (`site/public/terms.html`). They say:
  - nexttupp hosts nothing;
  - what you play is your call: play only what you have the right to;
  - your computer shares pieces while it plays, and your IP address is visible to others on the network;
  - YouTube's terms apply to music;
  - what the account keeps.
- **Where the terms are linked:**
  - the site's footer;
  - sign-in on the site and in the app ("By continuing, you agree to the terms");
  - the app's Account page.
- **"Before you play," once per browser.** Before the first play, download or preview of a source, the app says
  where sources come from and whose call it is ("I understand", "Not now", "Read the terms").
  - The answer is kept in that browser (`nexttupp:sources-ok`), so a phone asks once too.
  - "Not now" plays nothing.
- **Rights holders open a GitHub issue.** There is nothing on our servers to take down. We leave the work out of
  future versions.

## Consequences

- The terms and the notice lower the risk; they don't remove it. A lawyer should read the terms before
  nexttupp is promoted widely.
- There's no monitored contact email yet. Takedown requests and account deletion go through GitHub issues.
- Removing the built-in sources later stays possible: the indexers sit behind one function (`findSources`, `server/sources/`).
