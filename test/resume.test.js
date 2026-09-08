import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlan as runNewPlan } from '../src/plan.js';
import { scriptedPlanningAdapters, scriptedFreshPlanningAdapters } from './fixtures/planning-responses.js';
const runPlan = options => runNewPlan({ artifactRoot: join(tmpdir(), 'uro-task3-fixture-artifacts'), ...options, adapters: scriptedPlanningAdapters(options.adapters ?? {}) });
import { planningArtifactDigest } from '../src/conversation.js';
import { withVerifiedSuperpowers } from '../fixtures/verified-superpowers.mjs';
import { run as executeRun } from '../src/run.js';
const run = options => executeRun({ ...options, env: { ...process.env, ...options.env,
  URO_ARTIFACT_ROOT: options.artifactRoot ?? join(options.scratchRoot, 'artifacts') }, adapters: scriptedFreshPlanningAdapters(options.adapters) });
import { isolate } from '../src/isolation.js';
import { materializeReviewBundle } from '../src/review.js';
import { execFileSync } from 'node:child_process';
import { parseArgs } from '../src/args.js';
import { runQueue } from '../src/queue.js';
import { assertCleanTarget, landQueueDiff } from '../src/queue-runtime.js';
const resumeModule = await import('../src/resume.js').catch(() => ({}));
const resume = { ...resumeModule, resumeRun: options => resumeModule.resumeRun({ ...options,
  env: { ...process.env, ...options.env, URO_ARTIFACT_ROOT: join(tmpdir(), 'uro-task3-fixture-artifacts') },
  adapters: scriptedFreshPlanningAdapters(options.adapters) }) };

test('resume CLI accepts only the saved run and answer file, never a mode override', () => {
  assert.deepEqual(parseArgs(['resume', '--run', 'saved', '--decision-file', 'answers.json']),
    { command: 'resume', runDirectory: 'saved', decisionFile: 'answers.json' });
  assert.throws(() => parseArgs(['resume', '--run', 'saved', '--decision-file', 'answers.json', '--mode', 'autonomous']));
  assert.throws(() => parseArgs(['resume', '--run', 'saved']));
});

for (const candidates of [1, 3]) test(`manual planning resumes its saved proposal and transcript without a second initial draft (${candidates} candidates)`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-resume-plan-'));
  const target = join(root, 'target'), out = join(root, 'plan');
  mkdirSync(target);
  const proposal = { plan: 'Keep the existing schema.\n', gate: [] };
  const authors = [], reviewers = [];
  let selections = 0;
  const adapters = {
    runExecutor: async () => { selections++; return { exitCode: 0, lastMessage: '<SELECTED_CANDIDATE>candidate-2</SELECTED_CANDIDATE>' }; },
    author: async request => { authors.push(request); return { ...proposal, agree: false,
      readable: true, content: 'The existing schema is required.' }; },
    reviewer: async request => { reviewers.push(request); return { agree: false, readable: true,
      artifactDigest: request.artifactDigest, suggestions: [{ id: 'S1', text: 'Prefer a new schema.' }],
      content: 'The new schema is preferable.' }; },
  };
  const pending = await runPlan(withVerifiedSuperpowers({ goal: 'Preserve compatibility.', target, out, candidates, adapters }));
  assert.equal(pending.reason, 'needs-decision');
  const callsBeforeOverwrite = authors.length + reviewers.length;
  await assert.rejects(runPlan(withVerifiedSuperpowers({ goal: 'Different task.', target, out, candidates: 1, adapters })), /overwrite|checkpoint/);
  assert.equal(authors.length + reviewers.length, callsBeforeOverwrite);
  assert.equal(typeof resume.resumeRun, 'function');
  const saved = JSON.parse(readFileSync(join(out, 'uro-checkpoint.json'), 'utf8'));
  const decisionFile = join(root, 'answers.json');
  writeFileSync(decisionFile, JSON.stringify({ schemaVersion: 1, runId: pending.runId,
    artifactDigest: saved.artifactDigest, answers: [{ id: saved.pending.questions[0].id,
      answer: 'approve: Preserve the existing schema as proposed.' }] }));
  const done = await resume.resumeRun({ runDirectory: out, decisionFile, adapters });
  assert.equal(done.approved, true);
  assert.equal(done.approval.decidedBy, 'human');
  assert.equal(done.approval.artifactDigest, planningArtifactDigest('Preserve compatibility.', proposal));
  assert.equal(authors.filter(r => r.type === 'draft').length, candidates);
  assert.equal(selections, candidates > 1 ? 1 : 0);
  if (candidates > 1) {
    assert.equal(done.checkpointState.candidateState.selectedCandidateId, 'candidate-2');
    assert.equal(done.checkpointState.candidateState.candidates.length, candidates);
  }
  assert.match(readFileSync(join(out, 'plan.md'), 'utf8'), /existing schema/);
  assert.ok(done.messages.some(m => m.speaker === 'human'));
  const calls = authors.length + reviewers.length;
  const replay = await resume.resumeRun({ runDirectory: out, decisionFile, adapters });
  assert.equal(replay.approved, true);
  assert.equal(authors.length + reviewers.length, calls);
});

