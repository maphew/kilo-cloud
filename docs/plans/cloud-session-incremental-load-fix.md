# Cloud Agent session incremental load — fix design

**Date**: 2026-09-25
**Status**: Proposed
**Related**: [Cloud Agent session load performance](./cloud-session-load-performance.md)
**Platforms**: web (`apps/web`), Android (`apps/mobile`), shared SDK (`packages/cloud-agent-sdk`), `services/cloud-agent-next`

## Goal

Opening an existing session must transfer and apply only what changed since the last time this client saw it. Cost should scale with the delta, not with total transcript length. Re-opening a session viewed a minute ago should be near-instant and must not visibly rebuild static history.

## Precise root cause (beyond "no cache")

The diagnosis doc identified `fromId=0` and missing client state. There is a second, larger contributor on the server:

`CloudAgentSession`'s replay handler runs three passes whenever `reconcileMaterializedEvents` is on (always for cloud-agent sessions, `services/cloud-agent-next/src/sandbox-session/SandboxSession.ts:323`):

1. raw pass — `fromId` filtered (`services/cloud-agent-next/src/websocket/stream.ts:187`).
2. materialized `updates` pass (`stream.ts:191`).
3. materialized `removals` pass (`stream.ts:192`).

The materialized passes deliberately ignore the caller's cursor:

```ts
// services/cloud-agent-next/src/websocket/stream.ts:366
let cursor: EventId | undefined = materialized ? undefined : filters.fromId;
```

So on **every connect**, including every reconnect, the DO scans and re-sends one row per materialized message and part for the entire session, each with `eventId: 0`. The client parses and re-applies all of them (`packages/cloud-agent-sdk/src/cloud-agent-transport.ts:216-238`), recomputing the derived list per write. This is the "everything loads from scratch" behavior, and it scales with transcript size rather than delta.

The repo's own tests encode this behavior: `stream.test.ts:943-997` asserts that `fromId=20` and `replay=false` both still reconcile every materialized update and removal. Bounding them requires `startTime`/`endTime`, which `buildConditions` applies to the materialized passes too (`session/queries/events.ts:117-119`).

An `id`-based cursor cannot fix this on its own, because entity rows keep a stable `id` across updates:

```ts
// services/cloud-agent-next/src/session/queries/events.ts:268-290
.upsert({ ... }).onConflictDoUpdate({ target: events.entity_id, set: { payload, timestamp } })
```

An update to an existing message/part keeps its original `id` and only changes `payload`/`timestamp`. A delta cursor must therefore be based on something that advances on update. The `events.timestamp` column is already updated on upsert and is what retention prunes by (`events.ts` `deleteOlderThan`), so it is a usable change watermark today.

## Fix strategy

Three phases. Phase 1 and 2 are client-only and deliver the user-visible win. Phase 3 makes the materialized delta exact and removes timestamp assumptions.

### Phase 1 — Bound replay with a persisted change watermark (client-only)

Use the existing `startTime` stream filter, which is already parsed and honored for raw and materialized passes (`services/cloud-agent-next/src/websocket/filters.ts:90`, `session/queries/events.ts:117-119`, `buildConditions` in `events.ts:105-136`). `startTime` is inclusive (`gte`).

Client changes in `packages/cloud-agent-sdk/src/cloud-agent-transport.ts`:

1. Track `maxServerTimestamp`: the greatest `timestamp` seen across replayed and live events (both raw and `eventId: 0` materialized events carry a timestamp).
2. Persist `{ lastEventId, maxServerTimestamp }` per session through a new config hook, e.g.:
   ```ts
   getResumeCursor?: (kiloSessionId: KiloSessionId) =>
     | { lastEventId: number; maxServerTimestamp: number }
     | null;
   setResumeCursor?: (
     kiloSessionId: KiloSessionId,
     cursor: { lastEventId: number; maxServerTimestamp: number }
   ) => void;
   clearResumeCursor?: (kiloSessionId: KiloSessionId) => void;
   ```
3. In `buildWebsocketUrl` (`cloud-agent-transport.ts:85-99`), when a cursor exists, also set `startTime` to `Math.max(0, maxServerTimestamp - REPLAY_OVERLAP_MS)` (suggest 60_000). `fromId` already carries the raw cursor.
4. Seed the cursor on first open from `getResumeCursor(sessionId)` instead of the current unconditional `lastEventId = watermark != null ? 0 : null` (`:159`). Fall back to the existing behavior when there is no persisted cursor.
5. Advance and persist the cursor as events are applied, throttled (e.g. coalesced with the existing animation-frame scheduler). Clear it on `/clear` (transcript cleared) and on session deletion.

Effect:

- **Reconnect** (tab visibility, network blip): in-memory `maxServerTimestamp` bounds the materialized passes to entities changed since the last event, instead of the whole transcript. This alone removes a large, currently-hidden cost.
- **Reopen**: the persisted watermark bounds replay to changes since the last visit. For a one-minute gap the replay is tiny.
- **First-ever visit**: unchanged (full replay); it must be, because no cursor exists and the page may lag the event log.

Why this is safe:

- The REST page remains the authoritative transcript for the visible window and is fetched on every open, so pre-cursor static history is not lost by skipping the pre-cursor entity replay.
- Any entity changed while the client was away has `timestamp > maxServerTimestamp`, so it is still delivered.
- The overlap margin absorbs equal-timestamp boundaries and minor ordering skew; re-delivering a few events is idempotent (upserts).
- `startTime` never narrows the set of events delivered relative to what the client still needs, because the cursor is only advanced past events the client has already applied.

