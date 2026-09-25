# Cloud Agent session load performance

**Date**: 2026-09-25
**Platforms**: web (`apps/web`), Android (`apps/mobile`)
**Scope**: Why reopening an existing Cloud Agent session reloads everything from scratch, flashes the transcript, and does not load an incremental delta. Diagnosis only; the fix design is a separate document.

## Symptom

Opening an existing session takes a long time even when it was viewed a minute ago. The transcript visibly flashes (empty → skeleton/dimmed → full) and the whole thread appears to reload. In long threads the history is static, so only the tail should need fetching, but the entire session is re-processed every visit.

## Summary

The load is a cold load by construction, not a caching accident. Two independent causes multiply:

1. **There is no transcript cache across visits.** The shared SDK clears all state, creates a fresh empty Jotai store, and rebuilds from the network on every open. No cursor or transcript is persisted anywhere (web or mobile).
2. **The first WebSocket connect starts at `fromId=0`.** Even after the newest page is fetched over REST, the Durable Object replays the entire stored event log (plus two materialized reconciliation passes). Every replayed event is re-parsed and re-applied, recomputing the derived message list each time.

The combination means a session viewed seconds ago pays the full cost again, and the replay burst causes the flashing.

## Load sequence on open

For a cloud-agent session, opening it performs a serial waterfall before first paint:

1. `cliSessionsV2.getWithRuntimeState` — PostgreSQL access/metadata read **plus** a synchronous worker `getSession` Durable Object call (`apps/web/src/routers/cli-sessions-v2-router.ts:1497-1652`).
2. `resolveSession` — `activeSessions.list` and/or `cliSessionsV2.get` to determine session type (`apps/web/src/components/cloud-agent-next/CloudAgentProvider.tsx:89-116`; mobile `apps/mobile/src/components/agents/mobile-session-manager.ts:179-208`).
3. `POST /api/cloud-agent-next/sessions/stream-ticket` — auth + DB ownership check + 60 s JWT (`apps/web/src/app/api/cloud-agent-next/sessions/stream-ticket/route.ts:52-125`).
4. `cliSessionsV2.getSessionMessagesPage` — PG access check + a second worker `getSession` call for the event-log watermark + the bounded page read from `SessionIngestDO` (`apps/web/src/routers/cli-sessions-v2-router.ts:1412-1485`). The page read hydrates parts per message, with per-item SQLite reads and R2 reads for oversized items (`services/session-ingest/src/dos/kilo-sdk-materialization.ts`).
5. WebSocket connect to the `cloud-agent-next` DO `/stream`, then event replay.

Only after step 5 produces activity does `isLoading` clear (`packages/cloud-agent-sdk/src/session-manager.ts:1967-1981`).

## Root causes

### 1. No transcript cache across visits

- `switchSession()` unconditionally clears all state and builds a brand-new empty storage, then reloads over the network: `packages/cloud-agent-sdk/src/session-manager.ts:1600-1633` (`clearAllAtoms()` at 1615, `createJotaiStorage(store)` at 1632).
- Web: a fresh store per provider mount, and the transcript uses a **raw tRPC client + Jotai, not React Query** (`apps/web/src/components/cloud-agent-next/CloudAgentProvider.tsx:60-61`). The global 60 s React Query `staleTime` therefore never applies to messages.
- Mobile: the provider is remounted per session id and the manager is destroyed on unmount (`apps/mobile/src/components/agents/session-provider.tsx:24-30,42-45`). The encrypted persisted read-cache explicitly denies transcript pages; only a small allowlist (identity, org list, first session-list page) persists (`apps/mobile/src/lib/persist/read-cache.ts:101-156`).
- No `lastEventId`/`lastMessageId` is persisted in localStorage, AsyncStorage, or SQLite. The only incremental cursor lives in the transport closure and is reset to `0` on each open.

### 2. Full event-log replay on first connect

The initial REST page returns an event-log watermark, but the transport deliberately starts the socket at zero:

```ts
// packages/cloud-agent-sdk/src/cloud-agent-transport.ts:151-159
lastEventId = page.watermarkEventId != null ? 0 : null;
```

The comment documents the reason: `fromId=0` makes the DO replay every stored event, closing the gap when `SessionIngest` materialization lags the event log. The DO then also runs two additional full passes plus preparation snapshots when `reconcileMaterializedEvents` is set (`services/cloud-agent-next/src/websocket/stream.ts:185-208`; flag enabled at `services/cloud-agent-next/src/sandbox-session/SandboxSession.ts:323`). Event retention equals the session TTL (90 days), so the replay is the session's whole lifetime (`services/cloud-agent-next/src/persistence/CloudAgentSession.ts:201-202`).

Result: the newest 50 messages arrive over REST, then the entire session history is re-delivered over the socket and re-applied on top.

### 3. O(messages × parts) recomputation and a render burst

