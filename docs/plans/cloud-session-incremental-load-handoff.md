# Handoff: implement incremental Cloud Agent session loading

**Date**: 2026-09-25
**Base branch**: `perf/cloud-session-incremental-load` (fork `maphew/kilo-cloud`)
**Read first**: [diagnosis](./cloud-session-load-performance.md), [fix design](./cloud-session-incremental-load-fix.md)
**Goal**: re-opening an existing Cloud Agent session must transfer and apply only what changed since this client last saw it, instead of replaying the whole transcript on every connect.

This document is the implementation brief. It defines the interface contract, the workstream split, verification, and the non-obvious gotchas. Read the two linked docs for the root cause and phase rationale.

---

## 0. Prerequisite reading for every agent

- `packages/cloud-agent-sdk/src/cloud-agent-transport.ts` (replay + cursor)
- `packages/cloud-agent-sdk/src/session.ts` / `session-manager.ts` (config threading, `switchSession`)
- `services/cloud-agent-next/src/websocket/stream.ts` (the three replay passes)
- `services/cloud-agent-next/src/session/queries/events.ts` (cursor semantics, entity upsert)
- `services/cloud-agent-next/src/websocket/filters.ts` (`startTime` parsing/matching)
- Repo rules: `AGENTS.md`, `services/cloud-agent-next/AGENTS.md`, `apps/mobile/AGENTS.md`, `apps/web/AGENTS.md`
- Load the `repository-verification` skill before running checks and `code-quality` before editing TS.

Do not commit to `main`. One branch/PR per workstream, each based on `perf/cloud-session-incremental-load`.

---

## 1. Contract (owned by Workstream A, consumed by B/C)

Settle and land these types before B/C start. Put them in the SDK's public surface.

```ts
type SessionResumeCursor = {
  /** Highest persisted raw event id the client has applied. `fromId` is exclusive. */
  lastEventId: number;
  /** Highest server event timestamp (ms) applied across raw AND materialized events. */
  maxServerTimestamp: number;
};

// Added to CloudAgentTransportConfig and threaded through SessionManagerConfig.
getResumeCursor?: (kiloSessionId: KiloSessionId) => SessionResumeCursor | null;
setResumeCursor?: (kiloSessionId: KiloSessionId, cursor: SessionResumeCursor) => void;
clearResumeCursor?: (kiloSessionId: KiloSessionId) => void;
```

`getResumeCursor` may be sync or async; prefer sync to keep `buildWebsocketUrl` synchronous. If async is unavoidable, resolve the cursor before `connectWebsocket` and store it in the closure.

### URL seeding rules

In `buildWebsocketUrl` (`cloud-agent-transport.ts:85-99`):

| Situation | `fromId` | `startTime` |
|---|---|---|
| Persisted cursor exists | `cursor.lastEventId` | `max(0, cursor.maxServerTimestamp - REPLAY_OVERLAP_MS)` |
| No cursor, `watermarkEventId != null` (first visit) | `0` (current behavior) | omit |
| No cursor, no watermark | `replay=false` (current behavior) | omit |

`REPLAY_OVERLAP_MS = 60_000`. Never send `startTime=0` (treat 0/absent as "no bound").

### Cursor advancement rules

- `lastEventId` advances only on wire events with `raw.eventId > 0` (current behavior at `:212-214`). Materialized events use `eventId: 0` and must not advance it.
- `maxServerTimestamp` advances on **every** applied event, raw and materialized, from the event's `timestamp`. Also advance it on live snapshot frames (`preparation`, `connected`, queued/accepted) if they carry timestamps.
- Persist the cursor after applied events, throttled with the existing scheduler; do not persist once per event synchronously.
- `clearResumeCursor` on `/clear` (transcript clear) and on session deletion. Reopening after a clear must not resume.
- Re-read the cursor on `switchSession`; do not reuse the previous session's in-memory cursor.

---

## 2. Workstreams

### Workstream A — SDK delta replay (critical path)

Owner: one agent. Blocks B and C.

Files:
- `packages/cloud-agent-sdk/src/cloud-agent-transport.ts`
- `packages/cloud-agent-sdk/src/session.ts` (`CloudAgentSessionTransport`, `CloudAgentSessionConfig`)
- `packages/cloud-agent-sdk/src/session-manager.ts` (`SessionManagerConfig`, `switchSession`, `/clear` path)
- `packages/cloud-agent-sdk/src/types.ts` if the cursor type belongs there

