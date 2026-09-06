---
description: "Analyze cloud session threads"
---

Load the `cloud-session-threads` skill and follow it. $ARGUMENTS

If a specific session id was given, fetch and analyze that session's thread
(`dump --cloud-agent-session-id` or `export --kilo-session-id`). If the request
is about failures (for example "all sessions failed this morning"), first list
the failed sessions in the window with the `failed` command, then dump the
relevant transcripts and correlate the failure metadata with transcript timing.
Write large transcripts to a file instead of printing them.
