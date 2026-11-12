# nexttupp cloud

The only online piece of nexttupp: **accounts, open sign-up, and syncing each user's taste data**
(profiles, likes/dislikes, My List, watch progress and completion) between their own devices, plus a small
**device list** so a phone can find the user's computer on the home Wi-Fi (see
[Devices and phone handoff](#devices-and-phone-handoff-watch-at-home)). One
Cloudflare Worker and one D1 database, sized for the Workers free plan.

Everything else stays on the user's machine. The API accepts only IMDb ids (`tt123`), episode ids
(`tt123:1:2`), numbers, timestamps and a few enums. It has no field for a title, source, torrent info
hash, magnet link or file name, and rejects any payload that tries to add one (see [Validation](#validation)).

**Status: deployed** at `https://api.nexttupp.com` (Worker `nexttupp-cloud`, D1 `nexttupp`, migrations
applied with `npx wrangler d1 migrations apply nexttupp --remote`). See
[Deploying](#deploying-needs-the-owners-approval).

## Run it locally

Node 24 (`nvm use` at the repo root). This directory has its own `package.json` and `node_modules`.

```bash
cd cloud
npm install
npm test                   # vitest inside workerd, against a local D1 with the real migrations
npm run typecheck
npm run db:migrate:local   # wrangler d1 migrations apply nexttupp --local
npm run dev                # wrangler dev --local on http://localhost:8799
```

End to end on one machine, with a local Worker and two nexttupp servers standing in for two laptops
(each with its own scratch data dir, never the real one):

```bash
npm run db:migrate:local && npm run dev              # here, in cloud/
# from the repo root, one shell each:
PORT=4550 NEXTTUPP_DATA=/tmp/nx-a NEXTTUPP_CLOUD_URL=http://127.0.0.1:8799 npm start
PORT=4551 NEXTTUPP_DATA=/tmp/nx-b NEXTTUPP_CLOUD_URL=http://127.0.0.1:8799 npm start
node scripts/sync-e2e.mjs                             # sign-up, sign-in, merge, both directions, tombstones
```

## The first admin

Anyone can sign up, and every account starts as a `member`. No endpoint can make an admin. The Cloudflare
account holder promotes one straight in D1, after signing up in the app like anyone else:

```bash
npx wrangler d1 execute nexttupp --remote --command "UPDATE accounts SET role = 'admin' WHERE email = 'you@example.com'"
```

(`--local` for the dev database.) Only someone who can already run `wrangler d1 execute` against the
database can do this, and no secret stays deployed in the Worker.

## API

Base URL: `https://api.nexttupp.com`. Requests and responses are JSON
(`Content-Type: application/json`). Authenticated calls send `Authorization: Bearer nxs_…`; the API uses
no cookies. CORS allows any origin, which is safe because nothing is ambient: a caller must hold the token.

Every error looks like `{ "error": "<code>", "message": "<human text>" }`. The codes are `invalid` (400),
`unauthorized` (401), `forbidden` / `account_disabled` / `wrong_password` (403), `not_found` (404),
`too_large` / `too_many_items` (413), `unsupported_media_type` (415), `unknown_profile` (422),
`too_many_attempts` (429, with `Retry-After`), plus the flow-specific codes listed below.
Request bodies reject unknown fields.

`Account` = `{ id, email, displayName: string|null, role: "admin"|"member", createdAt }`.
All times are integer milliseconds since the Unix epoch.

### Auth and account

| Method and path | Auth | Request | Response |
|---|---|---|---|
| `POST /v1/auth/prelogin` | – | `{ email }` | `200 { kdf: "pbkdf2-sha256", iterations: 600000, salt }` (see [Passwords](#passwords-stretched-by-the-client)) |
| `POST /v1/auth/login` | – | `{ email, key }` | `200 { token: "nxs_…", expiresAt, account: Account }` · `401 invalid_credentials` · `403 account_disabled` · `429 too_many_attempts` |
| `POST /v1/auth/logout` | bearer | none, or `{ all: true }` to end every session | `204` |
| `POST /v1/auth/reset` | – | `{ token: "nxr_…", salt, iterations, key }` | `204`, then log in · `400 invalid_token` |
| `GET /v1/account` | bearer | | `200 { account: Account }` |
| `PATCH /v1/account` | bearer | `{ displayName: string\|null }` | `200 { account: Account }` |
| `POST /v1/account/password` | bearer | `{ currentKey, salt, iterations, key }` | `204`; every other session is signed out · `403 wrong_password` |

- Emails are lowercased and unique. `displayName` is 1–40 characters. Passwords never reach the API (see
  below), so their length (8–256 characters) is checked by the clients.
- Sessions are opaque 256-bit tokens, stored only as SHA-256. A session expires after **90 days unused**,
  and each day it is used pushes the expiry out again. Logout deletes the session. An account keeps its
  20 most recent sessions.
- **Login throttling:** 5 failures per email or 30 per IP within 15 minutes lock that email or IP for 15
  minutes. While locked, even the right password gets `429`. The check runs before the key is compared.
  Counters are keyed by SHA-256 of the email or IP, so the table holds no emails or addresses. An unknown
  email is checked against a dummy verifier, so it fails the same way and takes the same work.

### Passwords: stretched by the client

The Workers free plan allows 10 ms of CPU per request, and PBKDF2 at a safe cost takes far longer. So the
client does the slow part, as Bitwarden does, and the server only checks a cheap HMAC:

1. **Sign-up, reset, password change.** The client picks a random 16-byte `salt` and derives
   `key = PBKDF2-SHA256(UTF-8(NFC(password)), salt, 600000)`, 32 bytes. It sends `salt` and `key` in
   base64url (22 and 43 characters) with `iterations: 600000`. Any other iteration count is refused
   (`400`, "update nexttupp"). The server stores
   `nxk1$<iterations>$<salt>$<server salt>$<HMAC-SHA256(server salt, key)>`, with a fresh random 16-byte
   server salt, in `accounts.password_hash`.
2. **Login.** The client calls `POST /v1/auth/prelogin { email }` for `{ kdf, iterations, salt }`, derives
   the key the same way, and sends `POST /v1/auth/login { email, key }`. The server recomputes the HMAC
   and compares in constant time.
3. A `key` that isn't exactly 32 bytes of base64url is a `400`, so a client can't send a password by
   mistake. The password itself never reaches the server or its logs.

**Unknown emails.** Prelogin answers every email the same way. One without an account gets
`HMAC-SHA256(server key, "prelogin-salt:" + email)` cut to 16 bytes: deterministic (asking twice gives the
same salt, as for a real account) and indistinguishable from a random salt. The server key is 32 random
bytes that migration `0002` generates inside D1 (`server_keys`), so **no deployed secret is needed** and
nothing has to be set at deploy time. Someone holding the database can tell real salts from fake ones,
but they already have the email list. Two small leaks remain, both accepted: a real account's salt
changes when its password changes and a fake one never does, and if `KDF_ITERATIONS` is raised later,
older accounts will report the old count until their password changes.

**What a leak would cost.** From the database alone, each password guess still needs 600,000 PBKDF2
rounds, the same as server-side stretching. The stored HMAC can't be replayed: login needs the key, and
the key is the PBKDF2 output.

**Where the clients are.** The nexttupp app's local server (`server/sync/cloud.ts`, Node's
`crypto.pbkdf2`, about 0.3–0.5 s) and any browser page (WebCrypto `PBKDF2`; the website's `/watch` page,
and this Worker's own `/reset` page in `/app.js`). `server/sync/cloud.test.ts` checks that both derive the same key.

### Sign-up (anyone)

| Method and path | Auth | Request | Response |
|---|---|---|---|
| `POST /v1/auth/signup` | – | `{ email, salt, iterations, key, displayName? }` | `201 { account: Account }`, then log in · `409 email_taken` · `429 too_many_attempts` |

- No invite is needed, and every new account is a `member`. Two clients call it: the app (through the local
  server) and the website (nexttupp.com/account and /watch, from the browser, through CORS).
- **5 sign-ups an hour per IP** (`SIGNUP_THROTTLE` in `src/auth.ts`), counted whether or not the email was
  free, so the endpoint can't be used to test emails in bulk. Then the IP waits an hour.
- Emails are unique, case-insensitively. Two sign-ups with one email at once create one account (tested).
- There's no email verification: nexttupp sends no email. An admin can disable an account.
- `GET /reset#…` serves a small HTML form (strict CSP; script at `/app.js`) for admin-issued reset links.

Sign-up used to need an invite. The `invites` table and `accounts.invited_by` / `invite_id` are still in
the database as history; nothing reads or writes them.

### Admin (role `admin`; anyone else gets 403)

| Method and path | Response |
|---|---|
| `GET /v1/admin/accounts` | `200 { accounts: [Account + { disabledAt, lastSeenAt }] }` |
| `POST /v1/admin/accounts/:id/disable` | `200 { account }`. Ends all its sessions and revokes its reset links. `409` for your own account |
| `POST /v1/admin/accounts/:id/enable` | `200 { account }` |
| `POST /v1/admin/accounts/:id/reset-link` | `201 { token: "nxr_…", url: "https://api.nexttupp.com/reset#nxr_…", expiresAt }` (this Worker's origin). Single-use, 24 h; replaces any earlier unused link |

There's no email sending. The admin passes a reset link on themselves. Using it signs out every session.

### Devices and phone handoff (Watch at home)

A computer running nexttupp registers itself while signed in, so a phone signed in to the same account (on
`https://nexttupp.com/watch`) can find it on the home Wi-Fi and open it without a QR or pairing code.

| Method and path | Auth | Request | Response |
|---|---|---|---|
| `PUT /v1/devices/:id` | bearer | `{ name, platform: "linux"\|"mac"\|"windows"\|"other", lan: boolean, lanUrls: string[] }` | `200 { device: Device }` |
| `GET /v1/devices` | bearer | | `200 { devices: Device[], serverTime }`, most recently seen first |
| `DELETE /v1/devices/:id` | bearer | | `204` (also drops its pending codes; idempotent) |
| `POST /v1/devices/:id/handoff` | bearer (the phone) | none | `201 { code: "nxh_…", expiresAt, lanUrls }` · `404` · `409 lan_off` · `409 device_offline` · `429` |
| `POST /v1/handoff/redeem` | bearer (the computer) | `{ code, deviceId }` | `200 { ok: true }` · `400 invalid_handoff` |

`Device` = `{ id, name, platform, lan, lanUrls, lastSeenAt, online, sameNetwork }`.

- `:id` is a random UUID the app picks once per install. Devices are keyed by `(account, id)`, so the same
  install signed in to another account is a separate row. The app calls `PUT` about once a minute (riding
  the sync loop) and `DELETE` when it signs out. An account keeps its 20 most recently seen devices; a
  device not seen for 90 days is deleted.
- `lanUrls` (at most 4) must each be `http://<private IPv4>:<port>` (10/8, 172.16/12, 192.168/16), so a phone
  is only ever sent to an address on a home network. `lan: false` (the person turned "Watch on phones and
  TVs at home" off) requires an empty list: no addresses are sent then.
- **Same network, without storing IPs.** Each `PUT` stores `net_hash = HMAC-SHA256(server key, "network:" +
  the caller's CF-Connecting-IP)`, using the IPv6 /64 prefix for IPv6 addresses. `GET` computes the same for
  the phone's request and sets `sameNetwork` when they match. The key is the `prelogin` key in
  `server_keys` (domain-separated by the `network:` prefix). `online` means seen within 2 minutes. A phone on
  IPv6 and a computer on IPv4 (or vice versa) won't match; the website then still lists the device.
- **Handoff codes** are 256 random bits, stored only as SHA-256, valid for **60 seconds**, bound to one
  account and one device, and refused for a device with `lan: false` or not seen for 10 minutes. At most
  10 unexpired codes per account. Redeeming deletes the code whether or not the check passes (one
  `DELETE … RETURNING`), so a code can be tried once. The computer redeems with its own session: a code
  only works on a computer signed in to the same account, so an impostor at the same LAN address can't
  use it.

### Health

`GET /v1/health` → `{ ok: true, serverTime }`.

## Sync

```
POST /v1/sync/push     body: Batch                  → 200 { applied: {profiles, events, ratings, list, progress, dismissals, prefs}, serverTime }
GET  /v1/sync/pull?since=<cursor>&limit=<1..1000>   → 200 { cursor, more, serverTime, ...Batch }
```

Every row belongs to the authenticated account. Another account's data can't be read, written or even
collided with: `account_id` is part of every key.

### The Batch

Every section is optional on push and always present (possibly empty) on pull. Push and pull use the
same row shapes, which mirror the local tables in `server/db.ts` in camelCase. Every field listed is
required, and `null` is spelled out.

```jsonc
{
  "profiles": [{ "id": "<uuid>", "name": "Aadi", "avatar": "#ff8800" /* or null */, "createdAt": 0, "updatedAt": 0, "deletedAt": null }],

  "events": [{
    "id": "<uuid>",                 // immutable; pushing the same id again is a no-op
    "profileId": "<uuid>",
    "kind": "rating",               // rating | list | play | progress | complete | dismiss | forget | hide | pref
    "itemId": "tt0133093",          // null only for kind "pref"
    "itemType": "movie",            // "movie" | "series"; null only for kind "pref"
    "value": 1,                     // see the table below
    "context": { "source": "title" },  // or null; only the keys allowed for the kind
    "at": 0
  }],

  "ratings":    [{ "profileId": "<uuid>", "itemId": "tt…", "itemType": "movie", "value": 1, "source": "title", "updatedAt": 0 }],
  "list":       [{ "profileId": "<uuid>", "itemId": "tt…", "itemType": "movie", "inList": 1, "addedAt": 0, "updatedAt": 0 }],
  "progress":   [{ "profileId": "<uuid>", "streamId": "tt0903747:1:2", "itemId": "tt0903747", "itemType": "series",
                   "season": 1, "episode": 2, "position": 700, "duration": 2800, "maxPosition": 700, "watchedSec": 650,
                   "completedAt": null, "startedAt": 0, "updatedAt": 0, "hidden": 0, "forgotten": 0 }],
  "dismissals": [{ "profileId": "<uuid>", "itemId": "tt…", "itemType": "movie", "reason": "seen", "updatedAt": 0 }],
  "prefs":      [{ "profileId": "<uuid>", "feature": "d:christopher nolan", "value": 1, "updatedAt": 0 }]
}
```

| Event kind | `value` | allowed `context` keys |
|---|---|---|
| `rating` | -1, 0, 1 | `source` |
| `list` | 0, 1 | none (context must be `null`) |
| `play`, `progress`, `complete` | 0..1 (fraction) | `streamId`, `position`, `duration`, `watchedSec` |
| `dismiss` | 0, 1 | `reason` |
| `forget`, `hide` | `null` | none |
| `pref` | -1, 0, 1 | `feature` (required); `itemId` and `itemType` are `null` |

### Field rules

| Field | Rule |
|---|---|
| ids (`id`, `profileId`) | lowercase UUID (any version; the local store uses v7) |
| `itemId` | `^tt\d{1,10}$` |
| `streamId` | `^tt\d{1,10}(:\d{1,4}:\d{1,5})?$`; its `tt…` part must equal `itemId`. A movie uses its own id; a series needs `tt…:season:episode`, and `season`/`episode` must match it (both `null` for a movie) |
| timestamps | integer ms, ≥ 2020-01-01 and ≤ server time + 1 hour |
| `position`, `maxPosition` | 0..86400 seconds; `duration` > 0 and ≤ 86400; `watchedSec` 0..10,000,000 |
| `hidden`, `forgotten`, `inList` | `0` or `1` (not booleans) |
| rating `value`, pref `value` | -1, 0, 1 (0 = cleared, a tombstone) |
| dismissal `reason` | `"not_interested"`, `"seen"` or `null` (undone, a tombstone) |
| rating `source` | `null` or `^[a-z][a-z0-9_-]{0,31}$` (`title`, `player`, `onboarding`) |
| `feature` | `g:`, `gg:`, `gd:`, `dec:`, `d:`, `w:`, `p:` or `c:` plus 1–120 characters, as in `server/reco/taste.ts` |
| profile `name` | 1–40 characters; `avatar` `null` or 1–64 characters |

All free text (profile name, avatar, feature key, display name) must be trimmed and must not
contain control or bidi-override characters. It also must not contain anything shaped like torrent data:
a run of 32+ letters/digits (a hex or base32 info hash), `magnet:`, `btih`, `://`, `.torrent`, or a video
or subtitle file extension (`.mkv`, `.mp4`, `.srt`, …).

A push holds at most **500 rows in total** and **256 KiB**. One bad field rejects the whole push (`400`,
with a message naming it, e.g. `ratings[1].itemId: must be an IMDb id like tt0133093`), and nothing is
stored. Every `profileId` must already be on the account or be in the same push's `profiles`
(`422 unknown_profile`). A profile id that belongs to another account gets `409 profile_conflict`. An
account holds at most 50 profiles, deleted ones included.

The validator runs in plain Node 24 as well. `cloud/src/wire.ts` has no Worker dependencies: the local
side can `import { parseBatch, VALIDATORS } from '../cloud/src/wire.ts'` to check rows before queueing
them, and set aside a row that fails rather than block the outbox.

### Merge rules (the server applies these; clients must agree)

- **Events:** insert once by `(account, id)`. A duplicate is ignored.
- **Ratings, My List, dismissals, prefs:** last write wins on `updatedAt`. The server takes an incoming
  row only if its `updatedAt` is **strictly greater**; on a tie it keeps its copy. Removals are rows with
  value 0, `inList: 0` or `reason: null`, never deletes.
- **Profiles:** last write wins on name and avatar. **Deletion is sticky**: a row with `deletedAt` set
  deletes the profile even if it is older than the stored row (the stored name stays). Nothing undeletes.
- **Progress:** last write wins on the row (position, duration, hidden, forgotten and the rest), except
  that within **one viewing** the monotonic parts merge, as ADR 0003 intends. Two rows belong to one
  viewing when neither is `forgotten` and the later one's `startedAt` is at or before the other's
  `updatedAt`. Within one viewing:
  - `maxPosition` and `watchedSec` take the larger value.
  - `completedAt` is sticky: a newer row without it keeps the stored one if the newer row started at or
    before that completion. An older row brings its completion when the stored row has none and started
    at or before it.
  - An older row that has nothing to add changes nothing and takes no new `seq`, so re-pushes stay
    idempotent.

  A newer `forgotten: 1` row (the local "that wasn't me") clears completion and stops any merge. A later
  fresh start (`startedAt` after the stored row's last update) begins clean.

**Client rule when applying a pulled row:** take it when `pulled.updatedAt >= local.updatedAt`. Note the
`>=`: the server breaks ties, and its merged rows can carry the same `updatedAt` as what you sent. For
profiles, also keep a local `deletedAt` once set. Insert pulled events if their id is new. With these
rules every device converges on the server's copy.

### Cursor and the sync loop

The server keeps a monotonic counter per account. Each row a push changes gets a fresh, unique `seq`
inside one transaction, so a pull sees all of a push or none of it, and nothing commits later with a
lower `seq`. `cursor` is an opaque decimal string: store it as given and send it back.

1. **Push first.** Send everything changed locally since the last successful push, in chunks of up to
   500 rows: the outbox, or rows with `updated_at` after a local "pushed up to" mark. Retrying a push is
   safe, because pushes are idempotent.
2. **Then pull** with `since=<stored cursor>` (`0` the first time) and apply the rows. While
   `more: true`, pull again with the returned `cursor`. Save the cursor after each page is applied.
3. Pull returns your own pushed rows too. Applying them is a no-op under the rules above.
4. `cursor` only advances when rows come back. `409 cursor_ahead` means the cursor is newer than the
   server's state (for example, the database was restored); pull again from `since=0`.

`serverTime` comes back on every sync response so the client can spot a badly wrong clock. Timestamps
more than an hour in the future are rejected.

### The local side (`server/sync/`)

The app's local server is the sync client; [ADR 0004](../docs/adr/0004-accounts-and-sync.md) has the
design. In short:

- Local `pref` events use `item_id = '-'` and `item_type = 'movie'`; on the wire these are `null`, `null`.
  Event `context` keys not allowed for the kind are dropped, and a free-text `ratings.source` that doesn't
  match `^[a-z][a-z0-9_-]{0,31}$` is sent as `null`.
- Triggers on the synced tables fill a local `sync_outbox` with the key of every row written. A push sends
  the current rows for those keys (validated with `VALIDATORS` first; a row that fails is set aside), plus
  the profile row each one refers to, so `422 unknown_profile` can't happen. Pulled rows are applied with
  the triggers muted, so they aren't pushed back.
- `profiles.account_id` is NULL until sign-in. At sign-in, after a full pull, each unlinked local profile
  with the same name as one of the account's live profiles is merged into it (newer row wins per title);
  the rest join the account. Profiles linked to another account stay on the device and don't sync.
  Profiles deleted before they were ever synced (test profiles, say) never reach the cloud.
- Profile names are checked with the cloud's rules when created (`server/taste/routes.ts`), so every
  profile can sync.
- `impressions`, `items` and `catalog_pages` are LOCAL. The cursor lives in `sync_state`.

## D1 schema

[`migrations/0001_init.sql`](migrations/0001_init.sql), [`0002_client_kdf.sql`](migrations/0002_client_kdf.sql) and [`0003_devices.sql`](migrations/0003_devices.sql). All tables are `STRICT`.

| Table | Key | Purpose |
|---|---|---|
| `accounts` | `id` (UUID), `email` unique | role, `password_hash` (the `nxk1$…` verifier), `disabled_at`, `last_seen_at`, `sync_seq` (the cursor counter) |
| `sessions` | `token_hash` | bearer sessions: `created_at`, `last_used_at`, `expires_at` |
| `invites` | `id`, `token_hash` unique | unused since sign-up opened; kept as history |
| `password_resets` | `token_hash` | admin-issued, single-use, 24 h |
| `login_attempts` | `key` (SHA-256 of email or IP) | failed logins and sign-ups: count, window, `locked_until` |
| `server_keys` | `name` | random keys generated in D1: `prelogin` (the fake-salt HMAC key, also used for `net_hash`) |
| `devices` | `(account_id, id)` | name, platform, `lan`, `lan_urls` (private IPv4 URLs), `net_hash` (an HMAC, never an IP), `created_at`, `last_seen_at` |
| `handoffs` | `code_hash` | one-time phone handoff codes: `account_id`, `device_id`, `expires_at` (60 s) |
| `profiles` | `id` | + `account_id`, name, avatar, `created_at`, `updated_at`, `deleted_at`, `seq` |
| `events` | `(account_id, id)` | kind, item, value, `at`, and the context as typed columns (`stream_id`, `position`, `duration`, `watched_sec`, `source`, `reason`, `feature`), `seq` |
| `ratings`, `my_list`, `dismissals` | `(account_id, profile_id, item_id)` | the local columns + `seq` |
| `progress` | `(account_id, profile_id, stream_id)` | the local columns + `seq` |
| `feature_prefs` | `(account_id, profile_id, feature)` | the local columns + `seq` |

Every synced table has an index on `(account_id, seq)`, so a pull reads only the rows it returns.

## Free-plan budget

**Password checks** cost one HMAC-SHA256: about **0.01 ms** per check in workerd (`test/hash-cost.test.ts`,
200 checks), so login, sign-up, reset and password change all fit the 10 ms budget with room to spare.
The expensive part, PBKDF2 at 600,000 iterations, runs on the client (see
[Passwords](#passwords-stretched-by-the-client)). Before this, the Worker ran PBKDF2 itself at 100,000
iterations (the most Workers' WebCrypto allows) and measured 13–26 ms per login, over the free plan's
limit. A flood of login attempts now costs the Worker microseconds each; the per-email and per-IP locks
still limit online guessing.

**Other limits:** a push is one D1 batch (one transaction) plus one ownership read. A pull is one batch.
D1 counts a batch as one query against the 50-queries-per-request free limit, and no request here makes
more than 4. Request bodies are capped (4 KiB for auth, 256 KiB for push). Parsing, validating and
re-serializing a full 500-row push took about 1.2 ms (Node 24, same V8 engine, warm), so a sync request
fits the 10 ms budget with room to spare.

## Deploying (needs the owner's approval)

Nothing below has been run. Each step changes the owner's Cloudflare account.

```bash
npx wrangler d1 create nexttupp                      # 1. creates the D1 database; paste its id into wrangler.jsonc
npx wrangler d1 migrations apply nexttupp --remote   # 2. creates the tables (0001–0003; 0002 also generates the prelogin key)
npx wrangler deploy                                  # 3. uploads the Worker and attaches api.nexttupp.com
# 4. sign up in the app, then promote that account ("The first admin", above)
```

**Updating the deployed service** (already running at `api.nexttupp.com`) for devices and phone handoff:
apply the new migration first, then the Worker, since the new code reads the new tables.

```bash
npx wrangler d1 migrations apply nexttupp --remote   # applies 0003_devices.sql (two tables, no data changes)
npx wrangler deploy
```

What that creates:

| Resource | Details | Free-plan allowance |
|---|---|---|
| D1 database `nexttupp` | 13 tables + indexes, plus wrangler's `d1_migrations` | 10 databases, 500 MB each, 5 GB per account |
| Worker `nexttupp-cloud` | `src/index.ts`; no vars, secrets, KV, R2, Durable Objects, queues or cron triggers | 100,000 requests/day |
| Custom domain `api.nexttupp.com` | a proxied DNS record and an edge certificate in the `nexttupp.com` zone (the zone must be on this account) | free |

`workers_dev` and preview URLs are off, so the Worker is reachable only at `api.nexttupp.com`. To use
another hostname, change `routes` in `wrangler.jsonc` before step 3 (and `NEXTTUPP_CLOUD_URL` for the app).