Deliverables:
1. The contract types and config hooks in §1.
2. `maxServerTimestamp` tracking, seeded from `getResumeCursor`, advanced on all applied events.
3. `startTime` in the URL per §1.
4. Reconnect (`onReconnected`, `:241-273`) also passes `startTime` from the in-memory `maxServerTimestamp`; this bounds reconnects even before persistence exists.
5. Persist/clear calls wired from the manager.
6. Tests in `packages/cloud-agent-sdk/src/cloud-agent-transport.test.ts` and `session-manager.test.ts`:
   - first connect without cursor → `fromId=0`, no `startTime`
   - connect with persisted cursor → both params, correct overlap math
   - materialized `eventId:0` events advance `maxServerTimestamp` but not `lastEventId`
   - reconnect with in-memory timestamp → `startTime` present and `fromId` preserved
   - switch to a session with a cursor does not reset to `fromId=0`
   - `/clear` triggers `clearResumeCursor`

Acceptance: existing transport/manager tests pass unmodified except where they assert the old seeding rule for a persisted cursor.

### Workstream B — Web wiring

Owner: one agent. Depends on A's contract; can start against the sketch if A lands the types first.

Files:
- `apps/web/src/components/cloud-agent-next/CloudAgentProvider.tsx:84-157`
- reuse `apps/web/src/lib/localStorage.ts` for Phase 1 (small key/value). Note Phase 2 (transcript snapshot) needs IndexedDB; do not put message bodies in localStorage.

Deliverables:
1. Implement `getResumeCursor` / `setResumeCursor` / `clearResumeCursor` with a namespaced key, e.g. `cloudAgent.resumeCursor.v1:{userId}:{orgId}:{kiloSessionId}`. Include the version segment.
2. Clear all cursors for a user on logout / identity change.
3. Guard reads with `safeLocalStorage` (SSR, private mode).
4. Test the provider mapping (mock storage) and that a second mount reuses the cursor.

### Workstream C — Mobile wiring

Owner: one agent. Depends on A's contract. Follow `apps/mobile/AGENTS.md` strictly (toast errors, no inline styles, `pnpm` only, no Expo Go).

Files:
- `apps/mobile/src/components/agents/mobile-session-manager.ts:98-257`
- storage: extend the encrypted persist layer (`apps/mobile/src/lib/persist/`) rather than AsyncStorage plaintext for cursor data; Phase 2 transcript caching uses the same store.

Deliverables:
1. Same three hooks, keyed by owner generation/user id/org/session (mirror the provider key at `[session-id].tsx:238-250`).
2. Clear on logout and on session delete.
3. Tests alongside the existing mobile-session-manager tests.

### Workstream D — Server `revision` (Phase 3, can run in parallel, ships later)

Owner: one agent. Independent of A/B/C.

Files:
- `services/cloud-agent-next/src/db/sqlite-schema.ts` (add `revision`)
- new `services/cloud-agent-next/drizzle/0002_add_events_revision.sql` + `drizzle/migrations.js` (follow `0001_add_entity_id.sql`)
- `services/cloud-agent-next/src/session/queries/events.ts` (`insert`/`upsert` assign `revision`; add exclusive `fromRevision` to `buildConditions`; include in `iterateByFilters` and `findByFilters`)
- `services/cloud-agent-next/src/websocket/filters.ts` + `types.ts` (parse `fromRevision`)
- `services/cloud-agent-next/src/websocket/stream.ts` (`replayEvents` materialized passes filter by `fromRevision` when supplied)
- `services/cloud-agent-next/src/persistence/CloudAgentSession.ts` (expose `latestRevision`; optional `getLatestRevision`)
- tests: `services/cloud-agent-next/src/websocket/stream.test.ts` (extend the `fromId`/`replay=false` reconcile test), query tests

