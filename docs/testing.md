# Fluxora Integration Testing: Admin Routes

This document provides a concise overview of the integration test suites covering the administrative route surface in `src/routes/admin.ts` and the Dead-Letter Queue (DLQ) surface in `src/routes/dlq.ts`.

## Structure

Admin integration tests are divided into isolated vitest suites under `tests/routes/`:
- `admin.pause.test.ts`: Toggling operational pause flags and read-only status.
- `admin.reindex.test.ts`: Triggering and checking background reindexing.
- `admin.apiKeys.test.ts`: Creating, listing, and revoking API keys.
- `admin.dlq.test.ts`: Standard operator access to the Dead-Letter Queue.

## Authentication Patterns

Administrative and operational endpoints require credentials depending on their mounting context:
1. **General Admin Endpoints (`/api/admin/*`)**:
   Protected by `requireAdminAuth`, verifying that a request's `Authorization: Bearer <ADMIN_API_KEY>` matches `process.env.ADMIN_API_KEY`.
2. **Dead-Letter Queue Endpoints (`/admin/dlq/*`)**:
   Protected by `authenticate`, `requireAuth`, and `requireOperator`, requiring a valid JWT issued to an address with `role: 'operator'`.

## State Isolation & Resets

To ensure deterministic behavior and prevent test-to-test side effects, in-process state is initialized and purged in `beforeEach`/`afterEach` hooks:
- **Pause & Reindex State**: Cleared using `_resetForTest()` from `src/state/adminState.ts`.
- **API Key Records**: Cleared using `_resetApiKeyStoreForTest()` from `src/lib/apiKey.ts`.
- **DLQ Entries**: Cleared using `_resetDlq()` from `src/routes/dlq.ts`.

## Supertest Integration

All endpoints are tested by running requests against the in-process Express application (`app` from `src/app.js`):

```typescript
import request from 'supertest';
import { app } from '../../src/app.js';

const res = await request(app)
  .get('/api/admin/pause')
  .set('Authorization', `Bearer \${process.env.ADMIN_API_KEY}`);
```