Every replayed event is Zod-parsed (`packages/cloud-agent-sdk/src/normalizer.ts`) and applied one at a time through the chat processor. Each message/part write bumps `partsRevision` and recomputes the full derived message list (`packages/cloud-agent-sdk/src/storage/jotai.ts:44-123`, `packages/cloud-agent-sdk/src/session-manager.ts:793-818`). For a long thread that is roughly quadratic work and a burst of renders.

Web mitigates this with a static/dynamic split and per-group memoization (`apps/web/src/components/cloud-agent-next/CloudChatPage.tsx:204-205`, `ConversationMessages.tsx`). Mobile subscribes to the whole `messagesList` atom at the screen root (`apps/mobile/src/components/agents/session-detail-content.tsx:204`), so the entire screen re-renders on every event.

### 4. The loading gate produces the visible flash

The store is emptied first, so even a previously viewed session always transitions empty → skeleton → full:

- `isLoading` stays true until first replay activity (`packages/cloud-agent-sdk/src/session-manager.ts:1967-1981`).
- Web dims the transcript to `opacity-40` while loading (`apps/web/src/components/cloud-agent-next/CloudChatPage.tsx:918-927,1140`).
- Mobile shows skeleton bubbles until the session metadata matches, then fades in (`apps/mobile/src/components/agents/session-detail-content.tsx:1143-1147,1704-1705,1728`).

### 5. Mobile refetches more aggressively still

- No global `staleTime` (defaults to 0) in the mobile query client (`apps/mobile/src/lib/query-client.ts:221-258`).
- `useRouteForegroundRefresh` invalidates every `cliSessionsV2` query on app foreground **and** on every route re-focus after the first (`apps/mobile/src/lib/hooks/use-route-foreground-refresh.ts:35-59`; wired at `apps/mobile/src/app/(app)/agent-chat/[session-id].tsx:82`).
- A `useFocusEffect` refetches `getWithRuntimeState` on every subsequent focus (`apps/mobile/src/components/agents/session-detail-content.tsx:490-565`).

So staying inside the app and navigating back re-triggers the metadata fetch even when the transcript would otherwise be warm.

## Why "delta since last visit" is not implemented

The desired behavior is correct, but the two pieces it needs do not exist:

1. **No persisted per-session cursor.** Nothing records the last event id or last message id the client has already rendered.
2. **No shared monotonic sequence** between the materialized REST message page and the event log. The REST page is ordered by message id and has no comparable event id, so the client cannot know which events the page already reflects. The watermark (`latestEventId`) is an upper bound, not a "materialized through here" mark.

Because the code cannot compute a safe starting point, it chooses correctness (`fromId=0`, full replay) over speed. The incremental primitives that do exist are in-session only: cursor-based older-page loading (`packages/cloud-agent-sdk/src/session-manager.ts:1475-1555`) and WebSocket reconnect deltas once `lastEventId` has advanced past zero (`packages/cloud-agent-sdk/src/cloud-agent-transport.ts:241-273`).

A real fix needs both (a) a persisted cursor and (b) a comparable high-water mark, or a server endpoint that returns the delta directly.

## Reference table

| Concern | Location |
|---|---|
| State wipe + fresh storage per open | `packages/cloud-agent-sdk/src/session-manager.ts:1600-1633` |
| `fromId=0` replay seed | `packages/cloud-agent-sdk/src/cloud-agent-transport.ts:151-159` |
| WS URL builder | `packages/cloud-agent-sdk/src/cloud-agent-transport.ts:85-99` |
| Reconnect delta / snapshot fallback | `packages/cloud-agent-sdk/src/cloud-agent-transport.ts:241-273` |
| DO replay + reconcile passes | `services/cloud-agent-next/src/websocket/stream.ts:185-208` |
| Reconcile flag enabled | `services/cloud-agent-next/src/sandbox-session/SandboxSession.ts:323` |
| Event-log watermark fetch | `apps/web/src/routers/cli-sessions-v2-router.ts:1417-1436` |
| Bounded page endpoint | `apps/web/src/routers/cli-sessions-v2-router.ts:1412-1485` |
| Page hydration (SQLite/R2 per item) | `services/session-ingest/src/dos/kilo-sdk-materialization.ts` |
| Jotai write/revision mechanics | `packages/cloud-agent-sdk/src/storage/jotai.ts:44-123` |
| Derived list recompute | `packages/cloud-agent-sdk/src/session-manager.ts:793-818` |
| Web store + raw tRPC client | `apps/web/src/components/cloud-agent-next/CloudAgentProvider.tsx:60-61` |
| Mobile provider remount/destroy | `apps/mobile/src/components/agents/session-provider.tsx:24-30,42-45` |
| Mobile persisted allowlist (transcripts denied) | `apps/mobile/src/lib/persist/read-cache.ts:101-156` |
| Mobile foreground/focus invalidation | `apps/mobile/src/lib/hooks/use-route-foreground-refresh.ts:35-59` |
| Loading gate / flash | `apps/web/src/components/cloud-agent-next/CloudChatPage.tsx:918-927,1140`; `apps/mobile/src/components/agents/session-detail-content.tsx:1143-1147` |