Deliverables:
1. Every insert and every entity upsert assigns a strictly increasing `revision` (never reuse the entity row's `id`).
2. `fromRevision` is exclusive; the materialized passes honor it; behavior with no `fromRevision` is unchanged.
3. Migration is additive and idempotent under the Drizzle DO migrator. Load the `durable-objects` skill and read `docs/do-sqlite-drizzle.md`.
4. No behavior change until Phase 1 clients start sending `fromRevision` (additive).

### Workstream E — Phase 2 local hydration (follow-up, not in the first PR set)

Defer until Phase 1 is measured. Scope in the fix design §Phase 2. Needs a storage-policy decision (TTL, size cap, encryption parity, multi-device). Do not start without an explicit decision from the human owner.

---

## 3. Ordering and coordination

1. A lands the contract types + a stub implementation. B and C can then proceed in parallel.
2. B and C ship independently; each is safe alone.
3. D can proceed anytime after A; it is additive and does not require B/C.
4. E is blocked on a human decision.

Coordination protocol: when A changes the contract after B/C started, A posts the exact type diff in the PR description and bumps the doc's contract section. B/C rebase.

---

## 4. Verification

Run focused checks; do not run repo-wide typecheck/lint (size/time limits).

| Package | Commands |
|---|---|
| SDK (`packages/cloud-agent-sdk`) | `pnpm typecheck`, `pnpm test` (jest) |
| Web (`apps/web`) | `pnpm typecheck`, `pnpm test -- <path>`, `pnpm lint` |
| Mobile (`apps/mobile`) | `pnpm typecheck`, `pnpm lint`, `pnpm test`, then `pnpm format && git diff --check` |
| Cloud agent (`services/cloud-agent-next`) | `pnpm typecheck`, `pnpm test`, `pnpm run test:integration`, `pnpm run format:check`, `pnpm run lint` |

Manual/E2E acceptance:
1. Open a long session, let it finish, close it, reopen within ~1 minute. Assert via network logs that the replayed materialized event count is proportional to the gap, not the transcript.
2. Reconnect (background/foreground or network blip) on a long session; assert the reconcile replay is bounded by the in-memory watermark.
3. First-ever visit (no cursor) still loads full history.
4. Clear transcript then reopen; history stays cleared and no cursor is reused.
5. Open the same account in a second browser/device; each device keeps its own cursor and neither loses content.

---

## 5. Gotchas (these caused the original bug)

- `fromId` is **exclusive** (`gt(events.id, fromId)`, `events.ts:108-110`). `startTime` is **inclusive** (`gte(timestamp)`, `:117-119`).
- Materialized reconcile passes ignore `fromId` by design (`stream.ts:366`; proven by `stream.test.ts:943-997`). Only `startTime`/`endTime` bound them. Do not assume `fromId` or `replay=false` narrows them.
- Entity rows keep a stable `id` and update `payload`/`timestamp` on conflict (`events.ts:268-290`). Never treat `lastEventId` as an entity-change cursor.
- Snapshot frames (`preparation`, `connected`, queued/accepted) carry `eventId: 0`; advance `maxServerTimestamp` from them but never `lastEventId`.
- `timestamp` is wrapper-supplied (`websocket/ingest.ts:565-567`), so backdated events are possible. The overlap margin is the Phase 1 mitigation; Phase 3 (revision) removes the assumption. Do not remove the margin before Phase 3 ships.
- Events are pruned by timestamp for the session TTL (`events.ts` `deleteOlderThan`). If a session's last activity is outside retention, ignore any persisted cursor and do a full load.
- Persisted cursors are per user + org + device. Never share across identities, and clear on logout.
- The web chat manages its own Jotai store with a raw tRPC client; do not introduce React Query for transcript state to solve this.
- Do not add comments explaining the change; match existing comment style (explain non-obvious invariants only).

---

## 6. Definition of done

- Phase 1 (A+B+C) merged: reopening and reconnecting transfer a bounded delta, first-visit behavior unchanged, `/clear` and retention are respected, and each platform has tests.
- The fix is measurable in the PR description (before/after replayed event counts for the same reopen scenario).
- Phase 3 (D) merged or scheduled with migration + tests; additive and backward compatible.
- Phase 2 (E) has a written storage-policy decision and a scoped follow-up issue.

## 7. Report back

In each PR, include: workstream, contract version used, commands run with results, the measured delta-bound evidence, and any deviation from this brief. If a rule here is wrong, fix the brief in the same branch and call it out.
