import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createFreshPivotBranch, run as executeRun } from '../src/run.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isolate } from '../src/isolation.js';
import { planningEnvelope, planningApproval } from './fixtures/planning-responses.js';
import { createInspectionReceipt } from '../src/context-evidence.js';
import { runPlanCandidateSet } from '../src/plan.js';

async function retainedScenario(t, config = {}) {
  const base = process.platform === 'win32' ? 'C:/ccc-test' : tmpdir(); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'uro-native-replan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'project'); mkdirSync(target);
  const git = (...args) => execFileSync('git', ['-C', target, ...args], { encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'core.autocrlf', 'false');
  writeFileSync(join(target, 'seed.txt'), 'seed'); git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-qm', 'base');
  const order = [], contexts = new Map(); let writes = 0, reviews = 0;
  const usage = config.unknown ? undefined : { inputTokens: 1, outputTokens: 1 };
  const task = 'Keep first work and finish remaining work';
  const facts = await executeRun({ task, target,
    gate: [{ bin: process.execPath, args: ['-e', "process.stdout.write('retained-output-'.repeat(1000));process.stderr.write('retained-error-'.repeat(1000))"] }],
    scratchRoot: join(root, 'scratch'), artifactRoot: join(root, 'archive'), runId: 'native-retained',
    mode: 'autonomous', superpowers: TEST_SUPERPOWERS, ...config.options, adapters: {
      ...(config.protection ? { isolate: async options => {
        const result = await isolate(options); mkdirSync(join(result.dir, '__uro_review/tests'), { recursive: true });
        writeFileSync(join(result.dir, '__uro_review/tests/proof.test.js'), executableProof);
        writeFileSync(join(result.dir, '__uro_review/REVIEW.md'), proofBytes);
        return result;
      } } : {}),
      runExecutor: r => {
        order.push('execute'); writes++;
        if (writes === 1) writeFileSync(join(r.cwd, 'first.txt'), '1');
        else {
          assert.equal(readFileSync(join(r.cwd, 'first.txt'), 'utf8'), '1');
          assert.equal(r.remainingWork, true);
          writeFileSync(join(r.cwd, 'remaining.txt'), 'done');
        }
        return { usage, exitCode: 0, dialogue: planningEnvelope(r, r.action) };
      },
      runReview: r => {
        if (++reviews <= (config.replans ?? 1)) {
          config.beforeReplan?.(r);
          const item = r.state.evidence.find(e => e.kind === 'command');
          return { usage, dialogue: planningEnvelope(r, 'replan', {
            issues: [{ id: 'R1', title: 'Remaining work needs a new plan', status: 'open', blocking: true }],
            replan: { issueId: 'R1', evidenceIds: [item.id], novelty: 'The completed first segment exposes remaining work; preserve first.txt and finish only remaining.txt.', ...config.trigger },
          }) };
        }
        const item = r.state.evidence.find(e => e.id === 'requirement-briefing'); readFileSync(item.capturedPath);
        const receipt = createInspectionReceipt({ operationId: r.operationId, seat: 'claude', evidence: [item], inspected: true, result: 'read' });
        return { usage, observations: { evidence: [], receipts: [receipt] }, dialogue: planningEnvelope(r, 'approve', {
          claims: [{ id: 'briefing-requirement', kind: 'fact', text: item.text, evidenceIds: [item.id] }],
          verifications: [{ claimId: 'briefing-requirement', evidenceIds: [item.id], inspectionReceiptIds: [receipt.id], result: 'supports', reason: 'Read original requirement' }],
        }) };
      },
      draftPlanCandidate: r => {
        order.push('claude-plan'); assert.equal(readFileSync(join(r.target, 'first.txt'), 'utf8'), '1');
        const context = r.state.snapshot.entries.find(entry => entry.id === 'retained-phase').content;
        if (contexts.has(r.state.runId)) assert.equal(context, contexts.get(r.state.runId));
        else contexts.set(r.state.runId, context);
        const command = r.state.evidence.find(e => e.kind === 'command');
        assert.equal(command.stdout, 'retained-output-'.repeat(1000));
        assert.equal(command.stderr, 'retained-error-'.repeat(1000));
        assert.match(r.input, /Remaining work needs a new plan/);
        if (config.draft) return config.draft(r);
        return { usage, plan: config.identical ? task : 'Finish remaining.txt only; preserve first.txt', gate: config.remainingGate ?? [], dialogue: planningEnvelope(r, 'propose') };
      },
      selectPlanCandidate: r => { order.push('codex-select'); return { usage, selectedCandidateId: r.candidates[0].id, dialogue: planningEnvelope(r, 'verify') }; },
      reviewPlanCandidate: r => {
        order.push('codex-plan'); assert.ok(r.state.evidence.some(e => e.kind === 'command'));
        assert.equal(r.state.snapshot.entries.find(entry => entry.id === 'retained-phase').content, contexts.get(r.state.runId));
        assert.equal(readFileSync(join(r.state.scope.sourceRoots[0], 'first.txt'), 'utf8'), '1');
        return config.review ? config.review(r) : { usage, ...planningApproval(r) };
      },
      createFreshPivotBranch: () => { throw new Error('must never reset retained work'); },
      ...config.adapters,
    } });
  return { facts, writes, order };
}

test('native retained replan keeps completed work and approves remaining work in distinct phases', async t => {
  const { facts, writes, order } = await retainedScenario(t);
  assert.equal(facts.approved, true, facts.reason);
  assert.equal(writes, 2);
  assert.deepEqual(order, ['execute', 'claude-plan', 'claude-plan', 'claude-plan', 'codex-select', 'codex-plan', 'execute']);
  assert.equal(facts.resources.providerLaunches, 9);
  assert.equal(facts.checkpointState.phaseChain.length, 3);
  assert.equal(new Set(facts.checkpointState.phaseChain.map(p => p.runId)).size, 3);
  assert.equal(readFileSync(join(facts.dir, 'first.txt'), 'utf8'), '1');
  assert.equal(readFileSync(join(facts.dir, 'remaining.txt'), 'utf8'), 'done');
});

test('native retained replan preserves the actual technical planning checkpoint', async t => {
  const { facts, writes } = await retainedScenario(t, { draft: () => ({ unavailable: true, usage: { inputTokens: 1, outputTokens: 1 } }) });
  assert.equal(facts.approved, false); assert.equal(writes, 1);
  assert.equal(facts.checkpointState.phase, 'planning');
  assert.equal(facts.checkpointState.interactionMode, 'autonomous');
  assert.ok(facts.checkpointState.planningArtifacts, facts.reason);
  assert.ok(facts.checkpointState.journalIdentity);
  assert.equal(facts.reason, 'author-unavailable');
  assert.equal(readFileSync(join(facts.dir, 'first.txt'), 'utf8'), '1');
});

test('native retained replan includes planning messages in run facts with actual roles', async t => {
  const { facts } = await retainedScenario(t, { options: { pivotCandidates: 1 }, identical: true });
  assert.equal(facts.approved, true, facts.reason);
  assert.ok(facts.planningMessages.some(m => m.phase === 'planning' && m.speaker === 'claude'));
});

test('native retained replan irreparable and selector failures retain actual preparation without another writer', async t => {
  const usage = { inputTokens: 1, outputTokens: 1 };
  for (const reason of ['proposal-irreparable', 'reviewer-unavailable', 'selection-unreadable']) {
    const config = reason === 'proposal-irreparable'
      ? { draft: r => ({ usage, answer: '<PLAN_MD>Missing gate artifact</PLAN_MD>', dialogue: planningEnvelope(r, 'propose') }) }
      : { adapters: { selectPlanCandidate: r => reason === 'reviewer-unavailable' ? { usage, unavailable: true }
        : { usage, selectedCandidateId: 'missing', dialogue: planningEnvelope(r, 'verify') } } };
    const { facts, writes } = await retainedScenario(t, config);
    assert.equal(facts.approved, false); assert.equal(writes, 1); assert.equal(facts.reason, reason);
    const checkpoint = facts.checkpointState;
    assert.equal(checkpoint.phase, 'planning'); assert.equal(checkpoint.interactionMode, 'autonomous');
    assert.ok(checkpoint.planningArtifacts); assert.ok(checkpoint.journalIdentity);
    assert.equal(checkpoint.proposal, null); assert.equal(checkpoint.approval, null);
    assert.ok(checkpoint.preparationState);
    const prepared = checkpoint.preparationHistory.filter(event => event.type === 'prepare');
    const completed = checkpoint.preparationHistory.filter(event => event.type === 'complete');
    assert.ok(prepared.length >= 4); assert.equal(completed.length, prepared.length);
    assert.equal(facts.resources.providerLaunches, 2 + completed.length);
    assert.equal(facts.resources.knownUsage.inputTokens, facts.resources.providerLaunches);
    assert.equal(facts.resources.usageUnknown, false);
    assert.equal(checkpoint.preparationHistory.some(event => event.type === 'preparation-paused'), false);
    assert.equal(readFileSync(join(facts.dir, 'first.txt'), 'utf8'), '1');
  }
});

test('native retained replan protection precheck failure records no fabricated provider launch', async t => {
  const { facts, writes, order } = await retainedScenario(t, { adapters: { runPlanCandidateSet: options => {
    const protect = options.retained.protect;
    options.retained.protect = async (...args) => {
      execFileSync('git', ['-C', options.target, '-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'external HEAD change'], { windowsHide: true });
      return protect(...args);
    };
    return runPlanCandidateSet(options);
  } } });
  assert.equal(facts.approved, false); assert.equal(writes, 1); assert.deepEqual(order, ['execute']);
  assert.match(facts.reason, /required retained source integrity/);
  assert.equal(facts.resources.providerLaunches, 2); assert.equal(facts.resources.knownUsage.inputTokens, 2);
  assert.equal(facts.resources.usageUnknown, false);
  const phase = facts.checkpointState.phaseChain.at(-1);
  assert.match(phase.integrityFailure, /HEAD changed/);
  assert.equal(phase.phase, 'planning'); assert.deepEqual(phase.observations, []);
  assert.equal(phase.checkpointState.planningArtifacts, undefined);
});

test('native retained replan twice retains exact manifests and cumulative execution cycles', async t => {
  const { facts, writes } = await retainedScenario(t, { replans: 2, options: { pivotCandidates: 1 } });
  assert.equal(facts.approved, true, facts.reason); assert.equal(writes, 3);
  assert.equal(facts.resources.providerLaunches, 10);
  assert.equal(facts.dialogue.proposalCycles, 3); assert.equal(facts.dialogue.correctionCycles, 0);
  assert.equal(facts.checkpointState.phaseChain.length, 5);
  assert.equal(new Set(facts.checkpointState.phaseChain.map(p => p.directory)).size, 5);
  for (const phase of facts.checkpointState.phaseChain) {
    const manifest = phase.checkpointState.executionArtifacts ?? phase.checkpointState.planningArtifacts;
    for (const entry of manifest.files) {
      assert.equal(createHash('sha256').update(readFileSync(join(phase.directory, entry.path))).digest('hex'), entry.sha256);
    }
  }
  const originalOperation = facts.checkpointState.phaseChain[0].checkpointState.dialogue.executionCycle.completedOperationIds[0];
  assert.match(JSON.stringify(facts.dialogue.priorExecution), new RegExp(originalOperation));
});

test('native retained replan rejects unknown affected references and untrusted evidence before planning', async t => {
  for (const trigger of [{ issueId: 'missing' }, { evidenceIds: ['invented'] }, { novelty: '' }]) {
    const { facts, writes, order } = await retainedScenario(t, { trigger });
    assert.equal(facts.approved, false); assert.equal(writes, 1); assert.deepEqual(order, ['execute']);
    assert.match(facts.reason, /retained replan/);
  }
});

test('native retained replan rejects stale or missing selected approval with no next writer', async t => {
  for (const mutate of [result => { result.approval = null; }, result => { result.selected.plan += 'stale'; }]) {
    const { facts, writes } = await retainedScenario(t, { options: { pivotCandidates: 1 },
      adapters: { runPlanCandidateSet: async options => { const result = await runPlanCandidateSet(options); mutate(result); return result; } } });
    assert.equal(facts.approved, false); assert.equal(writes, 1);
    assert.equal(facts.checkpointState.phase, 'planning');
  }
});

test('native retained replan human question stays autonomous planning with useful work retained', async t => {
  const { facts, writes } = await retainedScenario(t, { options: { pivotCandidates: 1 }, review: r => ({
    dialogue: planningEnvelope(r, 'ask', { issues: [{ id: 'H1', title: 'Choose remaining product behavior',
      kind: 'product', needsHuman: true, status: 'open', blocking: true }] }), usage: { inputTokens: 1, outputTokens: 1 },
  }) });
  assert.equal(facts.approved, false); assert.equal(writes, 1);
  assert.equal(facts.phase, 'planning'); assert.equal(facts.checkpointState.phase, 'planning');
  assert.equal(facts.checkpointState.interactionMode, 'autonomous');
  assert.equal(facts.checkpointState.dialogue.pendingDecision.authority, 'human');
  assert.equal(readFileSync(join(facts.dir, 'first.txt'), 'utf8'), '1');
});

test('native retained replan cumulative budget denies preparation and successor launches exactly once', async t => {
  for (const [tokenBudget, launches, writes] of [[4, 2, 1], [6, 3, 1], [12, 6, 1], [14, 7, 1], [16, 8, 2]]) {
    const result = await retainedScenario(t, { options: { tokenBudget } });
    assert.equal(result.facts.approved, false); assert.equal(result.writes, writes);
    assert.equal(result.facts.resources.providerLaunches, launches, result.facts.reason);
    assert.match(result.facts.reason, /budget-exhausted/);
    assert.equal(result.facts.resources.knownUsage.inputTokens + result.facts.resources.knownUsage.outputTokens, tokenBudget);
  }
});

test('native retained replan unknown accounting cannot launch another phase', async t => {
  const { facts, writes, order } = await retainedScenario(t, { unknown: true, options: { tokenBudget: 20 } });
  assert.equal(facts.approved, false); assert.equal(writes, 1); assert.deepEqual(order, ['execute']);
  assert.equal(facts.resources.usageUnknown, true); assert.match(facts.reason, /accounting-incomplete/);
});

test('native retained replan unknown child usage and exhausted protocol repair launch no further preparation', async t => {
  for (const unknown of [true, false]) {
    let drafts = 0;
    const { facts, writes } = await retainedScenario(t, { options: { tokenBudget: 6 }, draft: r => {
      drafts++;
      return unknown ? { plan: 'Remaining work', gate: [], dialogue: planningEnvelope(r, 'propose') }
        : { content: 'Malformed provider envelope', usage: { inputTokens: 1, outputTokens: 1 } };
    } });
    assert.equal(facts.approved, false); assert.equal(writes, 1); assert.equal(drafts, 1);
    assert.equal(facts.resources.providerLaunches, 3);
    assert.equal(facts.resources.usageUnknown, unknown);
    assert.match(facts.reason, unknown ? /accounting-incomplete/ : /budget-exhausted/);
    assert.equal(facts.checkpointState.phase, 'planning');
  }
});

test('native retained replan phase changes preserve an explicit execution cycle ceiling', async t => {
  const { facts, writes } = await retainedScenario(t, { replans: 2, options: { pivotCandidates: 1, debateRounds: 2 } });
  assert.equal(facts.approved, false); assert.equal(writes, 2); assert.match(facts.reason, /proposal-cycle limit/);
  assert.equal(facts.dialogue.proposalCycles, 2);
});

test('native retained replan preserves reviewer bytes and complete command output through failed planning and archive', async t => {
  let drafts = 0;
  const { facts, writes } = await retainedScenario(t, { protection: true, draft: r => {
    assert.deepEqual(readFileSync(join(r.target, '__uro_review/REVIEW.md')), proofBytes);
    assert.deepEqual(readFileSync(join(r.target, '__uro_review/tests/proof.test.js')), executableProof);
    writeFileSync(join(r.target, '__uro_review/REVIEW.md'), 'tamper');
    writeFileSync(join(r.target, '__uro_review/tests/proof.test.js'), 'tamper');
    writeFileSync(join(r.target, 'first.txt'), 'tamper');
    if (++drafts === 1) throw new Error('failed planner after attempted writes');
    return { usage: { inputTokens: 1, outputTokens: 1 }, plan: 'Finish only remaining.txt', gate: [], dialogue: planningEnvelope(r, 'propose') };
  } });
  assert.equal(facts.approved, true, facts.reason); assert.equal(writes, 2);
  assert.equal(drafts, 3); assert.equal(facts.resources.usageUnknown, true);
  assert.deepEqual(readFileSync(join(facts.dir, '__uro_review/REVIEW.md')), proofBytes);
  assert.deepEqual(readFileSync(join(facts.dir, '__uro_review/tests/proof.test.js')), executableProof);
  assert.equal(facts.artifacts.status, 'ok');
  for (const phase of facts.checkpointState.phaseChain) {
    const manifest = phase.checkpointState.executionArtifacts ?? phase.checkpointState.planningArtifacts;
    for (const file of manifest.files) {
      const archived = join(facts.artifacts.directory, relative(facts.dir, phase.directory), file.path);
      assert.equal(createHash('sha256').update(readFileSync(archived)).digest('hex'), file.sha256);
    }
  }
  const command = facts.evidence.find(e => e.kind === 'command');
  const raw = JSON.parse(readFileSync(command.capturedPath, 'utf8'));
  assert.equal(raw.stdout, 'retained-output-'.repeat(1000));
  assert.equal(raw.stderr, 'retained-error-'.repeat(1000));
});

test('native retained replan required link persistence fails before any planning launch', async t => {
  const { facts, writes, order } = await retainedScenario(t, { beforeReplan: r => {
    mkdirSync(join(r.cwd, '.uro-tmp'), { recursive: true });
    writeFileSync(join(r.cwd, '.uro-tmp/retained-phases'), 'not a directory');
  } });
  assert.equal(facts.approved, false); assert.equal(writes, 1); assert.deepEqual(order, ['execute']);
  assert.equal(readFileSync(join(facts.dir, 'first.txt'), 'utf8'), '1');
});

test('native retained replan parent integrity loss during planning prevents every following seat', async t => {
  let calls = 0;
  const { facts, writes } = await retainedScenario(t, { draft: r => {
    calls++;
    const link = JSON.parse(r.state.snapshot.entries.find(entry => entry.id === 'retained-phase').content);
    writeFileSync(join(link.parent.directory, '__uro_dialogue/journal-tail.jsonl'), 'tampered');
    return { usage: { inputTokens: 1, outputTokens: 1 }, plan: 'Remaining work', gate: [], dialogue: planningEnvelope(r, 'propose') };
  } });
  assert.equal(facts.approved, false); assert.equal(writes, 1); assert.equal(calls, 1);
  assert.equal(facts.checkpointState.phase, 'planning'); assert.match(facts.reason, /manifest changed/);
  assert.equal(facts.resources.providerLaunches, 3);
  assert.equal(facts.resources.knownUsage.inputTokens, 3);
  assert.equal(facts.resources.knownUsage.outputTokens, 3);
});

test('native retained replan adopted required commands run before final approval', async t => {
  const command = { bin: process.execPath, args: ['-e', "if(require('node:fs').readFileSync('remaining.txt','utf8')!=='done')process.exit(4);process.stdout.write('new-required-command')"] };
  const { facts } = await retainedScenario(t, { options: { pivotCandidates: 1 }, remainingGate: [command] });
  assert.equal(facts.approved, true, facts.reason);
  assert.equal(facts.evidence.filter(e => e.stdout === 'new-required-command').length, 1);
  assert.equal(facts.evidence.at(-1).exitCode, 0);
  assert.equal(facts.approval.artifactDigest, createHash('sha256').update(readFileSync(join(facts.dir, 'CHANGES.diff'))).digest('hex'));
});



const TEST_SUPERPOWERS = {
  seats: {
    codex: { verified: true, path: null },
    cursor: { verified: true, path: null },
    claude: { verified: true, path: null },
  },
};

function fixture(name) {
  const root = mkdtempSync(join(tmpdir(), `.ccc-test-${name}-`));
  const target = join(root, 'target');
  const scratchRoot = join(root, 'scratch');
  const worktree = join(scratchRoot, name, 'w');
  mkdirSync(target, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(target, 'seed.txt'), 'seed\n');
  return {
    root, target, scratchRoot, worktree,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const proofBytes = Buffer.from([0, 1, 2, 13, 10, 255, 42]);
const executableProof = Buffer.from("import assert from 'node:assert/strict'; assert.ok(true);\n");
const eventBytes = Buffer.from('{"stage":"debate","type":"pivot"}\n');
const reviewText = [
  '## F1',
  'Severity: blocking',
  'Category: correctness',
  'Description: The same boundary defect remains.',
  'Test: __uro_review/tests/f1.test.js',
  '',
].join('\n');

test('fresh branch creation uses the pre-debate commit and restores reviewer bytes', async () => {
  const item = fixture('fresh-branch-unit');
  const reviewDir = join(item.worktree, '__uro_review', 'tests');
  const proof = join(reviewDir, 'f1.test.js');
  const failedAttempt = join(item.worktree, 'failed-attempt.txt');
  const eventsPath = join(item.worktree, 'events.jsonl');
  mkdirSync(reviewDir, { recursive: true });
  writeFileSync(proof, proofBytes);
  writeFileSync(failedAttempt, 'discard me\n');
  writeFileSync(eventsPath, eventBytes);
  const gitCalls = [];
  try {
    const result = await createFreshPivotBranch({
      cwd: item.worktree,
      baseCommit: 'pre-debate-commit',
      branch: 'uro/test-fresh-1',
      spawn: async (_bin, args) => {
        gitCalls.push(args);
        if (args.includes('clean')) {
          rmSync(join(item.worktree, '__uro_review'), { recursive: true, force: true });
          rmSync(failedAttempt, { force: true });
        }
        return {
          code: 0,
          stdout: args.includes('rev-parse') ? 'pre-debate-commit\n' : '',
          stderr: '',
        };
      },
    });

    assert.equal(result.branchPoint, 'pre-debate-commit');
    assert.ok(gitCalls.some((args) => args.join(' ').includes(
      'switch --discard-changes -c uro/test-fresh-1 pre-debate-commit',
    )));
    assert.ok(gitCalls.some((args) => args.join(' ').includes(
      'clean -ffd -x -e events.jsonl',
    )));
    assert.equal(existsSync(failedAttempt), false);
    assert.deepEqual(readFileSync(proof), proofBytes);
    assert.deepEqual(readFileSync(eventsPath), eventBytes);
  } finally { item.cleanup(); }
});
