import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runPlan } from '../src/plan.js';

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

test('recurring findings take amend, fresh, and conclude pivot paths', async () => {
  const item = fixture();
  const inputs = [];
  try {
    const result = await runPlan({
      goal: 'Escape a circular plan', target: item.target, out: item.out, rounds: 8,
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
