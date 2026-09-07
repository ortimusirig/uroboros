import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlan } from '../src/plan.js';
import { planningArtifactDigest } from '../src/conversation.js';
import { withVerifiedSuperpowers } from '../fixtures/verified-superpowers.mjs';
import { run } from '../src/run.js';
import { isolate } from '../src/isolation.js';
import { materializeReviewBundle } from '../src/review.js';
import { execFileSync } from 'node:child_process';
import { parseArgs } from '../src/args.js';
import { runQueue } from '../src/queue.js';
import { landQueueDiff } from '../src/queue-runtime.js';
const resume = await import('../src/resume.js').catch(() => ({}));

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
  const adapters = { author: async () => ({ plan: 'Existing proposal.', gate: [], readable: true, agree: false, content: 'Keep it.' }),
    reviewer: async r => ({ readable: true, agree: false, artifactDigest: r.artifactDigest,
      suggestions: [{ id: 'S1', text: 'Change it.' }], content: 'Change it.' }) };
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

test('an explicit human acceptance resumes the edited Git isolate and overrides unchanged Claude dissent', async () => {
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
      const bundle = { version: 1,
        report: '## F1\nSeverity: blocking\nDescription: Support excluded input.\nTest: __uro_review/tests/f1.test.js\n',
        tests: [{ path: 'tests/f1.test.js', content: 'throw new Error("excluded input");\n' }],
        dispositions: [{ id: 'F1', status: 'upheld', reason: 'I still prefer supporting it.' }] };
      if (options.runId === 'execution-1') Object.assign(bundle, { report: 'No blocking findings.', tests: [], dispositions: [] });
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
    assertCleanTarget: async () => {},
    launchRun: async () => {
      launched++;
      pending = await run(withVerifiedSuperpowers({ task: 'Change the value.', target, gate: [],
        scratchRoot: join(root, 'scratch'), runId: `execution-${launched}`, debateRounds: 8, adapters }));
      return { runDirectory: pending.dir };
    },
    readRunFacts: async () => pending,
    judgeLanding: async ({ facts }) => { judged++; assert.equal(facts.approval.basis, facts.runId === 'execution-1' ? 'reviewer' : 'human'); return { approved: true }; },
    landDiff: async request => { landed++; return landQueueDiff(request); },
    appendLog: (path, row) => {
      if (row.landed && row.runId === 'execution-2' && crashAfterCommit) { crashAfterCommit = false; throw new Error('simulated crash after commit before queue log'); }
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
  await assert.rejects(resume.resumeRun({ runDirectory: pending.dir, decisionFile, adapters, queueDependencies }), /simulated crash/);
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
  assert.equal(execFileSync('git', ['-C', target, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim(), '3');
});
