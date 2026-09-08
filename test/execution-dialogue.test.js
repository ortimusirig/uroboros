import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runExecutionDialogue } from '../src/execution-dialogue.js';
import { captureEvidence, createInspectionReceipt } from '../src/context-evidence.js';
import { openProjectMemory, resolveProjectIdentity } from '../src/project-memory.js';
import { runGate } from '../src/gate.js';
import { createLivenessJudge } from '../src/liveness-judge.js';
import { spawnCapture } from '../src/spawn.js';
import { openPlanningContext } from '../src/planning-dialogue.js';
import { openDialogueJournal } from '../src/dialogue-journal.js';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'uro-execution-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const target = join(base, 'project'), directory = join(base, 'run'), artifactRoot = join(base, 'artifacts');
  mkdirSync(target); mkdirSync(directory);
  writeFileSync(join(target, 'source.js'), 'export const enabled = true;\n');
  execFileSync('git', ['init', '-q', target]);
  execFileSync('git', ['-C', target, 'config', 'core.autocrlf', 'false']);
  execFileSync('git', ['-C', target, 'add', '.']);
  execFileSync('git', ['-C', target, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'base']);
  return { target, directory, artifactRoot, runId: 'execution-fixture', requirements: 'Keep enabled', interactionMode: 'autonomous',
    artifactDigest: 'before', capture: () => ({ artifactDigest: readFileSync(join(target, 'source.js'), 'utf8'), diff: 'actual retained source' }) };
}
function reply(r, action, extra = {}) {
  return { schemaVersion: 1, action, artifactDigest: r.state.artifactDigest, contextDigest: r.state.snapshot.digest,
    replyTo: null, content: 'Discuss current retained work', claims: [], issues: [], evidence: [], verifications: [], next: null, ...extra };
}
function approve(r) {
  const evidence = r.state.evidence.find(item => item.id === 'requirement-briefing');
  const receipt = createInspectionReceipt({ operationId: r.operationId, seat: 'claude', evidence: [evidence], inspected: true, result: 'read' });
  return { observations: { evidence: [], receipts: [receipt] }, dialogue: reply(r, 'approve', {
    claims: [{ id: 'briefing-requirement', kind: 'fact', text: 'The briefing requires keeping enabled.', evidenceIds: [evidence.id] }],
    verifications: [{ claimId: 'briefing-requirement', evidenceIds: [evidence.id], inspectionReceiptIds: [receipt.id], result: 'supports', reason: 'Read the captured briefing.' }],
    memoryProposals: [{ id: 'execution-constraint', kind: 'constraint', content: 'Keep enabled', claimIds: ['briefing-requirement'] }],
  }) };
}

test('native liveness provider prepares before launch and retains usage and current task once', async t => {
  const opts = fixture(t); let launches = 0;
  const journalPath = join(opts.directory, '__uro_dialogue', 'journal.jsonl');
  const judge = createLivenessJudge({ cwd: opts.target, runSeat: (bin, args, options) => {
    launches++;
    const events = readFileSync(journalPath, 'utf8').trim().split('\n').map(JSON.parse);
    const intent = events.find(event => event.type === 'prepare' && event.purpose === 'liveness');
    assert.ok(intent);
    assert.equal(intent.input, options.input);
    assert.match(options.input, /Current parent task/);
    return spawnCapture(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => { console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({status:"working",reasoning:"Observed process still working"})}})); console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:7,output_tokens:3}})); });'], options);
  } });
  const result = await runExecutionDialogue({ ...opts, task: 'Current parent task', judgeLiveness: judge,
    execute: async r => {
      const verdict = await r.judgeLiveness({ checkCount: 1, gapMs: 50, processTree: { descendants: [] }, worktreeActivity: { changed: false } });
      assert.equal(verdict.status, 'working');
      await r.onLivenessDecisionRequired({ status: 'working', reasoning: verdict.reasoning });
      return { error: 'controlled writer pause', usage: { inputTokens: 2, outputTokens: 1 } };
    },
  });
  assert.equal(result.action, 'paused');
  assert.equal(launches, 1);
  assert.equal(result.resources.providerLaunches, 2);
  assert.deepEqual(result.resources.knownUsage, { inputTokens: 9, outputTokens: 4 });
  assert.equal(result.resources.usageUnknown, false);
  assert.equal(result.checkpointState.supervision.operations.filter(item => item.purpose === 'liveness').length, 1);
  assert.equal(result.checkpointState.supervision.decisions.length, 1);
});

