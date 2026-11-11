# 0009: AI picks and Ask AI, on the viewer's own account

Date: 2026-11-11 · Status: accepted

## Context

The owner wanted people to be able to connect ChatGPT, Claude or OpenAI, pick a model (by default the cheapest,
newest one), and get recommendations from it now and then, without spending credit unless they ask. Connecting
should take as little effort as possible, answers should be saved so nobody pays twice for the same thing, and
the results have to be good: a model that names a film that doesn't exist, or one the viewer already rated,
is worse than nothing. The only local model small enough to run (qwen3.5:0.8b) was tried and is good only for
turning a search into filters, so this uses the big hosted models.

## Decisions

- **Three ways in.** As of November 2026:
  - **Sign in with ChatGPT** is the easiest: OpenAI's OAuth for apps, using the viewer's Plus or Pro plan with
    no key and no separate bill. It uses PKCE, dynamic client registration on first sign-in, and a callback on
    `127.0.0.1:<port>/auth/callback`. The ID token is checked against OpenAI's keys; the
    `chatgpt.tokens.use.direct` scope is required. Tokens refresh before they expire, and Disconnect revokes them.
  - **A Claude API key.** Anthropic doesn't let other apps use Claude Pro or Max plans, so a key from
    platform.claude.com is the only way.
  - **An OpenAI API key**, for people who'd rather pay per use.
  - OpenRouter and the like were left out: they'd mean one more account to make.
- **Keys stay on this computer.** Keys and tokens live in `dataDir/ai.json` (mode 0600, written atomically).
  They are never synced, never sent to phones or TVs, and never shown again except for their last four
  characters. Electron's `safeStorage` isn't available in the server's utility process. Connecting and choosing
  a model work only from this computer (a loopback request that isn't cross-site); phones on the network can use
  AI but not change it.
- **Automatic model.** The newest model in the cheapest line that supports structured outputs: Claude's
  `haiku` line, and the cheapest line of OpenAI's newest generation (`gpt-6-luna` today). When several are
  connected, the order is ChatGPT (already paid for), then Claude, then OpenAI. The list comes from each
  provider's models endpoint, refreshed every 12 hours, so "Automatic" follows new releases. A model that
  disappears falls back to Automatic.
- **Only when asked.** A model is called only for Get AI picks, Refresh and Ask AI. Home and search show saved
  answers; nothing is ever sent in the background. Private mode never uses AI. There's a daily cap on requests
  across all profiles (50 by default, can be set from 0 to 200). Every call is logged with its tokens and cost,
  and the settings page shows today's and this month's use, plus an estimate before asking (from past calls, or
  typical sizes before there are any).
- **Saved answers.** `ai_results` keeps each profile's picks until Refresh, and each Ask AI answer for 14 days
  (keyed by the lowercased query). They're stored as ids and reasons, so a title the viewer rates later drops
  out of saved picks without another call. Neither table is synced.
- **What the model does, and what it doesn't.** The model only names titles and says why, as JSON checked
  against a strict schema (`output_config.format` on Claude, `text.format` on OpenAI). Each name is looked up in
  Cinemeta by name and year (within a year either way), in the other type too if the model got it wrong. Only
  the chosen match is fetched in full. Names that can't be found are dropped. Picks then go through the same
  filters as every other row (rated, dismissed, finished, muted, not recommendable), so nothing already seen
  comes back.
- **Prompts.** A system prompt says what makes a good pick: fit the whole taste, not one title; at most a
  quarter famous titles; a mix of genres, countries and decades; at most two from one franchise; nothing listed
  as seen; a reason that names what links it to their taste. The user prompt lists likes, finishes, dislikes,
  stops and "more of"/"never" choices by name and year, and up to 40 earlier picks so Refresh brings new ones.
  Picks run at medium effort and Ask AI at low.
- **Failures.** Errors are sorted into a few kinds (key turned down, out of credit, plan limit reached, busy,
  model gone, refused, network), each with a plain message. A key that's turned down or out of credit is
  flagged on the settings page until it works again. There's no silent switch to another provider.

## Consequences

- A typical set of picks with Haiku costs well under a cent, and nothing at all on a ChatGPT plan.
- Sign in with ChatGPT is built from OpenAI's documentation and tested against a fake server; it hasn't yet
  been tried with a real account.
- The bundled desktop server grows by about 2 MB (the two official SDKs).
