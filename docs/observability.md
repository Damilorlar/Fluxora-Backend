# Observability Metrics

The application exposes the following Prometheus business metrics at the `/metrics` endpoint.

## Custom Business Metrics

### 1. Stream Creation Rate
- **Metric Name**: `fluxora_streams_created_total`
- **Type**: Counter
- **Labels**:
  - `status`: The initial status of the created stream (e.g., `active`).
- **Meaning**: Total number of treasury streams successfully created.

### 2. Webhook Delivery Throughput
- **Metric Name**: `fluxora_webhook_deliveries_total`
- **Type**: Counter
- **Labels**:
  - `outcome`: The outcome of the webhook dispatch (`success` or `failed`).
- **Meaning**: Total number of webhook delivery attempts.

### 3. Webhook Delivery Duration
- **Metric Name**: `fluxora_webhook_delivery_duration_seconds`
- **Type**: Histogram
- **Buckets**: `[0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`
- **Meaning**: Latency duration of webhook delivery attempts in seconds.

### 4. Indexer Ingestion Throughput
- **Metric Name**: `fluxora_indexer_events_ingested_total`
- **Type**: Counter
- **Labels**: None
- **Meaning**: Total number of contract events successfully ingested and persisted by the indexer.

### 5. Indexer Ingestion Lag
- **Metric Name**: `fluxora_indexer_lag_seconds`
- **Type**: Gauge
- **Labels**: None
- **Meaning**: Ingestion lag of the indexer in seconds, calculated as the difference between current time and the latest ledger event timestamp (`happenedAt`) in the ingested batch.
