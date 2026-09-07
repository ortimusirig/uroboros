import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTaggedPair, runDecomposeGoal, runDecomposeProject, topologicalOrder,
  validateDecomposeProjectRequest, writeTier1Artifacts } from '../src/decompose.js';
import { parseArgs } from '../src/args.js';
import { RepairableArtifactError } from '../src/conversation.js';
const superpowers={seats:{codex:{verified:true},claude:{verified:true}}};
const proposalText = (tasksJson, tasksMd) => `<TASKS_JSON>${JSON.stringify(tasksJson)}</TASKS_JSON>\n<TASKS_MD>${tasksMd}</TASKS_MD>`;
const goodTasks = [
  { id: 'T1', name: 'T1-first', dependsOn: [], gate: [{ bin: 'node', args: ['--test'] }] },
  { id: 'T2', name: 'T2-second', dependsOn: ['T1'], gate: [{ bin: 'node', args: ['--test'] }] },
];
const goodMd = '## T1: first\nTitle: first\nRequired behavior: A.\nTest requirements: t.\n\n## T2: second\nTitle: second\nRequired behavior: B.\nTest requirements: t.\n';


const VERIFIED_SUPERPOWERS = { seats: { codex: { verified: true }, claude: { verified: true } } };
function adaptersFor(proposals) {
  let turn=0;
  return {
    runArbiter: async () => ({ answer: 'AGREE: yes\n' + proposals[Math.min(turn++,proposals.length-1)] }),
    runExecutor: async r => ({ exitCode:0, lastMessage:'AGREE: yes\nARTIFACT_DIGEST: '
      + /ARTIFACT_DIGEST: ([a-f0-9]{64})/.exec(r.plan)?.[1] }),
  };
}

function goalFixture(){
 const root=mkdtempSync(join(tmpdir(),'two-agent-decomp-'));
 const goalDir=join(root,'uro-project','goals','G1-demo');
 mkdirSync(goalDir,{recursive:true});
 const specPath=join(goalDir,'spec.md');
 writeFileSync(specPath,'# Goal\nOriginal specification with "quotes"\n');
 return {root,goalDir,specPath,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
const taskText=(suffix='')=>'AGREE: yes\n<TASKS_JSON>[{"id":"T1","name":"T1-first","dependsOn":[],"gate":[{"bin":"node","args":["--test"]}]}]</TASKS_JSON>\n<TASKS_MD>## T1: first\nTitle: first\nRequired behavior: '+suffix+'\nTest requirements: tests.\n</TASKS_MD>';
const goalsText=(suffix='')=>'AGREE: yes\n<GOALS_JSON>[{"id":"G1","slug":"first","statement":"Deliver first","capability":"first","dependsOn":[],"rationale":"MVP"}]</GOALS_JSON>\n<GOALS_MD>## G1: first\nA usable increment '+suffix+'\n</GOALS_MD>';
for(const tier of ['goal','project']){
 test(tier+' decomposition delivers verbatim debate to Claude and reviews revisions before writing',async t=>{
  const f=goalFixture(); t.after(f.cleanup);
  let authors=0,reviews=0;
  const run=tier==='goal'?runDecomposeGoal:runDecomposeProject;
  const result=await run({target:f.root,goalSpecPath:f.specPath,project:'Build the project',out:join(f.root,'project'),
   superpowers,adapters:{
    runArbiter:async r=>{
     authors++;
     if(authors===2) assert.match(r.prompt,/S1 P1: Preserve "quotes"\nRetain this line/);
     return {answer:(tier==='goal'?taskText:goalsText)(authors===1?'first':'revised')};
    },
    runExecutor:async r=>{
     reviews++;
     assert.equal(r.sandbox,'read-only');
     if(reviews===2) assert.match(r.plan,/revised/);
     return {exitCode:0,lastMessage:(reviews===1?'AGREE: no\nS1 P1: Preserve "quotes"\nRetain this line':'AGREE: yes')+
      '\nARTIFACT_DIGEST: '+/ARTIFACT_DIGEST: ([a-f0-9]{64})/.exec(r.plan)?.[1]};
    },
   }});
  assert.equal(result.approved,true);
  assert.equal(result.approval.basis,'consensus');
  assert.equal(authors,2);
  assert.equal(existsSync(tier==='goal'?join(f.goalDir,'tasks','T1-plan.md'):join(f.root,'project','goals','goals.json')),true);
 });
 test(tier+' manual dispute preserves the canonical artifact and raw transcript for resume',async t=>{
  const f=goalFixture();t.after(f.cleanup);
  const run=tier==='goal'?runDecomposeGoal:runDecomposeProject;
  const result=await run({target:f.root,goalSpecPath:f.specPath,project:'Build the project',out:join(f.root,'project'),
   superpowers,adapters:{
    runArbiter:async()=>({answer:(tier==='goal'?taskText:goalsText)()}),
    runExecutor:async r=>({exitCode:0,lastMessage:'AGREE: no\nS1 P1: unresolved\nARTIFACT_DIGEST: '
      +/ARTIFACT_DIGEST: ([a-f0-9]{64})/.exec(r.plan)?.[1]}),
   }});
  assert.equal(result.reason,'needs-decision');
  assert.equal(result.approved,false);
  const saved=JSON.parse(JSON.stringify(result.checkpointState));
  assert.equal(saved.tier,tier);
  assert.equal(saved.proposal.items[0].id,tier==='goal'?'T1':'G1');
  assert.ok(saved.proposal.sections);
  assert.equal(saved.messages.length,4);
 });
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
      proposePrompts[0],
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
