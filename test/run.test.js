import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/args.js';
import {
  DEFAULT_EXECUTOR_EFFORT,
  DEFAULT_EXECUTOR_MODEL,
  EXECUTOR_PREAMBLE,
} from '../src/executor.js';
import {
  HARNESS_ARTIFACTS,
  run as executeRun,
  diffText,
  resolveDebateRounds,
} from '../src/run.js';
import { VERIFIED_SUPERPOWERS, withVerifiedSuperpowers } from '../fixtures/verified-superpowers.mjs';
import { PIVOT_CONCLUDE, PIVOT_FRESH } from '../src/debate.js';
import { EMPTY_USAGE } from '../src/usage.js';
import { DEFAULT_ARBITER_MODEL } from '../src/arbiter.js';
import {
  DEFAULT_VERIFIER_MODEL,
  parseVerdictDetail,
  REVIEW_PROMPT,
} from '../src/verifier.js';
import { spawnCapture } from '../src/spawn.js';
import { exitCodeFor } from '../src/exit.js';
import { reviewDigest, materializeReviewBundle } from '../src/review.js';
import { createInspectionReceipt } from '../src/context-evidence.js';
import { planningEnvelope, planningApproval } from './fixtures/planning-responses.js';
import { execFileSync } from 'node:child_process';
import { deriveMergeContext, MERGE_LEDGER_FILENAME } from '../src/merge.js';
import { landQueueDiff } from '../src/queue-runtime.js';

const run = (options) => executeRun(withVerifiedSuperpowers(options));

function executionEnvelope(request, action, extra = {}) {
  return { schemaVersion: 1, action, artifactDigest: request.state.artifactDigest,
    contextDigest: request.state.snapshot.digest, replyTo: null, content: 'Current execution dialogue',
    claims: [], issues: [], evidence: [], verifications: [], next: null, ...extra };
}

function nativeApproval(r, extra = {}) {
  const item = r.state.evidence.find(e => e.id === 'requirement-briefing');
  const receipt = createInspectionReceipt({ operationId: r.operationId, seat: 'claude', evidence: [item], inspected: true, result: 'read' });
  return { usage: { inputTokens: 3, outputTokens: 2 }, observations: { evidence: [], receipts: [receipt] },
    dialogue: executionEnvelope(r, 'approve', { claims: [{ id: 'briefing-requirement', kind: 'fact', text: 'The saved briefing is present.', evidenceIds: [item.id] }],
      verifications: [{ claimId: 'briefing-requirement', evidenceIds: [item.id], inspectionReceiptIds: [receipt.id], result: 'supports', reason: 'Read saved briefing' }], ...extra }) };
}

function nativeFixture(t, name, adapters = {}, gate = []) {
  const scr = scratch(), target = makeTarget();
  t.after(() => { rmSync(scr, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); });
  return { task: 'Write completed work', target, gate, scratchRoot: scr, artifactRoot: join(scr, 'artifacts'), runId: name, mode: 'autonomous',
    adapters: { runExecutor: r => { writeFileSync(join(r.cwd, 'completed.txt'), '1'); return { exitCode: 0, changedFiles: ['completed.txt'], usage: { inputTokens: 5, outputTokens: 1 }, dialogue: executionEnvelope(r, r.action) }; },
      runReview: nativeApproval, ...adapters } };
}

