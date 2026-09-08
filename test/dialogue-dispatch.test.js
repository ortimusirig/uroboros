import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDialogueJournal } from '../src/dialogue-journal.js';
import { runIssueDialogue } from '../src/dialogue-dispatch.js';
import { applyDialogueEnvelope, canApproveDialogue } from '../src/dialogue.js';
import { createInspectionReceipt } from '../src/context-evidence.js';
import { captureEvidence } from '../src/context-evidence.js';
import { extendSharedContext } from '../src/shared-context.js';
import { fixture, envelope, claim, observe, support } from './fixtures/dialogue-fixture.js';

function setup(t, options = {}) {
  const f = fixture(t, options), journal = openDialogueJournal({ directory: f.base, runId: 'r1', projectId: 'p1' });
  t.after(() => journal.close());
  return { ...f, journal };
}
function response(dialogue, usage = null) { return { dialogue, content: JSON.stringify(dialogue), usage, delivery: { observed: true } }; }
function approve(state) {
  const receipt = Object.values(state.inspectionReceipts).find(r => r.seat === state.reviewer);
  return envelope(state, 'approve', { claims: [claim], verifications: [support(receipt)] });
}

test('artifact repair respects budget and recovers a completed no-application without a second application', async t => {
  const { state, journal } = setup(t, { limits: { rounds: 1, artifactRepairs: 5 } });
  state.proposalCycles = 1;
  state.artifactRepairs = 3;
  const pending = { operationId: 'repair-application', seat: 'claude', action: 'propose', effect: 'apply' };
  state.pendingOperation = pending;
  state.pendingArtifact = { action: 'propose', seat: 'claude', providerOperationId: 'saved-author' };
  journal.prepare({ ...pending, input: 'saved response', artifactDigest: state.artifactDigest,
    contextDigest: state.snapshot.digest, evidenceIds: ['E1'], unreadMessageIds: [] });
  journal.complete({ operationId: pending.operationId, result: { artifactDigest: state.artifactDigest,
    snapshot: state.snapshot, artifactRepair: { reason: 'Missing required artifact tag' } } });
  let applications = 0, launches = 0, budgetChecks = 0;
  const result = await runIssueDialogue({ state, journal, persist: async () => {},
    revise: async () => { applications++; }, seats: { claude: async () => { launches++; } },
    budget: ({ state: current, account, nextAction }) => {
      budgetChecks++;
      assert.equal(current.artifactRepairs, 4);
      assert.equal(current.artifactRepair.cycle, 1);
      assert.equal(current.artifactRepair.operationId, pending.operationId);
      assert.equal(nextAction.action, 'propose');
      assert.equal(account.providerLaunches, 0);
      return { allowed: false, reason: 'repair launch budget exhausted' };
    } });
  assert.equal(result.approved, false);
  assert.match(result.reason, /budget exhausted/);
  assert.equal(result.state.operations[pending.operationId].applied, false);
  assert.equal(result.state.artifactRepairs, 4);
  assert.equal(applications, 0);
  assert.equal(launches, 0);
  assert.equal(budgetChecks, 1);
});

test('uncertain artifact writer failure never becomes a format repair or retries application', async t => {
  const { state, journal } = setup(t, { limits: { rounds: 1, artifactRepairs: 5 } });
  state.next = { seat: 'claude', action: 'propose', reason: 'Draft' };
  let calls = 0, writes = 0;
  const result = await runIssueDialogue({ state, journal, persist: async () => {},
    seats: { claude: async ({ state: s }) => { calls++; return response(envelope(s, 'propose'), { inputTokens: 7, outputTokens: 2 }); } },
    revise: async () => { writes++; throw new Error('disk write may have partially applied'); } });
  assert.equal(result.action, 'paused');
  assert.equal(result.state.pendingOperation.effect, 'apply');
  assert.equal(result.state.artifactRepair, undefined);
  const again = await runIssueDialogue({ state: result.state, journal, persist: async () => {},
    seats: { claude: () => assert.fail('no repeated provider') }, revise: () => assert.fail('no repeated write') });
  assert.equal(again.action, 'paused');
  assert.equal(calls, 1);
  assert.equal(writes, 1);
  assert.equal(again.resources.providerLaunches, 1);
  assert.equal(again.resources.knownUsage.inputTokens, 7);
});

