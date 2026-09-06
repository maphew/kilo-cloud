#!/usr/bin/env node
// Measure the real cost of Cloud Agent "loss-and-resume" cycles from data a
// normal Kilo user can reach with their own account: session exports produced
// by `kilo export <id>` or the raw session payload served by the local kilo
// server (`/kilo/cloud/session/{id}`).
//
// A loss-and-resume cycle is the control-plane idle stop destroying the shared
// sandbox after ~5 minutes of inactivity and silently rebuilding it on the next
// message. End users cannot see the authoritative marker (`close_reason =
// 'activity_expired'` on `container_usage_interval`); that column is
// internal/admin-only. So this tool infers cycles from the transcript: a user
// message that arrives after the idle-stop threshold following the previous
// activity means the sandbox was torn down and the agent had to re-establish
// itself before doing any new work.
//
// Idempotent: identical inputs produce byte-identical output. Resumable: `--out`
// merges per-session results into an existing report file, and `--cache`
// skips re-fetching sessions already on disk.
//
// Zero dependencies: only Node built-ins, runnable as `node loss-resume-stats.mjs`.

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

export const DEFAULT_IDLE_MS = 5 * 60 * 1000;
export const REPORT_VERSION = 1;

export function toMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) {
      const n = Number(value);
      return n > 1e12 ? n : n * 1000;
    }
    const n = Date.parse(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function finiteNum(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function roundDollars(value) {
  return Math.round(value * 1e6) / 1e6;
}

function sumTokens(messages) {
  const total = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  for (const m of messages) {
    total.input += m.tokens.input;
    total.output += m.tokens.output;
    total.reasoning += m.tokens.reasoning;
    total.cacheRead += m.tokens.cacheRead;
    total.cacheWrite += m.tokens.cacheWrite;
  }
  return total;
}

function firstStepStart(messages) {
  for (const m of messages) {
    for (const part of m.parts) {
      if (part?.type !== 'step-start') continue;
      const start = toMs(part.time?.start);
      if (start != null) return start;
    }
  }
  return null;
}

function modelList(messages) {
  const models = [];
  for (const m of messages) {
    if (m.model && !models.includes(m.model)) models.push(m.model);
  }
  return models;
}

function costOf(messages) {
  let cost = 0;
  for (const m of messages) cost += m.cost;
  return roundDollars(cost);
}

function elapsedOf(messages) {
  let elapsed = 0;
  for (const m of messages) {
    if (m.completed != null && m.created != null) elapsed += m.completed - m.created;
  }
  return elapsed;
}

function normalizeMessage(raw, index) {
  const info = raw?.info ?? {};
  const time = info.time ?? {};
  const tokens = info.tokens ?? {};
  const cache = tokens.cache ?? {};
  return {
    index,
    id: info.id ?? null,
    role: info.role ?? null,
    created: toMs(time.created),
    completed: toMs(time.completed),
    cost: finiteNum(info.cost),
    tokens: {
      input: finiteNum(tokens.input),
      output: finiteNum(tokens.output),
      reasoning: finiteNum(tokens.reasoning),
      cacheRead: finiteNum(cache.read),
      cacheWrite: finiteNum(cache.write),
    },
    model: info.modelID ?? info.model?.modelID ?? null,
    agent: info.agent ?? null,
    parts: Array.isArray(raw?.parts) ? raw.parts : [],
  };
}

export function parseSession(value) {
  if (typeof value === 'string') value = JSON.parse(value);
  if (!value || typeof value !== 'object' || !Array.isArray(value.messages)) {
    throw new Error('expected a session object with { info, messages }');
  }
  const info = value.info ?? {};
  const time = info.time ?? {};
  const messages = value.messages
    .map(normalizeMessage)
    .filter(m => m.created != null)
    .sort((a, b) => a.created - b.created || a.index - b.index);
  const tokens = info.tokens ?? {};
  return {
    id: info.id ?? null,
    title: info.title ?? '',
    created: toMs(time.created),
    updated: toMs(time.updated) ?? toMs(time.created),
    cost: finiteNum(info.cost),
    tokens: {
      input: finiteNum(tokens.input),
      output: finiteNum(tokens.output),
      reasoning: finiteNum(tokens.reasoning),
      cacheRead: finiteNum(tokens.cache?.read),
      cacheWrite: finiteNum(tokens.cache?.write),
    },
    messages,
  };
}

export function detectCycles(session, { idleMs = DEFAULT_IDLE_MS } = {}) {
  const cycles = [];
  const messages = session.messages;
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    let prevActivity = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      const activity = messages[j].completed ?? messages[j].created;
      if (activity < msg.created) {
        prevActivity = activity;
        break;
      }
    }
    if (prevActivity == null) continue; // first message of the session: fresh start, not a resume
    const idleGap = msg.created - prevActivity;
    if (idleGap < idleMs) continue;
    const windowMessages = [];
    for (let j = i + 1; j < messages.length; j += 1) {
      if (messages[j].role === 'user') break;
      if (messages[j].role === 'assistant') windowMessages.push(messages[j]);
    }
    const first = windowMessages[0] ?? null;
    const stepStart = firstStepStart(windowMessages);
    cycles.push({
      resumedAt: msg.created,
      resumedAtISO: new Date(msg.created).toISOString(),
      userMessageID: msg.id,
      lastActivity: prevActivity,
      idleMs: idleGap,
      ttfMs: stepStart != null ? stepStart - msg.created : null,
      responseLatencyMs: first != null ? first.created - msg.created : null,
      firstTurn:
        first == null
          ? null
          : {
              cost: roundDollars(first.cost),
              elapsedMs: first.completed != null ? first.completed - first.created : null,
              model: first.model,
              tokens: first.tokens,
            },
      window: {
        turns: windowMessages.length,
        cost: costOf(windowMessages),
        elapsedMs: elapsedOf(windowMessages),
        models: modelList(windowMessages),
        tokens: sumTokens(windowMessages),
      },
    });
  }
  return cycles;
}