async function nativeMergeFixture(t, name, conflict = false) {
  const options = nativeFixture(t, name);
  const git = (...args) => execFileSync('git', ['-C', options.target, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-b', 'main'); git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'test'); git('config', 'user.email', 'test@local');
  const commit = message => { git('add', '-A'); git('-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-m', message); return git('rev-parse', 'HEAD'); };
  writeFileSync(join(options.target, 'shared.txt'), 'base\n');
  const base = commit('base'), parents = [];
  for (const id of ['left', 'middle', 'right']) {
    git('checkout', '-b', id, base);
    writeFileSync(join(options.target, conflict ? 'shared.txt' : `${id}.txt`), `${id}\n`);
    parents.push({ unitId: id, branch: id, commit: commit(id) });
  }
  git('checkout', 'main');
  options.baseRef = parents[0].commit;
  options.unitKind = 'merge';
  options.merge = await deriveMergeContext({ repository: options.target, parents });
  return { options, git };
}

test('native merge clean ordered parents have durable initial intent before Git and current merged approval', async t => {
  const { options } = await nativeMergeFixture(t, 'native-merge-clean');
  let beforeAdvance;
  options.reporter = event => {
    if (event.stage === 'merge' && event.type === 'start') {
      const cwd = join(options.scratchRoot, options.runId, 'w');
      const events = readFileSync(join(cwd, '__uro_dialogue/journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      beforeAdvance = { intent: events.findLast(e => e.type === 'prepare'),
        head: execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
        middleExists: existsSync(join(cwd, 'middle.txt')) };
    }
  };
  options.adapters.runExecutor = r => {
    const events = readFileSync(join(r.cwd, '__uro_dialogue/journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const intent = events.find(e => e.type === 'prepare' && e.effect === 'merge-sequence');
    assert.ok(intent, 'initial Git sequence must already have a durable intent');
    assert.equal(intent.selection.head, options.merge.parents[0].commit);
    assert.deepEqual(intent.selection.parents, options.merge.parents);
    assert.ok(events.some(e => e.type === 'complete' && e.operationId === intent.operationId));
    for (const id of ['left', 'middle', 'right']) assert.equal(readFileSync(join(r.cwd, `${id}.txt`), 'utf8'), `${id}\n`);
    writeFileSync(join(r.cwd, 'seam.test.js'), '');
    return { dialogue: executionEnvelope(r, r.action), usage: { inputTokens: 5, outputTokens: 1 } };
  };
  const facts = await run(options);
  assert.equal(facts.approved, true, facts.reason);
  assert.equal(beforeAdvance.intent.effect, 'merge-sequence');
  assert.equal(beforeAdvance.head, options.merge.parents[0].commit);
  assert.equal(beforeAdvance.middleExists, false, 'intent is observable before the first real parent merge');
  assert.equal(facts.dialogue.mergeProgress.complete, true);
  assert.equal(facts.dialogue.mergeProgress.nextParentIndex, 3);
  assert.equal(facts.dialogue.proposalCycles, 1);
  assert.equal(facts.resources.providerLaunches, 2);
  assert.match(readFileSync(join(facts.dir, 'CHANGES.diff'), 'utf8'), /left|middle|right/);
  assert.equal(facts.approval.artifactDigest, reviewDigest(readFileSync(join(facts.dir, 'CHANGES.diff'))));
  assert.ok(facts.evidence.some(e => e.kind === 'command' && e.argv.some(arg => arg.endsWith('merge-test-count.js'))));
  const landing = await landQueueDiff({ target: options.target, diffPath: join(facts.dir, 'CHANGES.diff'), unit: { name: 'merge' }, runId: facts.runId });
  assert.ok(landing.commit);
  for (const id of ['left', 'middle', 'right']) assert.equal(readFileSync(join(options.target, `${id}.txt`), 'utf8'), `${id}\n`);
});

test('native merge successive conflicts retain first resolution and separately prepare next parent without correction', async t => {
  const { options } = await nativeMergeFixture(t, 'native-merge-conflicts', true);
  let segments = 0;
  options.debateRounds = 1;
  options.adapters.runExecutor = r => {
    const parent = ++segments === 1 ? 'middle' : 'right';
    assert.equal(r.state.mergeProgress.conflict.parentUnitId, parent);
    assert.match(r.input, new RegExp(`merge of parent ${parent}`));
    if (segments === 2) assert.match(readFileSync(join(r.cwd, 'first-resolution.txt'), 'utf8'), /retained/);
    writeFileSync(join(r.cwd, 'shared.txt'), segments === 1 ? 'left and middle\n' : 'left and middle and right\n');
    writeFileSync(join(r.cwd, 'first-resolution.txt'), 'retained');
    writeFileSync(join(r.cwd, MERGE_LEDGER_FILENAME), JSON.stringify({ status: 'resolved', resolutions: [{ path: 'shared.txt', chosen: parent, reason: 'Preserve all parent behavior' }] }));
    return { dialogue: executionEnvelope(r, r.action), usage: { inputTokens: 5, outputTokens: 1 } };
  };
  const facts = await run(options);
  assert.equal(facts.approved, true, facts.reason);
  assert.equal(segments, 2);
  assert.equal(facts.dialogue.proposalCycles, 1);
  assert.equal(facts.dialogue.correctionCycles, 0);
  assert.equal(facts.resources.providerLaunches, 3);
  assert.deepEqual(facts.merge.resolutions.map(r => r.parentUnitId), ['middle', 'right']);
  assert.equal(existsSync(join(facts.dir, MERGE_LEDGER_FILENAME)), false);
});

test('native merge malformed missing and conflicting-intent ledgers retain work without another effect or reviewer', async t => {
  for (const kind of ['missing', 'malformed', 'conflicting-intent']) {
    const { options } = await nativeMergeFixture(t, `native-merge-ledger-${kind}`, true);
    let writes = 0, reviews = 0;
    options.adapters.runExecutor = r => {
      writes++;
      writeFileSync(join(r.cwd, 'retained.txt'), 'useful work');
      if (kind !== 'missing') writeFileSync(join(r.cwd, MERGE_LEDGER_FILENAME), kind === 'malformed' ? '{' : JSON.stringify({
        status: 'conflicting-intent', resolutions: [{ path: 'shared.txt', chosen: 'Unresolved for human', reason: 'Parent intents conflict' }] }));
      return { dialogue: executionEnvelope(r, r.action), usage: { inputTokens: 1, outputTokens: 1 } };
    };
    options.adapters.runReview = () => { reviews++; };
    const facts = await run(options);
    assert.equal(facts.approved, false);
    assert.match(facts.reason, kind === 'conflicting-intent' ? /conflicting-intent/ : kind === 'missing' ? /missing.*resolutions/ : /invalid.*resolutions/);
    assert.equal(readFileSync(join(facts.dir, 'retained.txt'), 'utf8'), 'useful work');
    assert.equal(writes, 1); assert.equal(reviews, 0);
    assert.equal(facts.dialogue.mergeProgress.nextParentIndex, 1);
    assert.equal(facts.dialogue.mergeProgress.complete, false);
    assert.equal(facts.evidence.length, 0);
  }
});

test('native merge actual derived test floor failure blocks current approval', async t => {
  const { options } = await nativeMergeFixture(t, 'native-merge-floor');
  options.merge.testCounts.required = 2;
  const facts = await run(options);
  assert.equal(facts.approved, false);
  assert.match(facts.reason, /checks.*failed/);
  const floor = facts.evidence.find(e => e.kind === 'command');
  assert.equal(floor.exitCode, 1);
  assert.match(floor.stdout, /actual=0 required=2/);
  assert.equal(facts.dialogue.approval, null);
});

test('native merge uncertain effect finalization observes partial bytes without staging or another provider', async t => {
  const { options } = await nativeMergeFixture(t, 'native-merge-uncertain');
  let captures = 0, providers = 0, heldIndex, heldHead;
  options.adapters.diffText = async cwd => {
    captures++;
    const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
    heldIndex = git('ls-files', '--stage'); heldHead = git('rev-parse', 'HEAD');
    writeFileSync(join(cwd, 'left.txt'), 'useful partial bytes after merge\n');
    writeFileSync(join(cwd, 'uncaptured.txt'), 'uncertain new work');
    throw new Error('interrupted merge outcome capture');
  };
  options.adapters.runExecutor = () => { providers++; };
  const facts = await run(options);
  assert.equal(facts.approved, false);
  assert.match(facts.reason, /interrupted merge outcome capture/);
  assert.equal(captures, 1, 'initial capture and post-uncertainty finalization must never call the staging adapter');
  assert.equal(providers, 0);
  const git = (...args) => execFileSync('git', ['-C', facts.dir, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(git('ls-files', '--stage'), heldIndex);
  assert.equal(git('rev-parse', 'HEAD'), heldHead);
  assert.match(readFileSync(join(facts.dir, 'CHANGES.diff'), 'utf8'), /useful partial bytes after merge/);
  assert.equal(facts.dialogue.pendingOperation.effect, 'merge-sequence');
  assert.equal(facts.checkpointState.mergeState.mergeProgress, null, 'callback-only progress is not a durably completed effect');
  assert.equal(facts.resources.providerLaunches, 0);
  assert.equal(facts.checkpointState.mergeState.observedWorkspace.diffComplete, false);
  assert.deepEqual(facts.checkpointState.mergeState.observedWorkspace.untrackedFiles, [{ path: 'uncaptured.txt', sha256: reviewDigest('uncertain new work') }]);
});

test('native merge retained replan carries completed progress and current remaining plan without repeating parents', async t => {
  const { options } = await nativeMergeFixture(t, 'native-merge-replan');
  let writes = 0, reviews = 0, advances = 0;
  options.pivotCandidates = 1;
  options.reporter = event => { if (event.stage === 'merge' && event.type === 'start') advances++; };
  options.adapters.runExecutor = r => {
    if (++writes === 2) {
      assert.match(r.input.split('Requested codex action:')[0], /Only add remaining.txt/);
      assert.equal(r.state.mergeProgress.complete, true);
      assert.equal(r.state.priorExecution.mergeProgress.operationId, r.state.mergeProgress.operationId);
    }
    writeFileSync(join(r.cwd, writes === 1 ? 'first.txt' : 'remaining.txt'), 'retained');
    return { dialogue: executionEnvelope(r, 'propose'), usage: { inputTokens: 1, outputTokens: 1 } };
  };
  options.adapters.runReview = r => ++reviews === 1 ? { dialogue: executionEnvelope(r, 'replan', {
    issues: [{ id: 'R1', title: 'Remaining seam work', status: 'open', blocking: true }],
    replan: { issueId: 'R1', evidenceIds: ['requirement-briefing'], novelty: 'The complete parent merge narrows remaining implementation to one additional file.' },
  }), usage: { inputTokens: 1, outputTokens: 1 } } : nativeApproval(r);
  options.adapters.draftPlanCandidate = r => ({ plan: 'Only add remaining.txt', gate: [], dialogue: planningEnvelope(r, 'propose'), usage: { inputTokens: 1, outputTokens: 1 } });
  options.adapters.reviewPlanCandidate = planningApproval;
  const facts = await run(options);
  assert.equal(facts.approved, true, facts.reason);
  assert.equal(advances, 1); assert.equal(writes, 2);
  assert.equal(facts.checkpointState.phaseChain.length, 3);
  assert.equal(facts.dialogue.proposalCycles, 2);
  assert.equal(facts.dialogue.correctionCycles, 0);
});

test('native merge rejects a replaced actual MERGE_HEAD before concluding the saved parent conflict', async t => {
  const { options } = await nativeMergeFixture(t, 'native-merge-head-mismatch', true);
  let writes = 0;
  options.adapters.runExecutor = r => {
    writes++;
    writeFileSync(join(r.cwd, 'shared.txt'), 'retained resolution');
    writeFileSync(join(r.cwd, MERGE_LEDGER_FILENAME), JSON.stringify({ status: 'resolved', resolutions: [{ path: 'shared.txt', chosen: 'both', reason: 'Retain both' }] }));
    const mergeHeadPath = execFileSync('git', ['-C', r.cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
    writeFileSync(mergeHeadPath, `${options.merge.parents[2].commit}\n`);
    return { dialogue: executionEnvelope(r, 'propose'), usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const facts = await run(options);
  assert.equal(facts.approved, false);
  assert.match(facts.reason, /actual merge parent.*saved conflict/);
  assert.equal(writes, 1);
  assert.equal(execFileSync('git', ['-C', facts.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(), options.merge.parents[0].commit);
  assert.equal(existsSync(join(facts.dir, MERGE_LEDGER_FILENAME)), true);
});

test('native merge partial replan composes each later conflict from the current approved remaining plan in one cycle', async t => {
  const { options } = await nativeMergeFixture(t, 'native-merge-partial-replan', true);
  let writes = 0, reviews = 0;
  options.pivotCandidates = 1; options.debateRounds = 1;
  const remainingPlan = 'Preserve partial.txt and complete only the remaining parent conflicts.';
  options.adapters.runExecutor = r => {
    writes++;
    if (writes === 1) {
      writeFileSync(join(r.cwd, 'partial.txt'), 'retained before planning');
      return { dialogue: executionEnvelope(r, 'ask'), usage: { inputTokens: 1, outputTokens: 1 } };
    }
    const parent = writes === 2 ? 'middle' : 'right';
    const taskPreamble = r.input.split('Requested codex action:')[0];
    assert.match(taskPreamble, /Preserve partial.txt and complete only the remaining parent conflicts/);
    assert.match(taskPreamble, new RegExp(`merge of parent ${parent}`));
    assert.equal(r.state.proposalCycles, 1); assert.equal(r.state.correctionCycles, 0);
    assert.equal(readFileSync(join(r.cwd, 'partial.txt'), 'utf8'), 'retained before planning');
    writeFileSync(join(r.cwd, 'shared.txt'), writes === 2 ? 'left and middle' : 'all three parents');
    writeFileSync(join(r.cwd, MERGE_LEDGER_FILENAME), JSON.stringify({ status: 'resolved', resolutions: [{ path: 'shared.txt', chosen: 'composed', reason: 'Preserve all parent behavior' }] }));
    return { dialogue: executionEnvelope(r, 'propose'), usage: { inputTokens: 1, outputTokens: 1 } };
  };
  options.adapters.runReview = r => ++reviews === 1 ? { dialogue: executionEnvelope(r, 'replan', {
    issues: [{ id: 'R1', title: 'Clarify remaining merge strategy', status: 'open', blocking: true }],
    replan: { issueId: 'R1', evidenceIds: ['requirement-briefing'], novelty: 'The retained partial implementation leaves only ordered parent conflict resolution.' },
  }), usage: { inputTokens: 1, outputTokens: 1 } } : nativeApproval(r);
  options.adapters.draftPlanCandidate = r => ({ plan: remainingPlan, gate: [], dialogue: planningEnvelope(r, 'propose'), usage: { inputTokens: 1, outputTokens: 1 } });
  options.adapters.reviewPlanCandidate = planningApproval;
  const facts = await run(options);
  assert.equal(facts.approved, true, facts.reason);
  assert.equal(writes, 3); assert.equal(reviews, 2);
  assert.equal(facts.dialogue.proposalCycles, 1); assert.equal(facts.dialogue.correctionCycles, 0);
  assert.equal(facts.dialogue.executionCycle.completedOperationIds.length, 3);
  assert.equal(facts.checkpointState.phaseChain.length, 3);
  assert.equal(facts.checkpointState.approvedExecutionPlan, `${remainingPlan}\n`);
});

test('native ordinary run binds actual writes and required command evidence to current approval and facts', async t => {
  const command = { bin: process.execPath, args: ['-e', "if(require('node:fs').readFileSync('completed.txt','utf8')!=='1')process.exit(4);process.stdout.write('x'.repeat(16000))"] };
  const facts = await run(nativeFixture(t, 'native-complete', { runReview: r => {
    const check = r.state.evidence.find(e => e.kind === 'command');
    assert.equal(check.stdout.length, 16000); assert.equal(check.exitCode, 0);
    assert.deepEqual(check.argv, [process.execPath, ...command.args]);
    assert.equal(check.claimIds.length, 1, 'observed command evidence must be available for factual verification');
    return nativeApproval(r);
  } }, [command]));
  assert.equal(facts.approved, true, facts.reason);
  assert.equal(facts.outcome, 'review-ready');
  assert.equal(facts.approval.artifactDigest, reviewDigest(readFileSync(join(facts.dir, 'CHANGES.diff'))));
  assert.equal(facts.approval.contextDigest, facts.dialogue.snapshot.digest);
  assert.equal(facts.resources.providerLaunches, 2);
  assert.equal(facts.tokens.total.inputTokens, 8);
  assert.equal(facts.dialogue.proposalCycles, 1);
  assert.equal(facts.checkpointState.executionArtifacts.files.some(f => f.path.endsWith('journal-tail.jsonl')), true);
  assert.equal(facts.iterations.length, 1);
});

test('native ordinary partial question resumes only remaining work with no gate at the yield', async t => {
  let writes = 0, reviews = 0;
  const facts = await run(nativeFixture(t, 'native-remaining', {
    runExecutor: r => {
      if (++writes === 1) { writeFileSync(join(r.cwd, 'completed.txt'), '1'); return { dialogue: executionEnvelope(r, 'ask') }; }
      assert.equal(r.remainingWork, true); assert.equal(readFileSync(join(r.cwd, 'completed.txt'), 'utf8'), '1');
      writeFileSync(join(r.cwd, 'remaining.txt'), 'done'); return { dialogue: executionEnvelope(r, 'propose') };
    }, runReview: r => {
      if (++reviews === 1) { assert.equal(r.state.executionChecks, undefined); return { dialogue: executionEnvelope(r, 'answer', { next: { seat: 'codex', action: 'propose', reason: 'Finish remaining work' } }) }; }
      return nativeApproval(r);
    },
  }));
  assert.equal(facts.approved, true, facts.reason); assert.equal(writes, 2);
  assert.equal(facts.dialogue.proposalCycles, 1); assert.equal(facts.dialogue.correctionCycles, 0);
  assert.equal(readFileSync(join(facts.dir, 'remaining.txt'), 'utf8'), 'done');
});

test('native ordinary failed required checks cannot become approval', async t => {
  const facts = await run(nativeFixture(t, 'native-red-command', {}, [{ bin: process.execPath, args: ['-e', 'process.exit(7)'] }]));
  assert.equal(facts.approved, false); assert.notEqual(facts.outcome, 'review-ready');
  assert.match(facts.reason, /required checks/);
  assert.equal(facts.evidence[0].exitCode, 7);
  const states = readFileSync(join(facts.dir, '__uro_dialogue', 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.type === 'state');
  assert.equal(states.at(-1).state.approval, null, 'failed checks must not durably finalize native approval');
});

test('native retained replan continues an open execution cycle without another correction', async t => {
  let writes = 0, reviews = 0, cycle;
  const facts = await run({ ...nativeFixture(t, 'native-replan-open-cycle', {
    runExecutor: r => {
      if (++writes === 1) {
        cycle = r.state.executionCycle.id; writeFileSync(join(r.cwd, 'completed.txt'), '1');
        return { dialogue: executionEnvelope(r, 'ask') };
      }
      assert.equal(r.state.executionCycle.id, cycle); assert.equal(r.state.proposalCycles, 1);
      assert.equal(r.state.correctionCycles, 0); assert.equal(r.remainingWork, true);
      writeFileSync(join(r.cwd, 'remaining.txt'), 'done'); return { dialogue: executionEnvelope(r, 'propose') };
    },
    runReview: r => ++reviews === 1 ? { dialogue: executionEnvelope(r, 'replan', {
      issues: [{ id: 'R1', title: 'Partial execution needs a remaining plan', status: 'open', blocking: true }],
      replan: { issueId: 'R1', evidenceIds: ['requirement-briefing'], novelty: 'The completed first segment narrows the remaining work to one file.' },
    }) } : nativeApproval(r),
    draftPlanCandidate: r => ({ plan: 'Only finish remaining.txt', gate: [], dialogue: planningEnvelope(r, 'propose') }),
    reviewPlanCandidate: planningApproval,
  }), pivotCandidates: 1, debateRounds: 1 });
  assert.equal(facts.approved, true, facts.reason); assert.equal(writes, 2);
  assert.equal(facts.dialogue.proposalCycles, 1); assert.equal(facts.dialogue.correctionCycles, 0);
  assert.equal(facts.dialogue.executionCycle.completedOperationIds.length, 2);
});

test('native retained replan manual dispute launches no child before human resolution', async t => {
  let planning = 0;
  const facts = await run({ ...nativeFixture(t, 'native-replan-manual-dispute', {
    runReview: r => ({ dialogue: executionEnvelope(r, 'replan', {
      issues: [{ id: 'R1', title: 'Disputed remaining strategy', status: 'disputed', blocking: true }],
      replan: { issueId: 'R1', evidenceIds: ['requirement-briefing'], novelty: 'The completed segment raises a disputed remaining-work choice.' },
    }) }),
    draftPlanCandidate: () => { planning++; return { unavailable: true }; },
  }), mode: 'manual' });
  assert.equal(facts.approved, false); assert.equal(planning, 0);
  assert.equal(facts.nextAction, 'needs-decision'); assert.equal(facts.phase, 'execution');
  assert.equal(facts.dialogue.pendingDecision.authority, 'human');
  assert.equal(facts.dialogue.terminalAction, 'replan');
  assert.equal(readFileSync(join(facts.dir, 'completed.txt'), 'utf8'), '1');
});

test('native ordinary dialogue permits four challenges and enforces an explicit separate challenge limit', async t => {
  for (const limit of [undefined, 2]) {
    let exchanges = 0, coding = 0;
    const options = nativeFixture(t, `native-exchanges-${limit}`, {
      runExecutor: r => {
        if (r.action === 'challenge') { exchanges++; return { dialogue: executionEnvelope(r, 'challenge', { evidence: ['requirement-briefing'] }) }; }
        coding++; writeFileSync(join(r.cwd, 'completed.txt'), '1'); return { dialogue: executionEnvelope(r, 'propose') };
      }, runReview: r => exchanges < 4 ? { dialogue: executionEnvelope(r, 'ask', { next: { seat: 'codex', action: 'challenge', reason: 'Discuss evidence' } }) } : nativeApproval(r),
    });
    options.challengeRounds = limit;
    const facts = await run(options);
    assert.equal(coding, 1); assert.equal(exchanges, limit ?? 4);
    assert.equal(facts.approved, limit === undefined, facts.reason);
    assert.equal(facts.dialogue.proposalCycles, 1);
  }
});

test('native ordinary uncertain writer retains bytes without another provider even with restart configured', async t => {
  let calls = 0, reviews = 0;
  const options = nativeFixture(t, 'native-timeout', {
    runExecutor: r => { calls++; writeFileSync(join(r.cwd, 'partial.txt'), 'retained'); return { timedOut: true, exitCode: 1, lastMessage: '' }; },
    runReview: () => { reviews++; },
  });
  options.stallPolicy = 'restart'; options.stallRestartLimit = 3;
  const facts = await run(options);
  assert.equal(facts.approved, false); assert.equal(calls, 1); assert.equal(reviews, 0);
  assert.match(readFileSync(join(facts.dir, 'CHANGES.diff'), 'utf8'), /retained/);
  assert.equal(facts.resources.providerLaunches, 1);
});

test('native ordinary empty malformed output and absent or legacy reviewer never imply approval', async t => {
  for (const shape of ['empty', 'missing-review', 'legacy-review']) {
    const options = nativeFixture(t, `native-negative-${shape}`);
    if (shape === 'empty') options.adapters.runExecutor = () => ({ exitCode: 0, changedFiles: [], lastMessage: '' });
    if (shape === 'missing-review') delete options.adapters.runReview;
    if (shape === 'legacy-review') options.adapters.runReview = () => ({ conclusion: 'clean', artifact: null });
    const facts = await run(options);
    assert.equal(facts.approved, false); assert.notEqual(facts.outcome, 'no-op');
    assert.notEqual(exitCodeFor(facts), 0);
  }
});

test('native ordinary retained manifest corruption is unapproved before another seat', async t => {
  let reviews = 0;
  const facts = await run(nativeFixture(t, 'native-manifest', {
    judgeLiveness: async () => ({ status: 'working', reasoning: 'Observed current progress', usage: { inputTokens: 4, outputTokens: 2 } }),
    runExecutor: async r => { await r.judgeLiveness({ checkCount: 1 }); writeFileSync(join(r.cwd, 'completed.txt'), '1');
      writeFileSync(join(r.cwd, '__uro_context', `${r.state.snapshot.id}.json`), '{}');
      return { dialogue: executionEnvelope(r, 'propose'), usage: { inputTokens: 7, outputTokens: 3 } }; }, runReview: () => { reviews++; },
  }));
  assert.equal(facts.approved, false); assert.equal(reviews, 0);
  assert.equal(facts.checkpointState.executionArtifacts, undefined);
  assert.equal(readFileSync(join(facts.dir, 'completed.txt'), 'utf8'), '1');
  assert.equal(facts.checkpointState.supervision.observedWorkspace.diffComplete, false);
  assert.ok(facts.checkpointState.supervision.observedWorkspace.untrackedFiles.some(file => file.path === 'completed.txt'));
  assert.equal((await spawnCapture('git', ['-C', facts.dir, 'ls-files', '--', 'completed.txt'])).stdout, '');
  assert.equal(facts.resources.providerLaunches, 2);
  assert.partialDeepStrictEqual(facts.resources.knownUsage, { inputTokens: 11, outputTokens: 5 });
  assert.equal(facts.checkpointState.phaseChain.at(-1).checkpointState.executionArtifacts, undefined);
  assert.ok(facts.requiredSourceFailure);
});

test('native ordinary invalid merge identities stop before initial Git advance and every provider', async t => {
  let calls = 0;
  const { options } = await nativeMergeFixture(t, 'native-merge-pause');
  options.adapters.runExecutor = () => { calls++; };
  options.merge.parents[1].commit = 'does-not-exist';
  const facts = await run(options);
  assert.equal(facts.approved, false); assert.match(facts.reason, /bad revision|unknown revision|Command failed|ambiguous argument/);
  assert.equal(calls, 0); assert.equal(facts.resources.providerLaunches, 0);
});

test('native ordinary reviewer mistake is rebutted and disposed without another edit', async t => {
  let coding = 0, reviews = 0;
  const facts = await run(nativeFixture(t, 'native-rebuttal', {
    runExecutor: r => {
      if (r.action === 'rebut') return { dialogue: executionEnvelope(r, 'rebut', { evidence: ['requirement-briefing'], content: 'The requirement already specifies this behavior.' }) };
      coding++; writeFileSync(join(r.cwd, 'completed.txt'), '1'); return { dialogue: executionEnvelope(r, 'propose') };
    }, runReview: r => ++reviews === 1 ? { dialogue: executionEnvelope(r, 'ask', {
      issues: [{ id: 'I1', title: 'Possible requirement mismatch', status: 'awaiting-answer', blocking: true }],
      next: { seat: 'codex', action: 'rebut', reason: 'Explain the requirement' },
    }) } : nativeApproval(r, { issues: [{ id: 'I1', status: 'resolved', disposition: { kind: 'rejected', reason: 'The briefing already specifies it.', claimIds: ['briefing-requirement'] } }] }),
  }));
  assert.equal(facts.approved, true, facts.reason); assert.equal(coding, 1);
  assert.equal(facts.dialogue.issues.I1.disposition.kind, 'rejected');
  assert.equal(facts.messages.some(m => m.action === 'rebut'), true);
});

test('native ordinary final code change invalidates the current approval instead of relabelling it', async t => {
  let captures = 0;
  const facts = await run(nativeFixture(t, 'native-stale-final', { diffText: async (cwd, base) => {
    if (++captures === 4) writeFileSync(join(cwd, 'completed.txt'), 'changed after review');
    return diffText(cwd, base);
  } }));
  assert.equal(facts.approved, false); assert.match(facts.reason, /stale/);
  assert.match(readFileSync(join(facts.dir, 'CHANGES.diff'), 'utf8'), /changed after review/);
});

test('native ordinary reviewer check addition runs independently and invalidates the earlier approval', async t => {
  let reviews = 0;
  const facts = await run(nativeFixture(t, 'native-added-check', { runReview: async r => {
    reviews++;
    if (reviews > 1) {
      assert.equal(r.state.approval, null);
      assert.equal(r.state.evidence.some(e => e.kind === 'command' && e.argv.includes('--test')), true);
      return nativeApproval(r);
    }
    const response = nativeApproval(r);
    const bundle = { version: 1, conclusion: 'clean', report: 'Check the existing implementation.', tests: [{ path: 'tests/current.test.js', content: "require('node:assert/strict').equal(require('node:fs').readFileSync('completed.txt','utf8'),'1');" }] };
    return { ...response, resultSeen: true, resultUsable: true, materializationDeferred: true,
      answer: `${JSON.stringify(bundle)}\n<UROBOROS_DIALOGUE>${JSON.stringify(response.dialogue)}</UROBOROS_DIALOGUE>` };
  } }, [{ bin: process.execPath, args: ['--test'] }]));
  assert.equal(facts.approved, true, facts.reason); assert.equal(reviews, 2);
  assert.equal(facts.dialogue.proposalCycles, 1);
});

test('native ordinary correction starts one new cycle and rechecks actual changed files', async t => {
  let coding = 0, reviews = 0;
  const facts = await run(nativeFixture(t, 'native-correction', {
    runExecutor: r => { coding++; writeFileSync(join(r.cwd, 'completed.txt'), coding === 1 ? 'first' : 'corrected'); return { dialogue: executionEnvelope(r, r.action) }; },
    runReview: r => ++reviews === 1 ? { dialogue: executionEnvelope(r, 'ask', { next: { seat: 'codex', action: 'revise', reason: 'Correct the implementation using current evidence' } }) } : nativeApproval(r),
  }));
  assert.equal(facts.approved, true, facts.reason); assert.equal(coding, 2);
  assert.equal(facts.dialogue.proposalCycles, 2); assert.equal(facts.dialogue.correctionCycles, 1);
  assert.match(readFileSync(join(facts.dir, 'CHANGES.diff'), 'utf8'), /corrected/);
});

test('native ordinary discussion bundle restored by isolation cannot support approval', async t => {
  let reviews = 0;
  const facts = await run(nativeFixture(t, 'native-restored-bundle', {
    runExecutor: r => {
      if (r.action === 'answer') return { dialogue: executionEnvelope(r, 'answer', { next: { seat: 'claude', action: 'answer', reason: 'Discuss the explanation' } }) };
      writeFileSync(join(r.cwd, 'completed.txt'), '1'); return { dialogue: executionEnvelope(r, 'propose') };
    }, runReview: async r => {
      if (++reviews === 1) return { dialogue: executionEnvelope(r, 'ask', { next: { seat: 'codex', action: 'answer', reason: 'Explain the work' } }) };
      assert.equal(r.action, 'answer');
      const artifact = await materializeReviewBundle({ cwd: r.cwd, round: r.round, diffDigest: r.diffDigest,
        bundle: { version: 1, conclusion: 'clean', report: 'Discussion emitted a new report.', tests: [] } });
      return { ...nativeApproval(r), artifact };
    },
  }));
  assert.equal(facts.approved, false);
  assert.match(facts.reason, /retained review artifact/);
  assert.equal(facts.resources.providerLaunches, 4);
});

test('native ordinary requested answer approves current issues in the same call after protected raw transport', async t => {
  let reviews = 0, answers = 0;
  const deferred = (r, response, bundle) => ({ ...response, resultSeen: true, resultUsable: true, materializationDeferred: true,
    answer: `${JSON.stringify(bundle)}\n<UROBOROS_DIALOGUE>${JSON.stringify(response.dialogue)}</UROBOROS_DIALOGUE>` });
  const retainedReport = 'Explain the existing implementation.';
  const facts = await run(nativeFixture(t, 'native-answer-approval', {
    runExecutor: r => {
      if (r.action === 'answer') return { dialogue: executionEnvelope(r, 'answer', { next: { seat: 'claude', action: 'answer', reason: 'Settle this issue using the briefing' } }) };
      writeFileSync(join(r.cwd, 'completed.txt'), '1'); return { dialogue: executionEnvelope(r, 'propose') };
    }, runReview: r => {
      reviews++;
      assert.equal(r.deferMaterialization, true);
      if (reviews === 1) return deferred(r, { dialogue: executionEnvelope(r, 'ask', {
        issues: [{ id: 'I1', title: 'Clarify intended behavior', status: 'awaiting-answer', blocking: true }],
        next: { seat: 'codex', action: 'answer', reason: 'Explain the implementation' },
      }) }, { version: 1, conclusion: 'issues', report: retainedReport, tests: [] });
      answers++;
      assert.equal(r.action, 'answer');
      assert.equal(readFileSync(join(r.cwd, '__uro_review/REVIEW.md'), 'utf8'), retainedReport);
      assert.equal(r.state.executionChecks.artifactDigest, r.state.artifactDigest);
      writeFileSync(join(r.cwd, '__uro_review/REVIEW.md'), 'unauthorized raw provider edit');
      mkdirSync(join(r.cwd, '__uro_review/tests'), { recursive: true });
      writeFileSync(join(r.cwd, '__uro_review/tests/tamper.test.js'), 'unauthorized new test');
      writeFileSync(join(r.cwd, 'completed.txt'), 'unauthorized project edit');
      return deferred(r, nativeApproval(r, { issues: [{ id: 'I1', status: 'resolved', disposition: { kind: 'rejected', reason: 'The briefing supports the implemented behavior.', claimIds: ['briefing-requirement'] } }] }),
        { version: 1, conclusion: 'clean', report: 'The current issue is resolved by the cited briefing.', tests: [] });
    },
  }, [{ bin: process.execPath, args: ['-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('completed.txt','utf8'),'1')"] }]));
  assert.equal(facts.approved, true, facts.reason);
  assert.equal(answers, 1, 'the requested answer must approve without a second provider call');
  assert.equal(reviews, 2); assert.equal(facts.resources.providerLaunches, 4);
  assert.equal(facts.dialogue.issues.I1.status, 'resolved');
  assert.equal(facts.approval.messageId, facts.messages.at(-1).id);
  assert.equal(readFileSync(join(facts.dir, 'completed.txt'), 'utf8'), '1');
  assert.equal(existsSync(join(facts.dir, '__uro_review/tests/tamper.test.js')), false);
  assert.equal(facts.iterations.at(-1).reviewer.artifact.revisions.find(item => item.path === 'REVIEW.md').before, reviewDigest(retainedReport));
  assert.match(readFileSync(join(facts.dir, '__uro_review/REVIEW.md'), 'utf8'), /current issue is resolved/);
});

test('native ordinary budget stops before the next provider using journal usage once', async t => {
  let reviews = 0;
  const options = nativeFixture(t, 'native-budget', { runReview: () => { reviews++; } });
  options.tokenBudget = 6;
  const facts = await run(options);
  assert.equal(facts.approved, false); assert.equal(reviews, 0);
  assert.equal(facts.resources.providerLaunches, 1); assert.equal(facts.tokens.total.inputTokens, 5);
  assert.match(facts.reason, /budget-exhausted/);
});

test('native ordinary required sink failure prevents second command and next reviewer', async t => {
  let reviews = 0;
  const facts = await run(nativeFixture(t, 'native-sink', { captureEvidence: () => { throw new Error('required sink unavailable'); },
    runReview: r => { reviews++; return nativeApproval(r); } }, [
    { bin: process.execPath, args: ['-e', "require('node:fs').writeFileSync('first-command','1')"] },
    { bin: process.execPath, args: ['-e', "require('node:fs').writeFileSync('second-command','1')"] },
  ]));
  assert.equal(facts.approved, false); assert.match(facts.reason, /required sink unavailable/);
  assert.equal(existsSync(join(facts.dir, 'first-command')), true);
  assert.equal(existsSync(join(facts.dir, 'second-command')), false); assert.equal(reviews, 0);
});

test('native ordinary missing replan authorization and requested mutation pause before later effects', async t => {
  for (const effect of ['replan', 'mutation']) {
    let later = 0;
    const options = nativeFixture(t, `native-wip-${effect}`, { runPlanCandidateSet: () => { later++; }, runMutation: () => { later++; },
      runReview: r => effect === 'replan' ? { dialogue: executionEnvelope(r, 'replan') } : nativeApproval(r) });
    if (effect === 'mutation') options.mutation = true;
    const facts = await run(options);
    assert.equal(facts.approved, false); assert.match(facts.reason, new RegExp(effect));
    assert.equal(later, 0); assert.equal(readFileSync(join(facts.dir, 'completed.txt'), 'utf8'), '1');
  }
});

test('default run captures partial execution before a human question and launches no gate or reviewer', async t => {
  const scr = scratch(), target = makeTarget();
  t.after(() => { rmSync(scr, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); });
  let gates = 0, reviews = 0;
  const facts = await run({ task: 'Keep the original requirement', target, gate: [], scratchRoot: scr,
    runId: 'native-human-partial', mode: 'autonomous', adapters: {
      runExecutor: r => {
        writeFileSync(join(r.cwd, 'completed.txt'), '1');
        assert.ok(r.state, 'normal run must deliver the prepared native dialogue request');
        return { exitCode: 0, changedFiles: ['completed.txt'], dialogue: executionEnvelope(r, 'ask', {
          evidence: ['requirement-briefing'], issues: [{ id: 'Q1', title: 'Choose the remaining product behavior',
            kind: 'product', needsHuman: true, blocking: true, status: 'awaiting-answer' }],
        }) };
      }, runGate: () => { gates++; }, runReview: () => { reviews++; },
    },
  });
  assert.equal(facts.approved, false);
  assert.equal(facts.outcome, 'needs-decision');
  assert.equal(readFileSync(join(facts.dir, 'completed.txt'), 'utf8'), '1');
  assert.equal(facts.dialogue.pendingDecision.authority, 'human');
  assert.equal(facts.dialogue.pendingDecision.artifactDigest, reviewDigest(facts.checkpointState.workspace.diff));
  assert.equal(facts.checkpointState.version, 2);
  assert.equal(facts.checkpointState.interactionMode, 'autonomous');
  assert.equal(gates, 0);
  assert.equal(reviews, 0);
});

function makeTarget(withFile = true) {
  const d = mkdtempSync(join(tmpdir(), 'tgt-'));
  if (withFile) writeFileSync(join(d, 'seed.txt'), 'seed');
  return d;
}
// Scratch base must satisfy assertSafeScratchRoot: NOT under AppData or OneDrive.
// os.tmpdir() is under AppData on Windows and process.cwd() is under OneDrive for a
// checkout that lives in a synced folder — both are rejected by the guard. Mirror the
// production default from bin/loop.js, which is safe by the same construction.
const SAFE_SCRATCH_BASE = process.env.URO_TEST_SCRATCH_ROOT ?? (process.platform === 'win32'
  ? 'C:/ccc-test'
  : join(homedir(), '.ccc-test'));
const scratch = () => {
  mkdirSync(SAFE_SCRATCH_BASE, { recursive: true });
  return mkdtempSync(join(SAFE_SCRATCH_BASE, '.ccc-test-'));
};

// Executor fake that writes a file into the isolated dir, so the diff is non-empty.
const writingExecutor = async ({ cwd }) => {
  writeFileSync(join(cwd, 'new.txt'), 'content');
  return { changedFiles: ['new.txt'], lastMessage: 'wrote new.txt' };
};
const noopExecutor = async () => ({ changedFiles: [], lastMessage: 'nothing to do' });

const DECISION_CONTENT = `
## Q1
Kind: technical
Question: Should this follow the existing implementation convention?
Options: follow the task literally, follow the existing convention
Recommendation: follow the existing convention
`;

const AUTHORITY_DECISION_CONTENT = `
## Q1
Kind: authority
Question: May the executor choose on the operator's behalf?
Options: halt, follow the isolated-worktree recommendation
Recommendation: follow the isolated-worktree recommendation
`;

test('one holistic review report carries correctness and intent findings into the record', async () => {
  const scr = scratch();
  const reviewCalls = [];
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'f1',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async () => ({ passed: true, results: [] }),
      runReview: reviewerForRounds([
        `${suggestionReview('F1')}\n## F2\nSeverity: suggestion\nCategory: intent\nDescription: The shared-scope requirement was dropped.\n`,
      ], reviewCalls),
    },
  });
  assert.equal(facts.outcome, 'review-ready');
  const round = facts.debate.roundHistory[0];
  assert.deepEqual(round.findingIds, ['F1', 'F2']);
  assert.equal(round.findings[1].category, 'intent');
  assert.equal(round.findings[1].description, 'The shared-scope requirement was dropped.');
  // The two-seat verdict surface is gone from the facts entirely.
  for (const gone of ['verdict', 'correctnessVerdict', 'intentVerdict',
    'verifierFindings', 'intentVerifierFindings']) {
    assert.equal(Object.hasOwn(facts, gone), false, `${gone} must not exist`);
  }
  assert.equal(facts.baseRef, 'HEAD');
  assert.match(facts.baseCommit, /^[0-9a-f]{40,64}$/);
  assert.equal(facts.branch, 'uro/f1');
  assert.equal(reviewCalls.length, 1, 'one seat, one report');
  assert.equal(reviewCalls[0].request.originalRequirements, 'do the task');
  assert.match(reviewCalls[0].request.diff, /new.txt/);
  assert.match(JSON.stringify(reviewCalls[0].request.messages), /wrote new.txt/);
  rmSync(scr, { recursive: true, force: true });
});

test('debate fix rounds accumulate usage and model overrides reach both agents and run facts', async () => {
  const scr = scratch();
  const executorCalls = [];
  const verifierCalls = [];
  let executorCall = 0;
  let gateCall = 0;
  const executorUsages = [
    { inputTokens: 10, cachedInputTokens: 5, outputTokens: 2,
      reasoningOutputTokens: 1, cacheWriteTokens: 0 },
    { inputTokens: 20, cachedInputTokens: 10, outputTokens: 3,
      reasoningOutputTokens: 2, cacheWriteTokens: 1 },
  ];
  const roundOneUsage = { inputTokens: 18, cachedInputTokens: 9, outputTokens: 14,
    reasoningOutputTokens: 0, cacheWriteTokens: 5 };
  const roundTwoUsage = { inputTokens: 18, cachedInputTokens: 9, outputTokens: 14,
    reasoningOutputTokens: 0, cacheWriteTokens: 5 };
  const cliOpts = parseArgs(['run', '--task', 'do the task', '--target', makeTarget(),
    '--gate', 'unused-gate.json', '--gate-retries', '1',
    '--executor-model', 'executor-override', '--executor-effort', 'medium',
    '--claude-model', 'reviewer-override']);
  const facts = await run({
    ...cliOpts, verifierModel: cliOpts.claudeModel, gate: [],
    scratchRoot: scr, runId: 'usage-models',
    adapters: {
      runExecutor: async (opts) => {
        executorCalls.push(opts);
        writeFileSync(join(opts.cwd, 'new.txt'), 'content');
        return { changedFiles: ['new.txt'], lastMessage: `attempt ${executorCall + 1}`,
          usage: executorUsages[executorCall++] };
      },
      runGate: async () => { gateCall++; return { passed: true, results: [] }; },
      // Round one's report files a blocking finding to force a fix round;
      // round two's report is clean, so the debate converges.
      runReview: (() => {
        const reviewer = reviewerForRounds([blockingReview(), null], verifierCalls);
        let round = 0;
        return async (opts) => {
          const result = await reviewer(opts);
          round++;
          return { ...result, usage: round === 1 ? roundOneUsage : roundTwoUsage };
        };
      })(),
    },
  });
  assert.equal(executorCalls.length, 2, 'initial execution plus one debate fix round');
  for (const call of executorCalls) {
    assert.equal(call.model, 'executor-override');
    assert.equal(call.effort, 'medium');
  }
  assert.equal(verifierCalls.length, 2, 'two rounds, one reviewer each');
  for (const call of verifierCalls) assert.equal(call.model, 'reviewer-override');
  assert.deepEqual(verifierCalls.map((call) => call.request.round), [1, 2]);
  assert.deepEqual(facts.model, {
    executor: 'executor-override', executorEffort: 'medium', verifier: 'reviewer-override',
    arbiter: 'reviewer-override',
  });
  assert.deepEqual(facts.iterations[0].executorUsage, executorUsages[0]);
  assert.deepEqual(facts.iterations[1].executorUsage, executorUsages[1]);
  assert.deepEqual(facts.tokens, {
    participants: [
      { provider: 'codex', phase: 'execution', role: 'implementation-author',
        usage: { inputTokens: 30, cachedInputTokens: 15, outputTokens: 5, reasoningOutputTokens: 3, cacheWriteTokens: 1 } },
      { provider: 'claude', phase: 'execution', role: 'execution-reviewer',
        usage: { inputTokens: 36, cachedInputTokens: 18, outputTokens: 28, reasoningOutputTokens: 0, cacheWriteTokens: 10 } },
    ],
    total: { inputTokens: 66, cachedInputTokens: 33, outputTokens: 33,
      reasoningOutputTokens: 3, cacheWriteTokens: 11 },
  });
  assert.equal(facts.debate.roundsRun, 2);
  assert.deepEqual(facts.debate.findingsPerRound, [['F1'], []]);
  assert.equal(Object.hasOwn(facts, 'verdictSource'), false);
  assert.equal(Object.hasOwn(facts, 'gateFailure'), false);
  rmSync(scr, { recursive: true, force: true });
});

// The retained-evidence verdict-consistency surface died with the verdict
// passes; checkVerdictConsistency remains covered in verifier.test.js where
// the transport lives.
test('a token invariant violation is reported without failing a completed run', async () => {
  const scr = scratch();
  const target = makeTarget();
  try {
    const facts = await run({
      task: 'do the task', target, gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'usage-disagreement',
      adapters: {
        runExecutor: async (opts) => {
          await writingExecutor(opts);
          return {
            changedFiles: ['new.txt'],
            lastMessage: 'wrote new.txt',
            usage: {
              inputTokens: 10,
              cachedInputTokens: 30,
              outputTokens: 2,
              reasoningOutputTokens: 0,
              cacheWriteTokens: 0,
            },
          };
        },
        runGate: async () => ({ passed: true, results: [] }),
        runVerifier: async () => ({
          verdict: 'NO_BLOCKERS', launchFailed: false, usage: EMPTY_USAGE,
        }),
      },
    });

    assert.equal(facts.outcome, 'review-ready', 'accounting diagnostics must not fail the run');
    assert.equal(facts.usageConsistency.status, 'disagreement');
    const violation = facts.usageConsistency.checks.find((check) => (
      check.seat === 'executor' && check.status === 'disagreement'
    ));
    assert.ok(violation, 'the executor violation must be retained in run facts');
    assert.equal(violation.invariant, 'cachedInputTokens <= inputTokens');
    assert.equal(violation.inputTokens, 10);
    assert.equal(violation.cachedInputTokens, 30);

    const persisted = JSON.parse(readFileSync(join(facts.dir, 'uro-runfacts.json'), 'utf8'));
    assert.equal(persisted.usageConsistency.status, 'disagreement');
    const report = readFileSync(join(facts.dir, 'uro-report.md'), 'utf8');
    assert.match(report, /token accounting bookkeeping disagreement/i);
    assert.match(report, /input 10, cached input 30/i);
  } finally {
    rmSync(scr, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('omitted model flags travel through the CLI path to both agents and run-fact defaults', async () => {
  const scr = scratch();
  const executorCalls = [];
  const verifierCalls = [];
  const cliOpts = parseArgs(['run', '--task', 'do the task', '--target', makeTarget(),
    '--gate', 'unused-gate.json']);
  const facts = await run({
    ...cliOpts, verifierModel: cliOpts.claudeModel, gate: [], scratchRoot: scr, runId: 'default-models',
    adapters: {
      runExecutor: async (opts) => {
        executorCalls.push(opts);
        return writingExecutor(opts);
      },
      runGate: async () => ({ passed: true, results: [] }),
      runReview: reviewerForRounds([null], verifierCalls),
    },
  });

  assert.equal(executorCalls[0].model, DEFAULT_EXECUTOR_MODEL);
  assert.equal(executorCalls[0].effort, DEFAULT_EXECUTOR_EFFORT);
  assert.equal(Object.hasOwn(executorCalls[0], 'superpowersDir'), false);
  assert.deepEqual(verifierCalls.map((call) => call.model), [DEFAULT_VERIFIER_MODEL]);
  assert.deepEqual(verifierCalls.map((call) => call.bin), ['claude']);
  assert.deepEqual(facts.model, {
    executor: DEFAULT_EXECUTOR_MODEL,
    executorEffort: DEFAULT_EXECUTOR_EFFORT,
    verifier: DEFAULT_VERIFIER_MODEL,
    arbiter: DEFAULT_ARBITER_MODEL,
  });
  assert.equal(facts.skills, VERIFIED_SUPERPOWERS.seats.claude.path);
  assert.deepEqual(Object.keys(facts.superpowers.seats).sort(), ['claude', 'codex']);
  rmSync(scr, { recursive: true, force: true });
});

test('TASK.md is written before execution, excluded from the diff, and the reviewer launches', async () => {
  let launches = 0;
  const scr = scratch();
  const plan = 'Implement the exact requested behavior.\nDo not narrow shared scope.\n';
  const composedPlan = `${EXECUTOR_PREAMBLE}\n\n${plan}`;
  const target = makeTarget();
  const facts = await run({
    task: plan, target, gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'g1',
    adapters: {
      runExecutor: async ({ cwd, plan: received }) => {
        assert.ok(received.startsWith(EXECUTOR_PREAMBLE));
        assert.equal(received.slice(EXECUTOR_PREAMBLE.length + 2), plan,
          'the operator plan must survive byte-for-byte after the preamble');
        assert.equal(received, composedPlan);
        assert.equal(readFileSync(join(cwd, 'TASK.md'), 'utf8'), received,
          'TASK.md must exactly match the text sent to the executor');
        return writingExecutor({ cwd });
      },
      runGate: async () => ({ passed: true, results: [] }),
      runReview: (() => {
        const reviewer = reviewerForRounds([null]);
        return async (opts) => { launches++; return reviewer(opts); };
      })(),
    },
  });
  assert.equal(facts.outcome, 'review-ready');
  assert.equal(launches, 1);
  assert.ok(existsSync(join(facts.dir, 'CHANGES.diff')), 'CHANGES.diff handed to the reviewer');
  const diff = readFileSync(join(facts.dir, 'CHANGES.diff'), 'utf8');
  assert.match(diff, /new[.]txt/);
  assert.doesNotMatch(diff, /TASK[.]md/);
  assert.equal(existsSync(join(target, 'TASK.md')), false, 'the target must remain untouched');
  rmSync(scr, { recursive: true, force: true });
});

test('run reads an existing .txt task file instead of executing its path string', async () => {
  const scr = scratch();
  const taskDir = mkdtempSync(join(tmpdir(), 'run-task-'));
  const taskPath = join(taskDir, 'plan.txt');
  const plan = 'Use the contents of the text task file.\n';
  const composedPlan = `${EXECUTOR_PREAMBLE}\n\n${plan}`;
  writeFileSync(taskPath, plan);
  const facts = await run({
    task: taskPath, target: makeTarget(), gate: [], gateRetries: 0,
    scratchRoot: scr, runId: 'txt-task',
    adapters: {
      runExecutor: async ({ cwd, plan: received }) => {
        assert.equal(received, composedPlan,
          'the executor must receive framed file contents, not the .txt path');
        assert.equal(readFileSync(join(cwd, 'TASK.md'), 'utf8'), received);
        return noopExecutor();
      },
      runGate: async () => ({ passed: true, results: [] }),
      runReview: async () => { throw new Error('no-op must not launch a reviewer'); },
    },
  });
  assert.equal(facts.outcome, 'no-op');
  rmSync(taskDir, { recursive: true, force: true });
  rmSync(scr, { recursive: true, force: true });
});

test('the first call is verbatim and a fix round carries the failing evidence', async () => {
  const scr = scratch();
  const plan = 'Implement the requested behavior exactly.\nKeep the original plan unchanged.\n';
  const composedPlan = `${EXECUTOR_PREAMBLE}\n\n${plan}`;
  const executorPlans = [];
  let gateCall = 0;
  const failure = {
    bin: 'node', args: ['--test', 'test/repair.test.js'], code: 7,
    outputTail: '[stdout]\nrepair test failed\n[stderr]\nexpected true but received false',
  };
  const facts = await run({
    task: plan, target: makeTarget(), gate: [], gateRetries: 1,
    scratchRoot: scr, runId: 'retry-context',
    adapters: {
      runExecutor: async (opts) => {
        executorPlans.push(opts.plan);
        return writingExecutor(opts);
      },
      runGate: async () => gateCall++ <= 1
        ? { passed: false, results: [failure] }
        : { passed: true, results: [] },
      // The fix round is driven by a finding; the failing command travels with it.
      runReview: reviewerForRounds([blockingReview(), null]),
    },
  });

  assert.equal(executorPlans.length, 2);
  assert.equal(executorPlans[0], composedPlan,
    'the initial executor prompt must frame the verbatim plan');
  assert.match(executorPlans[1], /Previous gate attempt failed/);
  assert.match(executorPlans[1], /"bin":"node"/);
  assert.match(executorPlans[1], /"--test","test\/repair[.]test[.]js"/);
  assert.match(executorPlans[1], /Exit code: 7/);
  assert.ok(executorPlans[1].includes(failure.outputTail));
  assert.equal(readFileSync(join(facts.dir, 'TASK.md'), 'utf8'), executorPlans[1],
    'TASK.md must match the final fix text the executor received');
  rmSync(scr, { recursive: true, force: true });
});

test('each fix round receives only the immediately preceding failing evidence', async () => {
  const scr = scratch();
  const plan = 'Repair the implementation.';
  const composedPlan = `${EXECUTOR_PREAMBLE}\n\n${plan}`;
  const executorPlans = [];
  const firstFailure = {
    bin: 'node', args: ['--test', 'test/first.test.js'], code: 11,
    outputTail: '[stdout]\nFIRST_FAILURE_ONLY\n[stderr]\nfirst stack',
  };
  const secondFailure = {
    bin: 'npm', args: ['run', 'second-check'], code: 22,
    outputTail: '[stdout]\nSECOND_FAILURE_ONLY\n[stderr]\nsecond stack',
  };
  const gateResults = [
    { passed: false, results: [firstFailure] },
    { passed: false, results: [firstFailure] },
    { passed: false, results: [secondFailure] },
    { passed: false, results: [secondFailure] },
    { passed: true, results: [] },
  ];
  const facts = await run({
    task: plan, target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'fresh-retry-context',
    adapters: {
      runExecutor: async (opts) => {
        executorPlans.push(opts.plan);
        return writingExecutor(opts);
      },
      runGate: async () => gateResults.shift(),
      // Two rounds of findings drive two fix rounds; the third review is clean.
      runReview: reviewerForRounds([blockingReview('F1'), blockingReview('F2'), null]),
    },
  });

  assert.equal(executorPlans.length, 3);
  assert.equal(executorPlans[0], composedPlan);
  assert.ok(executorPlans[1].includes('FIRST_FAILURE_ONLY'));
  assert.ok(!executorPlans[1].includes('SECOND_FAILURE_ONLY'));
  assert.match(executorPlans[1], /Exit code: 11/);
  assert.ok(executorPlans[2].includes('SECOND_FAILURE_ONLY'));
  assert.ok(!executorPlans[2].includes('FIRST_FAILURE_ONLY'),
    'the second retry must not accumulate the first failure');
  assert.match(executorPlans[2], /"bin":"npm"/);
  assert.match(executorPlans[2], /Exit code: 22/);
  rmSync(scr, { recursive: true, force: true });
});

test('a green first gate never augments the executor prompt', async () => {
  const scr = scratch();
  const plan = 'Make one focused change.\n';
  const composedPlan = `${EXECUTOR_PREAMBLE}\n\n${plan}`;
  const executorPlans = [];
  const facts = await run({
    task: plan, target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'green-no-retry-context',
    adapters: {
      runExecutor: async (opts) => {
        executorPlans.push(opts.plan);
        return writingExecutor(opts);
      },
      runGate: async () => ({ passed: true, results: [] }),
      runVerifier: async () => ({ verdict: 'NO_BLOCKERS', launchFailed: false }),
    },
  });

  assert.equal(facts.outcome, 'review-ready');
  assert.deepEqual(executorPlans, [composedPlan]);
  assert.doesNotMatch(executorPlans[0], /Previous gate attempt failed/);
  rmSync(scr, { recursive: true, force: true });
});

test('a reviewer launch failure yields verifier-failed', async () => {
  const scr = scratch();
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'vf1',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async () => ({ passed: true, results: [] }),
      runReview: async () => { throw new Error('reviewer CLI would not start'); },
    },
  });
  assert.equal(facts.outcome, 'verifier-failed');
  assert.equal(facts.debate.stopReason, 'review-failed');
  assert.match(facts.iterations[0].reviewer.error, /reviewer CLI would not start/);
  rmSync(scr, { recursive: true, force: true });
});

test('a reviewer that runs but writes no report yields verifier-failed', async () => {
  // Silence is not consent in execution either: a seat that launched and
  // produced no REVIEW.md did not review, and the run says so.
  const scr = scratch();
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'vf2',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async () => ({ passed: true, results: [] }),
      runReview: async () => ({ launchFailed: false, timedOut: false }),
    },
  });
  assert.equal(facts.outcome, 'verifier-failed');
  assert.equal(facts.debate.stopReason, 'unreviewed');
  rmSync(scr, { recursive: true, force: true });
});

test('empty diff → verifier is NOT launched (no-op)', async () => {
  let launches = 0;
  const scr = scratch();
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'e1',
    adapters: {
      runExecutor: noopExecutor,
      runGate: async () => ({ passed: true, results: [] }),
      runReview: async () => { launches++; return { launchFailed: false, timedOut: false }; },
    },
  });
  assert.equal(launches, 0, 'no diff means nothing to review');
  assert.equal(facts.outcome, 'no-op');
  assert.equal(readFileSync(join(facts.dir, 'TASK.md'), 'utf8'),
    `${EXECUTOR_PREAMBLE}\n\ndo the task`);
  assert.equal(await diffText(facts.dir), '',
    'TASK.md and generated report artifacts must not turn a no-op into a change');
  rmSync(scr, { recursive: true, force: true });
});

// The UNVERIFIED marker died with the verdict passes. A seat that cannot
// review now surfaces as a launch failure, a timeout, or a missing report —
// all covered above.
test('a failing verifier preflight probe stops before executor dispatch', async () => {
  let executorCalled = false;
  const target = makeTarget();
  try {
    await assert.rejects(
      () => run({
        task: 'do the task', target, gate: [], gateRetries: 0,
        scratchRoot: 'unused-because-preflight-fails', runId: 'probe-failed',
        adapters: {
          probeVerifier: async () => ({
            ok: false,
            reason: 'verifier liveness probe failed for agent: tried "agent --version"; exited 9',
          }),
          runExecutor: async () => {
            executorCalled = true;
            return { changedFiles: [], lastMessage: 'must not run' };
          },
          runGate: async () => ({ passed: true, results: [] }),
          runVerifier: async () => ({ verdict: 'NO_BLOCKERS', launchFailed: false }),
        },
      }),
      /agent.*agent --version.*exited 9/i,
    );
    assert.equal(executorCalled, false);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('a passing verifier preflight probe leaves executor dispatch unchanged', async () => {
  const scr = scratch();
  let executorCalled = false;
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
    scratchRoot: scr, runId: 'probe-passed',
    adapters: {
      probeVerifier: async () => ({ ok: true, reason: null }),
      runExecutor: async () => {
        executorCalled = true;
        return { changedFiles: [], lastMessage: 'nothing to do' };
      },
      runGate: async () => ({ passed: true, results: [] }),
      runReview: async () => { throw new Error('no-op must not verify'); },
    },
  });

  assert.equal(executorCalled, true);
  assert.equal(facts.outcome, 'no-op');
  rmSync(scr, { recursive: true, force: true });
});

test('a sentinel-only executor challenge needs a decision in manual mode', async () => {
  const scr = scratch();
  const events = [];
  let gateCalls = 0;
  let verifierCalls = 0;
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
    scratchRoot: scr, runId: 'manual-decision', mode: 'manual',
    reporter: (event) => events.push(event),
    adapters: {
      runExecutor: async ({ cwd }) => {
        writeFileSync(join(cwd, 'DECISION.md'), DECISION_CONTENT);
        return { changedFiles: ['DECISION.md'], lastMessage: 'need a decision', exitCode: 0 };
      },
      runGate: async () => {
        gateCalls++;
        return { passed: true, results: [] };
      },
      runReview: async () => {
        verifierCalls++;
        throw new Error('reviewer must not launch for a challenge');
      },
    },
  });

  assert.equal(facts.outcome, 'needs-decision');
  assert.equal(gateCalls, 0);
  assert.equal(verifierCalls, 0);
  assert.equal(facts.decision.questions.length, 1);
  assert.equal(facts.decision.questions[0].id, 'Q1');
  assert.equal(facts.decision.mode, 'manual');
  assert.equal(facts.decision.challengeRound, 1);
  assert.equal(events.filter((event) => (
    event.stage === 'decision' && event.type === 'challenged'
  )).length, 1);
  rmSync(scr, { recursive: true, force: true });
});

test('a clean executor run is unchanged in every mode', async () => {
  const scr = scratch();
  for (const mode of ['manual', 'autonomous']) {
    const facts = await run({
      task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: `${mode}-noop`, mode,
      decisionResolver: async () => { throw new Error('no challenge must not resolve'); },
      adapters: {
        runExecutor: async () => ({ changedFiles: [], lastMessage: 'nothing', exitCode: 0 }),
        runGate: async () => ({ passed: true, results: [] }),
        runReview: async () => { throw new Error('verifier must not launch for no-op'); },
      },
    });
    assert.equal(facts.outcome, 'no-op');
    assert.equal(facts.decision, undefined);
  }
  rmSync(scr, { recursive: true, force: true });
});

test('a sentinel plus substantive files follows the normal gate and verifier path', async () => {
  const scr = scratch();
  let gateCalls = 0;
  let verifierCalls = 0;
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
    scratchRoot: scr, runId: 'decision-with-work', mode: 'manual',
    adapters: {
      runExecutor: async ({ cwd }) => {
        writeFileSync(join(cwd, 'DECISION.md'), DECISION_CONTENT);
        writeFileSync(join(cwd, 'new.txt'), 'substantive work');
        return {
          changedFiles: ['DECISION.md', 'new.txt'],
          lastMessage: 'wrote a sentinel and real work',
          exitCode: 0,
        };
      },
      runGate: async () => {
        gateCalls++;
        return { passed: true, results: [] };
      },
      runReview: (() => {
        const reviewer = reviewerForRounds([null]);
        return async (opts) => { verifierCalls++; return reviewer(opts); };
      })(),
    },
  });

  assert.equal(facts.outcome, 'review-ready');
  assert.equal(gateCalls, 1);
  assert.equal(verifierCalls, 1);
  assert.equal(facts.decision, undefined);
  rmSync(scr, { recursive: true, force: true });
});

test('autonomous mode resolves a sentinel challenge and reruns the executor', async () => {
  const scr = scratch();
  const events = [];
  const executorPlans = [];
  const resolverCalls = [];
  let executorCalls = 0;
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
    scratchRoot: scr, runId: 'autonomous-decision', mode: 'autonomous',
    reporter: (event) => events.push(event),
    decisionResolver: async (input) => {
      resolverCalls.push(input);
      return { answers: [{ id: 'Q1', answer: 'Follow the existing convention.' }] };
    },
    adapters: {
      runExecutor: async ({ cwd, plan }) => {
        executorCalls++;
        executorPlans.push(plan);
        if (executorCalls === 1) {
          writeFileSync(join(cwd, 'DECISION.md'), DECISION_CONTENT);
          return { changedFiles: ['DECISION.md'], lastMessage: 'need a decision', exitCode: 0 };
        }
        writeFileSync(join(cwd, 'new.txt'), 'resolved work');
        return { changedFiles: ['new.txt'], lastMessage: 'implemented the answer', exitCode: 0 };
      },
      runGate: async () => ({ passed: true, results: [] }),
      runVerifier: async () => ({ verdict: 'NO_BLOCKERS', launchFailed: false }),
    },
  });

  assert.equal(facts.outcome, 'review-ready');
  assert.equal(executorCalls, 2);
  assert.equal(resolverCalls.length, 1);
  assert.equal(resolverCalls[0].plan, 'do the task');
  assert.equal(resolverCalls[0].task, 'do the task');
  assert.equal(executorPlans[0], `${EXECUTOR_PREAMBLE}\n\ndo the task`);
  assert.ok(executorPlans[1].startsWith(`${EXECUTOR_PREAMBLE}\n\ndo the task`),
    'the challenge rerun must retain the same framed plan');
  assert.match(executorPlans[1], /## Recorded decision/);
  assert.match(executorPlans[1], /Answer: Follow the existing convention\./);
  assert.equal(readFileSync(join(facts.dir, 'TASK.md'), 'utf8'), executorPlans[1]);
  assert.equal(existsSync(join(facts.dir, 'DECISION.md')), false);
  const resolved = events.find((event) => (
    event.stage === 'decision' && event.type === 'resolved'
  ));
  assert.equal(resolved.answeredBy, 'claude');
  assert.equal(facts.decision.answeredBy, 'claude');
  rmSync(scr, { recursive: true, force: true });
});

test('autonomous authority does not change when a TTY is present', async () => {
  const scr = scratch();
  let executorCalls = 0;
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
    scratchRoot: scr, runId: 'authority-present', mode: 'autonomous',
    decisionResolver: async () => ({
      answers: [{ id: 'Q1', answer: 'follow the recommendation' }],
      escalation: 'operator-absent',
      presenceEvidence: { ttyAttached: true, invocation: 'interactive' },
      reasoning: 'The operator is actually present.',
    }),
    adapters: {
      runExecutor: async ({ cwd }) => {
        executorCalls++;
        writeFileSync(join(cwd, 'DECISION.md'), AUTHORITY_DECISION_CONTENT);
        return { changedFiles: ['DECISION.md'], lastMessage: 'need authority', exitCode: 0 };
      },
      runGate: async () => { throw new Error('gate must not run'); },
      runReview: async () => { throw new Error('verifier must not run'); },
    },
  });

  assert.equal(facts.outcome, 'needs-pivot');
  assert.equal(executorCalls, 3);
  assert.equal(facts.authority, 'claude');
  assert.equal(facts.debate.stopReason, 'challenge-limit');
  rmSync(scr, { recursive: true, force: true });
});

test('autonomous authority uses reviewer merits without inventing an operator-absent assumption', async () => {
  const scr = scratch();
  const events = [];
  let executorCalls = 0;
  const presenceEvidence = {
    ttyAttached: false,
    invocation: 'non-interactive',
    operatorWait: 'not-acknowledged',
  };
  const reasoning = 'No TTY was attached, so there was no operator available to answer.';
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
    scratchRoot: scr, runId: 'authority-absent', mode: 'autonomous',
    reporter: (event) => events.push(event),
    decisionResolver: async () => ({
      answers: [{ id: 'Q1', answer: 'follow the isolated-worktree recommendation' }],
      escalation: 'operator-absent',
      presenceEvidence,
      reasoning,
    }),
    adapters: {
      runExecutor: async ({ cwd }) => {
        executorCalls++;
        if (executorCalls === 1) {
          writeFileSync(join(cwd, 'DECISION.md'), AUTHORITY_DECISION_CONTENT);
          return { changedFiles: ['DECISION.md'], lastMessage: 'need authority', exitCode: 0 };
        }
        writeFileSync(join(cwd, 'new.txt'), 'resolved authority work');
        return { changedFiles: ['new.txt'], lastMessage: 'continued safely', exitCode: 0 };
      },
      runGate: async () => ({ passed: true, results: [] }),
      runVerifier: async () => ({ verdict: 'NO_BLOCKERS', launchFailed: false }),
    },
  });

  assert.equal(facts.outcome, 'review-ready');
  assert.equal(executorCalls, 2);
  assert.equal(facts.decision.answeredBy, 'claude');
  assert.equal(facts.escalation, undefined);
  assert.equal(events.some((event) => event.type === 'assumed'), false);
  rmSync(scr, { recursive: true, force: true });
});

test('challenge-round exhaustion halts instead of starting another executor', async () => {
  const scr = scratch();
  let executorCalls = 0;
  let resolverCalls = 0;
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
    scratchRoot: scr, runId: 'challenge-exhaustion', mode: 'autonomous', challengeRounds: 2,
    decisionResolver: async () => {
      resolverCalls++;
      return { answers: [{ id: 'Q1', answer: 'follow the recommendation' }] };
    },
    adapters: {
      runExecutor: async ({ cwd }) => {
        executorCalls++;
        writeFileSync(join(cwd, 'DECISION.md'), DECISION_CONTENT);
        return { changedFiles: ['DECISION.md'], lastMessage: 'challenge again', exitCode: 0 };
      },
      runGate: async () => { throw new Error('gate must not run'); },
      runReview: async () => { throw new Error('verifier must not run'); },
    },
  });

  assert.equal(facts.outcome, 'needs-pivot');
  assert.equal(facts.decision.challengeRound, 3);
  assert.equal(executorCalls, 3);
  assert.equal(resolverCalls, 2);
  rmSync(scr, { recursive: true, force: true });
});

test('a resolver returning no answers halts without rerunning the executor', async () => {
  const scr = scratch();
  let executorCalls = 0;
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
    scratchRoot: scr, runId: 'empty-resolution', mode: 'autonomous',
    decisionResolver: async () => ({ answers: [] }),
    adapters: {
      runExecutor: async ({ cwd }) => {
        executorCalls++;
        writeFileSync(join(cwd, 'DECISION.md'), DECISION_CONTENT);
        return { changedFiles: ['DECISION.md'], lastMessage: 'need a decision', exitCode: 0 };
      },
      runGate: async () => { throw new Error('gate must not run'); },
      runReview: async () => { throw new Error('verifier must not run'); },
    },
  });

  assert.equal(facts.outcome, 'needs-pivot');
  assert.equal(executorCalls, 1);
  assert.equal(existsSync(join(facts.dir, 'DECISION.md')), true);
  rmSync(scr, { recursive: true, force: true });
});