test('rereading registered evidence adds a receipt without changing material context', async t => {
  const { state, journal } = setup(t);
  let launches = 0;
  const result = await runIssueDialogue({ state, journal, persist: async () => {}, seats: {
    codex: async ({ state: current }) => {
      if (++launches === 1) return response(envelope(current, 'inspect', { requests: [{ evidenceId: 'E1' }] }));
      assert.equal(current.snapshot.digest, state.snapshot.digest);
      assert.equal(Object.keys(current.inspectionReceipts).length, 1);
      return response(approve(current));
    },
  } });
  assert.equal(result.approved, true, result.reason);
  assert.equal(launches, 2);
});

test('first clean review completes after exactly one launch with full common input', async (t) => {
  const { state, journal } = setup(t, { interactionMode: 'manual' });
  observe(state);
  state.next = { seat: 'codex', action: 'verify', reason: 'Review current artifact' };
  let launches = 0;
  const result = await runIssueDialogue({ state, journal, seats: { codex: async ({ input, state: current }) => {
    launches++;
    assert.match(input, /Keep the feature enabled/);
    assert.match(input, /UROBOROS_DIALOGUE/);
    assert.match(input, /inspectionReceiptIds/);
    return response(approve(current), { inputTokens: 12, outputTokens: 5 });
  } }, renderInput: () => 'phase instructions', persist: async () => {} });
  assert.equal(result.approved, true);
  assert.equal(launches, 1);
  assert.equal(result.resources.providerLaunches, 1);
  assert.equal(result.rounds, 0);
});

test('many ask-answer and challenge-rebut exchanges preserve project bytes and proposal cycles', async (t) => {
  const { state, journal, root } = setup(t, { limits: { rounds: 1 } });
  observe(state);
  state.next = { seat: 'codex', action: 'ask', reason: 'Discuss' };
  let exchanges = 0, applications = 0;
  const seats = {
    codex: async ({ state: current }) => response(++exchanges <= 6 ? envelope(current, exchanges <= 3 ? 'challenge' : 'ask', {
      content: `Question ${exchanges}`, next: { seat: 'claude', action: exchanges <= 3 ? 'rebut' : 'answer', reason: 'Explain' },
    }) : approve(current)),
    claude: async ({ state: current }) => response(envelope(current, exchanges <= 3 ? 'rebut' : 'answer', {
      replyTo: current.messages.at(-1).id, next: { seat: 'codex', action: 'verify', reason: 'Assess response' },
    })),
  };
  const result = await runIssueDialogue({ state, journal, seats, revise: async () => { applications++; }, persist: async () => {} });
  assert.equal(result.approved, true);
  assert.equal(result.messages.length, 13);
  assert.equal(result.resources.providerLaunches, 13);
  assert.equal(result.rounds, 0);
  assert.equal(applications, 0);
  assert.equal(readFileSync(join(root, 'source.js'), 'utf8'), 'export const enabled = true;\n');
});

test('revision launches once, validates old input identity, applies saved response and installs new identity before review', async (t) => {
  const { state, journal } = setup(t);
  observe(state);
  state.approval = { seat: 'codex', artifactDigest: 'a1', contextDigest: state.snapshot.digest };
  state.next = { seat: 'claude', action: 'revise', reason: 'Apply requested change' };
  let launches = 0, applications = 0, delivered;
  const saves = [];
  const result = await runIssueDialogue({ state, journal, persist: async ({ state: s }) => saves.push(structuredClone(s)),
    seats: {
      claude: async ({ state: s }) => { launches++; delivered = response(envelope(s, 'revise')); return delivered; },
      codex: async ({ state: s }) => {
        launches++;
        assert.equal(s.artifactDigest, 'a2');
        assert.equal(s.snapshot.parentDigest, state.snapshot.digest);
        assert.equal(s.approval, null);
        assert.equal(s.pendingArtifact, null);
        return response(approve(s));
      },
    }, revise: async ({ state: s, response: completed, envelope: returned, operationId }) => {
      applications++;
      assert.deepEqual(completed, delivered);
      assert.equal(returned.artifactDigest, 'a1');
      assert.equal(journal.operation(operationId).status, 'prepared');
      return { artifactDigest: 'a2', snapshot: extendSharedContext({ snapshot: s.snapshot, sourceRevision: 'new' }), response: completed };
    } });
  assert.equal(result.approved, true);
  assert.equal(launches, 2);
  assert.equal(applications, 1);
  assert.equal(result.rounds, 1);
  assert.equal(result.state.correctionCycles, 1);
  assert.ok(saves.some(s => s.artifactDigest === 'a2' && s.approval === null));
  assert.equal(canApproveDialogue({ state: { ...result.state, artifactDigest: 'a3' }, seat: 'codex' }).approved, false);
});