function aggregateCycles(cycles) {
  const totals = {
    cycles: cycles.length,
    idleMs: 0,
    ttfMs: 0,
    ttfMsSamples: 0,
    firstTurnCost: 0,
    windowCost: 0,
    firstTurnTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    windowTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    windowElapsedMs: 0,
  };
  for (const cycle of cycles) {
    totals.idleMs += cycle.idleMs;
    if (cycle.ttfMs != null) {
      totals.ttfMs += cycle.ttfMs;
      totals.ttfMsSamples += 1;
    }
    if (cycle.firstTurn) {
      totals.firstTurnCost = roundDollars(totals.firstTurnCost + cycle.firstTurn.cost);
      for (const key of Object.keys(totals.firstTurnTokens)) {
        totals.firstTurnTokens[key] += cycle.firstTurn.tokens[key];
      }
    }
    totals.windowCost = roundDollars(totals.windowCost + cycle.window.cost);
    for (const key of Object.keys(totals.windowTokens)) {
      totals.windowTokens[key] += cycle.window.tokens[key];
    }
    totals.windowElapsedMs += cycle.window.elapsedMs;
  }
  return totals;
}

export function computeReport(sessions, { idleMs = DEFAULT_IDLE_MS, sinceMs = null } = {}) {
  const sessionReports = [];
  for (const session of sessions) {
    if (sinceMs != null && (session.updated == null || session.updated < sinceMs)) continue;
    const cycles = detectCycles(session, { idleMs });
    sessionReports.push({
      id: session.id,
      title: session.title,
      created: session.created,
      updated: session.updated,
      cost: roundDollars(session.cost),
      tokens: session.tokens,
      messages: session.messages.length,
      cycles,
      totals: aggregateCycles(cycles),
    });
  }
  sessionReports.sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));
  const totals = {
    sessions: sessionReports.length,
    cycles: 0,
    idleMs: 0,
    ttfMs: 0,
    ttfMsSamples: 0,
    firstTurnCost: 0,
    windowCost: 0,
    firstTurnTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    windowTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    windowElapsedMs: 0,
  };
  for (const s of sessionReports) {
    totals.cycles += s.totals.cycles;
    totals.idleMs += s.totals.idleMs;
    totals.ttfMs += s.totals.ttfMs;
    totals.ttfMsSamples += s.totals.ttfMsSamples;
    totals.firstTurnCost = roundDollars(totals.firstTurnCost + s.totals.firstTurnCost);
    totals.windowCost = roundDollars(totals.windowCost + s.totals.windowCost);
    for (const key of Object.keys(totals.firstTurnTokens)) {
      totals.firstTurnTokens[key] += s.totals.firstTurnTokens[key];
      totals.windowTokens[key] += s.totals.windowTokens[key];
    }
    totals.windowElapsedMs += s.totals.windowElapsedMs;
  }
  return {
    version: REPORT_VERSION,
    options: { idleMs, sinceMs },
    sessions: sessionReports,
    totals,
  };
}

