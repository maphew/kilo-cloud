#!/usr/bin/env tsx
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { computeDatabaseUrl, createDrizzleClient } from '@kilocode/db';
import { and, desc, eq, gte, isNotNull } from 'drizzle-orm';
import {
  cli_sessions_v2,
  cloud_agent_session_runs,
  cloud_agent_sessions,
} from '@kilocode/db/schema';

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

function requireArg(args: string[], name: string): string {
  const value = getArg(args, name);
  if (!value) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not configured. Set it in your environment or in .env.local/.env.`);
  }
  return value;
}

function isValidKiloSessionId(value: string): boolean {
  return value.startsWith('ses_') && value.length === 30;
}

function requireKiloSessionId(args: string[]): string {
  const value = requireArg(args, '--kilo-session-id');
  if (!isValidKiloSessionId(value)) {
    throw new Error('--kilo-session-id must be a 30-character kilo session id starting with ses_');
  }
  return value;
}

function resolveOwnerId(args: string[]): string {
  return getArg(args, '--kilo-user-id') ?? process.env.KILO_USER_ID ?? '';
}

function requireOwnerId(args: string[]): string {
  const ownerId = resolveOwnerId(args);
  if (!ownerId) {
    throw new Error(
      'Missing owning user id: pass --kilo-user-id or set KILO_USER_ID in the environment.'
    );
  }
  return ownerId;
}

function printUsage(): never {
  console.error(`Usage:
  pnpm exec tsx scripts/cloud-session-threads.ts export --kilo-session-id <ses_...> [--kilo-user-id <id>] [--output <file>]
  pnpm exec tsx scripts/cloud-session-threads.ts dump --cloud-agent-session-id <agent_...|workspace_...> [--output <file>]
  pnpm exec tsx scripts/cloud-session-threads.ts failed [--since <iso>] [--kilo-user-id <id>] [--limit <n>] [--output <file>]

Commands:
  export  Stream the canonical transcript (info + messages with parts) for a kilo session
          from the session-ingest export endpoint. Requires SESSION_INGEST_WORKER_URL and
          SESSION_INGEST_INTERNAL_SECRET; --kilo-user-id or KILO_USER_ID names the owner.

  dump    Resolve a cloud agent session to its kilo session and owner via Postgres, attach the
          control-plane session row and run failures, and stream the transcript. Requires
          POSTGRES_URL (or USE_PRODUCTION_DB=true with POSTGRES_URL_PRODUCTION) plus the same
          export variables as 'export'.

  failed  List failed cloud agent sessions created on/after --since (default: 24h ago) with
          failure classification and their kilo_session_id. Requires Postgres as in 'dump'.

Load the 'cloud-session-threads' skill for the data model and guided usage.`);
  process.exit(1);
}

function createDb() {
  loadEnvFile(resolve(process.cwd(), '.env.local'));
  loadEnvFile(resolve(process.cwd(), '.env'));
  return createDrizzleClient({ connectionString: computeDatabaseUrl(), poolConfig: { max: 1 } });
}

function emitResult(data: unknown, outputPath: string | undefined) {
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  if (outputPath) {
    writeFileSync(resolve(outputPath), serialized);
    console.log(`Wrote ${outputPath}`);
  } else {
    process.stdout.write(serialized);
  }
}

async function fetchSessionExport(
  workerUrl: string,
  internalSecret: string,
  kiloSessionId: string,
  kiloUserId: string
): Promise<unknown | null> {
  const baseUrl = workerUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/internal/session/${encodeURIComponent(kiloSessionId)}/export`;
  const response = await fetch(url, {
    headers: {
      'X-Internal-Secret': internalSecret,
      'X-Kilo-User-Id': kiloUserId,
    },
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Session export failed (${response.status})${body ? `: ${body}` : ''}`);
  }
  return response.json();
}

async function runExport(args: string[]): Promise<void> {
  const kiloSessionId = requireKiloSessionId(args);
  const kiloUserId = requireOwnerId(args);
  const outputPath = getArg(args, '--output');

  const workerUrl = requireEnv('SESSION_INGEST_WORKER_URL');
  const internalSecret = requireEnv('SESSION_INGEST_INTERNAL_SECRET');

  const transcript = await fetchSessionExport(workerUrl, internalSecret, kiloSessionId, kiloUserId);
  if (transcript === null) {
    console.error(`No export found for kilo session ${kiloSessionId}.`);
    process.exitCode = 2;
    return;
  }

  emitResult(transcript, outputPath);
}

async function runDump(args: string[]): Promise<void> {
  const cloudAgentSessionId = requireArg(args, '--cloud-agent-session-id');
  const outputPath = getArg(args, '--output');

  const { db, pool } = createDb();
  try {
    const [cloudSession] = await db
      .select()
      .from(cloud_agent_sessions)
      .where(eq(cloud_agent_sessions.cloud_agent_session_id, cloudAgentSessionId))
      .limit(1);

    if (!cloudSession) {
      console.error(`No cloud agent session row for ${cloudAgentSessionId}.`);
      process.exitCode = 2;
      return;
    }

    const [cliSession] = await db
      .select()
      .from(cli_sessions_v2)
      .where(eq(cli_sessions_v2.cloud_agent_session_id, cloudAgentSessionId))
      .limit(1);

    const runs = await db
      .select()
      .from(cloud_agent_session_runs)
      .where(eq(cloud_agent_session_runs.cloud_agent_session_id, cloudAgentSessionId))
      .orderBy(desc(cloud_agent_session_runs.queued_at));

    const kiloUserId = cliSession?.kilo_user_id || resolveOwnerId(args);
    if (!kiloUserId) {
      throw new Error(
        'Missing owning user id: no cli_sessions_v2 row resolved one; pass --kilo-user-id or set KILO_USER_ID.'
      );
    }

    const transcript = await fetchSessionExport(
      requireEnv('SESSION_INGEST_WORKER_URL'),
      requireEnv('SESSION_INGEST_INTERNAL_SECRET'),
      cloudSession.kilo_session_id,
      kiloUserId
    );
    if (transcript === null) {
      console.error(
        `No export found for kilo session ${cloudSession.kilo_session_id}; emitting metadata only.`
      );
    }

    emitResult(
      {
        cloud_agent_session_id: cloudSession.cloud_agent_session_id,
        kilo_session_id: cloudSession.kilo_session_id,
        kilo_user_id: kiloUserId,
        cloud_agent_session: cloudSession,
        cli_session: cliSession ?? null,
        runs,
        transcript,
      },
      outputPath
    );
  } finally {
    await pool.end();
  }
}

async function runFailed(args: string[]): Promise<void> {
  const outputPath = getArg(args, '--output');
  const sinceValue =
    getArg(args, '--since') ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const since = new Date(sinceValue);
  if (Number.isNaN(since.getTime())) {
    throw new Error(`Invalid --since value: ${sinceValue}`);
  }

  const limitValue = getArg(args, '--limit') ?? '50';
  const limit = Number(limitValue);
  if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
    throw new Error('--limit must be an integer between 1 and 500');
  }

  const kiloUserId = resolveOwnerId(args);

  const { db, pool } = createDb();
  try {
    const conditions = [
      isNotNull(cloud_agent_sessions.failure_at),
      gte(cloud_agent_sessions.failure_at, since.toISOString()),
    ];
    if (kiloUserId) {
      conditions.push(eq(cli_sessions_v2.kilo_user_id, kiloUserId));
    }

    const rows = await db
      .select({
        cloud_agent_session_id: cloud_agent_sessions.cloud_agent_session_id,
        kilo_session_id: cloud_agent_sessions.kilo_session_id,
        kilo_user_id: cli_sessions_v2.kilo_user_id,
        title: cli_sessions_v2.title,
        sandbox_id: cloud_agent_sessions.sandbox_id,
        created_at: cloud_agent_sessions.created_at,
        failure_at: cloud_agent_sessions.failure_at,
        failure_stage: cloud_agent_sessions.failure_stage,
        failure_code: cloud_agent_sessions.failure_code,
        failure_responsibility: cloud_agent_sessions.failure_responsibility,
        failure_reason: cloud_agent_sessions.failure_reason,
        error_message_redacted: cloud_agent_sessions.error_message_redacted,
      })
      .from(cloud_agent_sessions)
      .leftJoin(
        cli_sessions_v2,
        eq(cli_sessions_v2.cloud_agent_session_id, cloud_agent_sessions.cloud_agent_session_id)
      )
      .where(and(...conditions))
      .orderBy(desc(cloud_agent_sessions.failure_at))
      .limit(limit);

    emitResult(rows, outputPath);
  } finally {
    await pool.end();
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') printUsage();

  if (command === 'export') return runExport(args);
  if (command === 'dump') return runDump(args);
  if (command === 'failed') return runFailed(args);

  printUsage();
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
