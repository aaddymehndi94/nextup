# 0004: Accounts and taste sync

Date: 2026-11-11 · Status: accepted (cloud not yet deployed)

## Context

nexttupp runs on each person's computer, and streaming never leaves it. Taste data (profiles, likes, My
List, watch progress, dismissals, taste adjustments) was built sync-ready in [0003](0003-taste-profiles-and-ranking.md):
UUIDv7 ids, an append-only event log, last-write-wins rows with `updated_at`, tombstones. People who use
more than one computer want that data to follow them. Accounts must stay optional: the app works fully
without one.

The online part is `cloud/`: one Cloudflare Worker and one D1 database on the free plan, with invite-only
accounts. Its API, limits and merge rules are in [`cloud/README.md`](../../cloud/README.md).

## Decisions

**Passwords are stretched by the client.** The free plan allows 10 ms of CPU per request, and the Worker's
own PBKDF2 (100,000 iterations, the most Workers' WebCrypto allows) took 13–26 ms. Following Bitwarden,
the client derives `PBKDF2-SHA256(NFC(password), salt, 600000)` and sends only that 32-byte key. The Worker
stores `HMAC-SHA256(server salt, key)` and compares in constant time (about 0.01 ms). The salt is random per
account, chosen by the client at sign-up and returned by `POST /v1/auth/prelogin`. For an email without an
account, prelogin returns a deterministic fake salt, an HMAC of the email under a random key that a D1
migration generates, so no deployed secret is needed. A leaked database still costs 600,000 PBKDF2 rounds
per password guess. Login throttling (per email and per IP) stays.

**The local server is the client.** The browser never holds the session token: it lives in
`<NEXTTUPP_DATA>/account.json` (mode 0600). The web app talks to `/api/account/*` on its own server and
sees only the email and a sync status. Account writes need a JSON body, so another website can't trigger
them without a CORS preflight, which fails. (One exception since [0006](0006-watch-at-home.md): the phone page
nexttupp.com/watch keeps its own cloud session in `localStorage` on that origin, to find the computer.)

**An outbox, filled by triggers.** Every insert or update on a synced table records the row's key in
`sync_outbox`, so no write path can be missed. A rewritten key gets a new id, and a push only clears the
ids it sent, so a progress ping during a push isn't lost. A "pushed up to" timestamp was rejected: rows
pulled from a device with a fast clock would push the mark past local writes. While a pull is applied, a
row in `sync_mute` silences the triggers, so pulled rows aren't pushed back.

**Merging.** The cloud's rules decide (last write wins on `updatedAt`, ties to the server, sticky profile
deletion, monotonic progress within one viewing). The client takes a pulled row when its `updatedAt` is at
least the local one, keeps a local deletion, and inserts events once by id. Every device converges on the
cloud's copy.

**Profiles at sign-in.** After the first full pull, each local profile that isn't on an account yet joins
this one. If the account has a live profile with the same name (the default "Me" on a second computer),
the two merge: the newer row wins per title, the local twin is retired, and the web app switches to the
account's profile. Profiles that belong to another account stay on the computer and don't sync. Profiles
deleted before they were ever synced never upload.

**When it syncs.** Push, then pull: a few seconds after start-up, every 60 s, and 2 s after a taste or
profile change (not after the player's 10 s progress pings, which the minute timer carries). Offline is
normal: the status says so, changes wait in the outbox, and retries back off from 5 s to 5 minutes. A row
the cloud refuses is set aside so it can't block the rest.

**Invites.** Any member can invite. The invite code (`nxi_…`) is shared as is or as
`https://nexttupp.com/join?code=<code>`; the app's Join form takes either. The cloud's own `/join` page is a
fallback that signs up in the browser with WebCrypto.

## Consequences

- Signing out keeps everything on the computer; signing in again to the same account resumes. Signing in
  to a different account on the same computer shows both accounts' profiles locally, but only the
  signed-in account's sync.
- The server can't enforce password length any more; the app and the join pages do (8–256 characters).
- Raising the iteration count later means a new `KDF_ITERATIONS`, accepted for new credentials; existing
  accounts keep theirs until the password changes, and prelogin then reveals which accounts are older.
- Hard limits from the cloud apply: 50 profiles per account (deleted ones included), 500 rows per push.
- Since [0006](0006-watch-at-home.md), a signed-in computer also registers itself as a device (id, name, OS
  family, last seen, an HMAC of its public IP, and with phones on its LAN URLs), as a heartbeat on the sync
  loop. That is the only non-taste data the cloud holds about a computer; signing out deletes it.

## Testing

```bash
npx vitest run server/sync          # outbox, wire mapping, merge rules, profile linking, offline
cd cloud && npm test                # the Worker, in workerd with the real migrations
CODE=nxi_… node scripts/sync-e2e.mjs   # two local servers and a local Worker; see the script's header
```