test('rounds=1 allows dialogue after proposal but refuses second proposal before launch', async (t) => {
  const { state, journal } = setup(t, { limits: { rounds: 1 } });
  state.next = { seat: 'claude', action: 'propose', reason: 'Initial artifact' };
  let launches = 0;
  const result = await runIssueDialogue({ state, journal, persist: async () => {},
    seats: {
      claude: async ({ state: s, action }) => { launches++; return response(envelope(s, action,
        action === 'answer' ? { next: { seat: 'codex', action: 'verify', reason: 'Answered' } } : {})); },
      codex: async ({ state: s }) => { launches++; return response(envelope(s, 'ask', {
        next: { seat: 'claude', action: launches === 2 ? 'answer' : 'revise', reason: 'Continue' },
      })); },
    }, revise: async ({ state: s }) => ({ artifactDigest: 'a2', snapshot: s.snapshot }) });
  assert.equal(result.approved, false);
  assert.match(result.reason, /proposal|round/);
  assert.equal(result.rounds, 1);
  assert.equal(launches, 4);
});

test('reviewer stop judgment and reason are retained without extra final review', async (t) => {
  const { state, journal } = setup(t);
  state.next = { seat: 'codex', action: 'verify', reason: 'Assess progress' };
  const result = await runIssueDialogue({ state, journal, persist: async () => {}, seats: {
    codex: async ({ state: s }) => response(envelope(s, 'stop', { content: 'The discussion is drifting; stop here.' })),
  } });
  assert.equal(result.action, 'stop');
  assert.match(result.reason, /drifting/);
  assert.equal(result.resources.providerLaunches, 1);
});

test('budget is checked before every launch including final decision and format repair', async (t) => {
  for (const malformed of [false, true]) {
    const { state, journal } = setup(t);
    state.next = { seat: 'codex', action: 'verify', reason: 'Review' };
    let launches = 0, checks = 0;
    const result = await runIssueDialogue({ state, journal, persist: async () => {},
      budget: ({ account }) => { checks++; return { allowed: account.providerLaunches < 1, reason: 'Token budget exhausted' }; },
      seats: { codex: async ({ state: s }) => { launches++; return malformed ? { content: 'bad', usage: null }
        : response(envelope(s, 'answer', { next: { seat: 'codex', action: 'decide', reason: 'Final decision' } })); } },
    });
    assert.equal(result.approved, false);
    assert.match(result.reason, /budget/);
    assert.equal(launches, 1);
    assert.equal(checks, 2);
  }
});

test('one format repair is counted separately and a second malformed response pauses unreadable', async (t) => {
  const { state, journal } = setup(t);
  state.next = { seat: 'codex', action: 'verify', reason: 'Review' };
  const result = await runIssueDialogue({ state, journal, persist: async () => {}, seats: { codex: async () => ({ content: 'APPROVED', usage: null }) } });
  assert.equal(result.approved, false);
  assert.match(result.reason, /unreadable/);
  assert.equal(result.resources.providerLaunches, 2);
  assert.equal(result.resources.repairLaunches, 1);
  assert.equal(result.resources.usageUnknown, true);
  assert.equal(result.messages.length, 0);
});

