# WebSocket Stream Subscriptions

Endpoint:

```text
ws://<host>/ws/streams
```

Clients receive stream events only after subscribing. A subscription filter may target one stream or one recipient address. Recipient addresses must be Stellar Ed25519 public keys encoded as SEP-23 StrKeys.

## Subscribe

```json
{ "type": "subscribe", "stream_id": "stream-123" }
```

```json
{ "type": "subscribe", "recipient_address": "GCCFZVJYMLYWVOSZ63KUEAQSHYOYEEHZVNEK2EJBIEWJLDKAE6WFEGT7" }
```

Recipient subscriptions require WebSocket authentication. The JWT `sub` must be the canonical recipient address, and `recipient_address` must match it.

Authenticated clients may subscribe to all events for their own recipient address with an explicit empty filter:

```json
{ "type": "subscribe", "filter": {} }
```

The empty filter resolves to the JWT `sub` value.

## Unsubscribe

Use the same filter shape:

```json
{ "type": "unsubscribe", "stream_id": "stream-123" }
```

```json
{ "type": "unsubscribe", "recipient_address": "GCCFZVJYMLYWVOSZ63KUEAQSHYOYEEHZVNEK2EJBIEWJLDKAE6WFEGT7" }
```

## Handshake Filter

Clients may include an initial subscription filter in the WebSocket URL:

```text
ws://<host>/ws/streams?stream_id=stream-123
ws://<host>/ws/streams?recipient_address=GCCFZVJYMLYWVOSZ63KUEAQSHYOYEEHZVNEK2EJBIEWJLDKAE6WFEGT7
```

## Event Delivery

`StreamHub.broadcast()` delivers an event to clients whose active filters match:

- `stream_id` equals the event `streamId`
- `recipient_address` equals the event `recipientAddress`, `payload.recipient_address`, `payload.recipientAddress`, or `payload.recipient`

If a client has both matching stream and recipient subscriptions, it receives the event once.

## Security Notes

Recipient subscriptions are ownership-sensitive. In deployments where recipient privacy matters, enable `WS_AUTH_REQUIRED=true` and issue JWTs whose `sub` is the canonical Stellar recipient address. The hub validates recipient filters with Stellar StrKey shape, version-byte, and checksum rules before indexing them. The hub does not disclose whether a stream exists when a client subscribes to a stream id; it only indexes the filter for future matching broadcasts.