Bound: replay cost becomes O(entities changed since last visit), not O(transcript).

### Phase 2 — Hydrate transcript locally to remove the flash (client-side cache)

Phase 1 removes the replay cost but the open still clears state and shows skeleton → page → full. To make it feel instant:

- Persist a versioned per-session transcript snapshot (messages + parts) alongside the cursor.
- On `switchSession`, hydrate the storage from the snapshot before/while the page fetch runs, and clear `isLoading` immediately, then reconcile with the REST page + delta.
- Invalidate when: transcript was cleared (`transcriptClearedAtom`), session deleted/renamed, snapshot schema version changes, or the snapshot is older than a TTL / exceeds a size budget.
- Storage: web uses IndexedDB (localStorage is too small once parts include attachments; the existing `safeLocalStorage` at `apps/web/src/lib/localStorage.ts` is only for small flags). Mobile reuses its encrypted SQLCipher store, extending the allowlist that currently denies transcript pages (`apps/mobile/src/lib/persist/read-cache.ts:101-156`).

This is the phase that delivers "no flashing". It is larger and has privacy/multi-device implications, so it should follow Phase 1.

### Phase 3 — Explicit materialized revision (server-side exactness)

Phase 1 relies on `timestamp`, which is wrapper-supplied (`services/cloud-agent-next/src/websocket/ingest.ts:565-567`) and can be non-monotonic across clock skew or late delivery. To make the delta exact:

1. Add `revision INTEGER` to the `events` table, assigned from a per-DO monotonic counter on every insert **and** every entity upsert. Follow the existing `drizzle/0001_add_entity_id.sql` pattern and register in `drizzle/migrations.js`.
2. Add a `fromRevision` stream filter (exclusive) and apply it to the materialized passes in place of the `timestamp` watermark.
3. Expose `latestRevision` via the session RPC and return it from `getSessionMessagesPage` so a cold client can seed from the page's materialization point once `SessionIngest` can report which revision it has materialized.

This removes the overlap margin and the clock-skew edge cases, and lets a future server-side "materialized through revision N" watermark eliminate even the first-visit full replay.

## Files to touch (Phase 1)

| Change | Location |
|---|---|
| Cursor type + config hooks | `packages/cloud-agent-sdk/src/cloud-agent-transport.ts:46-74`, `packages/cloud-agent-sdk/src/session.ts` (`CloudAgentSessionTransport`), `packages/cloud-agent-sdk/src/session-manager.ts:272-290` |
| Track `maxServerTimestamp`, persist/seed cursor, add `startTime` | `packages/cloud-agent-sdk/src/cloud-agent-transport.ts:83-99,159,203-214,241-273` |
| Resolve/clear persisted cursor on switch/clear/delete | `packages/cloud-agent-sdk/src/session-manager.ts:1600-1633` and the `/clear` path |
| Web persistence (localStorage or IndexedDB) | `apps/web/src/components/cloud-agent-next/CloudAgentProvider.tsx:84-157` |
| Mobile persistence | `apps/mobile/src/components/agents/mobile-session-manager.ts:98-257` |
| Tests | `packages/cloud-agent-sdk/src/cloud-agent-transport.test.ts`, `session-manager.test.ts`; web provider tests |

No server change is required for Phase 1.

## Tests

1. Transport: reconnect with an in-memory watermark sets `startTime = maxSeen - overlap` and keeps `fromId`; first connect with no cursor omits `startTime` and uses `fromId=0` when a watermark exists.
2. Transport: persisted cursor seeds both `fromId` and `startTime`; cursor advances on replayed and live events; `/clear` clears it.
3. Manager: `switchSession` for a session with a persisted cursor does not reset to `fromId=0`.
4. Server integration (`services/cloud-agent-next`): a `/stream` connect with `startTime` replays only materialized entities whose timestamp is at or after the filter, and still replays everything when omitted. Extend `stream.test.ts`, which already covers the reconcile passes.
5. End-to-end: open a long session, leave, reopen after a short gap; assert the number of replayed events is proportional to the gap, not the transcript.

## Risks and open questions

- **Timestamp trust**: Phase 1 trades exactness for a small, bounded risk of a missed backdated entity. The REST page covers the recent visible window, and Phase 3 removes the assumption. If this is unacceptable in the near term, do Phase 3 before Phase 1's reopen persistence and apply Phase 1 only to reconnects (in-memory), where correctness is easier to argue.
- **Storage/cache policy**: Phase 2 needs a decision on retention, size caps, encryption parity with mobile, and behavior when the same account is used on multiple devices.
- **Cleared transcripts**: any persisted cursor must be invalidated together with `transcriptClearedAtom`, or a revisit will hide the cleared history.
- **Session retention**: events are pruned by timestamp and the session TTL is 90 days; a persisted cursor older than the retained window must fall back to a full replay (guard by treating a cursor whose session last-activity is outside retention as absent).
- **Old clients**: Phase 1 is client-only and safe to ship independently; the server already understands `startTime`.

## Recommendation

Ship Phase 1 first. It removes the dominant O(transcript) replay on both reconnect and reopen with no protocol or schema change, and it is independently testable. Add Phase 2 for the remaining flash, then Phase 3 to make the delta exact.