// The old "challenge during a gate retry" scenario has no equivalent in the
// evidence flow: a debate fix round presupposes a substantive diff, and
// routeChallenges deliberately ignores a sentinel beside one (a challenge
// presupposes none). Both surviving behaviours are covered by their own tests:
// "a sentinel-only executor challenge needs a decision in manual mode" and
// "a sentinel plus substantive files follows the normal gate and verifier path".

test('--mode accepts manual or autonomous and rejects other values', () => {
  const base = ['run', '--task', 'p', '--target', 't', '--gate', 'g'];
  assert.equal(parseArgs([...base, '--mode', 'manual']).mode, 'manual');
  assert.equal(parseArgs([...base, '--mode', 'autonomous']).mode, 'autonomous');
  assert.throws(() => parseArgs([...base, '--mode', 'interactive']), /invalid --mode/i);
});

test('non-zero executor exit with an empty diff is executor-failed', async () => {
  let verifierCalls = 0;
  const scr = scratch();
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'executor-failed-empty-diff',
    adapters: {
      runExecutor: async () => ({
        changedFiles: [], lastMessage: 'executor aborted before making changes', exitCode: 1,
      }),
      runGate: async () => ({ passed: true, results: [] }),
      runReview: async () => {
        verifierCalls++;
        throw new Error('an empty diff must not launch a reviewer');
      },
    },
  });
  assert.equal(facts.outcome, 'executor-failed',
    'a non-zero executor exit with no diff must be reported as executor-failed');
  assert.equal(verifierCalls, 0, 'an empty diff must not launch a verifier');
  assert.notEqual(exitCodeFor(facts.outcome), 0);
  rmSync(scr, { recursive: true, force: true });
});