test('a further planning dispute atomically replaces pending state without a false terminal replay window', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-resume-next-'));
  const target = join(root, 'target'), out = join(root, 'plan');
  mkdirSync(target);
  const adapters = scriptedPlanningAdapters({ author: async () => ({ plan: 'Existing proposal.', gate: [], readable: true, agree: false, content: 'Keep it.' }),
    reviewer: async r => ({ readable: true, agree: false, artifactDigest: r.artifactDigest,
      suggestions: [{ id: 'S1', text: 'Change it.' }], content: 'Change it.' }) });
  const pending = await runPlan(withVerifiedSuperpowers({ goal: 'A goal.', target, out, candidates: 1, adapters }));
  const decisionFile = join(root, 'answers.json');
  writeFileSync(decisionFile, JSON.stringify({ schemaVersion: 1, runId: pending.runId,
    artifactDigest: pending.checkpoint.artifactDigest, answers: [{ id: pending.pendingDecision.id, answer: 'Please clarify the retained concern.' }] }));
  const statuses = [], originalRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('uro-checkpoint.json')) statuses.push(JSON.parse(readFileSync(from, 'utf8')).status);
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  let next;
  try { next = await resume.resumeRun({ runDirectory: out, decisionFile, adapters }); }
  finally { fs.renameSync = originalRename; syncBuiltinESMExports(); }
  assert.equal(next.reason, 'needs-decision');
  assert.equal(statuses.includes('terminal'), false);
  assert.notEqual(next.checkpoint.artifactDigest, pending.checkpoint.artifactDigest);
  const replay = await resume.resumeRun({ runDirectory: out, decisionFile,
    adapters: { author: () => assert.fail('replayed author'), reviewer: () => assert.fail('replayed reviewer') } });
  assert.deepEqual(replay.checkpoint, next.checkpoint);
});

