import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runPlan as executePlan } from '../src/plan.js';

const VERIFIED_SUPERPOWERS = {
  ok: true,
  seats: {
    codex: { seat: 'codex', verified: true, evidence: 'registry', version: '6.3.0', path: null },
    cursor: { seat: 'cursor', verified: true, evidence: 'manifest', version: '6.0.2', path: 'C:/cursor-superpowers' },
    claude: { seat: 'claude', verified: true, evidence: 'manifest', version: '6.0.2', path: 'C:/claude-superpowers' },
  },
};

const runPlan = (options) => executePlan({
  ...options,
  adapters: {
    verifySuperpowers: async () => VERIFIED_SUPERPOWERS,
    ...options.adapters,
  },
});

const planText = [
  '## Title', '', 'Plan test', '',
  '## Required behavior', '', 'Implement the goal.', '',
  '## Invariants', '', 'Keep compatibility.', '',
  '## Test requirements', '', '1. Exercise the behavior.', '',
  '## Out of scope', '', 'Unrelated work.', '',
].join('\n');

function fixture() {
  const directory = mkdtempSync(join(process.cwd(), '.ccc-test-plan-'));
  return {
    target: directory,
    out: join(directory, 'generated'),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function draft() {
  return { plan: planText, gate: [] };
}

const passingGate = async () => ({ passed: true, failures: [] });

test('a one-round convergence writes both artifacts and emits plan/converged', async () => {
  const item = fixture();
  const events = [];
  try {
    const result = await runPlan({
      goal: 'Implement the approved behavior', target: item.target, out: item.out,
      reporter: (event) => events.push(event),
      adapters: {
        draft: async (request) => {
          assert.equal(request.sandbox, 'read-only');
          return draft();
        },
        runPlanGate: passingGate,
        review: async () => 'NO_BLOCKERS',
      },
    });
    assert.equal(result.converged, true);
    assert.equal(result.rounds, 1);
    assert.equal(readFileSync(result.planPath, 'utf8'), planText);
    assert.deepEqual(JSON.parse(readFileSync(result.gatePath, 'utf8')), []);
    assert.ok(events.some((event) => `${event.stage}/${event.type}` === 'plan/converged'));
    assert.deepEqual(events.map((event) => `${event.stage}/${event.type}`), [
      'plan/start', 'plan/gate', 'plan/round', 'plan/converged', 'plan/finish',
    ]);
  } finally { item.cleanup(); }
});

test('a gate-failed draft skips review and sends the exact failure into the next round', async () => {
  const item = fixture();
  const inputs = [];
  let gateCalls = 0;
  let reviews = 0;
  try {
    const result = await runPlan({
      goal: 'Repair planning evidence', target: item.target, out: item.out, rounds: 2,
      adapters: {
        draft: async (request) => { inputs.push(request.input); return draft(); },
        runPlanGate: async () => gateCalls++ === 0
          ? { passed: false, failures: [{ id: 'PG_PATH', check: 'cited-paths', message: 'cited path does not exist: src/ghost.js' }] }
          : { passed: true, failures: [] },
        review: async () => { reviews++; return 'NO_BLOCKERS'; },
      },
    });
    assert.equal(result.converged, true);
    assert.equal(reviews, 1, 'the failed first draft must not reach review');
    assert.match(inputs[1], /cited path does not exist: src[/\\]ghost[.]js/);
  } finally { item.cleanup(); }
});

test('blocking review findings drive another round through the fix plan', async () => {
  const item = fixture();
  const inputs = [];
  let reviews = 0;
  try {
    const result = await runPlan({
      goal: 'Cover the edge case', target: item.target, out: item.out, rounds: 2,
      adapters: {
        draft: async (request) => { inputs.push(request.input); return draft(); },
        runPlanGate: passingGate,
        review: async () => reviews++ === 0 ? [
          '## F1', 'Severity: blocking', 'Category: tests',
          'Description: The edge case is uncovered.', 'Test: test/edge.test.js',
        ].join('\n') : 'NO_BLOCKERS',
      },
    });
    assert.equal(result.converged, true);
    assert.equal(result.rounds, 2);
    assert.match(inputs[1], /# Fix Plan[\s\S]*F1 \(blocking\): The edge case is uncovered/);
  } finally { item.cleanup(); }
});

test('suggestions alone converge without driving another round', async () => {
  const item = fixture();
  let drafts = 0;
  try {
    const result = await runPlan({
      goal: 'Keep suggestions optional', target: item.target, out: item.out,
      adapters: {
        draft: async () => { drafts++; return draft(); },
        runPlanGate: passingGate,
        review: async () => ({
          verdict: 'ISSUES',
          content: [
            '## F1', 'Severity: suggestion', 'Category: style',
            'Description: Consider different wording.', 'Test:',
          ].join('\n'),
        }),
      },
    });
    assert.equal(result.converged, true);
    assert.equal(drafts, 1);
  } finally { item.cleanup(); }
});

test('a capability veto is unoverrulable and its remedy drives the next draft', async () => {
  const item = fixture();
  const inputs = [];
  const capabilityCalls = [];
  try {
    const result = await runPlan({
      goal: 'Use a supported launch mechanism', target: item.target, out: item.out, rounds: 2,
      adapters: {
        draft: async (request) => { inputs.push(request.input); return draft(); },
        runPlanGate: passingGate,
        review: async () => 'NO_BLOCKERS',
        runArbiter: async () => ({ verdict: 'valid' }),
        checkCapability: async ({ seat, remedyOnly }) => {
          capabilityCalls.push({ seat, remedyOnly: remedyOnly === true });
          if (seat !== 'executor' || inputs.length > 1) return { capable: true };
          if (!remedyOnly) {
            return 'I cannot use --plugin-dir.';
          }
          return {
            capable: false,
            what: '--plugin-dir',
            why: 'the flag does not exist',
            alternative: 'register the plugin marketplace and reuse CODEX_HOME',
          };
        },
      },
    });
    assert.equal(result.converged, true);
    assert.equal(result.rounds, 2);
    assert.match(inputs[1], /register the plugin marketplace and reuse CODEX_HOME/);
    assert.ok(capabilityCalls.some((call) => call.seat === 'executor' && call.remedyOnly));
    assert.equal(result.capabilityVetoes[0].vetoes[0].answers.length, 2);
  } finally { item.cleanup(); }
});

test('an arbiter cannot overrule a seat capability veto', async () => {
  const item = fixture();
  let arbiterCalls = 0;
  try {
    const result = await runPlan({
      goal: 'Respect seat limits', target: item.target, out: item.out, rounds: 1,
      adapters: {
        draft,
        runPlanGate: passingGate,
        review: async () => 'NO_BLOCKERS',
        runArbiter: async () => { arbiterCalls++; return { verdict: 'valid' }; },
        checkCapability: async ({ seat }) => seat === 'reviewer'
          ? {
              capable: false,
              what: 'write outside the review directory',
              why: 'the reviewer is scoped read-only',
              alternative: 'have the executor perform implementation writes',
            }
          : { capable: true },
      },
    });
    assert.equal(result.converged, false);
    assert.equal(result.reason, 'rounds-exhausted');
    assert.equal(result.capabilityVetoes[0].vetoes[0].seat, 'reviewer');
    assert.equal(arbiterCalls, 0, 'clean reviews need no arbiter and vetoes are never arbitrated');
  } finally { item.cleanup(); }
});

test('without --rounds recurring findings run until the pivot ladder concludes', async () => {
  const item = fixture();
  const inputs = [];
  try {
    const result = await runPlan({
      goal: 'Escape a circular plan', target: item.target, out: item.out,
      adapters: {
        draft: async (request) => { inputs.push(request.input); return draft(); },
        runPlanGate: async () => ({
          passed: false,
          failures: [{ id: 'PG_REPEAT', check: 'cited-paths', message: 'same recurring defect' }],
        }),
        review: async () => { throw new Error('a gate-failed plan must not be reviewed'); },
      },
    });
    assert.equal(result.converged, false);
    assert.equal(result.reason, 'pivot-conclude');
    assert.equal(result.rounds, 5);
    assert.match(inputs[3], /Amend the approach/);
    assert.match(inputs[4], /genuinely fresh approach/);
    assert.equal(existsSync(join(item.out, 'plan.md')), false);
  } finally { item.cleanup(); }
});

test('round exhaustion writes no plan and reports the mechanical reason', async () => {
  const item = fixture();
  try {
    const result = await runPlan({
      goal: 'Do not emit an untrusted plan', target: item.target, out: item.out, rounds: 1,
      adapters: {
        draft,
        runPlanGate: async () => ({
          passed: false,
          failures: [{ id: 'PG_GATE', check: 'gate-runs', message: 'gate command exited 1: node --test' }],
        }),
        review: async () => { throw new Error('must not review'); },
      },
    });
    assert.equal(result.reason, 'rounds-exhausted');
    assert.match(result.gate.failures[0].message, /exited 1/);
    assert.equal(existsSync(join(item.out, 'plan.md')), false);
    assert.equal(existsSync(join(item.out, 'gate.json')), false);
  } finally { item.cleanup(); }
});

test('dry-run validates output without drafting or writing', async () => {
  const item = fixture();
  try {
    const result = await runPlan({
      goal: 'Validate this goal', target: item.target, out: item.out, dryRun: true,
      adapters: { draft: async () => { throw new Error('must not draft'); } },
    });
    assert.equal(result.dryRun, true);
    assert.equal(existsSync(item.out), false);
  } finally { item.cleanup(); }
});

test('plan refuses an unverified seat before invoking either agent', async () => {
  const item = fixture();
  let drafts = 0;
  let reviews = 0;
  try {
    await assert.rejects(runPlan({
      goal: 'Do not spend tokens', target: item.target, out: item.out,
      adapters: {
        verifySuperpowers: async () => ({
          ok: false,
          seats: {
            ...VERIFIED_SUPERPOWERS.seats,
            codex: {
              seat: 'codex', verified: false, evidence: 'Codex not installed', version: null,
              remediation: 'Codex: codex plugin add superpowers@openai-curated',
            },
          },
        }),
        draft: async () => { drafts++; return draft(); },
        review: async () => { reviews++; return 'NO_BLOCKERS'; },
      },
    }), /Codex.*codex plugin add superpowers@openai-curated/i);
    assert.equal(drafts, 0);
    assert.equal(reviews, 0);
  } finally { item.cleanup(); }
});

test('plan launches use the environment and Cursor directory that were verified', async () => {
  const item = fixture();
  const env = { CODEX_HOME: 'C:/registered-codex-home' };
  const home = 'C:/seat-home';
  let draftRequest;
  let reviewRequest;
  try {
    const result = await runPlan({
      goal: 'Use verified seat configuration', target: item.target, out: item.out,
      env,
      home,
      adapters: {
        draft: async (request) => { draftRequest = request; return draft(); },
        runPlanGate: passingGate,
        review: async (request) => { reviewRequest = request; return 'NO_BLOCKERS'; },
      },
    });

    assert.equal(result.converged, true);
    assert.equal(draftRequest.env, env);
    assert.equal(reviewRequest.env, env);
    assert.equal(reviewRequest.home, home);
    assert.equal(reviewRequest.superpowersDir, VERIFIED_SUPERPOWERS.seats.cursor.path);
  } finally { item.cleanup(); }
});