test('zero executor exit with an empty diff remains a successful no-op', async () => {
  const scr = scratch();
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'clean-empty-diff',
    adapters: {
      runExecutor: async () => ({ changedFiles: [], lastMessage: 'nothing to do', exitCode: 0 }),
      runGate: async () => ({ passed: true, results: [] }),
      runReview: async () => { throw new Error('a no-op must not launch a verifier'); },
    },
  });
  assert.equal(facts.outcome, 'no-op');
  assert.equal(exitCodeFor(facts.outcome), 0);
  rmSync(scr, { recursive: true, force: true });
});

test('an approval-request message names the advisory no-op reason without changing status', async () => {
  const scr = scratch();
  const facts = await run({
    task: 'Implement the requested behavior.', target: makeTarget(), gate: [], gateRetries: 0,
    scratchRoot: scr, runId: 'approval-request-no-op',
    adapters: {
      runExecutor: async () => ({
        changedFiles: [],
        agentMessages: ['I reviewed the design.', "Approve this design and I'll implement it."],
        lastMessage: "Approve this design and I'll implement it.",
        exitCode: 0,
      }),
      runGate: async () => ({ passed: true, results: [] }),
      runReview: async () => { throw new Error('a no-op must not launch a verifier'); },
    },
  });

  assert.equal(facts.noOpReason, 'approval-requested');
  assert.equal(facts.outcome, 'no-op');
  assert.equal(exitCodeFor(facts.outcome), 0);
  const report = readFileSync(join(facts.dir, 'uro-report.md'), 'utf8');
  assert.match(report, /approval-requested/);
  assert.match(report, /DECISION[.]md/);
  rmSync(scr, { recursive: true, force: true });
});

