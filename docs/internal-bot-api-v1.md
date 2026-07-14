# VictoryLabs Internal Bot API v1

Private, versioned, read-only API exposing existing VictoryLabs market data
to trading bots. Consumer: `/root/vl-nft-bots` (separate process/VPS).

Purpose: so bots never call Magic Eden, Tensor, or Helius directly — they
read this API instead, which reuses the backend's existing caches
(listings-store), pure analytics functions (floor-depth, cross-market,
normalized-collection-bid), and one existing indexed DB query
(`getEventsByCollection`, the same query `/collections/trade-history`
already uses as its DB-fallback path).

**This API contains no trading-strategy logic, no transaction building, and
no wallet/private-key handling.** It is a read-only market-data surface.
Bots decide and act entirely on their own side.

Namespace: `/api/internal/bots/v1`.

Source: `src/server/bot-api/`, `src/domain/bot-api-types.ts`.

---

## Auth

Every route under `/api/internal/bots/v1/*` requires:

```
Authorization: Bearer <BOT_API_KEY>
```

Behavior:

- `BOT_API_KEY` unset/blank → **every** request gets `401` (fail-closed,
  never an open bypass — even if a caller presents *some* value).
- Missing header, or a key that doesn't match → `401`.
- Comparison is constant-time (`crypto.timingSafeEqual`) — response timing
  never leaks how much of a guessed key was correct.
- The presented/expected key values are **never logged** — only pass/fail
  and a reason code.
