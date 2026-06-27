# WebSocket Subscription Protocol — Developer Guide

> **Source references:**
> - [`src/ws/messageHandler.ts`](../src/ws/messageHandler.ts) — message parsing and filter normalisation
> - [`src/ws/hub.ts`](../src/ws/hub.ts) — `StreamHub`: connection lifecycle, auth, broadcast, backpressure, replay
> - [`src/ws/connectionLimiter.ts`](../src/ws/connectionLimiter.ts) — per-IP connection limits and ban logic
> - See also [`docs/websocket.md`](./websocket.md) for a shorter overview and backpressure policy details.

---

## Table of Contents

1. [Protocol overview](#1-protocol-overview)
2. [Connection and upgrade](#2-connection-and-upgrade)
3. [Authentication](#3-authentication)
4. [Handshake-time subscription](#4-handshake-time-subscription)
5. [Client → Server messages](#5-client--server-messages)
   - 5.1 [subscribe](#51-subscribe)
   - 5.2 [unsubscribe](#52-unsubscribe)
   - 5.3 [replay](#53-replay)
6. [Server → Client messages](#6-server--client-messages)
   - 6.1 [stream_update](#61-stream_update)
   - 6.2 [stream_replay](#62-stream_replay)
   - 6.3 [stream_replay_complete](#63-stream_replay_complete)
   - 6.4 [error](#64-error)
7. [Filter reference](#7-filter-reference)
8. [Error codes reference](#8-error-codes-reference)
9. [WebSocket close codes](#9-websocket-close-codes)
10. [Rate limiting and connection limits](#10-rate-limiting-and-connection-limits)
11. [Backpressure policy](#11-backpressure-policy)
12. [Reconnection and catch-up pattern](#12-reconnection-and-catch-up-pattern)
13. [Security notes](#13-security-notes)
14. [OpenAPI / schema cross-reference](#14-openapi--schema-cross-reference)

---

## 1. Protocol overview

Fluxora exposes a WebSocket channel at:

```
ws[s]://<host>/ws/streams
```

All frames are **UTF-8 JSON text**. Binary frames are rejected immediately with an
`error` envelope (code `BINARY_NOT_SUPPORTED`).

The protocol is stateful per connection:

1. **Upgrade** — client sends an HTTP Upgrade request (optionally with a JWT and/or
   query-string filter).
2. **Subscribe** — client sends one or more `subscribe` control frames to opt in to
   specific streams or recipients.
3. **Events** — server pushes `stream_update` frames whenever a matched stream
   changes state.
4. **Replay** (optional) — client sends a `replay` frame to backfill historical
   events from the event store.
5. **Unsubscribe** — client sends `unsubscribe` to stop receiving a specific filter.
6. **Close** — either side closes; the server cleans up all subscriptions.

There is **no heartbeat frame** at the application layer. The `ws` library's
built-in ping/pong mechanism operates at the WebSocket protocol layer and does not
produce JSON frames visible to the application.

---

## 2. Connection and upgrade

```
GET /ws/streams HTTP/1.1
Host: api.example.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: <key>
Sec-WebSocket-Version: 13
Authorization: Bearer <jwt>          # optional – see section 3
X-Correlation-ID: <uuid>             # optional – propagated to logs/traces
```

The server **only** accepts upgrades on the exact path `/ws/streams`. Any other
path is silently ignored and the connection falls back to HTTP.

### Connection limit pre-check

Before the WebSocket handshake is completed, `StreamHub` calls
[`checkLimiter`](../src/ws/connectionLimiter.ts) against the connecting IP address.
If the limit is exceeded or the IP is banned, the socket is **immediately closed**
with close code `4029` — no `101 Switching Protocols` is ever sent.

---

## 3. Authentication

Authentication is **optional by default** and controlled by two environment
variables (see [`src/ws/hub.ts`](../src/ws/hub.ts)):

| Variable | Default | Effect |
|---|---|---|
| `WS_AUTH_REQUIRED` | `false` | When `true`, upgrades without a valid JWT are rejected with `HTTP 401` before the handshake completes. |
| `JWT_SECRET` | _(none)_ | HS256 secret used to verify tokens. Must be set when `WS_AUTH_REQUIRED=true`. |

**Token delivery** (first match wins):

1. `Authorization: Bearer <token>` header on the upgrade request.
2. `?token=<jwt>` query-string parameter.

When `WS_AUTH_REQUIRED=false`, all connections are accepted regardless of whether
a token is present. You can still issue tokens to clients and flip the flag later
for a zero-downtime rollout.

**Authenticated subject (`sub` claim):** The JWT `sub` claim is extracted and stored
per connection. If `sub` is a valid Stellar Ed25519 public key (StrKey, 56
characters, valid CRC16-XModem checksum), the connection is considered an
_authenticated recipient_ and gains access to `recipient_address` subscriptions
(see section 5.1).

### Example: connecting with a JWT

```js
const token = '<your-jwt-placeholder>';
const ws = new WebSocket(
  'wss://api.example.com/ws/streams',
  { headers: { Authorization: `Bearer ${token}` } }
);
```

---

## 4. Handshake-time subscription

A subscription filter can be applied **at connection time** via query-string
parameters, avoiding an extra round-trip:

| Parameter | Alias | Description |
|---|---|---|
| `stream_id` | `streamId` | Subscribe to a single stream by ID. |
| `recipient_address` | `recipientAddress` | Subscribe to events for a Stellar public key. Requires an authenticated subject matching the key (see section 3). |

If neither parameter is supplied, the connection is established without an initial
subscription; the client must send `subscribe` frames after the socket opens.

```
# Subscribe to a specific stream at connect time
wss://api.example.com/ws/streams?stream_id=stream-abc-123

# Subscribe to a recipient's events at connect time (JWT with matching sub required)
wss://api.example.com/ws/streams?recipient_address=GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7
```

> **Implementation note:** `parseHandshakeSubscriptionFilter` in
> [`messageHandler.ts`](../src/ws/messageHandler.ts) parses and validates these
> parameters using the same Zod schemas as post-connection control frames. Invalid
> parameters produce an `error` frame immediately after the socket opens; the
> connection remains open.

---

## 5. Client → Server messages

All client messages must be JSON objects with a `"type"` string field.
Messages exceeding **4,096 bytes** are rejected with `PAYLOAD_TOO_LARGE`.
The client is rate-limited to **30 messages per 10 seconds** per connection.

### 5.1 `subscribe`

Opts the connection into receiving broadcasts that match the given filter.

#### By stream ID

```json
{
  "type": "subscribe",
  "stream_id": "stream-abc-123"
}
```

#### By recipient address (authenticated)

```json
{
  "type": "subscribe",
  "recipient_address": "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"
}
```

#### Using the nested `filter` object

All filter fields can also be nested under a `filter` key. This is useful when
generating messages programmatically:

```json
{
  "type": "subscribe",
  "filter": {
    "stream_id": "stream-abc-123"
  }
}
```

#### Empty filter (authenticated recipient only)

When a `filter: {}` (explicit empty object) is supplied and the connection has an
authenticated Stellar public key subject, the server automatically expands the
filter to `{ recipientAddress: <authenticated-subject> }`:

```json
{
  "type": "subscribe",
  "filter": {}
}
```

#### Alias support

Both snake_case and camelCase variants are accepted interchangeably and produce
the same normalised filter. Conflicting values (e.g. `stream_id: "a"` and
`streamId: "b"`) are rejected as `INVALID_MESSAGE`.

| Canonical field | Accepted aliases |
|---|---|
| `streamId` | `stream_id`, `streamId`, `filter.stream_id`, `filter.streamId` |
| `recipientAddress` | `recipient_address`, `recipientAddress`, `filter.recipient_address`, `filter.recipientAddress` |

#### Validation failures

| Condition | Error code | Error message |
|---|---|---|
| Both `stream_id` and `recipient_address` provided | `INVALID_MESSAGE` | `"subscription filter accepts either stream_id or recipient_address, not both"` |
| `recipient_address` fails StrKey format | `INVALID_MESSAGE` | `"recipient_address must be a valid Stellar public key"` |
| `recipient_address` fails CRC16 checksum | `INVALID_MESSAGE` | `"recipient_address must be a valid Stellar StrKey public key"` |
| No filter field and no explicit `filter` key | `INVALID_MESSAGE` | `"subscribe and unsubscribe messages require stream_id, recipient_address, or an explicit empty filter"` |
| `recipient_address` used without authenticated subject | `UNAUTHORIZED` | `"recipient_address subscriptions require an authenticated Stellar public key subject"` |
| `recipient_address` does not match authenticated subject | `FORBIDDEN` | `"recipient_address subscriptions must match the authenticated subject"` |
| Empty `filter: {}` with non-Stellar authenticated subject | `UNAUTHORIZED` | `"empty subscription filters require an authenticated Stellar public key subject"` |

> **Idempotency:** Re-subscribing to a filter already held by the connection is a
> no-op (the server does not error).

---

### 5.2 `unsubscribe`

Cancels an active subscription. Uses the same filter format and validation rules
as `subscribe`.

```json
{
  "type": "unsubscribe",
  "stream_id": "stream-abc-123"
}
```

```json
{
  "type": "unsubscribe",
  "filter": {
    "recipient_address": "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"
  }
}
```

> **Note:** Attempting to unsubscribe from a filter not currently held is a no-op.

---

### 5.3 `replay`

Requests a replay of historical events from the event store, delivered as a
sequence of `stream_replay` frames followed by a `stream_replay_complete` frame.

```json
{
  "type": "replay",
  "afterEventId": "event-00012345",
  "limit": 200
}
```

All fields are optional:

| Field | Type | Constraint | Description |
|---|---|---|---|
| `afterEventId` | `string` | min 1 char | Exclusive event-ID cursor. Replay begins after this event. |
| `fromLedger` | `integer` | >= 0 | Inclusive ledger number to start replay from. |
| `toledger` | `integer` | >= 0 | Inclusive ledger number to end replay at. _(Note: field uses lowercase `l` to match the original schema in `messageHandler.ts`.)_ |
| `contractId` | `string` | 1–256 chars | Filter events by contract ID. |
| `topic` | `string` | 1–256 chars | Filter events by event topic. |
| `limit` | `integer` | 1–1000 | Maximum events per response page. Default: 100. |

#### Replay with ledger range and contract filter

```json
{
  "type": "replay",
  "fromLedger": 1000000,
  "toledger": 1000500,
  "contractId": "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  "limit": 500
}
```

#### Replay error cases

| Condition | Error code | Notes |
|---|---|---|
| Event store not configured server-side | `REPLAY_UNAVAILABLE` | Server-side configuration issue; reconnect or contact operator. |
| `afterEventId` cursor no longer exists in store | `STALE_CURSOR` | Cursor was pruned; resync from `fromLedger` instead. |

---

## 6. Server → Client messages

All server frames are JSON objects with a `"type"` string field.

### 6.1 `stream_update`

Pushed whenever a subscribed stream broadcasts a new event. Deduplication by
`(streamId, eventId)` is applied server-side; each unique event is delivered at
most once per connection.

```json
{
  "type": "stream_update",
  "streamId": "stream-abc-123",
  "eventId": "event-00067890",
  "payload": {
    "status": "completed",
    "amount": "100.0000000",
    "recipient_address": "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"
  },
  "correlationId": "01924e5a-7b3c-7000-8000-000000000001"
}
```

| Field | Type | Description |
|---|---|---|
| `type` | `"stream_update"` | Discriminant. |
| `streamId` | `string` | ID of the stream that produced this event. |
| `eventId` | `string` | Unique event identifier. Use as an `afterEventId` cursor for replay. |
| `payload` | `object` | Arbitrary event payload as defined by the stream producer. |
| `correlationId` | `string or undefined` | Propagated from the originating request for distributed tracing. |

---

### 6.2 `stream_replay`

Delivered for each historical event matching a `replay` request. Frames are
sent in ledger-ascending order.

```json
{
  "type": "stream_replay",
  "eventId": "event-00012346",
  "ledger": 1000001,
  "topic": "transfer",
  "payload": {
    "amount": "50.0000000",
    "recipient_address": "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"
  },
  "happenedAt": "2025-01-15T10:30:00.000Z"
}
```

| Field | Type | Description |
|---|---|---|
| `type` | `"stream_replay"` | Discriminant. |
| `eventId` | `string` | Unique event identifier. Can be used as the next `afterEventId` cursor. |
| `ledger` | `number` | Ledger sequence number of the event. |
| `topic` | `string or undefined` | Event topic if indexed. |
| `payload` | `unknown` | Event payload as stored by the indexer. |
| `happenedAt` | `string or undefined` | ISO-8601 timestamp when the event was recorded. |

---

### 6.3 `stream_replay_complete`

Sent once after all pages of a `replay` request have been delivered (or when the
cursor reaches the end of the store). The `cursor` field contains the `eventId` of
the last delivered event, or `null` if no events were returned.

```json
{
  "type": "stream_replay_complete",
  "cursor": "event-00012890"
}
```

```json
{
  "type": "stream_replay_complete",
  "cursor": null
}
```

> **Usage pattern:** Store `cursor` and use it as `afterEventId` on the next
> `replay` request to page forward incrementally, or as the starting point after a
> reconnect (see section 12).

---

### 6.4 `error`

Sent in response to an invalid or unauthorised client message. The connection
remains open after an `error` frame.

```json
{
  "type": "error",
  "code": "INVALID_MESSAGE",
  "message": "subscription filter accepts either stream_id or recipient_address, not both"
}
```

| Field | Description |
|---|---|
| `type` | Always `"error"`. |
| `code` | Machine-readable error code (see section 8). |
| `message` | Human-readable description of the problem. |

---

## 7. Filter reference

A subscription filter specifies which broadcasts a connection receives. Exactly
one dimension can be active per subscription slot:

| Dimension | Field | Requires auth? | Description |
|---|---|---|---|
| Stream | `streamId` | No | Matches all events for a specific stream ID. |
| Recipient | `recipientAddress` | Yes — JWT `sub` must equal the key | Matches events whose `recipientAddress` field equals the key. |

A single connection can hold **multiple** active subscriptions (one per unique key:
`stream:<streamId>` or `recipient:<address>`). Each `subscribe` call adds a slot;
each `unsubscribe` call removes exactly one slot.

### Recipient address matching

When a `stream_update` event is broadcast, the hub resolves the `recipientAddress`
dimension by inspecting (in order):

1. The `recipientAddress` top-level field on the `StreamUpdateEvent`.
2. The `recipient_address`, `recipientAddress`, or `recipient` key inside `payload`.

---

## 8. Error codes reference

| Code | Trigger |
|---|---|
| `INVALID_JSON` | Inbound message is not valid JSON. |
| `INVALID_MESSAGE` | Message structure or field values fail Zod validation. |
| `UNKNOWN_TYPE` | `type` field is not `subscribe`, `unsubscribe`, or `replay`. |
| `BINARY_NOT_SUPPORTED` | Client sent a binary WebSocket frame. |
| `PAYLOAD_TOO_LARGE` | Message body exceeds 4,096 bytes. |
| `RATE_LIMIT_EXCEEDED` | Client sent more than 30 messages in any 10-second window. |
| `UNAUTHORIZED` | Operation requires authentication or a valid Stellar public key subject. |
| `FORBIDDEN` | `recipient_address` does not match the authenticated subject. |
| `REPLAY_UNAVAILABLE` | `replay` requested but the event store is not configured on the server. |
| `STALE_CURSOR` | `afterEventId` cursor no longer exists in the event store; resync from `fromLedger`. |

---

## 9. WebSocket close codes

The server uses the following close codes on the **upgrade** path and during
the connection lifetime:

| Code | Reason string | Trigger |
|---|---|---|
| `1000` | _(normal)_ | Client-initiated clean close. |
| `1001` | _(going away)_ | Server graceful shutdown. |
| `1011` | `Internal Error` | Unhandled WebSocket error event on the server. |
| `4000` | `admin-forced-disconnect` | An operator called `hub.disconnectByStreamId()` to force-close all subscribers of a stream. |
| `4029` | `Too many connections` | Per-IP connection limit reached (`WS_MAX_CONNECTIONS_PER_IP`, default 10). |
| `4029` | `IP banned due to abuse` | IP was auto-banned after exceeding the rejection threshold (`WS_ABUSE_THRESHOLD`, default 5 violations in 60 s). |

> **Note on `4029`:** This code is sent via `ws.close()` before the handshake
> completes, meaning the client receives it as part of the upgrade response frame,
> not a normal close frame. Clients should treat any `4029` as a backoff signal.

---

## 10. Rate limiting and connection limits

### Per-connection message rate

Parsed at [`src/ws/hub.ts`](../src/ws/hub.ts):

| Constant | Value | Description |
|---|---|---|
| `RATE_LIMIT_MAX` | 30 | Maximum messages in any sliding window. |
| `RATE_LIMIT_WINDOW_MS` | 10,000 ms | Sliding window duration. |
| `MAX_MESSAGE_BYTES` | 4,096 bytes | Maximum inbound message size. |

Exceeding either limit produces an `error` frame (`RATE_LIMIT_EXCEEDED` or
`PAYLOAD_TOO_LARGE`). The connection is **not** closed.

### Per-IP connection limit

Managed by [`src/ws/connectionLimiter.ts`](../src/ws/connectionLimiter.ts):

| Environment variable | Default | Description |
|---|---|---|
| `WS_MAX_CONNECTIONS_PER_IP` | `10` | Maximum simultaneous connections from one IP. |
| `WS_ABUSE_THRESHOLD` | `5` | Rejections within the abuse window before an IP ban. |
| `WS_BAN_TTL_S` | `3600` | Ban duration in seconds. |
| `WS_TRUSTED_PROXIES` | _(empty)_ | Comma-separated list of trusted proxy IPs for `X-Forwarded-For` resolution. |

Bans are stored in Redis (when available) via the `BanStore` abstraction,
allowing cluster-wide enforcement. When Redis is unavailable, the ban falls back
to in-memory state local to that process.

---

## 11. Backpressure policy

`StreamHub` checks `ws.bufferedAmount` before sending each broadcast:

| Threshold | Constant | Default | Action |
|---|---|---|---|
| Drop | `BACKPRESSURE_DROP_BYTES` | 1 MiB | Frame is dropped for that connection; `droppedMessages` counter incremented. |
| Terminate | `BACKPRESSURE_TERMINATE_BYTES` | 4 MiB | Connection is force-terminated; both `droppedMessages` and `terminatedConnections` incremented. |

A `backpressure` event is emitted on the `StreamHub` instance and a structured
`ws_backpressure` warning is written to the application log. **Payload bodies are
intentionally excluded** from backpressure metadata to prevent accidental leakage.

Recovery: reconnect and use the `replay` API with the last received `eventId` as
`afterEventId` to catch up on dropped events (see section 12).

---

## 12. Reconnection and catch-up pattern

WebSocket connections can be interrupted by network issues, backpressure
terminations, or server restarts. The recommended reconnection pattern:

```js
let lastEventId = null;

async function connect() {
  const ws = new WebSocket('wss://api.example.com/ws/streams', {
    headers: { Authorization: 'Bearer <your-jwt-placeholder>' }
  });

  ws.addEventListener('open', () => {
    // Re-subscribe to desired filters after reconnect.
    ws.send(JSON.stringify({ type: 'subscribe', stream_id: 'stream-abc-123' }));

    // Catch up on any events missed during downtime.
    if (lastEventId !== null) {
      ws.send(JSON.stringify({
        type: 'replay',
        afterEventId: lastEventId,
        limit: 1000
      }));
    }
  });

  ws.addEventListener('message', (evt) => {
    const msg = JSON.parse(evt.data);

    if (msg.type === 'stream_update' || msg.type === 'stream_replay') {
      lastEventId = msg.eventId;
      handleEvent(msg);
    }

    if (msg.type === 'stream_replay_complete') {
      // Replay finished; now in live mode.
      lastEventId = msg.cursor ?? lastEventId;
    }

    if (msg.type === 'error' && msg.code === 'STALE_CURSOR') {
      // Cursor pruned from the event store; fall back to a known ledger.
      ws.send(JSON.stringify({ type: 'replay', fromLedger: knownGoodLedger }));
    }
  });

  ws.addEventListener('close', () => {
    // Apply exponential back-off before reconnecting.
    setTimeout(connect, computeBackoff());
  });
}
```

**Key points:**

- Persist `lastEventId` across reconnects (e.g. in `localStorage` or your
  application state).
- If you receive `STALE_CURSOR`, your cursor has been pruned. Fall back to a
  `fromLedger` value within the retention window.
- Subscription state is **not** automatically restored on reconnect; always
  re-send `subscribe` frames after the socket re-opens.

---

## 13. Security notes

- **Placeholder values only.** All addresses and tokens in this document are
  examples. Never commit real JWT secrets, API keys, or Stellar private keys to
  source control.
- **Binary frames are rejected.** Only UTF-8 JSON text frames are accepted;
  binary frames receive an `error` frame immediately.
- **Message size and rate limits** prevent resource exhaustion on the server.
- **JWT validation** uses HS256. The secret is set via `JWT_SECRET` and must be
  at least 256 bits of random data in production.
- **`recipient_address` isolation.** A client can only subscribe to a
  `recipient_address` that matches its authenticated JWT subject. Cross-recipient
  subscriptions are rejected with `FORBIDDEN`.
- **No payload PII in logs.** Backpressure logs, connection logs, and tracing
  spans deliberately exclude stream payload bodies to prevent accidental PII
  exposure.
- **IP banning.** Abusive IPs that repeatedly exceed connection limits are banned
  automatically and the ban is shared across cluster nodes via Redis.

---

## 14. OpenAPI / schema cross-reference

The Fluxora REST API is described in [`openapi.yaml`](../openapi.yaml). As of this
writing, the WebSocket channel is **not** modelled in the OpenAPI document (OpenAPI
3.0 does not natively support WebSocket). The authoritative schema for all
WebSocket message types is the Zod schemas defined in
[`src/ws/messageHandler.ts`](../src/ws/messageHandler.ts):

| Schema name | Covers |
|---|---|
| `subscriptionMessageSchema` | `subscribe` and `unsubscribe` client frames |
| `subscriptionFilterSchema` | Nested `filter` object within subscription messages |
| `replayMessageSchema` | `replay` client frames |

TypeScript interfaces exported by [`messageHandler.ts`](../src/ws/messageHandler.ts):

| Export | Description |
|---|---|
| `SubscriptionFilter` | Normalised filter `{ streamId?, recipientAddress? }` |
| `WsClientMessage` | Union type of all valid parsed client messages |
| `WsMessageParseResult` | Parse result (ok/error) returned by `parseWsClientMessage` |
| `HandshakeSubscriptionParseResult` | Parse result for URL query-string filters |

TypeScript types exported by [`hub.ts`](../src/ws/hub.ts):

| Export | Description |
|---|---|
| `StreamUpdateEvent` | Internal event shape used by `hub.broadcast()` |
| `StreamHubOptions` | Constructor options for `StreamHub` |
| `BackpressureMetrics` | Counters exposed by `hub.getMetrics()` |
| `StreamHubBackpressureEvent` | Payload of the `"backpressure"` event emitter event |