test('transport failure is saved, charged as unknown usage and never approved', async (t) => {
  const { state, journal } = setup(t);
  state.next = { seat: 'codex', action: 'verify', reason: 'Review' };
  const result = await runIssueDialogue({ state, journal, persist: async () => {}, seats: { codex: async () => { throw new Error('offline'); } } });
  assert.equal(result.approved, false);
  assert.match(result.reason, /offline/);
  assert.equal(result.resources.failedLaunches, 1);
  assert.equal(result.resources.usageUnknown, true);
});

test('persistence failure pauses before any provider or project effect', async (t) => {
  const { state, journal } = setup(t);
  state.next = { seat: 'claude', action: 'revise', reason: 'Apply' };
  let launches = 0;
  const result = await runIssueDialogue({ state, journal, persist: async () => { throw new Error('disk full'); },
    seats: { claude: async () => { launches++; } } });
  assert.equal(result.approved, false);
  assert.match(result.reason, /disk full/);
  assert.equal(launches, 0);
});

test('unavailable durable tail pauses before launching the next provider effect', async (t) => {
  const { state, journal, base } = setup(t);
  let launches = 0, saves = 0;
  const result = await runIssueDialogue({ state, journal, persist: async () => {
    if (++saves !== 1) return;
    const tail = join(base, '__uro_dialogue', 'journal-tail.jsonl');
    if (existsSync(tail)) rmSync(tail);
    mkdirSync(tail);
  }, seats: { codex: async ({ state: s }) => { launches++; return response(envelope(s, 'stop', { content: 'Should not launch.' })); } } });
  assert.equal(result.action, 'paused');
  assert.equal(result.approved, false);
  assert.match(result.reason, /tail/);
  assert.equal(launches, 0);
});

test('completed pending provider operation is consumed on recovery without another launch', async (t) => {
  const { state, journal } = setup(t);
  observe(state);
  state.next = { seat: 'codex', action: 'verify', reason: 'Review' };
  state.pendingOperation = { operationId: 'saved-provider', seat: 'codex', action: 'verify', effect: 'provider' };
  journal.prepare({ ...state.pendingOperation, input: 'saved complete input', contextDigest: state.snapshot.digest,
    artifactDigest: 'a1', evidenceIds: ['E1'], unreadMessageIds: [] });
  journal.complete({ operationId: 'saved-provider', result: response(approve(state)), usage: null, delivery: { observed: true } });
  const result = await runIssueDialogue({ state, journal, persist: async () => {}, seats: { codex: async () => { throw new Error('must not relaunch'); } } });
  assert.equal(result.approved, true);
  assert.equal(result.resources.providerLaunches, 1);
});

test('unknown pending operation pauses without retrying an external launch', async (t) => {
  const { state, journal } = setup(t);
  state.next = { seat: 'codex', action: 'verify', reason: 'Review' };
  state.pendingOperation = { operationId: 'missing', seat: 'codex', action: 'verify', effect: 'provider' };
  let launches = 0;
  const result = await runIssueDialogue({ state, journal, persist: async () => {}, seats: { codex: async () => { launches++; } } });
  assert.equal(result.approved, false);
  assert.match(result.reason, /unknown|uncertain/);
  assert.equal(launches, 0);
});

test('explicit scoped inspection delivers observed receipts for a subsequent semantic assessment', async (t) => {
  const { state, journal } = setup(t);
  state.next = { seat: 'codex', action: 'verify', reason: 'Review' };
  let launches = 0, inspections = 0;
  const result = await runIssueDialogue({ state, journal, persist: async () => {},
    seats: { codex: async ({ state: s, input }) => {
      if (++launches === 1) return response(envelope(s, 'inspect', { requests: [{ evidenceId: 'E1' }] }));
      assert.match(input, /receipt-/);
      return response(approve(s));
    } }, inspect: async ({ requests, seat, operationId, state: s }) => {
      inspections++;
      assert.deepEqual(requests, [{ evidenceId: 'E1' }]);
      return { evidence: s.evidence, receipts: [createInspectionReceipt({ operationId, seat, evidence: s.evidence, inspected: true, result: 'read' })] };
    } });
  assert.equal(result.approved, true);
  assert.equal(launches, 2);
  assert.equal(inspections, 1);
  assert.equal(result.resources.providerLaunches, 2);
});