- Optional IP allowlist: `BOT_API_ALLOWED_IPS` (comma-separated). A
  correctly-authenticated request from a non-allowlisted IP gets `403`
  (distinct from `401` so an operator can tell "bad key" from "right key,
  wrong network" while debugging). Unset/blank = any IP may use a valid key.

Env vars (see `.env.example`):

```
BOT_API_KEY=
BOT_API_ALLOWED_IPS=
BOT_API_MAX_SSE_CLIENTS=50
BOT_API_HEARTBEAT_MS=25000
```

## Rate limiting

Every route shares one rate-limit bucket **separate from every public
route** in this backend (`rateLimit({limit: 120, windowMs: 60_000, label:
'internal/bots/v1'})` — its own `Map`, its own budget). Exceeding it
returns `429` with `Retry-After` / `X-RateLimit-*` headers, same shape as
every other rate-limited route in this codebase.

The SSE endpoint additionally caps **concurrent connections**
(`BOT_API_MAX_SSE_CLIENTS`, default 50) rather than request rate, since one
SSE connection is long-lived, not a burst of requests.

---

## `GET /api/internal/bots/v1/health`

```json
{
  "apiVersion": "1",
  "status": "ok",
  "serverTime": "2026-07-14T12:00:00.000Z",
  "uptimeSec": 3600,
  "sources": [
    { "source": "magiceden", "state": "ok" },
    { "source": "tensor", "state": "ok" }
  ],
  "eventStreamClients": 2
}
```

- `sources` reuses the existing per-marketplace health monitor
  (`src/health/source-health.ts`) that already drives the public Live
  Feed's degraded-source indicator — no new detector.
- `eventStreamClients` is this process's current Bot API SSE subscriber
  count (not the public feed's).
- No secrets, no filesystem paths, no internal config in this response.

---

## `GET /api/internal/bots/v1/collections/:slug/snapshot`

`slug` must match the same shape every other collection route in this
backend validates against (`^[a-z0-9_-]{1,60}$`) — anything else is `400
{"error":"invalid_slug"}` before any store/DB access happens.

```json
{
  "apiVersion": "1",
  "generatedAt": "2026-07-14T12:00:00.050Z",
  "receivedAt": "2026-07-14T12:00:00.010Z",
  "dataVersion": "2026-07-14T12:00:00.050Z",
  "stale": false,
  "collection": {
    "slug": "mad_lads",
    "floorDepth": { "...": "computeFloorDepth() result, verbatim" },
    "crossMarket": { "...": "computeCrossMarketGap() result, verbatim" },
    "bids": { "bestContextBid": null, "bestUsableForValueBid": null },
    "recentSales": [
      {
        "signature": "5wkb...",
        "blockTime": "2026-07-14T11:58:00.000Z",
        "marketplace": "magic_eden",
        "saleType": "normal_sale",
        "priceSol": "1.25",
        "mint": "6mVv..."
      }
    ]
  },
  "warnings": []
}
```

### Freshness semantics

- `receivedAt` — when the backend received this HTTP request.
- `generatedAt` — when this response's body finished being assembled. The
  gap between the two is server-side processing time (mostly: whether the
  listings-store snapshot for this slug needed a live refetch or was
  already warm).
- `dataVersion` — currently a timestamp string equal to `generatedAt`.
  **Documented limitation:** this is NOT a content hash. A bot should treat
  it as opaque and use it only to notice "this response is newer than the
  one I saw before" — not to detect whether the underlying data actually
  changed byte-for-byte.
- `stale: true` means one or more upstream/cached sources failed for this
  request and the response is serving partial or last-known-good data
  (see `warnings` for which source and why). **A bot MUST NOT execute
  against a `stale: true` snapshot without revalidating** — see Bot
  Contract below.

### Field provenance (no duplicated formulas)

| Field         | Source function                                                                          |
|---------------|-------------------------------------------------------------------------------------------|
| `floorDepth`  | `computeFloorDepth()` — `src/analytics/floor-depth.ts` (pure, already tested)             |
| `crossMarket` | `computeCrossMarketGap()` — `src/analytics/cross-market.ts` (pure, already tested)        |
| `bids`        | `getBestCollectionBids()` — `src/analytics/normalized-collection-bid.ts`                  |
| `recentSales` | `getEventsByCollection()` — `src/db/queries.ts`, same indexed query `/trade-history` uses |

Listings themselves (input to `floorDepth`/`crossMarket`) come from
`listings-store.ts`'s existing cache + in-flight dedup (`ensureFresh` /
`getByCollection`). **No route in this API calls `fetch()` to ME/Tensor/
Helius directly** — every external call happens exactly where it already
happened before this API existed.

`recentSales` is capped at 10 rows over a 24h window — kept minimal per
design; a bot needing deeper history should use the existing
`/api/collections/trade-history` route (also bot-key-agnostic, public/
rate-limited) rather than expecting this endpoint to grow into a full
trade-history API.

### Partial failure (fail-soft)

If `ensureFresh` (listings refresh) or the bid lookup throws, the response
is still `200` — never `500` for a partial upstream outage. `stale` flips
`true` and a `warnings[]` entry names the failure:

```json
{ "code": "listings_refresh_failed", "message": "listings snapshot refresh failed for mad_lads; serving last-known-cached data: ..." }
{ "code": "bids_lookup_failed", "message": "collection bid lookup failed for mad_lads: ..." }
{ "code": "recent_sales_failed", "message": "recent sales lookup failed for mad_lads: ..." }
```

`floorDepth`/`crossMarket` also surface their own analytics-level warnings
(e.g. "fewer than 2 unique mints") verbatim under `code: "floor_depth"` /
`"cross_market"`.

`bids: null` specifically means "the bid lookup failed" — distinct from a
normal `{"bestContextBid": null, "bestUsableForValueBid": null}`, which
means "the lookup succeeded and there simply are no bids right now."

### Number safety

Every response goes through a JSON-safety pass
(`src/server/bot-api/json-safe.ts`) before serialization:

- `NaN` / `Infinity` / `-Infinity` → `null` (explicit, not `JSON.stringify`'s
  silent default — a bot reading `null` can trust it means "no value", not
  "broken float").
- Any `bigint` → decimal string (plain `JSON.stringify` throws on a raw
  `bigint`; this API never does).
- `recentSales[].priceSol` is deliberately a **decimal string** (as
  Postgres returns it), not a JS float, so a bot doing exact arithmetic on
  it never inherits float rounding.

---

## `GET /api/internal/bots/v1/events`

Server-Sent Events. Same bot auth + IP allowlist as every other route.

### Event envelope

```json
{
  "apiVersion": "1",
  "eventId": "bot-482",
  "eventType": "sale",
  "sequence": 482,
  "generatedAt": "2026-07-14T12:00:00.000Z",
  "dataVersion": "2026-07-14T12:00:00.000Z",
  "payload": { "...": "event-type-specific, see below" }
}
```

Each SSE frame carries the envelope as `data:` and the `eventId` as the SSE
`id:` field (so `EventSource`'s native `Last-Event-ID` reconnect header
works with zero bot-side bookkeeping):

```
id: bot-482
event: sale
data: {"apiVersion":"1","eventId":"bot-482", ...}

```

### Event types wired in Stage 1

| `eventType`        | Wired? | Source                                                              |
|---------------------|--------|-----------------------------------------------------------------------|
| `sale`              | ✅ yes | existing `saleEventBus.onSale` — the same feed the public Live Feed reads, field-mapped to an explicit allowlist (`signature`, `mint`, `slug`, `priceSol`, `marketplace`, `saleType`, `blockTime`) |
| `listing_change`    | ✅ yes | existing `listing_snapshot` / `listing_remove` bus events — a **coarse hint** ("this slug's listings may have changed"), never a full listing payload |
| `resync_required`   | ✅ yes | sent to a single reconnecting client when its `Last-Event-ID` can't be satisfied from the replay buffer |
| `signal_reserved`   | ❌ never emitted today | reserved placeholder type so bots can build a forward-compatible `switch`/`case` ahead of a future validated signal. **Do not build logic that expects this to arrive** — there is no whale-liquidation detector or similar behind this today. |

`sale` payload:

```json
{ "signature": "5wkb...", "mint": "6mVv...", "slug": "mad_lads", "priceSol": 1.25, "marketplace": "magic_eden", "saleType": "normal_sale", "blockTime": "2026-07-14T11:58:00.000Z" }
```

`listing_change` payload:

```json
{ "slug": "mad_lads", "kind": "snapshot" }
{ "slug": "mad_lads", "kind": "remove", "id": "ME:6mVv...:sellerAbc" }
```

`kind: "snapshot"` means a full per-slug listings refresh landed;
`kind: "remove"` means one listing id was removed (sale/delist/etc). A bot
should treat either as **"refetch the snapshot endpoint for this slug if
you care about it right now"** — this event carries no price/listing data
of its own.

### Heartbeat

A `heartbeat` frame (`event: heartbeat`, `data: {"t": <epoch ms>}`) is sent
every `BOT_API_HEARTBEAT_MS` (default 25s). It does **not** consume a
sequence number — it's transport-level keepalive, not a domain event.

### Reconnect / replay / resync flow

1. The backend keeps a bounded, process-local, in-memory ring buffer of the
   last 500 published events (no DB, no Redis — see Scope Restrictions).
   `sequence` is monotonically increasing and resets to 1 on a backend
   restart.
2. On reconnect, present the last `eventId` you saw, either via the
   standard `Last-Event-ID` header (what `EventSource` sends automatically)
   or `?lastEventId=bot-482` for non-browser clients.
3. If that id is still in the ring buffer, every event published **after**
   it replays immediately, in order, before live events resume. No gap.
4. If that id is **not** in the ring buffer (evicted by overflow, from a
   previous process lifetime, or simply unrecognized), the server emits one
   `resync_required` event instead of silently resuming from "now":
   ```json
   { "eventType": "resync_required", "payload": { "reason": "replay_unavailable", "requestedLastEventId": "bot-12" } }
   ```
   **On `resync_required`, the bot MUST fetch a fresh snapshot** for every
   slug it cares about before trusting any further live events — it cannot
   assume continuity with what it saw before the gap.
5. A backend restart resets `sequence` to 1. A bot noticing a **lower**
   sequence than its own last-seen value should treat that the same as
   `resync_required` (this is a strong latent signal, not a distinct wire
   event — see Limitations).

### Slow-client protection

If a client's socket buffer stays full for `MAX_CONSECUTIVE_BACKPRESSURE`
(8) consecutive frame writes — heartbeats included — the server evicts that
connection. Combined with the bounded ring buffer and the process-wide
`BOT_API_MAX_SSE_CLIENTS` cap, no single slow or runaway client can grow
backend memory without bound.

---

## Bot contract (non-negotiable)

Bots consuming this API **must**:

1. **Treat events as notifications, not proof of execution.** A `sale` /
   `listing_change` event means "something happened, go look" — never
   "here is confirmed on-chain state you can act on directly."
2. **Fetch/revalidate a snapshot before acting.** Always pull
   `GET /api/internal/bots/v1/collections/:slug/snapshot` immediately
   before building a decision on real capital — never act purely off a
   cached event payload.
3. **Reject stale data.** Check `stale` and `warnings[]` on every snapshot
   response; a `stale: true` snapshot is last-known-good, not current
   truth.
4. **Perform final execution checks locally.** This API returns
   market-data only — no transaction building, no simulation, no signing.
   Any on-chain execution safety check (slippage, balance, pool state at
   send-time, etc.) is entirely the bot's own responsibility.

---

## Versioning rules

- `apiVersion: "1"` is stamped on every envelope (response and event).
- v1 is **additive-only**: existing fields never change type or meaning,
  never get removed. New fields always arrive as optional additions a bot
  can safely ignore.
- A breaking change (field removal, type change, altered semantics) ships
  as a new namespace (`/api/internal/bots/v2`) with its own `apiVersion`,
  never as a silent mutation of v1.

---

## Current limitations

- `dataVersion` is a timestamp, not a content hash — see Freshness
  semantics above.
- The event replay ring buffer is in-memory and process-local: a backend
  restart drops it entirely (`sequence` resets to 1) and a bot must treat
  a lower-than-expected sequence as an implicit resync signal (there is no
  separate wire event for "the process restarted").
- No whale-liquidation detector, no executable per-mint bid feed, and no
  trading-strategy signal of any kind exists behind this API today —
  `signal_reserved` is a typed placeholder only, never emitted. Do not
  build bot logic that assumes future event types will match this shape;
  treat any new `eventType` as a genuine v1-additive change requiring a
  fresh look at this document.
- `recentSales` is capped at 10 rows / 24h for response-size reasons; use
  the existing public `/api/collections/trade-history` route for deeper
  history.
- Single-process only — no Redis fanout, no multi-instance event
  consistency (same limitation the rest of this backend's SSE
  infrastructure already has, see `CLAUDE.md`).

## Next step for connecting `vl-nft-bots`

1. Generate a long random `BOT_API_KEY`, set it in this backend's `.env`,
   restart `nft-backend`.
2. Configure the same key (and, if desired, `BOT_API_ALLOWED_IPS` for the
   bot VPS's egress IP) on the `vl-nft-bots` side.
3. Point `vl-nft-bots` at `https://<this-host>/api/internal/bots/v1` (or
   the internal hostname/IP if the two VPSes share a private network) —
   confirm with infra whether this route should be reachable from the
   public internet at all, or should be firewalled to the bot VPS's IP
   specifically (the IP allowlist here is defense-in-depth, not a
   substitute for network-level restriction).
4. Implement the reconnect/replay/resync flow above exactly — skipping
   `Last-Event-ID` handling is the most likely source of silent gaps in a
   naive bot client.
