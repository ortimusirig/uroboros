import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runPlan } from '../src/plan.js';
import { runQueue, continueQueue, loadQueueFile } from '../src/queue.js';
import { run as runExecution } from '../src/run.js';
import { runDecomposeProject, runDecomposeGoal } from '../src/decompose.js';
import { resumeRun } from '../src/resume.js';
import { checkpointDigest } from '../src/checkpoint.js';
import { planningEnvelope, planningApproval } from './fixtures/planning-responses.js';
import { createInspectionReceipt, captureEvidence } from '../src/context-evidence.js';
import { landQueueDiff } from '../src/queue-runtime.js';
import { withVerifiedSuperpowers } from '../fixtures/verified-superpowers.mjs';

const superpowers = { seats: { claude: { verified: true }, codex: { verified: true } } };
const usage = { inputTokens: 1, outputTokens: 1 };
function fixture(t) {
  fs.mkdirSync('C:/ccc-test', { recursive: true });
  const root = fs.mkdtempSync(join('C:/ccc-test', 'final-planning-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'target'); fs.mkdirSync(target);
  fs.writeFileSync(join(target, 'source.js'), 'export const preserved = true;\n');
  return { root, target, out: join(root, 'project'), artifactRoot: join(root, 'artifacts'), superpowers };
}
function decomposition(f, tier, adapters, extra = {}) {
  const goalDir = join(f.root, 'hierarchy', 'goals', 'G1-demo'); fs.mkdirSync(goalDir, { recursive: true });
  const goalSpecPath = join(goalDir, 'spec.md');
  const project = join(f.root, 'project-input.md');
  fs.writeFileSync(goalSpecPath, 'Preserve source behavior.'); fs.writeFileSync(project, 'Preserve source behavior.');
  const proposal = tier === 'goal'
    ? '<TASKS_JSON>[{"id":"T1","name":"T1-first","dependsOn":[],"gate":[]}]</TASKS_JSON><TASKS_MD>## T1: first\nTitle: first\nRequired behavior: preserve.\nTest requirements: tests.\n</TASKS_MD>'
    : '<GOALS_JSON>[{"id":"G1","slug":"first","statement":"Preserve behavior","capability":"first","dependsOn":[],"rationale":"MVP"}]</GOALS_JSON><GOALS_MD>## G1: first\nA usable increment\n</GOALS_MD>';
  return { source: tier === 'goal' ? goalSpecPath : project, proposal,
    run: options => (tier === 'goal' ? runDecomposeGoal : runDecomposeProject)({ ...f, goalSpecPath, project, ...extra, ...options, adapters }) };
}

for (const tier of ['project', 'goal']) test(`final integration ${tier} technical checkpoint continues completed planning through public resume`, async t => {
  const f = fixture(t); let authors = 0, reviews = 0, armed = false;
  const originalExists = fs.existsSync;
  t.mock.method(fs, 'existsSync', path => {
    if (armed && String(path) === join(f.target, 'source.js')) { armed = false; return false; }
    return originalExists(path);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const d = decomposition(f, tier, {
    author: r => { authors++; return { answer: d.proposal, dialogue: planningEnvelope(r, 'propose'), usage }; },
    reviewer: r => { reviews++; armed = true; return { dialogue: planningEnvelope(r, 'inspect', { requests: [{ path: 'source.js', line: 1, claimIds: [] }] }), usage }; },
  });
  const pending = await d.run();
  assert.equal(pending.action, 'paused', pending.reason);
  assert.match(pending.reason, /inspection source/);
  assert.equal(fs.existsSync(join(pending.out, 'uro-checkpoint.json')), true, 'technical pause must publish a resumable checkpoint');
  const saved = JSON.parse(fs.readFileSync(join(pending.out, 'uro-checkpoint.json'), 'utf8'));
  assert.ok(saved.references.some(ref => ref.path.replaceAll('\\', '/').toLowerCase() === d.source.replaceAll('\\', '/').toLowerCase()));
  const resumed = await resumeRun({ runDirectory: pending.out, technicalContinue: true, adapters: {
    author: () => assert.fail('completed proposal must not replay'),
    reviewer: r => { reviews++; assert.match(r.input, /export const preserved = true/); return { ...planningApproval(r), usage }; },
  } });
  assert.equal(resumed.approved, true, resumed.reason);
  assert.equal(authors, 1); assert.equal(reviews, 2);
  assert.equal(resumed.rounds, 1); assert.equal(resumed.resources.providerLaunches, 3);
  assert.deepEqual(resumed.resources.knownUsage, { inputTokens: 3, outputTokens: 3 });
});

for (const recovery of ['direct', 'planning', 'execution', 'landed-log', 'landed-return', 'prior-landed', 'next-unit']) test(`final integration goal queue ${recovery} delivers current native planning history to both execution seats`, async t => {
  const landed = ['landed-log', 'landed-return', 'prior-landed'].includes(recovery);
  const f = fixture(t), git = (...args) => execFileSync('git', ['-C', f.target, ...args], { encoding: 'utf8', windowsHide: true });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  git('add', '.'); git('commit', '-qm', 'base');
  const file = join(f.root, 'queue.json'); fs.writeFileSync(file, JSON.stringify([{ name: 'native-goal', goal: 'Preserve behavior', out: 'planned' },
    ...(recovery === 'next-unit' ? [{ name: 'next-goal', goal: 'Preserve next behavior', out: 'planned-next' }] : [])]));
  const loadedQueue = loadQueueFile(file);
  const marker = 'PLANNING_ONLY_DIALOGUE_ZEBRA_4729';
  let planning, facts, firstPlanningDigest, planCalls = 0, executionCalls = 0, reviews = 0; const inputs = [];
  const dependencies = {
    assertCleanTarget: async () => {},
    launchPlan: async r => { planCalls++; planning = await runPlan({ ...f, goal: r.unit.goal, out: r.unit.out,
      contextRef: r.contextRef, interactionMode: recovery === 'planning' ? 'manual' : 'autonomous', adapters: {
        author: r => {
          const evidence = captureEvidence({ projectId: r.state.projectId, root: f.target, directory: join(r.state.scope.evidenceRoots[0]),
            evidence: { id: 'planning-source', kind: 'code', projectId: r.state.projectId, claimIds: [], locator: { path: 'source.js', line: 1 }, sourceIdentity: r.state.snapshot.sourceRevision } });
          return { plan: 'Preserve behavior', gate: [], dialogue: planningEnvelope(r, 'propose', { content: `${marker}:unit-${planCalls}`,
            privateOptions: { reasoning: 'DO_NOT_DELIVER_PRIVATE_ENVELOPE' },
            issues: [{ id: 'optional-note', title: 'Attributed optional note', status: 'open', blocking: false, claimIds: [],
              privateOptions: { trace: 'DO_NOT_DELIVER_PRIVATE_NESTED' } }],
            next: { seat: 'codex', action: 'verify', reason: 'Review the current plan', privateOptions: { trace: 'DO_NOT_DELIVER_PRIVATE_NEXT' } },
          }), usage,
            opaqueProviderField: 'DO_NOT_PROMPT_TRANSPORT_RAW',
            observations: { evidence: [evidence], receipts: [] } };
        },
        reviewer: r => recovery === 'planning'
          ? { dialogue: planningEnvelope(r, 'decide', { issues: [{ id: 'risk', title: 'Known disputed option', status: 'disputed', blocking: true, claimIds: [] }] }), usage }
          : { ...planningApproval(r), usage },
      } }); firstPlanningDigest ??= planning.approval?.contextDigest; return planning; },
    launchRun: async r => {
      executionCalls++;
      facts = await runExecution(withVerifiedSuperpowers({ target: f.target, scratchRoot: join(f.root, 'scratch'), artifactRoot: f.artifactRoot,
        runId: `handoff-execution-${r.unit.index}`, task: fs.readFileSync(r.unit.task, 'utf8'), gate: [], mode: 'autonomous', contextRef: r.contextRef,
        adapters: {
          runExecutor: request => { inputs.push({ seat: 'codex', input: request.plan ?? request.input, planningDigest: r.contextRef.planningHandoff.contextDigest });
            if (landed || recovery === 'next-unit' && r.unit.index === 1) fs.writeFileSync(join(request.cwd, 'source.js'), 'export const preserved = "landed";\n');
            return { dialogue: planningEnvelope(request, 'propose', { content: `EXECUTION_ORDINARY_UNIT_${r.unit.index}`,
              ...(recovery === 'next-unit' && r.unit.index === 1 ? { privateOptions: { reasoning: 'PRIVATE_PRIOR_EXECUTION_ONLY' } } : {}) }), usage }; },
          runReview: request => {
            reviews++;
            inputs.push({ seat: 'claude', input: request.prompt, planningDigest: r.contextRef.planningHandoff.contextDigest });
            if (recovery === 'execution' && reviews === 1) return { dialogue: planningEnvelope(request, 'ask', {
              issues: [{ id: 'product', title: 'Choose the product option', kind: 'product', needsHuman: true, status: 'open', blocking: true, claimIds: [] }],
            }), usage };
            const evidence = request.state.evidence.find(e => e.id === 'requirement-briefing'); fs.readFileSync(evidence.capturedPath);
            const receipt = createInspectionReceipt({ operationId: request.operationId, seat: 'claude', evidence: [evidence], inspected: true, result: 'read' });
            return { dialogue: planningEnvelope(request, 'approve', {
              claims: [{ id: 'briefing-requirement', kind: 'fact', text: 'The saved briefing was read.', evidenceIds: [evidence.id] }],
              verifications: [{ claimId: 'briefing-requirement', evidenceIds: [evidence.id], inspectionReceiptIds: [receipt.id], result: 'supports', reason: 'Read briefing.' }],
            }), observations: { evidence: [], receipts: [receipt] }, usage };
          },
        } })); return { runDirectory: facts.dir };
    }, readRunFacts: async () => facts,
    judgeLanding: async ({ unit }) => ({ approved: landed || recovery === 'next-unit' && unit.index === 1, reasoning: 'Fixture landing judgement', usage }),
    landDiff: landQueueDiff,
    ...(landed ? { appendLog: (_path, record) => { if (record.landed) throw new Error('lost landed log'); } } : {}),
  };
  let result;
  if (landed) {
    await assert.rejects(runQueue({ file, target: f.target, mode: 'autonomous', dependencies }).then(value => { throw new Error('queue returned: ' + JSON.stringify(value.stop)); }), /lost landed log/);
    const journalPath = fs.readdirSync(join(f.root, '__uro_context')).find(name => name.endsWith('-queue.json'));
    const journal = JSON.parse(fs.readFileSync(join(f.root, '__uro_context', journalPath), 'utf8'));
    assert.equal(journal.units[1].logged, undefined);
    assert.ok(journal.units[1].landing.commit);
    if (recovery === 'landed-return') delete journal.units[1].landing;
    if (recovery === 'prior-landed') {
      journal.units[1].logged = true;
      journal.units[1].afterUnit = { attemptedCount: 1, landedCount: 1, totalTokens: { inputTokens: 5, outputTokens: 5, total: 10 } };
    }
    result = await continueQueue({ context: { queue: loadedQueue, fileDigest: checkpointDigest(fs.readFileSync(file, 'utf8')),
      unitIndex: 1, phase: 'execution', planResult: planning, attemptedCount: 0, landedCount: 0,
      totalTokens: { inputTokens: 0, outputTokens: 0, total: 0 }, options: { file, target: f.target, mode: 'autonomous' } },
      journal, phaseResult: facts, runDirectory: facts.dir, dependencies: { ...dependencies, appendLog: undefined,
        launchPlan: () => assert.fail('completed plan cannot replay'), launchRun: () => assert.fail('completed execution cannot replay'),
        judgeLanding: () => assert.fail('completed landing judgement cannot replay'),
        landDiff: recovery === 'landed-return' ? landQueueDiff : () => assert.fail('completed landing cannot replay') } });
    assert.equal(result.stop, null, result.stop?.reason);
    assert.equal(git('rev-list', '--count', 'HEAD').trim(), '2');
    assert.equal(result.totalTokens.total, 10, 'recovered planning, execution and landing are debited exactly once');
  } else result = await runQueue({ file, target: f.target, mode: recovery === 'planning' ? 'manual' : 'autonomous', dependencies });
  if (['planning', 'execution'].includes(recovery)) {
    const directory = recovery === 'planning' ? planning.out : facts.dir;
    const checkpoint = JSON.parse(fs.readFileSync(join(directory, 'uro-checkpoint.json'), 'utf8'));
    if (recovery === 'execution') {
      const reference = checkpoint.continuation.options.contextRef;
      assert.ok(reference?.planningHandoff, 'execution checkpoint retains the exact required handoff reference');
      const bytes = fs.readFileSync(reference.path);
      fs.unlinkSync(reference.path);
      const answerFile = join(f.root, 'missing-handoff-answer.json');
      fs.writeFileSync(answerFile, JSON.stringify({ schemaVersion: 1, runId: checkpoint.runId, artifactDigest: checkpoint.artifactDigest,
        answers: [{ id: checkpoint.pending.questions[0].id, answer: 'approve: preserve behavior.' }] }));
      await assert.rejects(resumeRun({ runDirectory: directory, decisionFile: answerFile, adapters: {
        runExecutor: () => assert.fail('missing handoff must refuse before launch'), runReview: () => assert.fail('missing handoff must refuse before launch'),
      } }), /ENOENT|handoff|context/i);
      fs.writeFileSync(reference.path, bytes);
    }
    const decisionFile = join(f.root, 'answer.json');
    fs.writeFileSync(decisionFile, JSON.stringify({ schemaVersion: 1, runId: checkpoint.runId, artifactDigest: checkpoint.artifactDigest,
      answers: [{ id: checkpoint.pending.questions[0].id, answer: 'approve: preserve behavior.' }] }));
    const resumed = await resumeRun({ runDirectory: directory, decisionFile, queueDependencies: dependencies, adapters: {
      author: () => assert.fail('completed planning author cannot replay'), reviewer: () => assert.fail('direct human planning approval has no extra inference'),
      runExecutor: () => assert.fail('completed execution writer cannot replay'),
      runReview: request => {
        reviews++; inputs.push({ seat: 'claude', input: request.prompt });
        const evidence = request.state.evidence.find(e => e.id === 'requirement-briefing'); fs.readFileSync(evidence.capturedPath);
        const receipt = createInspectionReceipt({ operationId: request.operationId, seat: 'claude', evidence: [evidence], inspected: true, result: 'read' });
        return { usage, observations: { evidence: [], receipts: [receipt] }, dialogue: planningEnvelope(request, 'approve', {
          claims: [{ id: 'briefing-requirement', kind: 'fact', text: 'The saved briefing was read.', evidenceIds: [evidence.id] }],
          verifications: [{ claimId: 'briefing-requirement', evidenceIds: [evidence.id], inspectionReceiptIds: [receipt.id], result: 'supports', reason: 'Read briefing.' }],
          issues: [{ id: 'product', status: 'resolved', disposition: { kind: 'accepted', reason: 'The human selected this option.', claimIds: ['briefing-requirement'] } }],
        }) };
      },
    } });
    if (recovery === 'planning') planning = resumed;
    result = resumed.queueResult;
    assert.ok(result, `public resume continues the attached queue: ${resumed.reason ?? resumed.outcome} ${resumed.checkpointState?.dialogue?.technicalPause?.reason ?? ''}`);
  }
  assert.equal(planCalls, recovery === 'next-unit' ? 2 : 1); assert.equal(executionCalls, recovery === 'next-unit' ? 2 : 1, result.stop?.reason);
  assert.equal(result.stop?.kind ?? null, landed ? null : 'final-review', result.stop?.reason);
  assert.equal(inputs.length, recovery === 'execution' ? 3 : recovery === 'next-unit' ? 4 : 2, result.stop?.reason);
  for (const { seat, input, planningDigest } of inputs) {
    assert.match(input, new RegExp(marker), `${seat} receives planning-only history`);
    assert.ok(input.includes(planningDigest ?? planning.approval.contextDigest), `${seat} receives approval-bound planning context identity`);
    assert.match(input, /journalIdentity/); assert.match(input, /inspectionReceipts/);
    assert.match(input, /export const preserved = true/);
    assert.doesNotMatch(input, /DO_NOT_PROMPT_TRANSPORT_RAW/);
    assert.doesNotMatch(input, /DO_NOT_DELIVER_PRIVATE_/);
    assert.match(input, /Attributed optional note/);
  }
  if (recovery === 'next-unit') for (const { seat, input } of inputs.slice(2)) {
    assert.ok(input.includes(`${marker}:unit-1`), `${seat} retains earlier ordinary planning dialogue`);
    assert.ok(input.includes(firstPlanningDigest), `${seat} retains earlier approval-bound identity`);
    assert.match(input, /EXECUTION_ORDINARY_UNIT_1/);
    assert.doesNotMatch(input, /PRIVATE_PRIOR_EXECUTION_ONLY/);
  }
});

for (const tier of ['project', 'goal']) for (const refusal of ['human', 'uncertain', 'source', 'integrity', 'rounds']) {
  test(`final integration ${tier} public technical resume refuses ${refusal}`, async t => {
    const f = fixture(t); let calls = 0;
    const d = decomposition(f, tier, {
      author: r => { calls++; if (refusal === 'uncertain') throw new Error('lost provider completion');
        return { answer: d.proposal, dialogue: planningEnvelope(r, 'propose'), usage }; },
      reviewer: r => { calls++; return { usage, dialogue: planningEnvelope(r,
        refusal === 'human' ? 'decide' : refusal === 'rounds' ? 'ask' : 'inspect',
        refusal === 'human' ? { issues: [{ id: 'risk', title: 'Human dispute', status: 'disputed', blocking: true, claimIds: [] }] }
          : refusal === 'rounds' ? { next: { seat: 'claude', action: 'revise', reason: 'Another proposal requested' } }
            : { requests: [{ path: 'missing.js', line: 1, claimIds: [] }] }) }; },
    }, refusal === 'rounds' ? { rounds: 1 } : {});
    const pending = await d.run();
    assert.equal(fs.existsSync(join(pending.out, 'uro-checkpoint.json')), true, pending.reason);
    const before = calls;
    if (refusal === 'source') fs.writeFileSync(d.source, 'Changed source requirement.');
    if (refusal === 'integrity') fs.appendFileSync(join(pending.out, '__uro_dialogue', 'journal.jsonl'), '\ncorrupt');
    await assert.rejects(resumeRun({ runDirectory: pending.out, technicalContinue: true, adapters: {
      author: () => assert.fail('refused continuation must not launch'), reviewer: () => assert.fail('refused continuation must not launch'),
    } }), /human decision|uncertain|reconciliation|changed|journal|unsafe technical|limit|manifest/i);
    assert.equal(calls, before);
  });
}

for (const corruption of ['missing-native-state', 'stale-source', 'altered-journal', 'cross-project', 'out-of-scope', 'altered-context-digest']) {
  test(`final integration queued native handoff refuses ${corruption} before execution`, async t => {
    const f = fixture(t), file = join(f.root, 'queue.json');
    fs.writeFileSync(file, JSON.stringify([{ name: 'native', goal: 'Preserve behavior', out: 'planned' }]));
    let executions = 0;
    const result = await runQueue({ file, target: f.target, mode: 'autonomous', dependencies: {
      assertCleanTarget: async () => {}, launchRun: () => { executions++; assert.fail('invalid required handoff must refuse execution'); },
      launchPlan: async r => {
        const plan = await runPlan({ ...f, goal: r.unit.goal, out: r.unit.out, interactionMode: 'autonomous', contextRef: r.contextRef, adapters: {
          author: request => {
            const evidence = captureEvidence({ projectId: request.state.projectId, root: f.target, directory: request.state.scope.evidenceRoots[0],
              evidence: { id: 'required-source', kind: 'code', projectId: request.state.projectId, claimIds: [], locator: { path: 'source.js', line: 1 }, sourceIdentity: request.state.snapshot.sourceRevision } });
            return { plan: 'Preserve behavior', gate: [], dialogue: planningEnvelope(request, 'propose'), observations: { evidence: [evidence], receipts: [] }, usage };
          }, reviewer: request => ({ ...planningApproval(request), usage }),
        } });
        assert.equal(plan.approved, true, plan.reason);
        if (corruption === 'missing-native-state') delete plan.checkpointState;
        if (corruption === 'stale-source') fs.writeFileSync(join(f.target, 'source.js'), 'changed source');
        if (corruption === 'altered-journal') fs.appendFileSync(join(plan.out, '__uro_dialogue', 'journal.jsonl'), '\nchanged');
        if (corruption === 'cross-project') plan.sharedContext = { ...plan.sharedContext, projectId: 'foreign-project' };
        if (corruption === 'out-of-scope') plan.planningArtifacts = { ...plan.planningArtifacts, directory: join(f.root, 'foreign') };
        if (corruption === 'altered-context-digest') plan.sharedContext = { ...plan.sharedContext, digest: '0'.repeat(64) };
        return plan;
      },
    } });
    assert.equal(executions, 0);
    assert.equal(result.stop?.kind, 'run-failed', result.stop?.reason);
    assert.match(result.stop.reason, /handoff|scope|manifest|stale|identity|context/i);
  });
}
