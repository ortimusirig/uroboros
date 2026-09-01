import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runConversation, RepairableArtifactError, CONVERSATION_DNA } from '../src/conversation.js';

const seatsFor = ({ proposals, agrees = true }) => {
  let proposeCalls = 0;
  const calls = { feedbackSeen: [] };
  return {
    calls,
    seats: {
      draftCodex: async () => 'DRAFT',
      draftCursor: null,
      reviewCodex: async () => ({ agree: agrees, readable: true, suggestions: [], questions: [], content: '' }),
      reviewCursor: async () => ({ agree: agrees, readable: true, suggestions: [], questions: [], content: '' }),
      checkCapability: null,
      arbitrate: async (request) => {
        if (request.type === 'propose') return { verdict: 'answered', answer: proposals[Math.min(proposeCalls++, proposals.length - 1)] };
        if (request.type === 'agreement') return { verdict: 'answered', converged: true, reason: '', feedback: '' };
        return { verdict: 'answered' };
      },
    },
    strategy: {
      draftRequest: ({ feedback }) => { calls.feedbackSeen.push(feedback ?? ''); return { codexInput: 'draft', cursorRequest: null, claudeRequest: null }; },
      parseDraft: (text) => ({ plan: text }),
      proposeRequest: ({ feedback }) => ({ type: 'propose', feedback }),
      parseProposal: (text) => {
        if (text === 'MALFORMED') throw new RepairableArtifactError('GOALS_JSON missing');
        return { plan: text };
      },
      reviewRequests: () => ({ codex: {}, cursor: {} }),
      agreementRequest: () => ({ type: 'agreement' }),
      capabilityPlanText: () => null,
      writeConverged: () => ({ written: true }),
    },
  };
};

test('a malformed proposal is fed back verbatim and repaired next round — never a terminal', async () => {
  const { seats, strategy } = seatsFor({ proposals: ['MALFORMED', 'GOOD'] });
  const proposeFeedback = [];
  const wrapped = { ...strategy, proposeRequest: (ctx) => { proposeFeedback.push(ctx.feedback ?? ''); return { type: 'propose' }; } };
  const result = await runConversation({ runId: 'conv-repair', tier: 'goal', seats, strategy: wrapped });
  assert.equal(result.converged, true);
  assert.equal(result.rounds, 2);
  assert.match(proposeFeedback[1], /GOALS_JSON missing/, 'the parse error reaches the proposer verbatim');
});

test('an unreachable proposer is still terminal — a seat that never ran cannot be repaired', async () => {
  const { seats, strategy } = seatsFor({ proposals: ['unused'] });
  seats.arbitrate = async (request) => request.type === 'propose'
    ? { verdict: 'UNVERIFIED', launchFailed: true }
    : { verdict: 'answered', converged: true };
  const result = await runConversation({ runId: 'conv-down', tier: 'goal', seats, strategy });
  assert.equal(result.converged, false);
  assert.equal(result.reason, 'arbiter-unavailable');
});

test('a repairable writeConverged failure (e.g. a dependency cycle) loops as feedback', async () => {
  const { seats, strategy } = seatsFor({ proposals: ['GOOD', 'GOOD'] });
  let writes = 0;
  strategy.writeConverged = () => {
    writes++;
    if (writes === 1) throw new RepairableArtifactError('T2 and T4 depend on each other — resolve or merge them');
    return { written: true };
  };
  const seen = [];
  strategy.proposeRequest = (ctx) => { seen.push(ctx.feedback ?? ''); return { type: 'propose' }; };
  const result = await runConversation({ runId: 'conv-cycle', tier: 'goal', seats, strategy });
  assert.equal(result.converged, true);
  assert.match(seen[1], /depend on each other/);
});

test('the DNA is present and carries the standing law verbatim', () => {
  assert.match(CONVERSATION_DNA, /Determinism advises; the model decides; contradiction asks/);
  assert.match(CONVERSATION_DNA, /SUPERSEDED/);
  assert.match(CONVERSATION_DNA, /Repair until it works/);
});