test('inspect requests outside trusted scope are rejected before the callback reads', async (t) => {
  const { state, journal, base } = setup(t);
  writeFileSync(join(base, 'outside.js'), 'private');
  state.next = { seat: 'codex', action: 'verify', reason: 'Review' };
  let inspections = 0;
  const result = await runIssueDialogue({ state, journal, persist: async () => {}, seats: {
    codex: async ({ state: s }) => response(envelope(s, 'inspect', { requests: [{ path: '../outside.js', line: 1 }] })),
  }, inspect: async () => { inspections++; } });
  assert.equal(result.approved, false);
  assert.match(result.reason, /scope|outside/);
  assert.equal(inspections, 0);
});

test('recovery between reduced proposal and local prepare applies the saved artifact without provider replay', async (t) => {
  const { state: original, journal } = setup(t);
  const pending = { operationId: 'proposal-completed', seat: 'claude', action: 'propose', effect: 'provider' };
  const proposed = envelope(original, 'propose');
  original.pendingOperation = pending;
  journal.prepare({ ...pending, input: 'complete input', artifactDigest: 'a1', contextDigest: original.snapshot.digest, evidenceIds: ['E1'], unreadMessageIds: [] });
  journal.complete({ operationId: pending.operationId, result: response(proposed), usage: null, delivery: null });
  const state = applyDialogueEnvelope({ state: original, seat: 'claude', envelope: proposed });
  state.pendingOperation = null;
  journal.append({ type: 'state', state });
  let applications = 0;
  const result = await runIssueDialogue({ state, journal, persist: async () => {},
    revise: async ({ response: saved }) => { applications++; assert.equal(saved.dialogue.action, 'propose'); return { artifactDigest: 'a2', snapshot: state.snapshot }; },
    seats: { codex: async ({ state: s }) => response(envelope(s, 'stop', { content: 'Applied artifact reached review.' })) },
  });
  assert.equal(applications, 1);
  assert.equal(result.state.artifactDigest, 'a2');
  assert.equal(result.resources.providerLaunches, 2);
});

test('inspection of an initially unknown digest delivers actual captured source bytes before semantic verification', async (t) => {
  const { state, journal } = setup(t);
  let calls = 0;
  const result = await runIssueDialogue({ state, journal, persist: async () => {}, seats: {
    codex: async ({ state: s, input }) => {
      if (++calls === 1) return response(envelope(s, 'inspect', { requests: [{ path: 'source.js', line: 1, claimIds: ['enabled'] }] }));
      assert.match(input, /export const enabled = true;/);
      const evidence = s.evidence.find(e => e.kind === 'code');
      const receipt = Object.values(s.inspectionReceipts).find(r => r.evidenceIds.includes(evidence.id));
      return response(envelope(s, 'approve', { claims: [{ id: 'enabled', kind: 'fact', text: 'The current source enables the feature.', evidenceIds: [evidence.id] }],
        verifications: [{ claimId: 'enabled', evidenceIds: [evidence.id], inspectionReceiptIds: [receipt.id], result: 'supports', reason: 'The source sets enabled to true.' }] }));
    },
  } });
  assert.equal(result.approved, true, result.reason);
  assert.equal(calls, 2);
});

test('a successful format repair preserves original observed evidence for approval', async (t) => {
  const { state, journal } = setup(t);
  let calls = 0;
  const result = await runIssueDialogue({ state, journal, persist: async () => {}, seats: {
    codex: async ({ state: s, operationId, action }) => {
      if (++calls === 1) return { content: 'Malformed format but an observed read.', usage: null, delivery: { status: 'submitted' },
        observations: { evidence: s.evidence, receipts: [createInspectionReceipt({ operationId, seat: 'codex', evidence: s.evidence, inspected: true, result: 'read' })] } };
      assert.equal(action, 'repair');
      return response(approve(s), { inputTokens: 4, outputTokens: 2 });
    },
  } });
  assert.equal(result.approved, true, result.reason);
  assert.equal(result.resources.providerLaunches, 2);
  assert.equal(result.resources.repairLaunches, 1);
  assert.equal(result.resources.usageUnknown, true);
  assert.deepEqual(journal.read().find(e => e.type === 'complete').delivery, { status: 'submitted' });
});

