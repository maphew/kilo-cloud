import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeReport,
  detectCycles,
  mergeReport,
  parseSession,
} from './loss-resume-stats.mjs';

const MIN = 60_000;
const BASE = 1_800_000_000_000;

function message(role, created, options = {}) {
  const tokens = options.tokens ?? {};
  return {
    info: {
      id: options.id ?? `msg_${role}_${created}`,
      role,
      time: {
        created,
        ...(options.completed != null ? { completed: options.completed } : {}),
      },
      cost: options.cost ?? 0,
      tokens: {
        input: tokens.input ?? 0,
        output: tokens.output ?? 0,
        reasoning: tokens.reasoning ?? 0,
        cache: { read: tokens.cacheRead ?? 0, write: tokens.cacheWrite ?? 0 },
      },
      modelID: options.model ?? 'kilo-auto/efficient',
    },
    parts: options.parts ?? [],
  };
}

function user(created, id) {
  return message('user', created, { id });
}

function assistant(created, completed, options = {}) {
  const parts = options.stepStartAt != null
    ? [{ type: 'step-start', time: { start: options.stepStartAt } }, ...(options.parts ?? [])]
    : options.parts ?? [];
  return message('assistant', created, { completed, ...options, parts });
}

function session(id, messages, info = {}) {
  return {
    info: {
      id,
      title: info.title ?? `Session ${id}`,
      time: {
        created: info.created ?? BASE,
        updated: info.updated ?? BASE + 1,
      },
      cost: info.cost ?? 0,
      tokens: {},
    },
    messages,
  };
}

function cycleFixture() {
  return session(
    'ses_test_cycles',
    [
      user(BASE, 'u1'),
      assistant(BASE + 10_000, BASE + 20_000, {
        cost: 0.01,
        tokens: { input: 10_000, output: 100 },
      }),
      user(BASE + 40 * MIN, 'u2'),
      assistant(BASE + 2_490_000, BASE + 2_500_000, {
        cost: 0.3,
        stepStartAt: BASE + 2_485_000,
        tokens: { input: 200_000, output: 1_000 },
      }),
      assistant(BASE + 2_510_000, BASE + 2_515_000, {
        cost: 0.05,
        tokens: { input: 50_000 },
      }),
      user(BASE + 2_520_000, 'u3'),
      assistant(BASE + 2_530_000, BASE + 2_535_000, {
        cost: 0.02,
        tokens: { input: 5_000 },
      }),
      user(BASE + 2_900_000, 'u4'),
      assistant(BASE + 2_980_000, BASE + 2_990_000, {
        cost: 0.4,
        stepStartAt: BASE + 2_970_000,
        tokens: { input: 150_000 },
      }),
    ],
    { cost: 0.78, updated: BASE + 9_000_000 }
  );
}

test('a continuous session has no loss-and-resume cycles', () => {
  const s = parseSession(
    session('ses_continuous', [
      user(BASE, 'u1'),
      assistant(BASE + 10_000, BASE + 20_000, { cost: 0.01 }),
      assistant(BASE + 21_000, BASE + 30_000, { cost: 0.02 }),
      assistant(BASE + 31_000, BASE + 45_000, { cost: 0.03 }),
      assistant(BASE + 46_000, BASE + 60_000, { cost: 0.04 }),
    ])
  );
  assert.deepEqual(detectCycles(s), []);
});

test('idle gaps below the threshold are not cycles', () => {
  const s = parseSession(
    session('ses_below', [
      user(BASE, 'u1'),
      assistant(BASE + 10_000, BASE + 20_000, { cost: 0.01 }),
      user(BASE + 2 * MIN, 'u2'),
      assistant(BASE + 2 * MIN + 5_000, BASE + 2 * MIN + 15_000, { cost: 0.02 }),
    ])
  );
  assert.deepEqual(detectCycles(s), []);
});

