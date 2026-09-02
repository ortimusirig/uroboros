import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDecomposeGoal } from '../src/decompose.js';
import { VERIFIED_SUPERPOWERS } from '../fixtures/verified-superpowers.mjs';

function goalFixture() {
  const root = mkdtempSync(join(tmpdir(), 'decomp-'));
  const goalDir = join(root, 'uro-project', 'goals', 'G1-demo');
  mkdirSync(goalDir, { recursive: true });
  const specPath = join(goalDir, 'spec.md');
  writeFileSync(specPath, '# G1: demo goal\nDeliver the demo capability.\n');
  return { root, goalDir, specPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const proposalText = (tasksJson, tasksMd) => `<TASKS_JSON>${JSON.stringify(tasksJson)}</TASKS_JSON>\n<TASKS_MD>${tasksMd}</TASKS_MD>`;
const goodTasks = [
  { id: 'T1', name: 'T1-first', dependsOn: [], gate: [{ bin: 'node', args: ['--test'] }] },
  { id: 'T2', name: 'T2-second', dependsOn: ['T1'], gate: [{ bin: 'node', args: ['--test'] }] },
];
const goodMd = '## T1: first\nTitle: first\nRequired behavior: A.\nTest requirements: t.\n\n## T2: second\nTitle: second\nRequired behavior: B.\nTest requirements: t.\n';

function adaptersFor(proposals) {
  let call = 0;
  return {
    draft: async () => '<TASKS_JSON>[]</TASKS_JSON>\n<TASKS_MD></TASKS_MD>',
    review: async () => ({ agree: true, readable: true, suggestions: [], questions: [], content: '' }),
    codexReview: async () => ({ agree: true, readable: true, suggestions: [], questions: [], content: '' }),
    runArbiter: async ({ request }) => request.type === 'propose'
      ? { verdict: 'answered', answer: proposals[Math.min(call++, proposals.length - 1)] }
      : request.type === 'agreement'
        ? { verdict: 'answered', converged: true, reason: '', feedback: '' }
        : { verdict: 'answered' },
  };
}

test('a converged goal writes topologically ordered task units, write-once', async () => {
  const fixture = goalFixture();
  try {
    const result = await runDecomposeGoal({
      goalSpecPath: fixture.specPath, target: fixture.root, runId: 'd2-ok',
      superpowers: VERIFIED_SUPERPOWERS,
      adapters: adaptersFor([proposalText([goodTasks[1], goodTasks[0]], goodMd)]),
    });
    assert.equal(result.converged, true);
    const queue = JSON.parse(readFileSync(join(fixture.goalDir, 'tasks', 'queue.json'), 'utf8'));
    assert.deepEqual(queue.map((unit) => unit.name), ['T1-first', 'T2-second'],
      'declared order serialized; T1 lands before its dependent');
    assert.match(readFileSync(join(fixture.goalDir, 'tasks', 'T1-plan.md'), 'utf8'), /Required behavior: A/);
    assert.deepEqual(JSON.parse(readFileSync(join(fixture.goalDir, 'tasks', 'T2-gate.json'), 'utf8')),
      [{ bin: 'node', args: ['--test'] }]);
    await assert.rejects(() => runDecomposeGoal({
      goalSpecPath: fixture.specPath, target: fixture.root, runId: 'd2-again',
      superpowers: VERIFIED_SUPERPOWERS, adapters: adaptersFor([proposalText(goodTasks, goodMd)]),
    }), /EEXIST|already exists/i, 'write-once: a second convergence collides loudly');
  } finally { fixture.cleanup(); }
});

test('a dependency cycle goes back as feedback and the repaired round converges', async () => {
  const fixture = goalFixture();
  const cyclic = [
    { id: 'T1', name: 'T1-a', dependsOn: ['T2'], gate: [] },
    { id: 'T2', name: 'T2-b', dependsOn: ['T1'], gate: [] },
  ];
  try {
    const result = await runDecomposeGoal({
      goalSpecPath: fixture.specPath, target: fixture.root, runId: 'd2-cycle',
      superpowers: VERIFIED_SUPERPOWERS,
      adapters: adaptersFor([
        proposalText(cyclic, '## T1: a\nx\n\n## T2: b\nx\n'),
        proposalText(goodTasks, goodMd),
      ]),
    });
    assert.equal(result.converged, true, 'the cycle repaired through feedback, not refusal');
    assert.equal(result.rounds, 2);
  } finally { fixture.cleanup(); }
});

test('mismatched ids are fed back verbatim, not terminal', async () => {
  const fixture = goalFixture();
  try {
    const result = await runDecomposeGoal({
      goalSpecPath: fixture.specPath, target: fixture.root, runId: 'd2-ids',
      superpowers: VERIFIED_SUPERPOWERS,
      adapters: adaptersFor([
        proposalText(goodTasks, '## T1: only one section\nx\n'),
        proposalText(goodTasks, goodMd),
      ]),
    });
    assert.equal(result.converged, true);
    assert.equal(result.rounds, 2);
  } finally { fixture.cleanup(); }
});

test('a proposer that answers with no tasks at all is terminal and writes nothing', async () => {
  const fixture = goalFixture();
  try {
    // `rounds` is deliberately unbounded: an artifact-less answer read as
    // repairable would feed itself back forever instead of ending the round.
    const result = await runDecomposeGoal({
      goalSpecPath: fixture.specPath, target: fixture.root, runId: 'd2-silent',
      superpowers: VERIFIED_SUPERPOWERS,
      adapters: { ...adaptersFor([]), runArbiter: async () => ({ verdict: 'answered' }) },
    });
    assert.equal(result.converged, false);
    assert.equal(result.reason, 'arbiter-unavailable');
    assert.equal(result.rounds, 1);
    assert.equal(existsSync(join(fixture.goalDir, 'tasks')), false,
      'a goal that never converged leaves no half-written task units behind');
  } finally { fixture.cleanup(); }
});

test('the standing law, the constitution, the repo map and the goal spec reach the seats verbatim', async () => {
  const fixture = goalFixture();
  writeFileSync(join(fixture.root, 'uro-project', 'constitution.md'), 'Rule 1: no new dependencies.\n');
  const drafted = [];
  const reviewed = [];
  try {
    const result = await runDecomposeGoal({
      goalSpecPath: fixture.specPath, target: fixture.root, runId: 'd2-prompts',
      superpowers: VERIFIED_SUPERPOWERS,
      adapters: {
        ...adaptersFor([proposalText(goodTasks, goodMd)]),
        draft: async (request) => {
          drafted.push(request);
          return '<TASKS_JSON>[]</TASKS_JSON>\n<TASKS_MD></TASKS_MD>';
        },
        codexReview: async (request) => {
          reviewed.push(request);
          return { agree: true, readable: true, suggestions: [], questions: [], content: '' };
        },
      },
    });
    assert.equal(result.converged, true);
    assert.equal(drafted[0].sandbox, 'read-only', 'a drafting seat never writes');
    assert.match(drafted[0].input, /Determinism advises; the model decides/, 'the standing law leads every prompt');
    assert.match(drafted[0].input, /Deliver the demo capability/, 'the goal spec travels verbatim');
    assert.match(drafted[0].input, /Rule 1: no new dependencies/, 'the constitution is quoted when present');
    assert.match(drafted[0].input, /# Repository map/, 'the repo-map ration is embedded');
    assert.match(
      drafted[0].input,
      /every task is a self-contained increment of the GOAL — runnable and testable alone, exactly one capability/,
      'the tier-2 incremental law is quoted verbatim',
    );
    assert.match(drafted[0].input, /no exit code passes or fails the change/,
      'gate commands are evidence, never a verdict');
    assert.equal(reviewed[0].goalSpec.includes('Deliver the demo capability'), true,
      'the reviewing seat is pinned to THIS goal spec');
  } finally { fixture.cleanup(); }
});