test('wrong output identity cannot apply artifact bytes and semantic rejection receives no format repair', async (t) => {
  const { state, journal } = setup(t);
  state.next = { seat: 'claude', action: 'revise', reason: 'Apply' };
  let applications = 0;
  const result = await runIssueDialogue({ state, journal, persist: async () => {}, revise: async () => { applications++; }, seats: {
    claude: async ({ state: s }) => response(envelope(s, 'revise', { artifactDigest: 'already-new' })),
  } });
  assert.equal(result.approved, false);
  assert.match(result.reason, /stale/);
  assert.equal(applications, 0);
  assert.equal(result.resources.providerLaunches, 1);
});

test('journal append failure after transport result prevents local artifact application', async (t) => {
  const { state, journal, base } = setup(t);
  state.next = { seat: 'claude', action: 'revise', reason: 'Apply' };
  let applications = 0;
  const result = await runIssueDialogue({ state, journal, persist: async () => {}, revise: async () => { applications++; }, seats: {
    claude: async ({ state: s }) => {
      writeFileSync(join(base, '__uro_dialogue', 'controller.lock'), 'another owner');
      return response(envelope(s, 'revise'));
    },
  } });
  assert.equal(result.approved, false);
  assert.match(result.reason, /ownership/);
  assert.equal(applications, 0);
});

test('a modified state projection cannot override the verified journal on resume', async (t) => {
  const { state, journal } = setup(t);
  journal.append({ type: 'state', state });
  state.artifactDigest = 'tampered';
  let calls = 0;
  const result = await runIssueDialogue({ state, journal, persist: async () => {}, seats: { codex: async () => { calls++; } } });
  assert.equal(result.approved, false);
  assert.match(result.reason, /verified journal/);
  assert.equal(calls, 0);
  assert.equal(journal.read().filter(e => e.type === 'state').at(-1).state.artifactDigest, 'a1');
});

test('revision retains old captured evidence as history and registers newly applied snapshot evidence', async (t) => {
  const { state, root, directory, journal } = setup(t);
  const old = captureEvidence({ projectId: 'p1', root, directory, evidence: { id: 'old-code', kind: 'code', projectId: 'p1',
    claimIds: ['old'], locator: { path: 'source.js', line: 1 }, sourceIdentity: 'base' } });
  state.evidence.push(old);
  state.next = { seat: 'claude', action: 'revise', reason: 'Disable feature for reviewed change' };
  const result = await runIssueDialogue({ state, journal, persist: async () => {},
    seats: { claude: async ({ state: s }) => response(envelope(s, 'revise')),
      codex: async ({ state: s, input }) => {
        assert.match(input, /export const enabled = true;/);
        assert.match(input, /historical/);
        assert.ok(s.evidence.some(e => e.id === 'new-code'));
        return response(envelope(s, 'stop', { content: 'Current and historic source are available.' }));
      } }, revise: async ({ state: s }) => {
      writeFileSync(join(root, 'source.js'), 'export const enabled = false;\n');
      const current = captureEvidence({ projectId: 'p1', root, directory, evidence: { id: 'new-code', kind: 'code', projectId: 'p1',
        claimIds: ['current'], locator: { path: 'source.js', line: 1 }, sourceIdentity: 'new' } });
      return { artifactDigest: 'a2', snapshot: extendSharedContext({ snapshot: s.snapshot, evidence: [current], sourceRevision: 'new' }) };
    } });
  assert.equal(result.action, 'stop', result.reason);
  assert.equal(result.resources.providerLaunches, 2);
});