test('unrelated executor prose does not label an empty successful pass as approval-requested',
  async () => {
    const scr = scratch();
    const facts = await run({
      task: 'Implement the requested behavior.', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'ordinary-no-op',
      adapters: {
        runExecutor: async () => ({
          changedFiles: [],
          agentMessages: ['The approved design is already implemented; no changes are needed.'],
          lastMessage: 'The approved design is already implemented; no changes are needed.',
          exitCode: 0,
        }),
        runGate: async () => ({ passed: true, results: [] }),
        runReview: async () => { throw new Error('a no-op must not launch a verifier'); },
      },
    });

    assert.equal(facts.outcome, 'no-op');
      assert.equal(exitCodeFor(facts.outcome), 0);
    assert.equal(Object.hasOwn(facts, 'noOpReason'), false);
    assert.doesNotMatch(readFileSync(join(facts.dir, 'uro-report.md'), 'utf8'),
      /approval-requested/);
    rmSync(scr, { recursive: true, force: true });
  });

test('a non-zero exit is evidence in front of the seats, never a verdict', async () => {
  // "No green, no red." The command ran once, its exit code and output are on
  // the record, and the reviewer is told in one argv-safe line and asked to
  // judge. With the reviewer satisfied the run converges — nothing anywhere
  // branches on the exit code, and no gateStatus or gateFailure field exists.
  let gateCalls = 0;
  const prompts = [];
  const scr = scratch();
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'r1',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async ({ onEvidence }) => {
        gateCalls++;
        onEvidence?.({
          bin: 'node', args: ['--test'], code: 1,
          stdout: 'failed assertion', stderr: 'stack trace',
        });
        return { passed: false, results: [{
          bin: 'node', args: ['--test'], code: 1,
          outputTail: '[stdout]\nfailed assertion\n[stderr]\nstack trace',
        }] };
      },
      runReview: (() => {
        const reviewer = reviewerForRounds([null]);
        return async (opts) => { prompts.push(opts.prompt); return reviewer(opts); };
      })(),
    },
  });
  assert.equal(facts.outcome, 'review-ready',
    'the reviewer satisfied means converged; an exit code cannot veto it');
  assert.equal(prompts.length, 1, 'the reviewer reviews, whatever the exit');
  for (const prompt of prompts) {
    assert.match(prompt, /"code":1/);
    assert.match(prompt, /failed assertion/);
    assert.match(prompt, /__uro_evidence\/round-1-01.out.txt/);
  }
  assert.equal(gateCalls, 1, 'commands run once as evidence — the retry loop is gone');
  assert.equal(Object.hasOwn(facts, 'gateStatus'), false, 'no verdict field survives');
  assert.equal(Object.hasOwn(facts, 'gateFailure'), false);
  assert.equal(facts.evidence.filter((entry) => entry.code !== 0).length, 1);
  rmSync(scr, { recursive: true, force: true });
});