test('native enforced budget denies liveness while writer usage is unknown', async t => {
  const opts = fixture(t); let judges = 0;
  const result = await runExecutionDialogue({ ...opts,
    budget: ({ account }) => account.usageUnknown ? { allowed: false, reason: 'accounting-incomplete: writer usage unknown' } : { allowed: true },
    judgeLiveness: async () => { judges++; throw new Error('unbudgeted judge'); },
    execute: async r => {
      const verdict = await r.judgeLiveness({ checkCount: 1 });
      assert.equal(verdict.available, false);
      assert.match(verdict.reason, /accounting-incomplete/);
      return { error: 'controlled writer pause', usage: { inputTokens: 2, outputTokens: 1 } };
    },
  });
  assert.equal(result.action, 'paused');
  assert.equal(judges, 0);
  assert.equal(result.resources.providerLaunches, 1);
  assert.equal(result.checkpointState.supervision.denials.length, 1);
});

test('native uncertain liveness settlement pauses a completed writer and ignores late completion', async t => {
  const opts = fixture(t); let release;
  const result = await runExecutionDialogue({ ...opts, livenessJudgeTimeoutMs: 30,
    judgeLiveness: () => new Promise(resolve => { release = resolve; }),
    execute: async r => { void r.judgeLiveness({ checkCount: 1 }); await new Promise(resolve => setTimeout(resolve, 5));
      return { dialogue: reply(r, 'propose'), usage: { inputTokens: 2, outputTokens: 1 } }; }, review: approve,
  });
  assert.equal(result.action, 'paused');
  assert.equal(result.approved, false);
  assert.equal(result.resources.usageUnknown, true);
  const path = join(opts.directory, '__uro_dialogue', 'journal.jsonl'), before = readFileSync(path, 'utf8');
  release({ status: 'working', reasoning: 'late', usage: { inputTokens: 99, outputTokens: 99 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(result.checkpointState.supervision.uncertainty[0].type, 'liveness-uncertain');
});

test('native preservation converges repeated callbacks on one prepared and completed real Git commit', async t => {
  const opts = fixture(t); let preserves = 0;
  mkdirSync(join(opts.target, '__uro_review'));
  const protectedFile = join(opts.target, '__uro_review', 'evidence.bin');
  writeFileSync(protectedFile, Buffer.from([0, 255, 3]));
  const result = await runExecutionDialogue({ ...opts,
    selectPreservation: () => ({ cwd: opts.target, head: execFileSync('git', ['-C', opts.target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }),
    preserveExecutorWork: ({ operationId }) => {
      preserves++;
      const events = readFileSync(join(opts.directory, '__uro_dialogue', 'journal.jsonl'), 'utf8');
      assert.match(events, new RegExp(operationId));
      execFileSync('git', ['-C', opts.target, 'add', '.']);
      execFileSync('git', ['-C', opts.target, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'partial']);
      return { head: execFileSync('git', ['-C', opts.target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), writerOutcome: 'unknown' };
    },
    execute: async r => {
      writeFileSync(protectedFile, 'invalid writer edit');
      writeFileSync(join(opts.target, 'partial'), 'retained');
      const first = r.beforeKillRequired({ kind: 'watchdog' });
      assert.equal(r.beforeKillRequired({ kind: 'deadline' }), first);
      const completed = await first;
      assert.deepEqual(await r.beforeKillRequired({ kind: 'abort' }), completed);
      return { aborted: true, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  });
  assert.equal(result.action, 'paused');
  assert.equal(preserves, 1);
  assert.equal(result.checkpointState.supervision.operations[0].status, 'completed');
  assert.equal(readFileSync(join(opts.target, 'partial'), 'utf8'), 'retained');
  assert.deepEqual(readFileSync(protectedFile), Buffer.from([0, 255, 3]));
  assert.equal(result.checkpointState.supervision.observations[0].restoration.status, 'completed');
  assert.ok(result.checkpointState.supervision.observations[0].restoration.paths.includes('__uro_review/evidence.bin'));
});

for (const failing of ['decision', 'preservation-prepare', 'preservation-complete']) test(`native required ${failing} sink failure pauses with no second preservation or provider`, async t => {
  const opts = fixture(t), session = openPlanningContext({ ...opts, phase: 'execution', tier: 'execution' });
  const journal = session.journal; let preserves = 0, writes = 0;
  const guarded = { ...journal,
    append: event => { if (failing === 'decision' && event.type === 'liveness-decision') throw new Error('required decision sink failed'); return journal.append(event); },
    prepare: intent => { if (failing === 'preservation-prepare' && intent.purpose === 'preservation') throw new Error('required preservation preparation failed'); return journal.prepare(intent); },
    complete: value => { if (failing === 'preservation-complete' && journal.operation(value.operationId).purpose === 'preservation') throw new Error('required preservation completion failed'); return journal.complete(value); },
  };
  const result = await runExecutionDialogue({ ...opts, session, journal: guarded,
    selectPreservation: () => ({ cwd: opts.target }),
    preserveExecutorWork: () => { preserves++; writeFileSync(join(opts.target, 'partial'), 'retained bytes'); return { writerOutcome: 'unknown' }; },
    execute: async r => {
      writes++;
      if (failing === 'decision') await assert.rejects(r.onLivenessDecisionRequired({ status: 'stuck' }), /sink failed/);
      await assert.rejects(r.beforeKillRequired({ kind: 'deadline' }), /failed/);
      await assert.rejects(r.beforeKillRequired({ kind: 'abort' }), /failed/);
      return { aborted: true, usage: { inputTokens: 1, outputTokens: 1 } };
    }, review: () => { throw new Error('must not review'); },
  });
  assert.equal(result.action, 'paused');
  assert.equal(writes, 1);
  assert.equal(preserves, failing === 'preservation-complete' ? 1 : 0);
  const events = readFileSync(join(opts.directory, '__uro_dialogue', 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(event => event.type === 'complete' && event.operationId.endsWith(':preservation')).length, 0);
});

test('native writer close cancels and settles its actual owned liveness child before phase closure', async t => {
  const opts = fixture(t); let ready;
  const childReady = new Promise(resolve => { ready = resolve; });
  const judge = createLivenessJudge({ cwd: opts.target, runSeat: (bin, args, options) => spawnCapture(process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:4,output_tokens:2}})+"\\n"); setInterval(()=>{},100);'],
    { ...options, onStdout: ready }) });
  const result = await runExecutionDialogue({ ...opts, judgeLiveness: judge,
    execute: async r => { void r.judgeLiveness({ checkCount: 1 }); await childReady;
      return { error: 'controlled writer close', usage: { inputTokens: 1, outputTokens: 1 } }; },
  });
  assert.equal(result.action, 'paused');
  const operation = result.checkpointState.supervision.operations[0];
  assert.equal(operation.status, 'completed');
  assert.equal(operation.result.aborted, true);
  assert.equal(operation.usage.inputTokens, 4);
  assert.deepEqual(result.resources.knownUsage, { inputTokens: 5, outputTokens: 3 });
});

test('native working judgment in the actual shared workspace permits normal protected completion', async t => {
  const opts = fixture(t);
  const result = await runExecutionDialogue({ ...opts, directory: opts.target,
    judgeLiveness: async () => ({ status: 'working', reasoning: 'Current work continues', usage: { inputTokens: 4, outputTokens: 2 } }),
    execute: async r => {
      const first = await r.judgeLiveness({ checkCount: 1 });
      assert.deepEqual(await r.judgeLiveness({ checkCount: 1 }), first);
      await r.onLivenessDecisionRequired({ status: first.status, reasoning: first.reasoning });
      return { dialogue: reply(r, 'propose'), usage: { inputTokens: 1, outputTokens: 1 } };
    }, review: r => ({ ...approve(r), usage: { inputTokens: 1, outputTokens: 1 } }),
  });
  assert.equal(result.approved, true, result.reason);
  assert.equal(result.resources.providerLaunches, 3);
  assert.deepEqual(result.resources.knownUsage, { inputTokens: 6, outputTokens: 4 });
});

for (const tamper of ['journal-rollback', 'context', 'extra', 'lock']) test(`native journal append allowance rejects ${tamper} and retains observed usage`, async t => {
  const opts = fixture(t); let reviews = 0;
  const result = await runExecutionDialogue({ ...opts, directory: opts.target,
    judgeLiveness: async () => ({ status: 'working', reasoning: 'observed', usage: { inputTokens: 4, outputTokens: 2 } }),
    execute: async r => {
      const files = ['journal.jsonl', 'journal-tail.jsonl'].map(name => join(opts.target, '__uro_dialogue', name));
      const prior = files.map(path => readFileSync(path));
      await r.judgeLiveness({ checkCount: 1 });
      if (tamper === 'journal-rollback') files.forEach((path, index) => writeFileSync(path, prior[index]));
      if (tamper === 'context') writeFileSync(join(opts.target, '__uro_context', readdirSync(join(opts.target, '__uro_context')).find(name => name.endsWith('.json'))), '{}');
      if (tamper === 'extra') writeFileSync(join(opts.target, '__uro_dialogue', 'unregistered.json'), '{}');
      if (tamper === 'lock') writeFileSync(join(opts.target, '__uro_dialogue', 'controller.lock'), 'unowned');
      return { dialogue: reply(r, 'propose'), usage: { inputTokens: 7, outputTokens: 3 } };
    }, review: r => { reviews++; return approve(r); },
  });
  assert.equal(result.approved, false);
  assert.equal(result.action, 'paused');
  assert.equal(reviews, 0);
  assert.equal(result.checkpointState.executionArtifacts, undefined);
  const observations = result.checkpointState.supervision.observations;
  assert.equal(observations.find(item => item.purpose === 'liveness')?.usage.inputTokens, 4);
  assert.equal(observations.find(item => !item.purpose)?.usage.inputTokens, 7);
});

for (const purpose of ['liveness', 'preservation']) test(`native recovered uncertain ${purpose} refuses every new writer and effect`, async t => {
  const opts = fixture(t), session = openPlanningContext({ ...opts, phase: 'execution', tier: 'execution' });
  session.journal.prepare({ operationId: 'interrupted-auxiliary', seat: purpose === 'liveness' ? 'codex' : 'harness',
    effect: purpose === 'liveness' ? 'provider' : 'preserve-partial-work', purpose, input: 'saved exact input',
    artifactDigest: opts.artifactDigest, contextDigest: session.snapshot.digest, evidenceIds: [], unreadMessageIds: [], providerOperationId: 'interrupted-writer' });
  session.journal.close();
  session.journal = openDialogueJournal({ directory: opts.directory, runId: opts.runId, projectId: session.snapshot.projectId });
  let writes = 0, effects = 0;
  const result = await runExecutionDialogue({ ...opts, session,
    execute: r => { writes++; return { dialogue: reply(r, 'propose') }; }, review: approve,
    preserveExecutorWork: () => { effects++; }, judgeLiveness: () => { effects++; },
  });
  assert.equal(result.action, 'paused');
  assert.match(result.reason, /uncertain.*replay refused/);
  assert.equal(writes, 0);
  assert.equal(effects, 0);
  assert.equal(result.checkpointState.supervision.operations[0].status, 'uncertain');
});

test('native writer close waits for watchdog preservation before closing its journal', async t => {
  const opts = fixture(t); let release, started;
  const preserving = new Promise(resolve => { started = resolve; });
  const pending = runExecutionDialogue({ ...opts,
    selectPreservation: () => ({ cwd: opts.target }),
    preserveExecutorWork: () => new Promise(resolve => { release = () => {
      writeFileSync(join(opts.target, 'partial'), 'retained'); resolve({ writerOutcome: 'unknown' });
    }; started(); }),
    execute: r => { void r.beforeKillRequired({ kind: 'watchdog' }).catch(() => {}); return { error: 'writer closed naturally', usage: { inputTokens: 1, outputTokens: 1 } }; },
  });
  await preserving;
  const outranPreservation = await Promise.race([pending.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 300))]);
  release();
  const result = await pending;
  assert.equal(outranPreservation, false);
  assert.equal(result.checkpointState.supervision.operations[0].status, 'completed');
});

test('native writer close never waits unboundedly on an unlaunched liveness preflight', async t => {
  const opts = fixture(t); let release, entered, launches = 0;
  const preflight = new Promise(resolve => { entered = resolve; });
  const pending = runExecutionDialogue({ ...opts,
    budget: ({ nextAction }) => nextAction.action !== 'liveness' ? { allowed: true } : new Promise(resolve => { release = () => resolve({ allowed: true }); entered(); }),
    judgeLiveness: () => { launches++; return { status: 'working', reasoning: 'must not launch' }; },
    execute: r => { void r.judgeLiveness({ checkCount: 1 }); return { error: 'writer closed' }; },
  });
  await preflight;
  const closedBeforeBudget = await Promise.race([pending.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 300))]);
  release();
  const result = await pending;
  assert.equal(closedBeforeBudget, true);
  assert.equal(result.action, 'paused');
  assert.equal(launches, 0);
});

test('real execution entry recalls notebook and promotes supported execution memory after approval', async t => {
  const opts = fixture(t);
  const memory = openProjectMemory({ artifactRoot: opts.artifactRoot, project: resolveProjectIdentity({ target: opts.target }) });
  memory.append({ entry: { id: 'prior-choice', kind: 'decision', content: 'Keep enabled', status: 'unsupported',
    sourceIdentity: 'prior-context', provenance: { origin: 'previous-run' }, evidence: [], claims: [] } });
  const result = await runExecutionDialogue({ ...opts,
    execute: r => {
      assert.equal(r.state.snapshot.recalled.length, 1);
      writeFileSync(join(opts.target, 'counter'), '1');
      return { dialogue: reply(r, 'propose') };
    }, review: approve,
  });
  assert.equal(result.approved, true, result.reason);
  assert.equal(readFileSync(join(opts.target, 'counter'), 'utf8'), '1');
  assert.equal(memory.list().find(entry => entry.id === 'execution-constraint').status, 'verified');
  assert.equal(result.checkpointState.version, 2);
  assert.equal(result.checkpointState.phase, 'execution');
  assert.equal(existsSync(join(opts.directory, '__uro_dialogue', 'controller.lock')), false);
});

test('execution explanation is read-only and does not start another coding step', async t => {
  const opts = fixture(t); let coding = 0, reviews = 0;
  mkdirSync(join(opts.target, '__uro_review'));
  const retainedReview = join(opts.target, '__uro_review', 'review-test.js');
  writeFileSync(retainedReview, 'reviewer-owned evidence');
  const result = await runExecutionDialogue({ ...opts,
    execute: r => { coding++; writeFileSync(join(opts.target, 'counter'), '1'); return { dialogue: reply(r, 'propose') }; },
    review: r => ++reviews === 1 ? { dialogue: reply(r, 'ask', { next: { seat: 'codex', action: 'answer', reason: 'Explain the work' } }) } : approve(r),
    discuss: r => {
      writeFileSync(join(opts.target, 'source.js'), 'unauthorized explanation write');
      writeFileSync(retainedReview, 'unauthorized reviewer evidence write');
      return { dialogue: reply(r, 'answer') };
    },
  });
  assert.equal(result.approved, true, result.reason);
  assert.equal(coding, 1);
  assert.equal(readFileSync(join(opts.target, 'source.js'), 'utf8'), 'export const enabled = true;\n');
  assert.equal(readFileSync(retainedReview, 'utf8'), 'reviewer-owned evidence');
});

test('omitted challenge control permits more than two cited execution exchanges', async t => {
  const opts = fixture(t); let coding = 0, exchanges = 0;
  const result = await runExecutionDialogue({ ...opts,
    execute: r => { coding++; return { dialogue: reply(r, 'propose') }; },
    review: r => exchanges < 4 ? { dialogue: reply(r, 'ask', { evidence: ['requirement-briefing'],
      next: { seat: 'codex', action: 'challenge', reason: 'Discuss the cited concern' } }) } : approve(r),
    discuss: r => { exchanges++; return { dialogue: reply(r, 'challenge', { evidence: ['requirement-briefing'] }) }; },
  });
  assert.equal(result.approved, true, result.reason);
  assert.equal(coding, 1);
  assert.equal(result.state.challengeCycles, 4);
});

test('explicit correction control pauses before a new coding step', async t => {
  const opts = fixture(t); let coding = 0;
  const result = await runExecutionDialogue({ ...opts, limits: { corrections: 0 },
    execute: r => { coding++; writeFileSync(join(opts.target, 'counter'), '1'); return { dialogue: reply(r, 'propose') }; },
    review: r => ({ dialogue: reply(r, 'answer', { next: { seat: 'codex', action: 'revise', reason: 'Correct the implementation' } }) }),
  });
  assert.equal(result.action, 'paused');
  assert.match(result.reason, /correction-cycle limit/);
  assert.equal(coding, 1);
  assert.equal(readFileSync(join(opts.target, 'counter'), 'utf8'), '1');
});

for (const kind of ['product', 'permission']) test(`missing ${kind} decision remains human in autonomous execution after retained writes`, async t => {
  const opts = fixture(t); let reviews = 0;
  const result = await runExecutionDialogue({ ...opts,
    execute: r => { writeFileSync(join(opts.target, 'counter'), '1'); return { dialogue: reply(r, 'ask', {
      evidence: ['requirement-briefing'], issues: [{ id: 'Q1', title: 'Missing user decision', status: 'awaiting-answer',
        blocking: true, kind, needsHuman: true }],
    }) }; }, review: r => { reviews++; return approve(r); },
  });
  assert.equal(result.action, 'needs-decision', result.reason);
  assert.equal(result.approved, false);
  assert.equal(result.state.pendingDecision.authority, 'human');
  assert.equal(result.state.pendingDecision.artifactDigest, result.state.artifactDigest);
  assert.equal(result.state.pendingDecision.contextDigest, result.state.snapshot.digest);
  assert.equal(result.state.pendingDecision.questionIdentity.artifactDigest, 'before');
  assert.equal(result.state.issues.Q1.kind, kind);
  assert.equal(result.state.issues.Q1.needsHuman, true);
  assert.equal(result.state.messages[0].action, 'ask');
  assert.equal(result.state.pendingExecutionCapture, null);
  assert.notEqual(result.state.artifactDigest, 'before');
  assert.equal(readFileSync(join(opts.target, 'counter'), 'utf8'), '1');
  assert.equal(reviews, 0);
});

test('the execution adapter preserves existing review bytes against executor edits', async t => {
  const opts = fixture(t);
  mkdirSync(join(opts.target, '__uro_review'));
  const reviewPath = join(opts.target, '__uro_review', 'review-test.js');
  writeFileSync(reviewPath, 'retained reviewer evidence');
  const result = await runExecutionDialogue({ ...opts,
    execute: r => { writeFileSync(reviewPath, 'executor overwrote review'); return { dialogue: reply(r, 'propose') }; },
    review: approve,
  });
  assert.equal(result.approved, true, result.reason);
  assert.equal(readFileSync(reviewPath, 'utf8'), 'retained reviewer evidence');
});

test('partial write question marks only subsequent execution as remaining work', async t => {
  const opts = fixture(t); let executions = 0;
  const result = await runExecutionDialogue({ ...opts,
    execute: r => {
      executions++;
      assert.equal(r.remainingWork, executions > 1);
      if (executions === 1) {
        writeFileSync(join(opts.target, 'counter'), '1');
        return { dialogue: reply(r, 'ask', { evidence: ['requirement-briefing'] }) };
      }
      assert.equal(readFileSync(join(opts.target, 'counter'), 'utf8'), '1');
      writeFileSync(join(opts.target, 'remaining'), 'done');
      return { dialogue: reply(r, 'propose') };
    }, review: r => r.action === 'answer' ? { dialogue: reply(r, 'answer', {
      next: { seat: 'codex', action: 'propose', reason: 'Continue only remaining work' },
    }) } : approve(r),
  });
  assert.equal(result.approved, true, result.reason);
  assert.equal(result.state.proposalCycles, 1);
  assert.equal(readFileSync(join(opts.target, 'remaining'), 'utf8'), 'done');
  assert.equal(result.state.executionCycle.completedOperationIds.length, 2);
});

test('required context failure surfaces a technical pause without a later review or notebook promotion', async t => {
  const opts = fixture(t); let reviews = 0;
  const result = await runExecutionDialogue({ ...opts,
    execute: r => {
      writeFileSync(join(opts.target, 'counter'), '1');
      writeFileSync(join(opts.directory, '__uro_context', `${r.state.snapshot.id}.json`), '{}');
      return { dialogue: reply(r, 'propose') };
    }, review: r => { reviews++; return approve(r); },
  });
  assert.equal(result.action, 'paused');
  assert.equal(result.approved, false);
  assert.match(result.reason, /context|sidecar|integrity/);
  assert.equal(reviews, 0);
  assert.equal(readFileSync(join(opts.target, 'counter'), 'utf8'), '1');
  assert.equal(result.checkpointState.executionArtifacts, undefined, 'no usable integrity manifest may be fabricated');
});

test('execution entry pauses on required command capture failure before review', async t => {
  const opts = fixture(t); let reviews = 0;
  const result = await runExecutionDialogue({ ...opts,
    execute: r => ({ dialogue: reply(r, 'propose') }),
    selectChecks: () => ({ identity: 'required-gate-1' }),
    runChecks: () => { writeFileSync(join(opts.target, 'first-check'), '1'); throw new Error('required command capture failed'); },
    review: r => { reviews++; return approve(r); },
  });
  assert.equal(result.action, 'paused');
  assert.equal(result.approved, false);
  assert.match(result.reason, /required command capture failed/);
  assert.equal(reviews, 0);
  assert.equal(readFileSync(join(opts.target, 'first-check'), 'utf8'), '1');
  assert.equal(result.checkpointState.dialogue.pendingOperation.effect, 'execution-checks');
});

test('execution entry delivers complete actual command evidence and post-command bytes before approval', async t => {
  const opts = fixture(t); let gates = 0;
  const script = "require('node:fs').writeFileSync('source.js', 'post-command bytes'); process.stdout.write('x'.repeat(16000));";
  const result = await runExecutionDialogue({ ...opts,
    execute: r => ({ dialogue: reply(r, 'propose') }),
    selectChecks: () => ({ identity: 'required-command-set-1', commands: [{ bin: process.execPath, args: ['-e', script] }] }),
    runChecks: async r => {
      gates++;
      const captured = [];
      await runGate({ commands: r.selection.commands, cwd: opts.target, requiredEvidence: true,
        codeIdentity: () => readFileSync(join(opts.target, 'source.js'), 'utf8'),
        onEvidence: entry => {
          captured.push(captureEvidence({ projectId: r.state.projectId, root: opts.target, directory: r.evidenceDirectory,
            evidence: { ...entry, id: `command-${r.operationId}`, kind: 'command', projectId: r.state.projectId,
              claimIds: ['gate-result'], sourceIdentity: entry.codeIdentity } }));
        },
      });
      return { artifactDigest: readFileSync(join(opts.target, 'source.js'), 'utf8'), diff: 'source.js now contains post-command bytes', evidence: captured };
    },
    review: r => {
      assert.equal(r.state.artifactDigest, 'post-command bytes');
      const command = r.state.evidence.find(e => e.kind === 'command');
      assert.equal(command.codeIdentity, 'export const enabled = true;\n');
      assert.deepEqual(command.argv, [process.execPath, '-e', script]);
      assert.equal(command.cwd, opts.target);
      assert.equal(command.exitCode, 0);
      assert.equal(command.stdout.length, 16000);
      return approve(r);
    },
  });
  assert.equal(result.approved, true, result.reason);
  assert.equal(gates, 1);
  assert.equal(result.state.executionChecks.artifactDigest, 'post-command bytes');
});

test('execution entry cannot approve an unusable terminal review carrying a valid envelope', async t => {
  const opts = fixture(t);
  const result = await runExecutionDialogue({ ...opts,
    execute: r => ({ dialogue: reply(r, 'propose') }),
    review: r => ({ ...approve(r), resultSeen: false, resultUsable: false, artifactFailed: true }),
  });
  assert.equal(result.action, 'paused');
  assert.equal(result.approved, false);
  assert.equal(result.state.approval, null);
});

test('Claude discussion preserves retained reviewer files while answering a partial question', async t => {
  const opts = fixture(t);
  mkdirSync(join(opts.target, '__uro_review'));
  const reviewPath = join(opts.target, '__uro_review', 'retained.js');
  writeFileSync(reviewPath, 'required reviewer test');
  let writes = 0;
  const result = await runExecutionDialogue({ ...opts,
    execute: r => ({ dialogue: reply(r, ++writes === 1 ? 'ask' : 'propose') }),
    review: r => {
      if (r.action === 'answer') {
        writeFileSync(reviewPath, 'unauthorized discussion write');
        return { dialogue: reply(r, 'answer', { next: { seat: 'codex', action: 'propose', reason: 'Finish remaining work' } }) };
      }
      return approve(r);
    },
  });
  assert.equal(result.approved, true, result.reason);
  assert.equal(readFileSync(reviewPath, 'utf8'), 'required reviewer test');
});