for (const interruption of ['log', 'return']) test(`an explicit human acceptance resumes the edited Git isolate and recovers ${interruption} interruption`, async () => {
  const base = process.platform === 'win32' ? 'C:/ccc-test' : tmpdir();
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'uro-resume-exec-'));
  const target = join(root, 'target');
  mkdirSync(target);
  writeFileSync(join(target, 'source.js'), 'export const value = 1;\n');
  execFileSync('git', ['init', '-q', target]);
  execFileSync('git', ['-C', target, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', target, 'config', 'user.email', 'test@local']);
  execFileSync('git', ['-C', target, 'config', 'core.autocrlf', 'false']);
  execFileSync('git', ['-C', target, 'add', '.']);
  execFileSync('git', ['-C', target, '-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-qm', 'baseline']);
  let isolates = 0;
  const implementations = [], reviews = [];
  const adapters = {
    isolate: async options => { isolates++; return isolate(options); },
    runExecutor: async options => {
      implementations.push(options);
      writeFileSync(join(options.cwd, 'source.js'), `export const value = ${options.runId === 'execution-1' ? 2 : 3};\n`);
      return { exitCode: 0, changedFiles: ['source.js'], lastMessage: JSON.stringify({ findingResponses:
        [{ id: 'F1', disposition: 'dispute', reason: 'The contract excludes this input.' }] }) };
    },
    runGate: async () => ({ passed: true, results: [] }),
    runReview: async options => {
      reviews.push(options);
      const bundle = { version: 1, conclusion: 'issues',
        report: '## F1\nSeverity: blocking\nDescription: Support excluded input.\nTest: __uro_review/tests/f1.test.js\n',
        tests: [{ path: 'tests/f1.test.js', content: 'throw new Error("excluded input");\n' }],
        dispositions: [{ id: 'F1', status: 'upheld', reason: 'I still prefer supporting it.' }] };
      if (options.runId === 'execution-1') Object.assign(bundle, { conclusion: 'clean', report: 'No blocking findings.', tests: [], dispositions: [] });
      return { provider: 'claude', answer: JSON.stringify(bundle),
        artifact: await materializeReviewBundle({ ...options, bundle }) };
    },
  };
  const queueFile = join(root, 'queue.json');
  writeFileSync(join(root, 'plan.md'), 'Change the value.');
  writeFileSync(join(root, 'gate.json'), '[]');
  writeFileSync(queueFile, JSON.stringify([{ name: 'first', task: 'plan.md', gate: 'gate.json' },
    { name: 'second', task: 'plan.md', gate: 'gate.json' }]));
  let judged = 0, landed = 0, launched = 0, pending, crashAfterCommit = true;
  const queueDependencies = {
    assertCleanTarget,
    launchRun: async () => {
      launched++;
      pending = await run(withVerifiedSuperpowers({ task: 'Change the value.', target, gate: [],
        scratchRoot: join(root, 'scratch'), runId: `execution-${launched}`, debateRounds: 8, adapters }));
      return { runDirectory: pending.dir };
    },
    readRunFacts: async () => pending,
    judgeLanding: async ({ facts }) => { judged++; assert.equal(facts.approval.basis, facts.runId === 'execution-1' ? 'reviewer' : 'human'); return { approved: true }; },
    landDiff: async request => {
      landed++;
      const result = await landQueueDiff(request);
      if (request.operationId && interruption === 'return' && crashAfterCommit) {
        crashAfterCommit = false;
        throw new Error('simulated lost return after real commit');
      }
      return result;
    },
    appendLog: (path, row) => {
      if (row.landed && row.runId === 'execution-2' && interruption === 'log' && crashAfterCommit) {
        crashAfterCommit = false;
        // A legacy uncertain failure row is retained, then explicitly reconciled.
        appendFileSync(path, `${JSON.stringify({ ...row, landed: false, commit: null })}\n`);
        throw new Error('simulated crash after commit before queue log');
      }
      appendFileSync(path, `${JSON.stringify(row)}\n`);
    },
  };
  const stoppedQueue = await runQueue({ file: queueFile, target, dependencies: queueDependencies });
  assert.equal(pending.outcome, 'needs-decision');
  const saved = JSON.parse(readFileSync(join(pending.dir, 'uro-checkpoint.json'), 'utf8'));
  assert.equal(stoppedQueue.stop.checkpoint?.artifactDigest, saved.artifactDigest);
  assert.equal(saved.queue.unitIndex, 2);
  const decisionFile = join(root, 'answers.json');
  writeFileSync(decisionFile, JSON.stringify({ schemaVersion: 1, runId: pending.runId,
    artifactDigest: saved.artifactDigest, answers: [{ id: 'F1', answer: 'Accept Codex rebuttal' }] }));
  const diffPath = join(pending.dir, 'CHANGES.diff');
  const actualDiff = readFileSync(diffPath, 'utf8');
  writeFileSync(diffPath, 'unreviewed substitute diff');
  await assert.rejects(resume.resumeRun({ runDirectory: pending.dir, decisionFile, adapters, queueDependencies }), /changed|corrupt|stale/);
  writeFileSync(diffPath, actualDiff);
  assert.equal(implementations.length, 3);
  assert.equal(judged, 1);
  const priorCalls = implementations.length;
  if (interruption === 'log') await assert.rejects(resume.resumeRun({ runDirectory: pending.dir, decisionFile, adapters, queueDependencies }), /simulated crash/);
  const done = await resume.resumeRun({ runDirectory: pending.dir, decisionFile, adapters, queueDependencies });
  assert.equal(done.dir, pending.dir);
  assert.equal(isolates, 2);
  assert.equal(implementations.length, priorCalls + 1);
  assert.match(implementations.at(-1).plan, /Accept Codex rebuttal/);
  assert.match(JSON.stringify(reviews.at(-1).request.messages), /Accept Codex rebuttal/);
  assert.equal(done.outcome, 'review-ready');
  assert.equal(done.approval.decidedBy, 'human');
  assert.equal(done.approval.basis, 'human');
  assert.deepEqual(done.debate.openFindings, []);
  const indexPath = join(root, 'scratch', 'artifacts', 'index.jsonl');
  assert.equal(readFileSync(indexPath, 'utf8').trim().split(/\r?\n/).length, 2);
  assert.equal(readFileSync(join(done.artifacts.directory, '__uro_review', 'tests', 'f1.test.js'), 'utf8'),
    'throw new Error("excluded input");\n');
  const calls = implementations.length + reviews.length;
  await resume.resumeRun({ runDirectory: pending.dir, decisionFile, adapters, queueDependencies });
  assert.equal(implementations.length + reviews.length, calls);
  assert.equal(done.queueResult.landedCount, 2, done.queueResult.stop?.reason);
  assert.equal(judged, 2);
  assert.equal(landed, 2);
  assert.equal(launched, 2);
  const operationRows = readFileSync(join(root, 'queue-log.jsonl'), 'utf8').trim().split(/\r?\n/)
    .map(line => JSON.parse(line)).filter(row => row.operationId);
  assert.equal(operationRows.filter(row => !row.landed).length, interruption === 'log' ? 1 : 0);
  assert.equal(operationRows.filter(row => row.landed).length, 1);
  if (interruption === 'log') assert.equal(operationRows.at(-1).reconcilesOperation, operationRows[0].operationId);
  assert.equal(execFileSync('git', ['-C', target, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim(), '3');
});

for (const twoGoals of [false, true]) test(`queued saved planning inside the target resumes with real cleanliness and exact generated-path allowances${twoGoals ? ' across two goals' : ''}`, async () => {
  const root = mkdtempSync(join(process.platform === 'win32' ? 'C:/ccc-test' : tmpdir(), 'uro-goal-attach-'));
  const target = join(root, 'target'), out = join(target, 'planned');
  mkdirSync(target);
  const git = (...args) => execFileSync('git', ['-C', target, ...args], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@local'); git('config', 'core.autocrlf', 'false');
  writeFileSync(join(target, 'source.js'), 'original\n'); git('add', '.'); git('commit', '-qm', 'baseline');
  const queueFile = join(root, 'queue.json');
  writeFileSync(queueFile, JSON.stringify([...(twoGoals ? [{ name: 'first', goal: 'First change', out: 'target/first-plan' }] : []),
    { name: 'goal', goal: 'Change source', out: 'target/planned' }]));
  let implementations = 0, drafts = 0, facts, planningUnit = 0, interrupted = false;
  const planningAdapters = { author: async () => { drafts++; return { plan: 'Change source.\n', gate: [], agree: twoGoals && planningUnit === 1, readable: true }; },
    reviewer: async r => ({ agree: twoGoals && planningUnit === 1, readable: true, artifactDigest: r.artifactDigest, suggestions: [{ id: 'S1', text: 'Prefer another change.' }] }) };
  const dependencies = { assertCleanTarget,
    launchPlan: ({ unit }) => { planningUnit = unit.index; return runPlan(withVerifiedSuperpowers({ goal: unit.goal, target, out: unit.out, candidates: 1, adapters: planningAdapters })); },
    launchRun: async ({ unit }) => {
      implementations++;
      facts = await run(withVerifiedSuperpowers({ task: unit.task, gate: unit.gate, target, scratchRoot: join(root, 'scratch'), runId: `goal-run-${implementations}`,
        adapters: { runExecutor: async ({ cwd }) => { writeFileSync(join(cwd, 'source.js'), `changed ${implementations}\n`); return { exitCode: 0, changedFiles: ['source.js'], lastMessage: 'Done' }; },
          runGate: async () => ({ results: [] }), runReview: async options => {
            const bundle = { version: 1, conclusion: 'clean', report: 'No blockers.', tests: [] };
            return { artifact: await materializeReviewBundle({ ...options, bundle }), answer: JSON.stringify(bundle) };
          } } }));
      return { runDirectory: facts.dir };
    }, readRunFacts: async () => facts, judgeLanding: async () => ({ approved: true }), landDiff: landQueueDiff,
    appendLog: (path, row) => {
      if (twoGoals && row.operationId && row.landed && !interrupted) {
        interrupted = true; throw new Error('two-goal interruption after commit before log');
      }
      appendFileSync(path, `${JSON.stringify(row)}\n`);
    } };
  const pending = await runQueue({ file: queueFile, target, dependencies });
  assert.equal(pending.stop.kind, 'plan-not-approved');
  const checkpoint = JSON.parse(readFileSync(join(out, 'uro-checkpoint.json'), 'utf8'));
  const decisionFile = join(root, 'answers.json');
  writeFileSync(decisionFile, JSON.stringify({ schemaVersion: 1, runId: checkpoint.runId, artifactDigest: checkpoint.artifactDigest,
    answers: [{ id: checkpoint.pending.questions[0].id, answer: 'approve' }] }));
  if (twoGoals) {
    assert.equal(pending.landedCount, 1);
    assert.equal(checkpoint.queue.unitIndex, 2);
    assert.equal(implementations, 1);
    const before = drafts, priorPlan = join(target, 'first-plan', 'plan.md');
    const savedPlan = readFileSync(priorPlan, 'utf8');
    writeFileSync(priorPlan, 'An unreviewed prior plan.');
    await assert.rejects(resume.resumeRun({ runDirectory: out, decisionFile, adapters: planningAdapters, queueDependencies: dependencies }), /changed|stale|approval/);
    writeFileSync(priorPlan, savedPlan);
    const unrelated = join(target, 'first-plan', 'unrelated.js');
    writeFileSync(unrelated, 'unrelated source');
    await assert.rejects(resume.resumeRun({ runDirectory: out, decisionFile, adapters: planningAdapters, queueDependencies: dependencies }), /changed|dirty/);
    fs.unlinkSync(unrelated);
    assert.equal(drafts, before);
    assert.equal(implementations, 1);
    await assert.rejects(resume.resumeRun({ runDirectory: out, decisionFile, adapters: planningAdapters, queueDependencies: dependencies }), /two-goal interruption/);
    const completedDrafts = drafts;
    writeFileSync(priorPlan, 'Changed prior plan during landing recovery.');
    await assert.rejects(resume.resumeRun({ runDirectory: out, decisionFile, adapters: planningAdapters, queueDependencies: dependencies }), /approval.*stale/);
    writeFileSync(priorPlan, savedPlan);
    writeFileSync(unrelated, 'must not be exempt during recovery');
    await assert.rejects(resume.resumeRun({ runDirectory: out, decisionFile, adapters: planningAdapters, queueDependencies: dependencies }), /dirty/);
    fs.unlinkSync(unrelated);
    assert.equal(drafts, completedDrafts);
    assert.equal(implementations, 2);
  }
  const result = await resume.resumeRun({ runDirectory: out, decisionFile, adapters: planningAdapters, queueDependencies: dependencies });
  assert.equal(result.queueResult.landedCount, twoGoals ? 2 : 1, result.queueResult.stop?.reason);
  assert.equal(implementations, twoGoals ? 2 : 1);
  // The explicit human approval applies the saved proposal without another author call.
  assert.equal(drafts, twoGoals ? 3 : 2);
  assert.equal(readFileSync(join(target, 'source.js'), 'utf8'), twoGoals ? 'changed 2\n' : 'changed 1\n');
  assert.equal(git('rev-list', '--count', 'HEAD').trim(), twoGoals ? '3' : '2');
  await resume.resumeRun({ runDirectory: out, decisionFile, adapters: planningAdapters, queueDependencies: dependencies });
  assert.equal(implementations, twoGoals ? 2 : 1);
  writeFileSync(join(out, 'unrelated.js'), 'must not be allowed');
  await assert.rejects(assertCleanTarget(target, { allowedPaths: [join(out, 'plan.md'), join(out, 'gate.json'), join(out, 'uro-checkpoint.json')] }), /unrelated.js/);
});

test('answer files inside hashed source get a placement diagnostic before model work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-answer-placement-')), target = join(root, 'target'), out = join(root, 'plan');
  mkdirSync(target);
  let calls = 0;
  const adapters = { author: async () => { calls++; return { plan: 'A plan.', gate: [], agree: false, readable: true }; },
    reviewer: async r => { calls++; return { agree: false, readable: true, artifactDigest: r.artifactDigest, suggestions: [{ id: 'S1', text: 'Dispute.' }] }; } };
  const pending = await runPlan(withVerifiedSuperpowers({ goal: 'A goal.', target, out, candidates: 1, adapters }));
  const before = calls, inside = join(target, 'answers.json'), outside = join(root, 'answers.json');
  writeFileSync(inside, JSON.stringify({ schemaVersion: 1, runId: pending.runId, artifactDigest: pending.checkpoint.artifactDigest,
    answers: [{ id: pending.pendingDecision.id, answer: 'approve' }] }));
  await assert.rejects(resume.resumeRun({ runDirectory: out, decisionFile: inside, adapters }), /answer.*outside.*target|decision file.*outside.*target/i);
  assert.equal(calls, before);
  fs.renameSync(inside, outside);
  assert.equal((await resume.resumeRun({ runDirectory: out, decisionFile: outside, adapters })).approved, true);
});

