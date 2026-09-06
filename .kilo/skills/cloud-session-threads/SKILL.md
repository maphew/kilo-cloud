---
name: cloud-session-threads
description: Read, fetch, and analyze Cloud Agent session threads (transcripts) in this platform. Use to resolve a cloud_agent_session_id (agent_... / workspace_...) to its kilo session, pull the full transcript from the session-ingest export endpoint, list recently failed cloud agent sessions, or analyze why Cloud Agent sessions failed early. Triggers on "read my session threads", "analyze cloud session", "session failed in first minute", transcript forensics, or cloud agent session debugging.
---

# Cloud Session Threads

Fetch and analyze user-visible Cloud Agent session transcripts and their
control-plane failure metadata.

## Where the data lives

- **Transcript (canonical):** `SessionIngestDO` in the `session-ingest` Worker
  (`services/session-ingest/`), keyed by `kiloUserId/kiloSessionId`. The export
  endpoint returns `{ info, messages: [{ info, parts: [] }] }` — the final
  compacted SDK messages, not streaming deltas.
- **Control-plane metadata (Postgres, `@kilocode/db` schema):**
  - `cloud_agent_sessions` — one row per cloud session: `kilo_session_id`,
    `failure_at`, `failure_stage`, `failure_code`, `failure_responsibility`,
    `failure_reason`, `error_message_redacted`. This table has no message text.
  - `cloud_agent_session_runs` — per-message run status (`queued`/`accepted`/
    `completed`/`failed`/`interrupted`) and the same `failure_*` columns.
  - `cli_sessions_v2` — title, `kilo_user_id`, `organization_id`, git info,
    cost; maps `cloud_agent_session_id` to `session_id` (the kilo session id).

The session-ingest service does the ownership/org-membership authorization on
every export read, so scripts should reuse its HTTP surface instead of reading
Durable Object SQLite directly.

## Access requirements

The fetch script needs these environment values (from the shell, `.env`, or
`.env.local`; never print or commit the secret):

| Variable | Used for |
|---|---|
| `SESSION_INGEST_WORKER_URL` | Base URL of the session-ingest Worker |
| `SESSION_INGEST_INTERNAL_SECRET` | Value of the Worker's `INTERNAL_API_SECRET_PROD` secret, sent as `X-Internal-Secret` |
| `KILO_USER_ID` | Owning user id fallback (also `--kilo-user-id`) |
| `POSTGRES_URL` (or `USE_PRODUCTION_DB=true` + `POSTGRES_URL_PRODUCTION`) | Only for `dump`/`failed`, which read Postgres metadata |

## Script

`scripts/cloud-session-threads.ts` implements three commands:

```
pnpm exec tsx scripts/cloud-session-threads.ts export --kilo-session-id <ses_...> [--kilo-user-id <id>] [--output <file>]
pnpm exec tsx scripts/cloud-session-threads.ts dump --cloud-agent-session-id <agent_...|workspace_...> [--output <file>]
pnpm exec tsx scripts/cloud-session-threads.ts failed [--since <iso>] [--kilo-user-id <id>] [--limit <n>] [--output <file>]
```

Workflow guidance:

1. Start broad with `failed --since <iso>` to find which cloud sessions failed
   (session-level `failure_at`) within the window. `failure_responsibility`
   (`platform`/`user`/`unknown`) and `failure_reason` already classify many
   early failures; a common early-failure shape is session failed before any
   `cloud_agent_session_runs` row reached `completed`.
2. For one session, run `dump --cloud-agent-session-id <id> --output /tmp/<id>.json`
   to combine the control-plane row, run rows, and the full transcript in one
   file. Prefer `--output` over stdout for long transcripts.
3. For kilo sessions already identified by `ses_...` id, use `export`.
4. To attribute failures precisely, correlate `failure_at` / run `failure_*`
   timestamps with transcript timing: preparation/queued state, the first user
   message, whether an assistant reply with parts ever appeared, and any
   `sessionDiff`/tool error text.

## Caveats

- Do not dump transcripts to the chat; write them to a file and read targeted
  sections.
- Session and user ids are not secret, but transcript content and redacted
  error fields can contain sensitive user data; follow the repository security
  baseline and never log the internal secret or tokens.
- `error_message_redacted` expires (`error_expires_at`); old rows may have it
  cleared.