export function mergeReport(existing, additions) {
  if (!existing) return additions;
  const byId = new Map(existing.sessions.map(s => [s.id, s]));
  for (const s of additions.sessions) byId.set(s.id, s);
  const merged = computeReport([], { idleMs: existing.options.idleMs, sinceMs: existing.options.sinceMs });
  merged.sessions = [...byId.values()].sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));
  merged.totals = {
    sessions: merged.sessions.length,
    cycles: 0,
    idleMs: 0,
    ttfMs: 0,
    ttfMsSamples: 0,
    firstTurnCost: 0,
    windowCost: 0,
    firstTurnTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    windowTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    windowElapsedMs: 0,
  };
  for (const s of merged.sessions) {
    merged.totals.cycles += s.totals.cycles;
    merged.totals.idleMs += s.totals.idleMs;
    merged.totals.ttfMs += s.totals.ttfMs;
    merged.totals.ttfMsSamples += s.totals.ttfMsSamples;
    merged.totals.firstTurnCost = roundDollars(merged.totals.firstTurnCost + s.totals.firstTurnCost);
    merged.totals.windowCost = roundDollars(merged.totals.windowCost + s.totals.windowCost);
    for (const key of Object.keys(merged.totals.firstTurnTokens)) {
      merged.totals.firstTurnTokens[key] += s.totals.firstTurnTokens[key];
      merged.totals.windowTokens[key] += s.totals.windowTokens[key];
    }
    merged.totals.windowElapsedMs += s.totals.windowElapsedMs;
  }
  return merged;
}

function formatMs(ms) {
  if (ms == null) return 'n/a';
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return rest === 0 ? `${m}m` : `${m}m${rest}s`;
}

