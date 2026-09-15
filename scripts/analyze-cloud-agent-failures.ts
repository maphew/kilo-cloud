#!/usr/bin/env tsx
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { computeDatabaseUrl, createDrizzleClient } from '@kilocode/db';

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    const value = rawValue.replace(/^['"]|['"]$/g, '');
    process.env[key] = value;
  }
}

function getArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function numberArg(args: string[], name: string, fallback: number): number {
  const raw = getArg(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid value for ${name}: ${raw}`);
  }
  return value;
}

function printUsage(): never {
  console.error(`Usage:
  pnpm exec tsx scripts/analyze-cloud-agent-failures.ts analyze [options]

Options:
  --days <n>            Lookback window in days (default: 30, max: 90)
  --responsibility <r>  Filter failures: all | platform | user | unknown (default: all)
  --code <code>         Filter to one failure code (e.g. wrapper_ping_timeout)
  --csv <path>          Write per-failure tech-support export as CSV
  --json <path>         Write per-failure tech-support export as JSON
  --limit <n>           Max rows in the export (default: 1000)
  --include-email       Include user email in the export (PII: keep internal)

Requires POSTGRES_URL (or POSTGRES_URL_PRODUCTION with USE_PRODUCTION_DB=true)
in the environment or .env.local/.env at the repository root.
`);
  process.exit(1);
}

const GENERIC_FAILURE_MESSAGES: Record<string, string> = {
  sandbox_connect_failed: 'Could not connect to the sandbox',
  workspace_setup_failed: 'Workspace setup failed',
  kilo_server_failed: 'Kilo server failed to start',
  wrapper_start_failed: 'Agent wrapper failed to start',
  invalid_delivery_request: 'The message could not be delivered',
  session_metadata_missing: 'Session metadata is unavailable',
  model_missing: 'No model was selected',
  delivery_failure_unknown: 'The message could not be delivered',
  wrapper_disconnected: 'Agent wrapper disconnected',
  wrapper_no_output: 'Agent wrapper made no execution progress during the watchdog window',
  wrapper_ping_timeout: 'Agent wrapper stopped responding',
  wrapper_error_before_activity: 'Agent wrapper failed before processing the message',
  assistant_error: 'Assistant request failed',
  wrapper_error_after_activity: 'Agent wrapper failed while processing the message',
  missing_assistant_reply: 'No assistant reply was produced',
  payment_required: 'Assistant request failed: insufficient credits',
  user_interrupt: 'The message was interrupted by the user',
  container_shutdown: 'The agent container shut down',
  system_interrupt: 'The message was interrupted',
  unclassified: 'The message failed',
};

const WORKSPACE_FAILURE_MESSAGES: Record<string, string> = {
  git_clone_timeout: 'Repository clone timed out',
  git_checkout_timeout: 'Repository checkout timed out',
  git_authentication_failed: 'Repository authentication failed',
  git_rate_limited: 'Repository request was rate limited',
  git_network_failed: 'Repository network request failed',
  git_pack_corrupt: 'Repository data is corrupt',
  git_checkout_conflict: 'Repository checkout conflict',
  git_branch_missing: 'Requested repository branch was not found',
  sandbox_storage_full: 'Workspace setup failed: sandbox storage full',
  kilo_import_timeout: 'Session import timed out',
  kilo_import_failed: 'Session import failed',
  setup_command_timeout: 'Setup command timed out',
  setup_command_failed: 'Setup command failed',
  workspace_setup_unknown: 'Workspace setup failed',
};

const SESSION_FAILURE_MESSAGES: Record<string, string> = {
  sandbox_id_derivation_failed: 'Could not create the session (sandbox identity)',
  do_registration_rejected: 'Could not create the session (registration rejected)',
  initial_admission_rejected: 'Environment preparation failed (admission rejected)',
  initial_queue_full: 'Environment preparation failed (queue full)',
  invalid_initial_intent: 'Environment preparation failed (invalid initial request)',
  do_rpc_outcome_unknown: 'Session creation outcome is unknown (transport failure)',
};

const RESPONSIBILITIES = ['all', 'platform', 'user', 'unknown'] as const;
type ResponsibilityFilter = (typeof RESPONSIBILITIES)[number];

type SummaryRow = {
  completed: string;
  failed: string;
  interrupted: string;
  platform_failures: string;
  user_failures: string;
  unknown_failures: string;
};

type BreakdownRow = {
  source: string;
  stage: string;
  code: string;
  responsibility: string;
  reason: string;
  count: string;
  affected_sessions: string;
  known_sandboxes: string;
  sessions_without_sandbox: string;
};

type TrendRow = {
  day: string;
  completed: string;
  failed: string;
  platform_failures: string;
  setup_failures: string;
};

type RepeatRow = {
  cloud_agent_session_id: string;
  kilo_session_id: string;
  kilo_user_id: string | null;
  failed_runs: string;
  distinct_codes: string;
  codes: string;
  first_failure_at: string | null;
  last_failure_at: string | null;
};

type LatencyRow = {
  failure_code: string;
  failures: string;
  no_activity_share: string;
  queued_to_terminal_p50_s: string | null;
  queued_to_terminal_p90_s: string | null;
  accepted_to_activity_p50_s: string | null;
};

type ExportDbRow = {
  source: string;
  terminal_at: string | Date | null;
  cloud_agent_session_id: string;
  kilo_session_id: string | null;
  sandbox_id: string | null;
  message_id: string | null;
  wrapper_run_id: string | null;
  status: string | null;
  failure_stage: string | null;
  failure_code: string | null;
  failure_responsibility: string | null;
  failure_reason: string | null;
  diagnostic: string | null;
  queued_at: string | Date | null;
  dispatch_accepted_at: string | Date | null;
  agent_activity_observed_at: string | Date | null;
  seconds_to_failure: string | number | null;
  kilo_user_id: string | null;
  organization_id: string | null;
  session_title: string | null;
  git_url: string | null;
  user_email: string | null;
};

type ExportRow = {
  source: 'run' | 'setup';
  occurred_at: string | null;
  cloud_agent_session_id: string;
  kilo_session_id: string | null;
  sandbox_id: string | null;
  message_id: string | null;
  wrapper_run_id: string | null;
  status: string | null;
  failure_stage: string | null;
  failure_code: string | null;
  failure_responsibility: string | null;
  failure_reason: string | null;
  user_visible_error: string | null;
  diagnostic: string | null;
  queued_at: string | null;
  dispatch_accepted_at: string | null;
  agent_activity_observed_at: string | null;
  seconds_to_failure: number | null;
  kilo_user_id: string | null;
  organization_id: string | null;
  session_title: string | null;
  git_url: string | null;
  user_email: string | null;
};

function userVisibleError(code: string | null, stage: string | null): string | null {
  if (!code) return null;
  if (stage === 'setup' || SESSION_FAILURE_MESSAGES[code]) {
    return SESSION_FAILURE_MESSAGES[code] ?? 'Environment preparation failed';
  }
  return GENERIC_FAILURE_MESSAGES[code] ?? 'The message failed';
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function writeCsv(path: string, rows: ExportRow[]): void {
  const headers: (keyof ExportRow)[] = [
    'source',
    'occurred_at',
    'cloud_agent_session_id',
    'kilo_session_id',
    'sandbox_id',
    'message_id',
    'wrapper_run_id',
    'status',
    'failure_stage',
    'failure_code',
    'failure_responsibility',
    'failure_reason',
    'user_visible_error',
    'diagnostic',
    'queued_at',
    'dispatch_accepted_at',
    'agent_activity_observed_at',
    'seconds_to_failure',
    'kilo_user_id',
    'organization_id',
    'session_title',
    'git_url',
    'user_email',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map(header => csvEscape(row[header])).join(','));
  }
  writeFileSync(path, `${lines.join('\n')}\n`);
}

function seconds(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(Number(value).toFixed(1));
}

function isoOrNull(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command !== 'analyze') {
    printUsage();
  }

  loadEnvFile(resolve(process.cwd(), '.env.local'));
  loadEnvFile(resolve(process.cwd(), '.env'));

  const days = Math.min(numberArg(args, '--days', 30), 90);
  const responsibilityArg = (getArg(args, '--responsibility') ?? 'all') as ResponsibilityFilter;
  if (!RESPONSIBILITIES.includes(responsibilityArg)) {
    throw new Error(`Invalid --responsibility: ${responsibilityArg}`);
  }
  const codeFilter = getArg(args, '--code');
  const csvPath = getArg(args, '--csv');
  const jsonPath = getArg(args, '--json');
  const exportLimit = numberArg(args, '--limit', 1000);
  const includeEmail = hasFlag(args, '--include-email');

  const { pool } = createDrizzleClient({
    connectionString: computeDatabaseUrl(),
    poolConfig: { max: 1, connectionTimeoutMillis: 10_000 },
  });

  try {
    const summary = await pool.query<SummaryRow>(
      `SELECT
        COUNT(*) FILTER (WHERE r.status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE r.status = 'failed') AS failed,
        COUNT(*) FILTER (WHERE r.status = 'interrupted') AS interrupted,
        COUNT(*) FILTER (WHERE r.status = 'failed' AND COALESCE(r.failure_responsibility, 'unknown') = 'platform') AS platform_failures,
        COUNT(*) FILTER (WHERE r.status = 'failed' AND COALESCE(r.failure_responsibility, 'unknown') = 'user') AS user_failures,
        COUNT(*) FILTER (WHERE r.status = 'failed' AND COALESCE(r.failure_responsibility, 'unknown') = 'unknown') AS unknown_failures
      FROM cloud_agent_session_runs r
      JOIN cloud_agent_sessions s ON s.cloud_agent_session_id = r.cloud_agent_session_id
      WHERE r.terminal_at >= now() - ($1 || ' days')::interval
        AND r.terminal_at < now()
        AND s.created_at > now() - interval '90 days'
        ${codeFilter ? 'AND r.failure_code = $2' : ''}`,
      codeFilter
        ? responsibilityArg === 'all'
          ? [codeFilter]
          : [responsibilityArg, codeFilter]
        : responsibilityArg === 'all'
          ? []
          : [responsibilityArg]
    );

    const summaryRow = summary.rows[0];
    if (!summaryRow) {
      console.log('No runs found in the window.');
      return;
    }
    const completed = Number(summaryRow.completed);
    const failed = Number(summaryRow.failed);
    const interrupted = Number(summaryRow.interrupted);
    const platformFailures = Number(summaryRow.platform_failures);
    const userFailures = Number(summaryRow.user_failures);
    const unknownFailures = Number(summaryRow.unknown_failures);
    const terminalRuns = completed + failed + interrupted;

    console.log(`\n=== Cloud agent failure analysis: last ${days} days ===`);
    console.log(`Window: ${new Date(Date.now() - days * 86_400_000).toISOString()} .. now (UTC)`);
    console.log(
      `Runs: ${terminalRuns} terminal (${completed} completed, ${failed} failed, ${interrupted} interrupted)`
    );
    const rate = (numerator: number) =>
      completed + numerator === 0 ? 'n/a' : `${((numerator / completed) * 100).toFixed(2)}%`;
    console.log(
      `Failure rate (failed/completed): ${rate(failed)}; platform-only: ${rate(platformFailures)}`
    );
    console.log(
      `Failures by responsibility: platform=${platformFailures} user=${userFailures} unknown=${unknownFailures}`
    );

    const setupSummary = await pool.query<{ setup_failures: string }>(
      `SELECT COUNT(*) AS setup_failures
      FROM cloud_agent_sessions s
      WHERE s.failure_at >= now() - ($1 || ' days')::interval
        AND s.failure_at < now()
        AND s.created_at > now() - interval '90 days'`,
      [days]
    );
    console.log(
      `Session-level (setup) failures: ${Number(setupSummary.rows[0]?.setup_failures ?? 0)}\n`
    );

    const breakdown = await pool.query<BreakdownRow>(
      `SELECT source, stage, code, responsibility, reason, count, affected_sessions, known_sandboxes, sessions_without_sandbox FROM (
        SELECT
          'setup' AS source,
          COALESCE(s.failure_stage, 'unclassified') AS stage,
          COALESCE(s.failure_code, 'unclassified') AS code,
          COALESCE(s.failure_responsibility, 'unknown') AS responsibility,
          COALESCE(s.failure_reason, 'unclassified') AS reason,
          COUNT(*) AS count,
          COUNT(*) AS affected_sessions,
          COUNT(DISTINCT s.sandbox_id) AS known_sandboxes,
          COUNT(*) FILTER (WHERE s.sandbox_id IS NULL) AS sessions_without_sandbox
        FROM cloud_agent_sessions s
        WHERE s.failure_at >= now() - ($1 || ' days')::interval
          AND s.failure_at < now()
          AND s.created_at > now() - interval '90 days'
          ${responsibilityArg === 'all' ? '' : 'AND COALESCE(s.failure_responsibility, \'unknown\') = $2'}
        GROUP BY 1, 2, 3, 4, 5
        UNION ALL
        SELECT
          'run' AS source,
          COALESCE(r.failure_stage, 'unknown') AS stage,
          COALESCE(r.failure_code, 'unclassified') AS code,
          COALESCE(r.failure_responsibility, 'unknown') AS responsibility,
          COALESCE(r.failure_reason, 'unclassified') AS reason,
          COUNT(*) AS count,
          COUNT(DISTINCT r.cloud_agent_session_id) AS affected_sessions,
          COUNT(DISTINCT s.sandbox_id) AS known_sandboxes,
          COUNT(DISTINCT r.cloud_agent_session_id) FILTER (WHERE s.sandbox_id IS NULL) AS sessions_without_sandbox
        FROM cloud_agent_session_runs r
        JOIN cloud_agent_sessions s ON s.cloud_agent_session_id = r.cloud_agent_session_id
        WHERE r.status = 'failed'
          AND r.terminal_at >= now() - ($1 || ' days')::interval
          AND r.terminal_at < now()
          AND s.created_at > now() - interval '90 days'
          ${responsibilityArg === 'all' ? '' : 'AND COALESCE(r.failure_responsibility, \'unknown\') = $2'}
        GROUP BY 1, 2, 3, 4, 5
      ) breakdown
      ORDER BY count DESC, source, stage, code`,
      responsibilityArg === 'all' ? [days] : [days, responsibilityArg]
    );

    console.log('--- Failure breakdown (top 15) ---');
    console.log(
      'source | stage | code | responsibility | reason | count | sessions | no-sandbox | user-visible error'
    );
    for (const row of breakdown.rows.slice(0, 15)) {
      console.log(
        [
          row.source,
          row.stage,
          row.code,
          row.responsibility,
          row.reason,
          Number(row.count),
          Number(row.affected_sessions),
          Number(row.sessions_without_sandbox),
          userVisibleError(row.code, row.source === 'setup' ? 'setup' : row.stage),
        ].join(' | ')
      );
    }

    const trend = await pool.query<TrendRow>(
      `WITH run_trend AS (
        SELECT date_trunc('day', r.terminal_at) AS day,
          COUNT(*) FILTER (WHERE r.status = 'completed') AS completed,
          COUNT(*) FILTER (WHERE r.status = 'failed') AS failed,
          COUNT(*) FILTER (WHERE r.status = 'failed' AND COALESCE(r.failure_responsibility, 'unknown') = 'platform') AS platform_failures
        FROM cloud_agent_session_runs r
        JOIN cloud_agent_sessions s ON s.cloud_agent_session_id = r.cloud_agent_session_id
        WHERE r.terminal_at >= now() - ($1 || ' days')::interval
          AND r.terminal_at < now()
          AND s.created_at > now() - interval '90 days'
        GROUP BY 1
      ), setup_trend AS (
        SELECT date_trunc('day', s.failure_at) AS day, COUNT(*) AS setup_failures
        FROM cloud_agent_sessions s
        WHERE s.failure_at >= now() - ($1 || ' days')::interval
          AND s.failure_at < now()
          AND s.created_at > now() - interval '90 days'
        GROUP BY 1
      )
      SELECT COALESCE(run_trend.day, setup_trend.day)::date::text AS day,
        COALESCE(run_trend.completed, 0) AS completed,
        COALESCE(run_trend.failed, 0) AS failed,
        COALESCE(run_trend.platform_failures, 0) AS platform_failures,
        COALESCE(setup_trend.setup_failures, 0) AS setup_failures
      FROM run_trend
      FULL OUTER JOIN setup_trend USING (day)
      ORDER BY day`,
      [days]
    );

    console.log('\n--- Daily trend (UTC) ---');
    console.log('day | completed | failed | platform-failed | setup-failed');
    let avg = 0;
    for (const row of trend.rows) {
      avg += Number(row.failed) + Number(row.setup_failures);
      console.log(
        `${row.day} | ${Number(row.completed)} | ${Number(row.failed)} | ${Number(row.platform_failures)} | ${Number(row.setup_failures)}`
      );
    }
    if (trend.rows.length > 0) {
      console.log(
        `Daily failure average: ${(avg / trend.rows.length).toFixed(1)}; worst day: ${trend.rows.reduce((worst, row) => (Number(row.failed) + Number(row.setup_failures) > Number(worst.failed) + Number(worst.setup_failures) ? row : worst)).day}\n`
      );
    }

    const repeats = await pool.query<RepeatRow>(
      `SELECT
        r.cloud_agent_session_id,
        MAX(s.kilo_session_id) AS kilo_session_id,
        MAX(c.kilo_user_id) AS kilo_user_id,
        COUNT(*) AS failed_runs,
        COUNT(DISTINCT r.failure_code) AS distinct_codes,
        string_agg(DISTINCT COALESCE(r.failure_code, 'unclassified'), ', ' ORDER BY COALESCE(r.failure_code, 'unclassified')) AS codes,
        MIN(r.terminal_at)::text AS first_failure_at,
        MAX(r.terminal_at)::text AS last_failure_at
      FROM cloud_agent_session_runs r
      JOIN cloud_agent_sessions s ON s.cloud_agent_session_id = r.cloud_agent_session_id
      LEFT JOIN cli_sessions_v2 c ON c.cloud_agent_session_id = s.cloud_agent_session_id
      WHERE r.status = 'failed'
        AND r.terminal_at >= now() - ($1 || ' days')::interval
        AND r.terminal_at < now()
        AND s.created_at > now() - interval '90 days'
      GROUP BY r.cloud_agent_session_id
      HAVING COUNT(*) >= 2
      ORDER BY failed_runs DESC
      LIMIT 20`,
      [days]
    );

    console.log('--- Sessions with 2+ failed runs (top 20) ---');
    for (const row of repeats.rows) {
      console.log(
        [
          Number(row.failed_runs),
          row.cloud_agent_session_id,
          row.kilo_user_id ?? 'no-user-link',
          row.codes,
          row.first_failure_at?.slice(0, 16),
          row.last_failure_at?.slice(0, 16),
        ].join(' | ')
      );
    }
    if (repeats.rows.length === 0) {
      console.log('(none)');
    }

    const latency = await pool.query<LatencyRow>(
      `SELECT
        COALESCE(r.failure_code, 'unclassified') AS failure_code,
        COUNT(*) AS failures,
        ROUND(COUNT(*) FILTER (WHERE r.agent_activity_observed_at IS NULL) * 100.0 / COUNT(*), 1) AS no_activity_share,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM r.terminal_at - r.queued_at)) AS queued_to_terminal_p50_s,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM r.terminal_at - r.queued_at)) AS queued_to_terminal_p90_s,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM r.agent_activity_observed_at - r.dispatch_accepted_at)) FILTER (WHERE r.agent_activity_observed_at IS NOT NULL AND r.dispatch_accepted_at IS NOT NULL) AS accepted_to_activity_p50_s
      FROM cloud_agent_session_runs r
      JOIN cloud_agent_sessions s ON s.cloud_agent_session_id = r.cloud_agent_session_id
      WHERE r.status = 'failed'
        AND r.terminal_at >= now() - ($1 || ' days')::interval
        AND r.terminal_at < now()
        AND s.created_at > now() - interval '90 days'
      GROUP BY 1
      ORDER BY COUNT(*) DESC`,
      [days]
    );

    console.log('\n--- Per-code latency pattern ---');
    console.log('code | failures | fail-before-activity % | queued→terminal p50/p90 s');
    for (const row of latency.rows) {
      console.log(
        [
          row.failure_code,
          Number(row.failures),
          row.no_activity_share,
          `${seconds(row.queued_to_terminal_p50_s) ?? 'n/a'} / ${seconds(row.queued_to_terminal_p90_s) ?? 'n/a'}`,
        ].join(' | ')
      );
    }

    if (csvPath || jsonPath) {
      const exportResult = await pool.query<ExportDbRow>(
        `SELECT
          'run' AS source,
          r.terminal_at,
          s.cloud_agent_session_id,
          s.kilo_session_id,
          s.sandbox_id,
          r.message_id,
          r.wrapper_run_id,
          r.status,
          r.failure_stage,
          r.failure_code,
          r.failure_responsibility,
          r.failure_reason,
          CASE WHEN r.error_expires_at > now() THEN r.error_message_redacted ELSE NULL END AS diagnostic,
          r.queued_at,
          r.dispatch_accepted_at,
          r.agent_activity_observed_at,
          EXTRACT(EPOCH FROM r.terminal_at - r.queued_at) AS seconds_to_failure,
          c.kilo_user_id,
          c.organization_id,
          c.title AS session_title,
          c.git_url,
          ${includeEmail ? 'u.google_user_email AS user_email' : 'NULL AS user_email'}
        FROM cloud_agent_session_runs r
        JOIN cloud_agent_sessions s ON s.cloud_agent_session_id = r.cloud_agent_session_id
        LEFT JOIN cli_sessions_v2 c ON c.cloud_agent_session_id = s.cloud_agent_session_id
        LEFT JOIN kilocode_users u ON u.id = c.kilo_user_id
        WHERE r.status = 'failed'
          AND r.terminal_at >= now() - ($1 || ' days')::interval
          AND r.terminal_at < now()
          AND s.created_at > now() - interval '90 days'
        ORDER BY r.terminal_at DESC
        LIMIT $2`,
        [days, exportLimit]
      );

      const rows: ExportRow[] = exportResult.rows.map(row => ({
        source: row.source === 'setup' ? 'setup' : 'run',
        occurred_at: isoOrNull(row.terminal_at),
        cloud_agent_session_id: row.cloud_agent_session_id,
        kilo_session_id: row.kilo_session_id,
        sandbox_id: row.sandbox_id,
        message_id: row.message_id,
        wrapper_run_id: row.wrapper_run_id,
        status: row.status,
        failure_stage: row.failure_stage,
        failure_code: row.failure_code,
        failure_responsibility: row.failure_responsibility,
        failure_reason: row.failure_reason,
        user_visible_error: userVisibleError(row.failure_code, 'run'),
        diagnostic: row.diagnostic,
        queued_at: isoOrNull(row.queued_at),
        dispatch_accepted_at: isoOrNull(row.dispatch_accepted_at),
        agent_activity_observed_at: isoOrNull(row.agent_activity_observed_at),
        seconds_to_failure: seconds(row.seconds_to_failure),
        kilo_user_id: row.kilo_user_id,
        organization_id: row.organization_id,
        session_title: row.session_title,
        git_url: row.git_url,
        user_email: row.user_email,
      }));

      if (csvPath) {
        writeCsv(resolve(process.cwd(), csvPath), rows);
        console.log(`\nWrote ${rows.length} failed runs to ${csvPath}`);
      }
      if (jsonPath) {
        writeFileSync(resolve(process.cwd(), jsonPath), `${JSON.stringify(rows, null, 2)}\n`);
        console.log(`Wrote ${rows.length} failed runs to ${jsonPath}`);
      }
      console.log(
        `Include this in the support ticket: session IDs (cloud_agent_session_id), kilo_session_id, user IDs, timestamps, and failure codes above. Diagnostics expire per error_expires_at; run promptly after failures.`
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error('Cloud agent failure analysis failed.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