test('a user message after the idle threshold is a loss-and-resume cycle with exact attribution', () => {
  const s = parseSession(cycleFixture());
  const cycles = detectCycles(s);
  assert.equal(cycles.length, 2);

  const [c1, c2] = cycles;

  assert.equal(c1.resumedAt, BASE + 2_400_000);
  assert.equal(c1.idleMs, 2_380_000);
  assert.equal(c1.ttfMs, 85_000);
  assert.equal(c1.firstTurn.cost, 0.3);
  assert.equal(c1.firstTurn.elapsedMs, 10_000);
  assert.deepEqual(c1.firstTurn.tokens, {
    input: 200_000,
    output: 1_000,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(c1.window.turns, 2);
  assert.equal(c1.window.cost, 0.35);
  assert.equal(c1.window.elapsedMs, 15_000);
  assert.deepEqual(c1.window.models, ['kilo-auto/efficient']);
  assert.deepEqual(c1.window.tokens, {
    input: 250_000,
    output: 1_000,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });

  assert.equal(c2.resumedAt, BASE + 2_900_000);
  assert.equal(c2.idleMs, 365_000);
  assert.equal(c2.ttfMs, 70_000);
  assert.equal(c2.window.turns, 1);
  assert.equal(c2.window.cost, 0.4);
  assert.equal(c2.window.tokens.input, 150_000);
});

test('the first message of a session is never a cycle', () => {
  const s = parseSession(
    session('ses_first', [
      user(BASE, 'u1'),
      assistant(BASE + 9_000_000, BASE + 9_001_000, { cost: 1 }),
    ])
  );
  assert.deepEqual(detectCycles(s), []);
});

test('detection is order-independent (unsorted transcript gives the same cycles)', () => {
  const sorted = parseSession(cycleFixture());
  const shuffled = parseSession({
    ...cycleFixture(),
    messages: [...cycleFixture().messages].reverse(),
  });
  assert.deepEqual(detectCycles(shuffled), detectCycles(sorted));
});

test('a cycle is still detected when per-message cost and tokens are missing', () => {
  const s = parseSession(
    session('ses_bare', [
      user(BASE, 'u1'),
      assistant(BASE + 10_000, BASE + 20_000),
      user(BASE + 10 * MIN, 'u2'),
      assistant(BASE + 10 * MIN + 5_000, BASE + 10 * MIN + 15_000),
    ])
  );
  const cycles = detectCycles(s);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].firstTurn.cost, 0);
  assert.deepEqual(cycles[0].window.tokens, {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test('messages without timestamps are dropped and a user message without followers still counts as a cycle', () => {
  const raw = session('ses_nofollow', [
    user(BASE, 'u1'),
    assistant(BASE + 10_000, BASE + 20_000, { cost: 0.01 }),
    { info: { role: 'assistant', time: {} }, parts: [] },
    user(BASE + 10 * MIN, 'u2'),
  ]);
  const s = parseSession(raw);
  assert.equal(s.messages.length, 3);
  const cycles = detectCycles(s);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].firstTurn, null);
  assert.equal(cycles[0].window.turns, 0);
  assert.equal(cycles[0].window.cost, 0);
  assert.equal(cycles[0].ttfMs, null);
});

test('computeReport is deterministic and aggregates session totals', () => {
  const report1 = computeReport([parseSession(cycleFixture())]);
  const report2 = computeReport([parseSession(cycleFixture())]);
  assert.deepEqual(report1, report2);
  assert.equal(JSON.stringify(report1), JSON.stringify(report2));

  const t = report1.totals;
  assert.equal(t.sessions, 1);
  assert.equal(t.cycles, 2);
  assert.equal(t.idleMs, 2_745_000);
  assert.equal(t.ttfMs, 155_000);
  assert.equal(t.ttfMsSamples, 2);
  assert.equal(t.firstTurnCost, 0.7);
  assert.equal(t.windowCost, 0.75);
  assert.equal(t.firstTurnTokens.input, 350_000);
  assert.equal(t.windowTokens.input, 400_000);
  assert.equal(t.windowElapsedMs, 25_000);
  const s = report1.sessions[0];
  assert.equal(s.id, 'ses_test_cycles');
  assert.deepEqual(s.totals, {
    cycles: 2,
    idleMs: 2_745_000,
    ttfMs: 155_000,
    ttfMsSamples: 2,
    firstTurnCost: 0.7,
    windowCost: 0.75,
    firstTurnTokens: {
      input: 350_000,
      output: 1_000,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    windowTokens: {
      input: 400_000,
      output: 1_000,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    windowElapsedMs: 25_000,
  });
});

test('--since filtering excludes older sessions', () => {
  const old = parseSession(session('ses_old', [], { updated: BASE + 1 }));
  const fresh = parseSession(cycleFixture());
  const report = computeReport([old, fresh], { sinceMs: BASE + 1000 });
  assert.deepEqual(report.sessions.map(s => s.id), ['ses_test_cycles']);
});

test('mergeReport accumulates per-session results and recomputes totals', () => {
  const reportA = computeReport([parseSession(cycleFixture())]);
  const reportB = computeReport([parseSession(session('ses_b', [user(BASE, 'u1')]))]);
  const merged = mergeReport(reportA, reportB);
  assert.deepEqual(
    merged.sessions.map(s => s.id),
    ['ses_b', 'ses_test_cycles']
  );
  assert.equal(merged.totals.sessions, 2);
  assert.equal(merged.totals.cycles, 2);
  assert.equal(merged.totals.windowCost, 0.75);
  assert.equal(merged.options.idleMs, reportA.options.idleMs);
  assert.deepEqual(mergeReport(reportA, reportA), reportA);
  assert.deepEqual(mergeReport(undefined, reportA), reportA);
});

test('a user message with no prior activity (session start) is excluded even after a long gap from nothing', () => {
  const s = parseSession(session('ses_start', [user(BASE, 'u1')]));
  assert.deepEqual(detectCycles(s), []);
});

test('step-start parts deeper in the recovery window still provide ttfMs from the first step-start', () => {
  const s = parseSession(
    session('ses_ttfb', [
      user(BASE, 'u1'),
      assistant(BASE + 10_000, BASE + 20_000),
      user(BASE + 10 * MIN, 'u2'),
      assistant(BASE + 10 * MIN + 9_000, BASE + 10 * MIN + 20_000, {
        cost: 0.1,
        stepStartAt: BASE + 10 * MIN + 2_000,
      }),
    ])
  );
  const cycles = detectCycles(s);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].ttfMs, 2_000);
  assert.equal(cycles[0].responseLatencyMs, 9_000);
});