test('a timed-out executor stops the run, is recorded, and maps to a non-zero process exit', async () => {
  const scr = scratch();
  let gateCalls = 0;
  let verifierCalls = 0;
  const facts = await run({
    task: 'Implement the requested timeout behavior.', target: makeTarget(), gate: [],
    gateRetries: 2, scratchRoot: scr, runId: 'executor-timeout',
    adapters: {
      runExecutor: async () => ({ changedFiles: [], lastMessage: 'partial work',
        timedOut: true, timeoutMs: 25, exitCode: -1 }),
      runGate: async () => { gateCalls++; return { passed: true, results: [] }; },
      runReview: async () => { verifierCalls++; return { launchFailed: false, timedOut: false }; },
    },
  });
  assert.equal(facts.nextAction, 'paused');
  assert.equal(facts.approved, false);
  assert.notEqual(exitCodeFor(facts.outcome), 0);
  assert.equal(gateCalls, 0, 'a timed-out executor must not advance to the gate');
  assert.equal(verifierCalls, 0);
  assert.equal(facts.iterations[0].executor.timedOut, true);
  assert.deepEqual(facts.timeoutEvents, [
    { stage: 'executor', iteration: 1, attempt: 1, timeoutMs: 25 },
  ]);
  assert.match(readFileSync(join(facts.dir, 'uro-report.md'), 'utf8'),
    /executor: timed out after 25 ms/i);
  rmSync(scr, { recursive: true, force: true });
});