function formatDuration(ms) {
  if (ms == null) return 'n/a';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h${m % 60}m` : `${m}m${s % 60}s`;
}

function formatMoney(usd) {
  if (!usd) return '$0.00';
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function renderText(report) {
  const lines = [];
  for (const s of report.sessions) {
    const cycles = s.totals.cycles;
    lines.push(
      `${s.id ?? '(no id)'}  "${s.title ?? ''}"  ${cycles} cycle${cycles === 1 ? '' : 's'}  ` +
        `session cost ${formatMoney(s.cost)}  updated ${s.updated ? new Date(s.updated).toISOString() : 'n/a'}`
    );
    for (const c of s.cycles) {
      const windowTokens = c.window.tokens;
      lines.push(
        `  resume ${c.resumedAtISO} after idle ${formatDuration(c.idleMs)}  ` +
          `ttfb ${formatMs(c.ttfMs)}  redo ${c.window.turns} turn(s) ${formatMoney(c.window.cost)}  ` +
          `tokens in ${windowTokens.input.toLocaleString()} out ${windowTokens.output.toLocaleString()} ` +
          `cacheRead ${windowTokens.cacheRead.toLocaleString()}`
      );
    }
    if (s.totals.cycles > 0) {
      const t = s.totals;
      lines.push(
        `  subtotal: ${t.cycles} cycles, ${formatDuration(t.idleMs)} idle, ` +
          `${formatDuration(t.ttfMs)} rebuild wait (${t.ttfMsSamples} samples), ` +
          `${formatMoney(t.windowCost)} redo (first-turn basis ${formatMoney(t.firstTurnCost)})`
      );
    }
  }
  const t = report.totals;
  lines.push('');
  lines.push(
    `Totals: ${t.sessions} session(s), ${t.cycles} loss-and-resume cycle(s), ` +
      `${formatDuration(t.idleMs)} idle, ${formatDuration(t.ttfMs)} rebuild wait, ` +
      `${formatMoney(t.windowCost)} redo inference cost (first-turn basis ${formatMoney(t.firstTurnCost)}), ` +
      `${t.windowTokens.input.toLocaleString()} redo input tokens`
  );
  return lines.join('\n');
}

function cachePath(cacheDir, id) {
  return join(cacheDir, `${String(id).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

async function fetchJson(url, what) {
  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (error) {
    throw new Error(`cannot reach ${what} at ${url}: ${error.message}`);
  }
  if (!res.ok) {
    throw new Error(`${what} at ${url} returned HTTP ${res.status}`);
  }
  return res.json();
}

function extractSessionIds(body) {
  const arr = Array.isArray(body)
    ? body
    : (body?.sessions ?? body?.data ?? body?.items ?? body?.results);
  if (!Array.isArray(arr)) {
    throw new Error('unexpected /kilo/cloud-sessions response; expected a list of session ids');
  }
  return arr
    .map(entry => (typeof entry === 'string' ? entry : entry?.id ?? entry?.sessionId ?? entry?.session_id ?? entry?.kiloSessionId))
    .filter(id => typeof id === 'string' && id.length > 0);
}

async function fetchSession(server, id, cacheDir, refresh) {
  const path = cachePath(cacheDir, id);
  if (!refresh && existsSync(path)) {
    return { id, payload: JSON.parse(readFileSync(path, 'utf8')) };
  }
  const payload = await fetchJson(`${server}/kilo/cloud/session/${encodeURIComponent(id)}`, `session ${id}`);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(path, JSON.stringify(payload));
  return { id, payload };
}

function listJsonFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => join(directory, name));
}

function printUsage() {
  console.log(`loss-resume-stats: measure Cloud Agent loss-and-resume cycle cost from session data

Usage:
  node loss-resume-stats.mjs [options] [file...]

Inputs (at least one required):
  file...              session JSON file(s): \`kilo export <id>\` output or the
                       raw payload from the local kilo server's
                       GET /kilo/cloud/session/{id} endpoint
  --dir <path>         analyze every *.json file under a directory
  --server <url>       local kilo server base URL (e.g. http://127.0.0.1:41245)
  --session <id>       fetch this cloud session from --server and analyze it
  --all                fetch every cloud session from --server (uses
                       GET /kilo/cloud-sessions) and analyze them
  --cache <dir>        cache directory for fetched sessions
                       (default: ./.kilo-session-cache)
  --refresh            re-fetch cached sessions instead of reusing them

Analysis:
  --idle-min <minutes> minimum idle gap that marks a loss-and-resume cycle
                       (default: 5, matching the control-plane idle stop)
  --since <iso>        only consider sessions updated at or after this time

Output:
  --json               print the machine-readable report instead of the table
  --out <file>         merge per-session results into <file> (creates or
                       updates it; re-running accumulates new sessions)
  --no-table           with --json, suppress the human-readable table
  --help               show this help`);
}

