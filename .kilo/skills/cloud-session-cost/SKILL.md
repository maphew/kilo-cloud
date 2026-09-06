---
name: cloud-session-cost
description: Measure the real cost of Cloud Agent loss-and-resume cycles from user-facing session data. Use when someone wants to know how much time, tokens, and inference credits idle-stop sandbox rebuilds have cost them across their cloud sessions, when asked for statistics on loss-and-resume cycles (issue #5901), or when a user suspects every resume after a few minutes idle is a paid re-do. Triggers on "loss-and-resume cost", "idle stop cost", "session rebuild statistics", "cloud session cost analysis".
---

# Cloud session cost and loss-and-resume cycle statistics

Quantify the "loss-and-resume cycle" cost from issue
[Kilo-Org/cloud#5901](https://github.com/Kilo-Org/cloud/issues/5901): the
control-plane idle stop destroys the shared sandbox after ~5 minutes of
inactivity (`DEADLINE_MS.idleStop = 5 * 60_000` in
`services/cloud-agent-next/src/sandbox-control/deadlines.ts`), and the next
message silently rebuilds it. Every resume after an idle gap is therefore a
paid re-do: the agent re-establishes context, re-reads files, re-applies
edits, and re-runs builds before doing any new work.

## Data source: user-facing only

This tool deliberately uses only data a normal Kilo user can reach with their
own account, not the internal Postgres replica. Consequences:

- The authoritative loss marker (`close_reason = 'activity_expired'` on
  `container_usage_interval`) is admin-only and is **not** visible to end
  users. Cycles are instead **inferred** from the transcript.
- Container-time cost (billable seconds × `cloud_billing_sku.rate`) is not
  visible either. What the tool reports is the **inference** cost (dollars and
  tokens) of the redo work plus the **wall-clock** time lost to idle gaps and
  rebuild waits. Container time is a few cents per cycle per the issue, so
  this is the dominant number.

## Inputs

Either:

1. **Exported session files** — for each session of interest run
   `kilo export <session-id> > session.json` (or point the tool at a directory
   of exports with `--dir`). The export carries per-message `cost` and
   `tokens` on assistant messages plus `time.created`/`time.completed`.
2. **Local kilo server** — the Kilo CLI's local HTTP server. List sessions
   with `GET /kilo/cloud-sessions`, fetch one with
   `GET /kilo/cloud/session/{id}`. The tool fetches these for you with
   `--server <base-url> --all` or `--server <base-url> --session <id>`, and
   caches payloads under `--cache <dir>` so re-runs are offline and fast.

## Script

`scripts/loss-resume-stats.mjs` is zero-dependency Node (built-ins only), so
any user can run it without installing the monorepo:

```bash
# One exported session:
node scripts/loss-resume-stats.mjs session.json

# A whole directory of `kilo export` outputs:
node scripts/loss-resume-stats.mjs --dir ~/session-exports

# Everything synced to the local kilo server, cached for re-runs:
node scripts/loss-resume-stats.mjs --server http://127.0.0.1:41245 --all --cache ~/.kilo-session-cache

# Resumable report file: merges per-session results, so repeated runs
# accumulate new sessions without recomputing history:
node scripts/loss-resume-stats.mjs --dir ~/session-exports --out ~/loss-resume-report.json

# Machine-readable output:
node scripts/loss-resume-stats.mjs --dir ~/session-exports --json
```

Run `node scripts/loss-resume-stats.mjs --help` for the full option list.

## How detection works

- Messages are sorted by `time.created` (the transcript is not necessarily in
  order).
- A **loss-and-resume cycle** is recorded when a user message arrives after an
  idle gap ≥ `--idle-min` minutes (default **5**, matching the control-plane
  idle stop) measured from the previous activity (the prior message's
  `completed`, falling back to `created`). The first message of a session is a
  fresh start, never a cycle.
- For each cycle the tool reports:
  - `idleMs` — how long the sandbox sat idle before the user returned.
  - `ttfMs` — time-to-first-token for the resumed work (from the first
    `step-start` part), i.e. the rebuild + rehydration wait.
  - `firstTurn` — cost/tokens/elapsed of the first assistant turn after the
    resume (the immediate re-establishment work).
  - `window` — all assistant turns between this user message and the next one
    (the upper-bound cost of the cycle, including follow-up redo work).
  - Session and grand totals over both bases.

The gap threshold is a heuristic: a user message after ≥5 minutes of silence
almost certainly means the sandbox was destroyed, but there is no
user-visible confirmation of the stop event. Raise `--idle-min` if you want
only unambiguous multi-cycle gaps; lower it if you want to count short
resumes too.

## Idempotency and resumability

- Identical inputs produce byte-identical JSON output (deterministic ordering,
  no timestamps injected into the report).
- `--out` merges per-session results into an existing report by session id,
  recomputing totals; re-running accumulates newly exported sessions.
- `--cache` keeps fetched server payloads on disk; `--refresh` re-fetches.
- `--since <iso>` drops sessions not updated at/after the given time for
  incremental runs.

## Caveats

- Numbers are inference credits and wall-clock time only; container cost is
  not reachable from the user-facing API.
- A user message after a long gap is an inferred rebuild, not a confirmed
  `activity_expired` stop.
- If the model or pricing changes mid-session, per-message costs still come
  from the session payload and remain internally consistent.
- Session and user ids are not secret, but transcripts can contain sensitive
  content; follow the repository security baseline and do not paste raw
  transcripts into chat or issues — quote only the report.