test('a timed-out executor commits partial work and writes an artifact-free diff before kill', async () => {
  const scr = scratch();
  const facts = await run({
    task: 'Preserve partial work before timeout.', target: makeTarget(), gate: [],
    gateRetries: 0, scratchRoot: scr, runId: 'partial-timeout', reporter: () => {},
    adapters: {
      runExecutor: async (opts) => {
        writeFileSync(join(opts.cwd, 'partial.js'), 'export const partial = true;\n');
        writeFileSync(join(opts.cwd, 'events.jsonl'), '{"harness":true}\n');
        await opts.beforeKillRequired({
          kind: 'deadline', timeoutMs: 25, gapMs: 25,
          lastEvent: { stage: 'executor', type: 'start', attempt: opts.attempt },
          setting: 'URO_STALL_THRESHOLD_MS',
        });
        return {
          changedFiles: ['partial.js'], lastMessage: 'partial work', timedOut: true,
          timeoutMs: 25, exitCode: -1,
          timeoutReason: {
            kind: 'deadline', gapMs: 25,
            lastEvent: { stage: 'executor', type: 'start', attempt: opts.attempt },
            setting: 'URO_STALL_THRESHOLD_MS',
          },
        };
      },
      runGate: async () => { throw new Error('timed-out executor must not run the gate'); },
      runReview: async () => { throw new Error('timed-out executor must not verify'); },
    },
  });

  assert.equal(facts.nextAction, 'paused');
  assert.equal(facts.approved, false);
  const diff = readFileSync(join(facts.dir, 'CHANGES.diff'), 'utf8');
  assert.match(diff, /partial[.]js/);
  for (const artifact of HARNESS_ARTIFACTS) {
    assert.doesNotMatch(diff, new RegExp(artifact.replace('.', '[.]')));
  }
  const committed = await spawnCapture('git', [
    '-C', facts.dir, 'show', '--pretty=', '--name-only', 'HEAD',
  ]);
  assert.equal(committed.code, 0, committed.stderr);
  assert.match(committed.stdout, /partial[.]js/);
  assert.doesNotMatch(committed.stdout, /events[.]jsonl/);
  assert.equal(facts.timeoutEvents[0].gapMs, 25);
  assert.equal(facts.timeoutEvents[0].lastEvent.type, 'start');
  assert.equal(facts.timeoutEvents[0].setting, 'URO_STALL_THRESHOLD_MS');
  rmSync(scr, { recursive: true, force: true });
});

test('a failed partial-work commit preserves bytes and reports a required unapproved pause', async () => {
  const scr = scratch();
  const facts = await run({
    task: 'Keep timeout outcome when preservation fails.', target: makeTarget(), gate: [],
    gateRetries: 0, scratchRoot: scr, runId: 'partial-commit-fails', reporter: () => {},
    adapters: {
      runExecutor: async (opts) => {
        writeFileSync(join(opts.cwd, 'partial.js'), 'export const incomplete = true;\n');
        const refDirectory = join(opts.cwd, '.git', 'refs', 'heads', 'uro');
        mkdirSync(refDirectory, { recursive: true });
        writeFileSync(join(refDirectory, 'partial-commit-fails.lock'),
          'force the commit ref update to fail\n');
        await assert.rejects(opts.beforeKillRequired({ kind: 'liveness', timeoutMs: 50, gapMs: 50,
          setting: 'URO_STALL_THRESHOLD_MS' }), /git commit failed/);
        return { changedFiles: ['partial.js'], lastMessage: 'partial work', timedOut: true,
          timeoutMs: 25, exitCode: -1,
          timeoutReason: {
            kind: 'liveness', timeoutMs: 50, gapMs: 50,
            setting: 'URO_STALL_THRESHOLD_MS',
          } };
      },
      runGate: async () => { throw new Error('timed-out executor must not run the gate'); },
      runReview: async () => { throw new Error('timed-out executor must not verify'); },
    },
  });

  assert.equal(facts.nextAction, 'paused');
  assert.equal(facts.approved, false);
  assert.match(facts.reason, /git commit failed/);
  assert.equal(facts.checkpointState.supervision.operations.find(item => item.purpose === 'preservation').status, 'prepared');
  assert.equal(facts.timeoutEvents[0].timeoutMs, 50,
    'the silence threshold is the recorded limit');
  assert.equal(facts.timeoutEvents[0].gapMs, 50);
  assert.equal(facts.timeoutEvents[0].setting, 'URO_STALL_THRESHOLD_MS');
  assert.match(readFileSync(join(facts.dir, 'CHANGES.diff'), 'utf8'), /partial[.]js/,
    'positive control: staging and diff production succeeded before git commit failed');
  rmSync(scr, { recursive: true, force: true });
});

test('a timed-out reviewer cannot produce a successful outcome', async () => {
  const scr = scratch();
  const facts = await run({
    task: 'Implement the requested timeout behavior.', target: makeTarget(), gate: [],
    gateRetries: 0, scratchRoot: scr, runId: 'verifier-timeout',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async () => ({ passed: true, results: [] }),
      runReview: async () => ({ launchFailed: false, timedOut: true,
        timeoutReason: { timeoutMs: 40 } }),
    },
  });
  assert.equal(facts.outcome, 'timed-out');
  assert.equal(facts.debate.stopReason, 'review-timed-out');
  assert.notEqual(exitCodeFor(facts.outcome), 0);
  assert.deepEqual(facts.timeoutEvents, [
    { stage: 'verifier', pass: 'review', iteration: 1, timeoutMs: 40 },
  ]);
  rmSync(scr, { recursive: true, force: true });
});

test('a timed-out gate command is distinguishable in run facts and the report', async () => {
  const scr = scratch();
  let verifierCalls = 0;
  const facts = await run({
    task: 'Implement the requested timeout behavior.', target: makeTarget(), gate: [],
    gateRetries: 0, scratchRoot: scr, runId: 'gate-timeout',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async () => ({ passed: false, results: [{
        bin: 'node', args: ['--test'], code: -1, timedOut: true, timeoutMs: 60,
        outputTail: '[stdout]\npartial test output\n[stderr]\n',
      }] }),
      runReview: async () => { verifierCalls++; return { launchFailed: false, timedOut: false }; },
    },
  });
  assert.equal(facts.outcome, 'timed-out');
  assert.notEqual(exitCodeFor(facts.outcome), 0);
  assert.equal(verifierCalls, 0);
  assert.deepEqual(facts.timeoutEvents, [{
    stage: 'gate', iteration: 1, attempt: 1, timeoutMs: 60,
    bin: 'node', args: ['--test'],
  }]);
  const report = readFileSync(join(facts.dir, 'uro-report.md'), 'utf8');
  assert.match(report, /Stage timeouts/);
  assert.match(report, /60 ms/);
  rmSync(scr, { recursive: true, force: true });
});

test('diffText throws when git fails (non-git dir)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'nogit-'));
  await assert.rejects(() => diffText(d), /git (add|diff) failed/);
});

function writeHarnessArtifact(directory, artifact, content) {
  if (artifact.endsWith('/')) {
    const artifactDirectory = join(directory, artifact);
    mkdirSync(artifactDirectory, { recursive: true });
    writeFileSync(join(artifactDirectory, 'REVIEW.md'), content);
    return;
  }
  writeFileSync(join(directory, artifact), content);
}

test('diffText unstages every pre-staged harness artifact and retains real changes', async () => {
  const d = makeTarget();
  await spawnCapture('git', ['-C', d, 'init', '-b', 'main']);
  await spawnCapture('git', ['-C', d, 'add', '-A']);
  await spawnCapture('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t',
    'commit', '-m', 'baseline']);
  writeFileSync(join(d, 'feature.js'), 'export const enabled = true;\n');
  for (const artifact of HARNESS_ARTIFACTS) {
    writeHarnessArtifact(d, artifact, `harness-only ${artifact}\n`);
  }
  const staged = await spawnCapture('git', ['-C', d, 'add', '-A']);
  assert.equal(staged.code, 0, staged.stderr);
  const stagedNames = await spawnCapture('git', ['-C', d, 'diff', '--cached', '--name-only']);
  const stagedPaths = stagedNames.stdout.split(/\r?\n/);
  assert.ok(HARNESS_ARTIFACTS.every((artifact) => artifact.endsWith('/')
    ? stagedPaths.some((path) => path.startsWith(artifact))
    : stagedPaths.includes(artifact)),
    'positive control: every harness artifact must be staged before diffText runs');

  const diff = await diffText(d);
  assert.match(diff, /feature[.]js/);
  for (const artifact of HARNESS_ARTIFACTS) {
    assert.doesNotMatch(diff, new RegExp(artifact.replace('.', '[.]')));
  }
  rmSync(d, { recursive: true, force: true });
});

test('diffText succeeds when gitignore lists every harness artifact', async () => {
  const d = makeTarget();
  await spawnCapture('git', ['-C', d, 'init', '-b', 'main']);
  writeFileSync(join(d, '.gitignore'), `${HARNESS_ARTIFACTS.join('\n')}\n`);
  await spawnCapture('git', ['-C', d, 'add', '-A']);
  await spawnCapture('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t',
    'commit', '-m', 'baseline']);
  writeFileSync(join(d, 'feature.js'), 'export const ignoredArtifactsStayIgnored = true;\n');
  for (const artifact of HARNESS_ARTIFACTS) {
    writeHarnessArtifact(d, artifact, `ignored harness-only ${artifact}\n`);
  }
  const ignored = await spawnCapture('git', ['-C', d, 'check-ignore', ...HARNESS_ARTIFACTS]);
  assert.equal(ignored.code, 0, ignored.stderr);
  assert.deepEqual(ignored.stdout.trim().split(/\r?\n/).sort(), [...HARNESS_ARTIFACTS].sort(),
    'positive control: git must ignore every harness artifact');

  const diff = await diffText(d);
  assert.match(diff, /feature[.]js/);
  assert.match(diff, /ignoredArtifactsStayIgnored/);
  for (const artifact of HARNESS_ARTIFACTS) {
    assert.doesNotMatch(diff, new RegExp(artifact.replace('.', '[.]')));
  }
  rmSync(d, { recursive: true, force: true });
});

// mergeVerifierVerdicts and reviewOutcomeFor died with the verdict passes:
// there is one review report now, and seat availability is measured by launch,
// timeout, and report presence — covered by the reviewer-failure tests above.
const blockingReview = (id = 'F1') => `
## ${id}
Severity: blocking
Category: correctness
Description: ${id} demonstrates a reproducible defect.
Test: __uro_review/tests/test_${id.toLowerCase()}.py
`;

const suggestionReview = (id = 'F1') => `
## ${id}
Severity: suggestion
Category: maintainability
Description: ${id} would make the implementation easier to maintain.
`;

