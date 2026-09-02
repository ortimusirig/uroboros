import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseTaggedPair, runDecomposeGoal, runDecomposeProject, topologicalOrder,
  validateDecomposeProjectRequest, writeTier1Artifacts,
} from '../src/decompose.js';
import { cursorSeatCall } from '../src/decompose.js';
import { assertUsablePrompt } from '../src/verifier.js';
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
    // F12 (dogfood run 6): this asserted `rounds === 2`, pinning the behaviour
    // where a parse repair burned a round in which no seat reviewed anything.
    // The id mismatch is caught by parseTaskProposal, so the retry reuses
    // round 1 and the single round of real deliberation is the one below.
    assert.equal(result.rounds, 1, 'the parse repair and its retry are one round');
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

test('the tier-2 agreement prompt names each seat state and quotes an unreadable answer raw', async () => {
  // Every dogfood run's agreement prompt rendered the parsed review as JSON, so
  // a stance that could not be READ arrived as `"agree": false` — a measurement
  // failure dressed as a refusal on the merits. The judge must be told which it
  // is, and for an unreadable stance must get the seat's own words to judge.
  const fixture = goalFixture();
  const unreadable = 'Reviewed the tasks and verified the cited seams. My user-facing answer is only the required block.';
  let agreementPrompt = null;
  const base = adaptersFor([proposalText(goodTasks, goodMd)]);
  try {
    const result = await runDecomposeGoal({
      goalSpecPath: fixture.specPath, target: fixture.root, runId: 'd2-states', rounds: 1,
      superpowers: VERIFIED_SUPERPOWERS,
      adapters: {
        ...base,
        codexReview: async () => 'AGREE: no\nS1 P0: T2 is two tasks',
        review: async () => unreadable,
        runArbiter: async (args) => {
          if (args.request?.type === 'agreement') agreementPrompt = args.prompt;
          return base.runArbiter(args);
        },
      },
    });
    assert.equal(result.converged, false, 'an unreadable stance is never consent');
    assert.ok(agreementPrompt, 'the agreement seat must actually have been invoked');
    assert.match(agreementPrompt, /CODEX_REVIEW \(stance: disagree/);
    assert.match(agreementPrompt, /CURSOR_REVIEW \(stance: stance-unreadable/);
    assert.match(agreementPrompt, /S1 P0: T2 is two tasks|T2 is two tasks/,
      'the readable seat still travels with its suggestions');
    const cursorBlock = agreementPrompt.slice(agreementPrompt.indexOf('CURSOR_REVIEW'));
    assert.ok(cursorBlock.includes(unreadable),
      'the unreadable answer is quoted verbatim so the judge can read it itself');
    assert.doesNotMatch(cursorBlock, /"agree"/,
      'an unreadable stance must never be rendered as an agree boolean');
    assert.doesNotMatch(cursorBlock, /stated AGREE: no/,
      'a stance that could not be read was never stated');
    assert.match(agreementPrompt, /stance-unreadable[\s\S]*never consent|never consent[\s\S]*stance-unreadable/,
      'the prompt states what an unreadable stance means for convergence');
  } finally { fixture.cleanup(); }
});

test('an unreadable tier-2 review stance is re-asked once with the answer fed back verbatim', async () => {
  // F20: the seat promised "the required AGREE/S/Q block" and never emitted it,
  // so a genuine verified review was thrown away as a content-free
  // disagreement. The tier hands that answer straight back to the same seat.
  const fixture = goalFixture();
  const meta = 'Reviewed the seams and the coverage. Final user-visible answer is the required AGREE/S/Q block.';
  const seen = [];
  try {
    const result = await runDecomposeGoal({
      goalSpecPath: fixture.specPath, target: fixture.root, runId: 'd2-reask', rounds: 1,
      superpowers: VERIFIED_SUPERPOWERS,
      adapters: {
        ...adaptersFor([proposalText(goodTasks, goodMd)]),
        review: async (request) => {
          seen.push(request);
          return seen.length === 1 ? meta : 'AGREE: yes';
        },
      },
    });
    assert.equal(seen.length, 2, 'exactly one re-ask per seat per round');
    assert.equal(seen[1].repairContent, meta, 'the unparseable answer travels back verbatim');
    assert.equal(seen[1].tasks, seen[0].tasks, 'the re-ask asks the same question of the same proposal');
    assert.equal(seen[0].repairContent, undefined, 'the first ask is not a repair');
    assert.equal(result.converged, true, 'a repaired reading counts as the stance it states');
  } finally { fixture.cleanup(); }
});

test('a seat that never ran is rendered unavailable to the agreement judge, not as disagreement', async () => {
  const fixture = goalFixture();
  let agreementPrompt = null;
  const base = adaptersFor([proposalText(goodTasks, goodMd)]);
  try {
    await runDecomposeGoal({
      goalSpecPath: fixture.specPath, target: fixture.root, runId: 'd2-unavailable', rounds: 1,
      superpowers: VERIFIED_SUPERPOWERS,
      adapters: {
        ...base,
        review: async () => { throw new Error('cursor review seat failed to launch'); },
        runArbiter: async (args) => {
          if (args.request?.type === 'agreement') agreementPrompt = args.prompt;
          return base.runArbiter(args);
        },
      },
    });
    assert.match(agreementPrompt, /CURSOR_REVIEW \(stance: unavailable/);
    const cursorBlock = agreementPrompt.slice(agreementPrompt.indexOf('CURSOR_REVIEW'));
    assert.doesNotMatch(cursorBlock, /stated AGREE: no/);
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

const goalProposal = () => `<GOALS_JSON>${JSON.stringify([
  { id: 'G1', slug: 'mvp', statement: 'Smallest true version.', capability: 'runs end to end', dependsOn: [], rationale: 'MVP-first' },
  { id: 'G2', slug: 'reports', statement: 'Add reporting.', capability: 'reports', dependsOn: ['G1'], rationale: 'builds on G1' },
])}</GOALS_JSON>\n<GOALS_MD>## G1: mvp\nDeliver the smallest true version.\n\n## G2: reports\nAdd reporting on top of G1.\n</GOALS_MD>`;

test('a converged project writes the manifest and per-goal specs verbatim, write-once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'decomp1-'));
  try {
    const out = join(root, 'uro-project');
    const result = await runDecomposeProject({
      project: 'Build the demo product.', target: root, out, runId: 'd1-ok',
      superpowers: VERIFIED_SUPERPOWERS, adapters: adaptersFor([goalProposal()]),
    });
    assert.equal(result.converged, true);
    assert.equal(readFileSync(join(out, 'project.md'), 'utf8'), 'Build the demo product.\n');
    const manifest = JSON.parse(readFileSync(join(out, 'goals', 'goals.json'), 'utf8'));
    assert.deepEqual(manifest.map((goal) => goal.id), ['G1', 'G2']);
    assert.match(readFileSync(join(out, 'goals', 'G1-mvp', 'spec.md'), 'utf8'),
      /Deliver the smallest true version\./);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the tier-1 agreement prompt renders seat states the same way', async () => {
  const root = mkdtempSync(join(tmpdir(), 'decomp1-'));
  let agreementPrompt = null;
  const base = adaptersFor([goalProposal()]);
  try {
    await runDecomposeProject({
      project: 'Build the demo product.', target: root, out: join(root, 'uro-project'),
      runId: 'd1-states', rounds: 1, superpowers: VERIFIED_SUPERPOWERS,
      adapters: {
        ...base,
        review: async () => 'I think these goals are fine',
        runArbiter: async (args) => {
          if (args.request?.type === 'agreement') agreementPrompt = args.prompt;
          return base.runArbiter(args);
        },
      },
    });
    assert.match(agreementPrompt, /CURSOR_REVIEW \(stance: stance-unreadable/);
    assert.match(agreementPrompt, /I think these goals are fine/);
    assert.match(agreementPrompt, /CODEX_REVIEW \(stance: agree/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an unreadable tier-1 review stance is re-asked once too', async () => {
  const root = mkdtempSync(join(tmpdir(), 'decomp1-'));
  const seen = [];
  try {
    const result = await runDecomposeProject({
      project: 'Build the demo product.', target: root, out: join(root, 'uro-project'),
      runId: 'd1-reask', rounds: 1, superpowers: VERIFIED_SUPERPOWERS,
      adapters: {
        ...adaptersFor([goalProposal()]),
        review: async (request) => {
          seen.push(request);
          return seen.length === 1 ? 'These goals look right to me' : 'AGREE: yes';
        },
      },
    });
    assert.equal(seen.length, 2);
    assert.equal(seen[1].repairContent, 'These goals look right to me');
    assert.equal(result.converged, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a second convergence over the same --out collides loudly, write-once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'decomp1-'));
  try {
    const out = join(root, 'uro-project');
    const first = await runDecomposeProject({
      project: 'Build the demo product.', target: root, out, runId: 'd1-again-1',
      superpowers: VERIFIED_SUPERPOWERS, adapters: adaptersFor([goalProposal()]),
    });
    assert.equal(first.converged, true);
    await assert.rejects(() => runDecomposeProject({
      project: 'Build the demo product.', target: root, out, runId: 'd1-again-2',
      superpowers: VERIFIED_SUPERPOWERS, adapters: adaptersFor([goalProposal()]),
    }), /EEXIST|already exists/i, 'write-once: a second convergence collides loudly');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a goal dependency cycle goes back as feedback and the repaired round converges', async () => {
  const root = mkdtempSync(join(tmpdir(), 'decomp1-'));
  const cyclicGoals = [
    { id: 'G1', slug: 'a', statement: 'A.', capability: 'a', dependsOn: ['G2'], rationale: 'x' },
    { id: 'G2', slug: 'b', statement: 'B.', capability: 'b', dependsOn: ['G1'], rationale: 'x' },
  ];
  const cyclicProposal = `<GOALS_JSON>${JSON.stringify(cyclicGoals)}</GOALS_JSON>\n<GOALS_MD>## G1: a\nx\n\n## G2: b\nx\n</GOALS_MD>`;
  try {
    const out = join(root, 'uro-project');
    const result = await runDecomposeProject({
      project: 'Build the demo product.', target: root, out, runId: 'd1-cycle',
      superpowers: VERIFIED_SUPERPOWERS,
      adapters: adaptersFor([cyclicProposal, goalProposal()]),
    });
    assert.equal(result.converged, true, 'the cycle repaired through feedback, not refusal');
    assert.equal(result.rounds, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('goals.json keeps the proposal order verbatim — never re-sorted by id or topology', async () => {
  // Case 1 (the spec's own construction): G2 lists first with no deps, G1
  // lists second depending (backward) on G2. A topological OR an id sort
  // would both put G1 first. The written manifest must match neither — it
  // must match the proposal, [G2, G1].
  const rootA = mkdtempSync(join(tmpdir(), 'decomp1-'));
  const outOfOrderGoals = [
    { id: 'G2', slug: 'reports', statement: 'Add reporting.', capability: 'reports', dependsOn: [], rationale: 'independent' },
    { id: 'G1', slug: 'mvp', statement: 'Smallest true version.', capability: 'runs end to end', dependsOn: ['G2'], rationale: 'MVP-first' },
  ];
  const outOfOrderProposal = `<GOALS_JSON>${JSON.stringify(outOfOrderGoals)}</GOALS_JSON>\n<GOALS_MD>## G2: reports\nAdd reporting.\n\n## G1: mvp\nDeliver the smallest true version.\n</GOALS_MD>`;
  try {
    const out = join(rootA, 'uro-project');
    const result = await runDecomposeProject({
      project: 'Build the demo product.', target: rootA, out, runId: 'd1-order-a',
      superpowers: VERIFIED_SUPERPOWERS, adapters: adaptersFor([outOfOrderProposal]),
    });
    assert.equal(result.converged, true);
    const manifest = JSON.parse(readFileSync(join(out, 'goals', 'goals.json'), 'utf8'));
    assert.deepEqual(manifest.map((goal) => goal.id), ['G2', 'G1'],
      "the seats' own order is the manifest order, never a topological or id re-sort");
  } finally { rmSync(rootA, { recursive: true, force: true }); }

  // Case 2: proposal order [G1, G2, G3], G2 depends (backward, validly) on
  // G1, G3 depends on nothing. A layered topological sort pushes G3 ahead of
  // G2 — both G1 and G3 are "ready" in the same first pass, G2 only becomes
  // ready a layer later — even though nothing here is out of order. This is
  // the exact silent re-sort the fix removes, on a manifest with no forward
  // dependency at all.
  const rootB = mkdtempSync(join(tmpdir(), 'decomp1-'));
  const threeGoals = [
    { id: 'G1', slug: 'mvp', statement: 'MVP.', capability: 'mvp', dependsOn: [], rationale: 'smallest' },
    { id: 'G2', slug: 'increment', statement: 'Increment on MVP.', capability: 'increment', dependsOn: ['G1'], rationale: 'builds on G1' },
    { id: 'G3', slug: 'extra', statement: 'Independent extra.', capability: 'extra', dependsOn: [], rationale: 'independent of G2' },
  ];
  const threeGoalsProposal = `<GOALS_JSON>${JSON.stringify(threeGoals)}</GOALS_JSON>\n<GOALS_MD>## G1: mvp\nx\n\n## G2: increment\nx\n\n## G3: extra\nx\n</GOALS_MD>`;
  try {
    const out = join(rootB, 'uro-project');
    const result = await runDecomposeProject({
      project: 'Build the demo product.', target: rootB, out, runId: 'd1-order-b',
      superpowers: VERIFIED_SUPERPOWERS, adapters: adaptersFor([threeGoalsProposal]),
    });
    assert.equal(result.converged, true);
    const manifest = JSON.parse(readFileSync(join(out, 'goals', 'goals.json'), 'utf8'));
    assert.deepEqual(manifest.map((goal) => goal.id), ['G1', 'G2', 'G3'],
      'a valid, non-cyclic, non-forward-dependent manifest is never reflowed by topological layering either');
  } finally { rmSync(rootB, { recursive: true, force: true }); }
});

test('a goal depending on a later goal is a contradiction fed back, not silently reordered', async () => {
  const root = mkdtempSync(join(tmpdir(), 'decomp1-'));
  const forwardDepGoals = [
    { id: 'G1', slug: 'a', statement: 'A.', capability: 'a', dependsOn: ['G2'], rationale: 'x' },
    { id: 'G2', slug: 'b', statement: 'B.', capability: 'b', dependsOn: [], rationale: 'x' },
  ];
  const forwardDepProposal = `<GOALS_JSON>${JSON.stringify(forwardDepGoals)}</GOALS_JSON>\n<GOALS_MD>## G1: a\nx\n\n## G2: b\nx\n</GOALS_MD>`;
  const base = adaptersFor([forwardDepProposal, goalProposal()]);
  const proposePrompts = [];
  try {
    const out = join(root, 'uro-project');
    const result = await runDecomposeProject({
      project: 'Build the demo product.', target: root, out, runId: 'd1-forward-dep',
      superpowers: VERIFIED_SUPERPOWERS,
      adapters: {
        ...base,
        runArbiter: async (args) => {
          if (args.request?.type === 'propose') proposePrompts.push(args.prompt);
          return base.runArbiter(args);
        },
      },
    });
    assert.equal(result.converged, true, 'the forward dependency repaired through feedback, not refusal');
    assert.equal(result.rounds, 2);
    assert.match(
      proposePrompts[1],
      /G1 depends on later goal G2 — goals are MVP-first and dependency-ordered; reorder or re-scope/,
      "the writer-found contradiction reaches round 2's proposing seat verbatim",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('project.md copies a --project file input byte-for-byte, no trim, no appended newline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'decomp1-'));
  const projectFile = join(root, 'PROJECT-input.md');
  const rawContent = '\nBuild it.\n\n';
  writeFileSync(projectFile, rawContent);
  try {
    const out = join(root, 'uro-project');
    const result = await runDecomposeProject({
      project: projectFile, target: root, out, runId: 'd1-verbatim',
      superpowers: VERIFIED_SUPERPOWERS, adapters: adaptersFor([goalProposal()]),
    });
    assert.equal(result.converged, true);
    assert.equal(readFileSync(join(out, 'project.md'), 'utf8'), rawContent,
      'a project FILE is copied exactly — not trimmed, not given an appended newline');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('validateDecomposeProjectRequest: an existing directory is not silently read as prose', () => {
  const root = mkdtempSync(join(tmpdir(), 'decomp1-'));
  try {
    assert.throws(
      () => validateDecomposeProjectRequest({ project: root, target: root, out: join(root, 'out') }),
      /project path is not a file/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('validateDecomposeProjectRequest: a path-shaped but missing --project names the mistake', () => {
  const root = mkdtempSync(join(tmpdir(), 'decomp1-'));
  try {
    assert.throws(
      () => validateDecomposeProjectRequest({
        project: './definitely-missing.md', target: root, out: join(root, 'out'),
      }),
      /project file not found/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('writeTier1Artifacts rollback removes the empty per-goal directory it created', () => {
  const root = mkdtempSync(join(tmpdir(), 'decomp1-'));
  try {
    const out = join(root, 'uro-project');
    const goalsDir = join(out, 'goals');
    // Pre-seed G2's directory as if a prior convergence already wrote it: this
    // call's write to G2-b/spec.md collides (EEXIST) AFTER it has already
    // freshly created and written G1-a/spec.md.
    mkdirSync(join(goalsDir, 'G2-b'), { recursive: true });
    writeFileSync(join(goalsDir, 'G2-b', 'spec.md'), 'already here\n');
    const items = [
      { id: 'G1', slug: 'a', statement: 'A.', capability: 'a', dependsOn: [], rationale: 'x' },
      { id: 'G2', slug: 'b', statement: 'B.', capability: 'b', dependsOn: [], rationale: 'x' },
    ];
    const sections = new Map([['G1', 'goal one'], ['G2', 'goal two']]);
    assert.throws(
      () => writeTier1Artifacts(out, { text: 'Build it.', source: null }, { items, sections }),
      /EEXIST|already exists/i,
    );
    assert.equal(existsSync(join(goalsDir, 'G1-a')), false,
      'the freshly-created, now-empty G1 directory is rolled back, not left behind');
    assert.equal(readFileSync(join(goalsDir, 'G2-b', 'spec.md'), 'utf8'), 'already here\n',
      'a pre-existing directory this call did not create is left completely alone');
  } finally { rmSync(root, { recursive: true, force: true }); }
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

test('cursor seat instructions travel as a workspace file, never argv', async () => {
  // The first dogfood decompose run (2026-09-02): every Cursor call was refused
  // by assertUsablePrompt because the instructions carried double quotes on
  // argv, and a three-seat debate silently ran with two. Instructions now ride
  // INSTRUCTIONS.md in the seat workspace; argv carries only the pointer.
  let body = null;
  let argvPrompt = null;
  const result = await cursorSeatCall({
    files: { 'GOAL_SPEC.md': 'spec quoting "the law"\n' },
    instructions: (workspace) => [
      'obey the law verbatim: "no determinism anywhere a decision is made"',
      'Return exactly <TASKS_JSON>[{"id":"T1"}]</TASKS_JSON>',
      `Read the goal from ${join(workspace, 'GOAL_SPEC.md')}.`,
    ],
    target: '.',
    verifierModel: 'test-model',
    timeoutMs: 50,
    verify: async ({ prompt }) => {
      argvPrompt = prompt;
      assertUsablePrompt(prompt);
      const instructionsPath = prompt
        .replace(/^Read /, '')
        .replace(/ and obey it completely.*$/, '');
      body = readFileSync(instructionsPath, 'utf8');
      return { findings: 'seen', plan: '', usage: { inputTokens: 1 } };
    },
  });
  assert.equal(result.findings, 'seen');
  assert.doesNotMatch(argvPrompt, /"/);
  assert.doesNotMatch(argvPrompt, /[\r\n]/);
  assert.match(body, /"no determinism anywhere a decision is made"/);
  assert.match(body, /\{"id":"T1"\}/);
  assert.match(body, /GOAL_SPEC\.md/);
});

test('no decompose cursor call bypasses the guarded seam', () => {
  const source = readFileSync(new URL('../src/decompose.js', import.meta.url), 'utf8');
  assert.equal(source.includes('runVerifier({'), false,
    'cursor prompts must go through cursorSeatCall, whose argv pointer satisfies assertUsablePrompt');
});