test('recovery reuses a completed local application result without executing it twice', async (t) => {
  const { state, journal } = setup(t);
  const pending = { operationId: 'local-completed', seat: 'claude', action: 'revise', effect: 'apply' };
  state.pendingOperation = pending;
  state.pendingArtifact = { action: 'revise', seat: 'claude' };
  journal.prepare({ ...pending, input: 'saved response application', artifactDigest: 'a1', contextDigest: state.snapshot.digest, evidenceIds: ['E1'], unreadMessageIds: [] });
  journal.complete({ operationId: pending.operationId, result: { artifactDigest: 'a2', snapshot: state.snapshot }, usage: null, delivery: null });
  let applications = 0;
  const result = await runIssueDialogue({ state, journal, persist: async () => {}, revise: async () => { applications++; }, seats: {
    codex: async ({ state: s }) => response(envelope(s, 'stop', { content: 'Recovered local application.' })),
  } });
  assert.equal(result.state.artifactDigest, 'a2');
  assert.equal(result.action, 'stop');
  assert.equal(applications, 0);
});

test('one authoritative approve response settles an autonomous dispute and completes without another call', async (t) => {
  const { state: initial, journal } = setup(t);
  const state = applyDialogueEnvelope({ state: initial, seat: 'claude', envelope: envelope(initial, 'challenge', {
    claims: [claim], issues: [{ id: 'I1', title: 'Requirement dispute', status: 'disputed', blocking: true, claimIds: ['C1'] }],
  }) });
  observe(state);
  const result = await runIssueDialogue({ state, journal, persist: async () => {}, seats: {
    codex: async ({ state: s }) => response({ ...approve(s), issues: [{ id: 'I1', status: 'resolved',
      disposition: { kind: 'accepted', reason: 'The briefing resolves the dispute.', claimIds: ['C1'] } }] }),
  } });
  assert.equal(result.approved, true, result.reason);
  assert.equal(result.state.issues.I1.disposition.by, 'codex');
  assert.equal(result.resources.providerLaunches, 1);
});

test('a manual approve response with an evidenced disputed disposition preserves the human checkpoint', async (t) => {
  const { state: initial, journal } = setup(t, { interactionMode: 'manual' });
  const state = applyDialogueEnvelope({ state: initial, seat: 'claude', envelope: envelope(initial, 'challenge', {
    claims: [claim], issues: [{ id: 'I1', title: 'Requirement dispute', status: 'disputed', blocking: true, claimIds: ['C1'] }],
  }) });
  observe(state);
  let launches = 0;
  const result = await runIssueDialogue({ state, journal, persist: async () => {}, seats: {
    codex: async ({ state: s }) => {
      launches++;
      return response({ ...approve(s), issues: [{ id: 'I1', status: 'resolved',
        disposition: { kind: 'accepted', reason: 'The briefing controls; human dispute ruling remains required.', claimIds: ['C1'] } }] });
    },
  } });
  assert.equal(result.action, 'needs-decision', result.reason);
  assert.equal(result.approved, false);
  assert.equal(result.state.pendingDecision.authority, 'human');
  assert.equal(result.state.technicalPause, null);
  assert.equal(result.state.approval, null);
  assert.equal(result.state.issues.I1.status, 'disputed');
  assert.equal(result.state.messages.at(-1).action, 'approve');
  const saved = journal.read().filter(event => event.type === 'state').at(-1).state;
  assert.deepEqual(saved.pendingDecision, result.state.pendingDecision);
  assert.equal(saved.messages.at(-1).sender, 'codex');
  assert.equal(launches, 1);
});

test('an explicit new revision is not skipped because the input artifact already had approval', async (t) => {
  const { state: initial, journal } = setup(t);
  const receipt = observe(initial);
  const state = applyDialogueEnvelope({ state: initial, seat: 'codex', envelope: envelope(initial, 'approve', { claims: [claim], verifications: [support(receipt)] }) });
  state.next = { seat: 'claude', action: 'revise', reason: 'User requested another change' };
  let applications = 0;
  const result = await runIssueDialogue({ state, journal, persist: async () => {},
    seats: { claude: async ({ state: s }) => response(envelope(s, 'revise')), codex: async ({ state: s }) => response(envelope(s, 'stop', { content: 'Reviewed new artifact.' })) },
    revise: async ({ state: s }) => { applications++; return { artifactDigest: 'a2', snapshot: s.snapshot }; } });
  assert.equal(applications, 1);
  assert.equal(result.state.artifactDigest, 'a2');
});