function reviewerForRounds(reports, calls = null) {
  let round = 0;
  const observed = new Set();
  return async (opts) => {
    calls?.push(opts);
    const report = reports[round++] ?? null;
    mkdirSync(join(opts.cwd, '__uro_review/tests'), { recursive: true });
    const ids = [...String(report ?? '').matchAll(/## (F\d+)/g)].map((match) => match[1]);
    for (const match of String(report ?? '').matchAll(/Test: (__uro_review\/tests\/[^\n\r]+)/g)) {
      writeFileSync(join(opts.cwd, match[1].trim()), '# independent proof\n');
    }
    const dispositions = [...observed].filter((id) => !ids.includes(id))
      .map((id) => ({ id, status: 'resolved', reason: 'Reviewed the correction and command evidence; the defect is addressed.' }));
    for (const id of ids) observed.add(id);
    writeFileSync(join(opts.cwd, '__uro_review', 'REVIEW.md'),
      report === null ? 'Reviewed. No findings this round.\n' : report);
    return { conclusion: /Severity: blocking/.test(report ?? '') ? 'issues' : 'clean', launchFailed: false, timedOut: false, dispositions };
  };
}

test('debate regression control converges after one clean review round', async () => {
  const scr = scratch();
  const events = [];
  try {
    let executorCalls = 0;
    let gateCalls = 0;
    const facts = await run({
      task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'debate-clean',
      reporter: (event) => events.push(event),
      adapters: {
        runExecutor: async (opts) => { executorCalls++; return writingExecutor(opts); },
        runGate: async () => { gateCalls++; return { passed: true, results: [] }; },
        runReview: reviewerForRounds([null]),
      },
    });

    assert.equal(facts.outcome, 'review-ready');
    assert.equal(executorCalls, 1);
    assert.equal(gateCalls, 1);
    assert.equal(facts.debate.roundsRun, 1);
    assert.deepEqual(facts.debate.findingsPerRound, [[]]);
    assert.equal(facts.debate.stopReason, 'converged');
    assert.equal(facts.debate.pivotCount, 0);
    assert.equal(facts.debate.finalPivotDecision, null);
    assert.equal(events.some((event) => event.stage === 'debate' && event.type === 'pivot'), false);
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});

test('one blocking finding is fixed by the executor and converges in round two', async () => {
  const scr = scratch();
  try {
    let executorCalls = 0;
    let gateCalls = 0;
    const plans = [];
    const facts = await run({
      task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'debate-fixed',
      adapters: {
        runExecutor: async (opts) => {
          executorCalls++;
          plans.push(opts.plan);
          return writingExecutor(opts);
        },
        runGate: async () => { gateCalls++; return { passed: true, results: [] }; },
        runReview: reviewerForRounds([blockingReview(), null]),
      },
    });

    assert.equal(facts.outcome, 'review-ready');
    assert.equal(executorCalls, 2);
    assert.equal(gateCalls, 3);
    assert.equal(facts.debate.roundsRun, 2);
    assert.deepEqual(facts.debate.findingsPerRound, [['F1'], []]);
    assert.deepEqual(facts.debate.resolvedFindingIds, ['F1']);
    assert.match(plans[1], /# Fix Plan/);
    assert.match(plans[1], /F1 \(blocking\)/);
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});

test('a finding persistent across three rounds detects circling and retries an amended plan', async () => {
  const scr = scratch();
  const events = [];
  const plans = [];
  try {
    const facts = await run({
      mode: 'autonomous', task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'debate-circling', debateRounds: 4,
      reporter: (event) => events.push(event),
      adapters: {
        runArbiter: async () => ({ decision: 'amend', reason: 'A corrected implementation approach remains viable.' }),
        runExecutor: async (opts) => {
          plans.push(opts.plan);
          return writingExecutor(opts);
        },
        runGate: async () => ({ passed: true, results: [] }),
        runReview: reviewerForRounds([
          blockingReview(), blockingReview(), blockingReview(), null,
        ]),
      },
    });

    assert.equal(facts.debate.roundsRun, 4);
    assert.equal(facts.debate.circlingDetected, true);
    assert.equal(facts.debate.pivotCount, 1);
    assert.equal(facts.debate.finalPivotDecision, 'amend');
    assert.equal(facts.debate.stopReason, 'converged');
    assert.equal(facts.outcome, 'review-ready');
    assert.ok(events.some((event) => event.stage === 'debate' && event.type === 'circling'));
    assert.ok(events.some((event) => event.stage === 'debate'
      && event.type === 'pivot' && event.decision === 'amend'));
    assert.equal(plans.length, 4);
    assert.match(plans[3], /## Pivot amendment/);
    assert.match(plans[3], /The prior fix approach is circling/);
    assert.match(plans[3], /Recurring blockers: F1/);
    assert.match(plans[3], /Round 3: F1/);
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});

test('circling on the final round suppresses an amend that cannot run', async () => {
  const scr = scratch();
  const events = [];
  try {
    const facts = await run({
      mode: 'autonomous', task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'debate-final-amend', debateRounds: 3,
      reporter: (event) => events.push(event),
      adapters: {
        runArbiter: async () => ({ decision: 'amend', reason: 'A corrected implementation approach remains viable.' }),
        runExecutor: writingExecutor,
        runGate: async () => ({ passed: true, results: [] }),
        runReview: reviewerForRounds([blockingReview(), blockingReview(), blockingReview()]),
      },
    });

    assert.equal(facts.outcome, 'needs-pivot');
    assert.equal(facts.debate.roundsRun, 3);
    assert.equal(facts.debate.circlingDetected, true);
    assert.equal(facts.debate.stopReason, 'rounds-exhausted');
    assert.equal(facts.debate.finalPivotDecision, null);
    assert.equal(facts.debate.pivotCount, 0);
    assert.ok(events.some((event) => event.stage === 'debate' && event.type === 'circling'));
    assert.equal(events.some((event) => event.stage === 'debate' && event.type === 'pivot'), false);
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});

test('native retained replan after the last execution cycle plans but cannot buy another cycle', async t => {
  let planning = 0, coding = 0;
  const facts = await run({ ...nativeFixture(t, 'native-replan-final-cycle', {
    runExecutor: r => { coding++; writeFileSync(join(r.cwd, 'completed.txt'), '1'); return { dialogue: executionEnvelope(r, 'propose') }; },
    runReview: r => ({ dialogue: executionEnvelope(r, 'replan', {
      issues: [{ id: 'R1', title: 'Remaining authorized work', status: 'open', blocking: true }],
      replan: { issueId: 'R1', evidenceIds: ['requirement-briefing'], novelty: 'The completed segment exposes a new remaining-work requirement.' },
    }) }),
    draftPlanCandidate: r => { planning++; return { plan: 'Remaining work only', gate: [], dialogue: planningEnvelope(r, 'propose') }; },
    reviewPlanCandidate: r => { planning++; return planningApproval(r); },
  }), pivotCandidates: 1, debateRounds: 1 });
  assert.equal(facts.approved, false); assert.equal(coding, 1); assert.equal(planning, 2);
  assert.equal(facts.phase, 'execution'); assert.equal(facts.dialogue.proposalCycles, 1);
  assert.match(facts.reason, /proposal-cycle limit/);
  assert.equal(readFileSync(join(facts.dir, 'completed.txt'), 'utf8'), '1');
});

test('native retained replan preserves explicit challenge use across remaining execution', async t => {
  let coding = 0, reviewing = 0;
  const facts = await run({ ...nativeFixture(t, 'native-replan-challenge', {
    runExecutor: r => {
      coding++;
      if (coding === 1) writeFileSync(join(r.cwd, 'completed.txt'), '1');
      else { assert.equal(r.state.challengeCycles, 1); assert.equal(r.remainingWork, true); writeFileSync(join(r.cwd, 'remaining.txt'), 'done'); }
      return { usage: { inputTokens: 1, outputTokens: 1 }, dialogue: executionEnvelope(r, r.action) };
    },
    runReview: r => {
      reviewing++;
      if (reviewing === 1) return { dialogue: executionEnvelope(r, 'challenge', {
        next: { seat: 'claude', action: 'verify', reason: 'Assess the current evidence' } }) };
      if (reviewing === 2) return { dialogue: executionEnvelope(r, 'replan', {
        issues: [{ id: 'R1', title: 'Remaining work', blocking: true, status: 'open' }],
        replan: { issueId: 'R1', evidenceIds: ['requirement-briefing'], novelty: 'The first completed file settles the first step; remaining.txt still needs implementation.' },
      }) };
      return { dialogue: executionEnvelope(r, 'ask', { next: { seat: 'claude', action: 'challenge', reason: 'Another explicit challenge' } }) };
    },
    draftPlanCandidate: r => ({ plan: 'Only finish remaining.txt', gate: [], dialogue: planningEnvelope(r, 'propose') }),
    reviewPlanCandidate: planningApproval,
  }), pivotCandidates: 1, challengeRounds: 1 });
  assert.equal(facts.approved, false); assert.match(facts.reason, /challenge limit/);
  assert.equal(coding, 2); assert.equal(reviewing, 3);
  assert.equal(facts.dialogue.challengeCycles, 1);
  assert.equal(readFileSync(join(facts.dir, 'completed.txt'), 'utf8'), '1');
});

test('the conclude pivot stops without reporting success', async () => {
  const scr = scratch();
  const events = [];
  try {
    const facts = await run({
      mode: 'autonomous', task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'debate-conclude', debateRounds: 3,
      reporter: (event) => events.push(event),
      adapters: {
        runExecutor: writingExecutor,
        runGate: async () => ({ passed: true, results: [] }),
        runReview: reviewerForRounds([blockingReview(), blockingReview(), blockingReview()]),
        runArbiter: async () => ({ decision: 'conclude', reason: 'The approach cannot satisfy requirements.' }),
      },
    });

    assert.equal(facts.outcome, 'needs-pivot');
    assert.equal(facts.debate.roundsRun, 3);
    assert.equal(facts.debate.stopReason, 'pivot');
    assert.equal(facts.debate.finalPivotDecision, 'conclude');
    assert.equal(facts.debate.pivotCount, 1);
    assert.ok(events.some((event) => event.stage === 'debate'
      && event.type === 'pivot' && event.decision === 'conclude'));
    assert.notEqual(exitCodeFor(facts.outcome), 0);
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});

test('URO_DEBATE_ROUNDS exhaustion stops honestly with unresolved findings', async () => {
  const scr = scratch();
  try {
    const facts = await run({
      task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'debate-exhausted',
      env: { URO_DEBATE_ROUNDS: '1' },
      adapters: {
        runExecutor: writingExecutor,
        runGate: async () => ({ passed: true, results: [] }),
        runReview: reviewerForRounds([blockingReview()]),
      },
    });

    assert.equal(facts.outcome, 'needs-pivot');
    assert.equal(facts.debate.roundsRun, 1);
    assert.equal(facts.debate.stopReason, 'rounds-exhausted');
    const report = readFileSync(join(facts.dir, 'uro-report.md'), 'utf8');
    assert.match(report, /Debate rounds:\*\* 1/);
    assert.match(report, /Debate stopped:\*\* rounds-exhausted/);
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});

test('a non-zero fix-round exit keeps the debate alive, and the seats decide', async () => {
  // A red fix-round exit is evidence in front of round 2's reviewer; nothing
  // ends the run for it.
  const scr = scratch();
  try {
    let gateCall = 0;
    let verifierCalls = 0;
    const facts = await run({
      task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'debate-fix-gate-failed',
      adapters: {
        runExecutor: writingExecutor,
        runGate: async () => ++gateCall === 1
          ? { passed: true, results: [] }
          : { passed: false, results: [{ bin: 'node', args: ['--test'], code: 7,
              outputTail: 'review regression failed' }] },
        runReview: (() => {
          const reviewer = reviewerForRounds([blockingReview(), null]);
          return async (options) => {
            verifierCalls++;
            return reviewer(options);
          };
        })(),
      },
    });

    // The exit-7 command is evidence in front of round 2's seats; they judged
    // it not worth blocking on, so the run converges. Nothing branched on it.
    assert.equal(facts.outcome, 'review-ready');
    assert.equal(verifierCalls, 2,
      'a non-zero fix-round exit must NOT prevent the next review round');
    assert.equal(facts.debate.roundsRun, 2);
    assert.equal(Object.hasOwn(facts, 'gateFailure'), false);
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});

// The UNVERIFIED round died with the verdict marker: a reviewer that
// cannot produce a report now stops the run as unreviewed, proved above.
test('suggestions alone converge without another executor or gate round', async () => {
  const scr = scratch();
  try {
    let executorCalls = 0;
    let gateCalls = 0;
    const facts = await run({
      task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'debate-suggestion',
      adapters: {
        runExecutor: async (opts) => { executorCalls++; return writingExecutor(opts); },
        runGate: async () => { gateCalls++; return { passed: true, results: [] }; },
        runReview: reviewerForRounds([suggestionReview()]),
      },
    });

    assert.equal(facts.outcome, 'review-ready');
    assert.equal(executorCalls, 1);
    assert.equal(gateCalls, 1);
    assert.equal(facts.debate.roundsRun, 1);
    assert.deepEqual(facts.debate.roundHistory[0].suggestionFindingIds, ['F1']);
    assert.deepEqual(facts.debate.ledger.rounds[0].findingIds, []);
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});

test('debate rounds are unbounded by default and accept any positive operator bound', () => {
  assert.equal(resolveDebateRounds({}), undefined);
  assert.equal(resolveDebateRounds({ URO_DEBATE_ROUNDS: '50' }), 50);
  assert.throws(() => resolveDebateRounds({ URO_DEBATE_ROUNDS: '0' }), /positive integer/);
  assert.throws(() => resolveDebateRounds({ URO_DEBATE_ROUNDS: '2.5' }), /positive integer/);
});

test('circling keeps Claude in its reviewer role and supplies the actual debate to its pivot judgment', async () => {
  // The owner's rule: once the debate has gone on for some time — the measured
  // circling signal, never a round count — Claude stops refereeing the other
  // seats' claims and reviews the diff first-hand. Its stance and findings are
  // recorded, handed to the pivot judgement, and put in front of Codex.
  const scr = scratch();
  try {
    const arbiterRequests = [];
    const executorPlans = [];
    const facts = await run({
      mode: 'autonomous', task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'debate-independent-review',
      adapters: {
        runExecutor: async (options) => {
          executorPlans.push(options.plan);
          return writingExecutor(options);
        },
        runGate: async () => ({ passed: true, results: [] }),
        runReview: reviewerForRounds([
          blockingReview(), blockingReview(), blockingReview(), null,
        ]),
        runArbiter: async ({ request }) => {
          arbiterRequests.push(request);
          if (request.type === 'finding') return { verdict: 'valid' };
          if (request.type === 'review') {
            return {
              stance: 'mixed',
              findings: [{ id: 'C1', severity: 'P0', text: 'the recurring objection is real at line 4' }],
              reasoning: 'read the diff first-hand',
            };
          }
          if (request.type === 'pivot') return { decision: 'amend', reason: 'the review shows it is fixable' };
          return { verdict: 'valid' };
        },
      },
    });

    assert.equal(facts.outcome, 'review-ready', 'the amended round converges');
    assert.equal(arbiterRequests.some((request) => request.type === 'review'), false);
    const pivotRequest = arbiterRequests.find((request) => request.type === 'pivot');
    assert.match(pivotRequest.diff, /diff --git/);
    assert.equal(pivotRequest.messages.filter((message) => message.speaker === 'codex').length, 3);
    assert.equal(facts.debate.independentReviews.length, 0);
    assert.match(executorPlans[3], /the review shows it is fixable/);
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});

test('every command run in the worktree leaves whole evidence on disk', async () => {
  // "No green, no red" starts here: the harness executes as a stenographer.
  // Full stdout/stderr per command goes to __uro_evidence/ files the seats can
  // read; the facts carry a tail excerpt plus the paths. Nothing may branch on
  // these records — they are transcript, not verdict.
  const scr = scratch();
  try {
    const facts = await run({
      task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'evidence-run',
      adapters: {
        runExecutor: writingExecutor,
        runGate: async ({ onEvidence }) => {
          onEvidence?.({
            bin: 'node', args: ['--test'], code: 0, timedOut: false, attempt: 1,
            stdout: `${'noise line\n'.repeat(200)}tests 823 pass 823 fail 0\n`,
            stderr: '',
          });
          return { passed: true, results: [] };
        },
        runVerifier: async () => ({ verdict: 'NO_BLOCKERS' }),
      },
    });

    assert.equal(facts.evidence.length, 1);
    const record = facts.evidence[0];
    assert.equal(record.code, 0);
    // The excerpt keeps the TAIL — the end of a run is where it says why it
    // stopped — and the full text lives on disk, untruncated.
    assert.match(record.excerpt, /tests 823 pass 823 fail 0/);
    assert.ok(record.excerpt.length <= 500);
    const full = readFileSync(join(facts.dir, record.outFile), 'utf8');
    assert.match(full, /^noise line/, 'the file must hold the WHOLE output, head included');
    assert.equal((full.match(/noise line/g) ?? []).length, 200);
    assert.equal(Object.hasOwn(record, 'passed'), false,
      'an evidence record must never carry a verdict field');
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});