export async function main(argv) {
  const args = [...argv];
  const files = [];
  const opts = {
    dir: null,
    server: null,
    session: null,
    all: false,
    cache: './.kilo-session-cache',
    refresh: false,
    idleMin: 5,
    since: null,
    json: false,
    out: null,
    table: true,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => {
      i += 1;
      return args[i];
    };
    switch (arg) {
      case '--help':
      case '-h':
        printUsage();
        return 0;
      case '--dir':
        opts.dir = next();
        if (!opts.dir) throw new Error('--dir requires a path');
        break;
      case '--server':
        opts.server = next();
        if (!opts.server) throw new Error('--server requires a URL');
        break;
      case '--session':
        opts.session = next();
        if (!opts.session) throw new Error('--session requires a session id');
        break;
      case '--all':
        opts.all = true;
        break;
      case '--cache':
        opts.cache = next();
        if (!opts.cache) throw new Error('--cache requires a path');
        break;
      case '--refresh':
        opts.refresh = true;
        break;
      case '--idle-min':
        opts.idleMin = Number(next());
        if (!Number.isFinite(opts.idleMin) || opts.idleMin <= 0) {
          throw new Error('--idle-min requires a positive number of minutes');
        }
        break;
      case '--since':
        opts.since = next();
        if (!opts.since) throw new Error('--since requires an ISO timestamp');
        break;
      case '--json':
        opts.json = true;
        break;
      case '--out':
        opts.out = next();
        if (!opts.out) throw new Error('--out requires a path');
        break;
      case '--no-table':
        opts.table = false;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
        files.push(arg);
    }
  }

  const sinceMs = opts.since != null ? toMs(opts.since) : null;
  if (opts.since != null && sinceMs == null) throw new Error(`cannot parse --since: ${opts.since}`);
  const idleMs = opts.idleMin * 60 * 1000;

  const sessions = [];
  const errors = [];

  if (opts.server) {
    const cacheDir = opts.cache;
    if (opts.all && !opts.session) {
      const list = await fetchJson(`${opts.server}/kilo/cloud-sessions`, 'session list');
      const ids = extractSessionIds(list);
      if (ids.length === 0) console.error(`warning: no cloud sessions returned by ${opts.server}`);
      for (const id of ids) {
        try {
          const { payload } = await fetchSession(opts.server, id, cacheDir, opts.refresh);
          sessions.push(parseSession(payload));
        } catch (error) {
          errors.push(`session ${id}: ${error.message}`);
          console.error(`warning: ${error.message}`);
        }
      }
    } else if (opts.session) {
      const { payload } = await fetchSession(opts.server, opts.session, cacheDir, opts.refresh);
      sessions.push(parseSession(payload));
    } else {
      throw new Error('--server requires --session <id> or --all');
    }
  }

  const filePaths = [...files];
  if (opts.dir) {
    filePaths.push(...listJsonFiles(opts.dir));
  }
  for (const path of filePaths) {
    let parsed;
    try {
      parsed = parseSession(readFileSync(path, 'utf8'));
    } catch (error) {
      errors.push(`${basename(path)}: ${error.message}`);
      console.error(`warning: skipping ${path}: ${error.message}`);
      continue;
    }
    sessions.push(parsed);
  }

  if (sessions.length === 0) {
    console.error(
      'error: no sessions to analyze. Pass session JSON files, --dir, or --server (with --session/--all).'
    );
    printUsage();
    return 1;
  }

  let report = computeReport(sessions, { idleMs, sinceMs });

  if (opts.out) {
    let existing = null;
    if (existsSync(opts.out)) {
      try {
        existing = JSON.parse(readFileSync(opts.out, 'utf8'));
      } catch {
        console.error(`warning: could not read existing ${opts.out}; starting fresh`);
      }
    }
    report = mergeReport(existing, report);
    writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (opts.table && (!opts.json || opts.out)) {
    process.stdout.write(`${renderText(report)}\n`);
  }
  if (opts.out && !opts.json) {
    process.stdout.write(`\nReport written to ${opts.out} (${report.sessions.length} sessions)\n`);
  }
  if (errors.length > 0 && !opts.json) {
    process.stderr.write(`\n${errors.length} input(s) were skipped; see warnings above.\n`);
  }
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then(code => {
      process.exitCode = code;
    })
    .catch(error => {
      console.error(`error: ${error.message}`);
      process.exitCode = 1;
    });
}
