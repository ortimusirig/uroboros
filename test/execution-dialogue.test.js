import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runExecutionDialogue } from '../src/execution-dialogue.js';
import { captureEvidence, createInspectionReceipt } from '../src/context-evidence.js';
import { openProjectMemory, resolveProjectIdentity } from '../src/project-memory.js';
import { runGate } from '../src/gate.js';

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
