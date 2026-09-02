import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTaggedPair, runDecomposeGoal, topologicalOrder } from '../src/decompose.js';
import { RepairableArtifactError } from '../src/conversation.js';
import { VERIFIED_SUPERPOWERS } from '../fixtures/verified-superpowers.mjs';
import { parseArgs } from '../src/args.js';

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
  let agreementPrompt = null;
  const base = adaptersFor([proposalText(goodTasks, goodMd)]);
  try {
    const result = await runDecomposeGoal({
      goalSpecPath: fixture.specPath, target: fixture.root, runId: 'd2-prompts',
      superpowers: VERIFIED_SUPERPOWERS,
      adapters: {
        ...base,
        draft: async (request) => {
          drafted.push(request);
          return '<TASKS_JSON>[]</TASKS_JSON>\n<TASKS_MD></TASKS_MD>';
        },
        codexReview: async (request) => {
          reviewed.push(request);
          return { agree: true, readable: true, suggestions: [], questions: [], content: '' };
        },
        // The agreement seat has the final say, so what reaches it is what
        // matters here — capture the actual PROMPT tier2Prompt built for it
        // (not just its structured request), exactly as the transport sees it.
        runArbiter: async (args) => {
          if (args.request?.type === 'agreement') agreementPrompt = args.prompt;
          return base.runArbiter(args);
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
    assert.ok(agreementPrompt, 'the agreement seat must actually have been invoked');
    assert.match(agreementPrompt, /Rule 1: no new dependencies/,
      'the agreement seat — final say on the decomposition — must see the constitution too');
    assert.match(agreementPrompt, /# Repository map/,
      'the agreement seat must see the repo map too');
  } finally { fixture.cleanup(); }
});

test('a duplicate "## T<n>" section feeds back as a named contradiction, not a silent overwrite', () => {
  // Two "## T1:" headings: without the guard, the second body silently
  // replaces the first in the sections Map and id-set equality still passes
  // (the KEY "T1" was already there) — the first task's plan just vanishes.
  const text = [
    '<TASKS_JSON>[{"id":"T1"}]</TASKS_JSON>',
    '<TASKS_MD>',
    '## T1: first',
    'first body',
    '',
    '## T1: first again',
    'second body',
    '</TASKS_MD>',
  ].join('\n');
  assert.throws(
    () => parseTaggedPair(text, { jsonTag: 'TASKS_JSON', mdTag: 'TASKS_MD', idPattern: 'T\\d+' }),
    (error) => error instanceof RepairableArtifactError
      && /duplicate section ## T1 — one section per task/.test(error.message),
  );
});

test('a task depending on itself is named honestly, not "T1 and undefined depend on each other"', () => {
  assert.throws(
    () => topologicalOrder([{ id: 'T1', name: 'T1-solo', dependsOn: ['T1'], gate: [] }]),
    (error) => error instanceof RepairableArtifactError && /depends on itself/.test(error.message),
  );
});

test('decompose args: goal mode', () => {
  const opts = parseArgs(['decompose', '--goal', 'g/spec.md', '--target', '.', '--map-budget', '5000']);
  assert.deepEqual({ command: opts.command, mode: opts.mode, goal: opts.goal, mapBudget: opts.mapBudget },
    { command: 'decompose', mode: 'goal', goal: 'g/spec.md', mapBudget: 5000 });
});
test('decompose args: exactly one of --goal/--project', () => {
  assert.throws(() => parseArgs(['decompose', '--target', '.']), /--goal or --project/);
  assert.throws(() => parseArgs(['decompose', '--goal', 'a', '--project', 'b', '--target', '.']), /--goal or --project/);
  assert.throws(() => parseArgs(['decompose', '--goal', 'a', '--target', '.', '--out', 'o']), /--out/);
});