for (const choice of ['stop', 'correction', 'fresh plan', 'further planning dispute', 'unchanged fresh plan', 'arbitrary prose']) test(`saved actual execution pivot honors ${choice} without replaying completed work`, async () => {
  const root = mkdtempSync(join(process.platform === 'win32' ? 'C:/ccc-test' : tmpdir(), 'uro-manual-pivot-'));
  const target = join(root, 'target'); mkdirSync(target);
  writeFileSync(join(target, 'source.js'), 'original\n');
  let implementations = 0, reviews = 0, initialDrafts = 0, authors = 0, planningReviews = 0, resumed = false, isolates = 0;
  const deliveredPlans = [], planningRequests = [];
  const proof = { path: 'tests/f1.test.js', content: 'throw Error("retained proof");\n' };
  const adapters = { isolate: async options => { isolates++; return isolate(options); }, detectCircling: () => true,
    runExecutor: async options => {
      implementations++; deliveredPlans.push(options.plan);
      if (implementations > 1) assert.equal(readFileSync(join(options.cwd, 'source.js'), 'utf8'), 'saved implementation\n');
      writeFileSync(join(options.cwd, 'source.js'), 'saved implementation\n');
      return { exitCode: 0, changedFiles: ['source.js'], lastMessage: 'Implemented the requested strategy.' };
    }, runGate: async ({ onEvidence }) => { onEvidence?.({ bin: 'node', args: ['test.js'], code: 1, stdout: 'Retained full evidence.' }); return { results: [] }; },
    runReview: async options => {
      reviews++;
      const bundle = { version: 1, conclusion: resumed ? 'clean' : 'issues', report: resumed ? 'No remaining blockers.'
        : '## F1\nSeverity: blocking\nDescription: Strategy misses a case.\nTest: __uro_review/tests/f1.test.js\n', tests: [proof],
        dispositions: resumed ? [{ id: 'F1', status: 'resolved', reason: 'Correction meets the requirement.' }] : [] };
      return { artifact: await materializeReviewBundle({ ...options, bundle }), answer: JSON.stringify(bundle) };
    },
    draftPlanCandidate: async request => {
      authors++; if (request.candidateIndex) initialDrafts++;
      planningRequests.push(request);
      return { plan: choice === 'unchanged fresh plan' ? 'Implement the original strategy.' : 'Use a replacement strategy over the saved implementation.\n',
        gate: [], readable: true, usage: { inputTokens: 1, outputTokens: 1 },
        agree: choice !== 'further planning dispute', content: 'A replacement strategy over retained work.' };
    }, reviewPlanCandidate: async request => {
      planningReviews++; planningRequests.push(request);
      return { readable: true, agree: choice !== 'further planning dispute', artifactDigest: request.artifactDigest,
        usage: { inputTokens: 1, outputTokens: 1 },
        suggestions: choice === 'further planning dispute' ? [{ id: 'P1', text: 'Retain the existing strategy instead.' }] : [], content: 'Current strategy review.' };
    }, createFreshPivotBranch: () => assert.fail('manual fresh plan must not reset or delete saved work'),
  };
  const pending = await run(withVerifiedSuperpowers({ task: 'Implement the original strategy.', target, gate: [],
    scratchRoot: join(root, 'scratch'), runId: 'manual-pivot', debateRounds: 8, pivotCandidates: 1, adapters }));
  assert.equal(pending.checkpointState.stage, 'execution-pivot');
  const checkpoint = JSON.parse(readFileSync(join(pending.dir, 'uro-checkpoint.json'), 'utf8'));
  const decisionFile = join(root, 'answers.json');
  const answer = ['further planning dispute', 'unchanged fresh plan'].includes(choice) ? 'fresh plan'
    : choice === 'arbitrary prose' ? 'Please consider a fresh plan later; correct this implementation now.' : choice;
  writeFileSync(decisionFile, JSON.stringify({ schemaVersion: 1, runId: pending.runId, artifactDigest: checkpoint.artifactDigest,
    answers: [{ id: 'pivot', answer }] }));
  const beforeDiff = readFileSync(join(pending.dir, 'CHANGES.diff'), 'utf8');
  resumed = true;
  let done = await resume.resumeRun({ runDirectory: pending.dir, decisionFile, adapters });
  if (choice === 'further planning dispute') {
    assert.equal(done.reason, 'needs-decision');
    assert.equal(implementations, 1);
    assert.equal(done.checkpointState.phase, 'planning');
    assert.equal(readFileSync(join(pending.dir, 'CHANGES.diff'), 'utf8'), beforeDiff);
    const next = JSON.parse(readFileSync(join(pending.dir, 'uro-checkpoint.json'), 'utf8'));
    const nextAnswers = join(root, 'plan-answers.json');
    writeFileSync(nextAnswers, JSON.stringify({ schemaVersion: 1, runId: pending.runId, artifactDigest: next.artifactDigest,
      answers: [{ id: next.pending.questions[0].id, answer: 'approve: Use the replacement strategy.' }] }));
    done = await resume.resumeRun({ runDirectory: pending.dir, decisionFile: nextAnswers, adapters });
    const count = implementations + authors + planningReviews + reviews;
    await resume.resumeRun({ runDirectory: pending.dir, decisionFile: nextAnswers, adapters });
    assert.equal(implementations + authors + planningReviews + reviews, count);
  }
  assert.equal(isolates, 1);
  const stopped = ['stop', 'unchanged fresh plan'].includes(choice);
  assert.equal(implementations, stopped ? 1 : 2);
  assert.equal(reviews, stopped ? 1 : 2);
  assert.equal(readFileSync(join(pending.dir, '__uro_review', 'tests', 'f1.test.js'), 'utf8'), proof.content);
  if (stopped) { assert.equal(done.reason, choice === 'stop' ? 'human-stopped' : 'fresh-plan-unchanged'); assert.equal(done.approved, false); }
  else assert.equal(done.outcome, 'review-ready');
  if (answer === 'fresh plan') {
    assert.equal(initialDrafts, 1);
    if (!stopped) assert.match(deliveredPlans.at(-1), /replacement strategy/);
    assert.equal(done.tokens.planning?.inputTokens, authors + planningReviews, 'retain all fresh-planning usage even when unchanged plans stop');
    assert.ok(planningRequests.every(request => JSON.stringify(request.messages).includes('fresh plan')));
  } else assert.equal(authors, 0);
  const total = implementations + reviews + authors + planningReviews;
  await resume.resumeRun({ runDirectory: pending.dir, decisionFile, adapters });
  assert.equal(implementations + reviews + authors + planningReviews, total);
});
