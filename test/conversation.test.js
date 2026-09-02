import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runConversation, RepairableArtifactError, CONVERSATION_DNA, parseSeatReview,
} from '../src/conversation.js';
import { parsePlanProposal } from '../src/plan.js';

const seatsFor = ({ proposals, agrees = true }) => {
  let proposeCalls = 0;
  const calls = { feedbackSeen: [], rawProposals: [] };
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
      // A tier parser, shaped like the real ones: it receives the seat's RAW
      // response and owns the distinction between "said nothing" (plain Error,
      // terminal) and "said it badly" (RepairableArtifactError, feedback).
      parseProposal: (response) => {
        calls.rawProposals.push(response);
        const text = typeof response === 'string' ? response : response?.answer;
        if (typeof text !== 'string' || text.trim() === '') {
          throw new Error('proposer returned no artifact');
        }
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
  const { calls, seats, strategy } = seatsFor({ proposals: ['MALFORMED', 'GOOD'] });
  const proposeFeedback = [];
  const wrapped = { ...strategy, proposeRequest: (ctx) => { proposeFeedback.push(ctx.feedback ?? ''); return { type: 'propose' }; } };
  const result = await runConversation({ runId: 'conv-repair', tier: 'goal', seats, strategy: wrapped });
  assert.equal(result.converged, true);
  assert.equal(result.rounds, 2);
  assert.match(proposeFeedback[1], /GOALS_JSON missing/, 'the parse error reaches the proposer verbatim');
  // The engine hands the parser the seat's response UNTOUCHED — no collapsing to
  // text on the way in, because only the tier can read its own artifact.
  assert.deepEqual(calls.rawProposals[0], { verdict: 'answered', answer: 'MALFORMED' },
    'the raw seat response reaches the tier parser, not a stringified shadow of it');
});

test('an answer with no artifact in it at all is terminal, and unbounded rounds do not loop', async () => {
  const { seats, strategy } = seatsFor({ proposals: ['unused'] });
  // Answered, reachable, and carrying nothing: not a malformed artifact but a
  // seat that never really spoke. `rounds` is deliberately unbounded — if this
  // were misread as repairable, the conversation would feed it back forever
  // instead of failing this assertion.
  seats.arbitrate = async (request) => (request.type === 'propose'
    ? { verdict: 'answered' }
    : { verdict: 'answered', converged: true, reason: '', feedback: '' });
  const result = await runConversation({ runId: 'conv-no-artifact', tier: 'goal', seats, strategy });
  assert.equal(result.converged, false);
  assert.equal(result.reason, 'arbiter-unavailable');
  assert.equal(result.rounds, 1, 'a seat that said nothing ends the round; it is never repaired');
});

test('the plan tier owns its own no-artifact rule: silence is terminal, malformed is repairable', () => {
  // The engine no longer decides this. `[object Object]` is what an artifact-less
  // response stringifies to, and reading THAT as a malformed artifact is what
  // made an unbounded plan conversation loop forever.
  assert.throws(
    () => parsePlanProposal({ verdict: 'answered' }),
    (error) => error instanceof Error && !(error instanceof RepairableArtifactError),
    'an object carrying neither an answer nor plan/gate is silence, not a repairable artifact',
  );
  assert.throws(() => parsePlanProposal('   '), (error) => !(error instanceof RepairableArtifactError));
  assert.throws(() => parsePlanProposal({ verdict: 'answered', answer: '' }), (error) => !(error instanceof RepairableArtifactError));
  assert.throws(
    () => parsePlanProposal({ verdict: 'answered', answer: 'prose with no tags' }),
    RepairableArtifactError,
    'an artifact that ARRIVED but does not parse still goes back as feedback',
  );
  // The shapes the plan tier's own tests inject keep working, raw.
  assert.deepEqual(parsePlanProposal({ plan: 'PLAN', gate: [] }), { plan: 'PLAN\n', gate: [] });
  assert.deepEqual(
    parsePlanProposal({ verdict: 'answered', answer: '<PLAN_MD>PLAN</PLAN_MD><GATE_JSON>[]</GATE_JSON>' }),
    { plan: 'PLAN\n', gate: [] },
  );
});

test('a tier that renders its own proposal text drives previousProposal, the pivot, and FRESH', async () => {
  // The engine must never assume `proposal.plan`: a tier whose artifact is
  // {items, sections} says what its proposal READS AS, and that rendering is
  // what the next proposal, the pivot judgement, and a FRESH re-storm see.
  const draftContexts = [];
  const proposeContexts = [];
  const pivotRequests = [];
  const objecting = () => ({
    agree: false, readable: true, content: '', questions: [],
    suggestions: [{ id: 'S1', severity: 'P0', text: 'the same objection every round' }],
  });
  const seats = {
    draftCodex: async () => 'DRAFT',
    draftCursor: null,
    reviewCodex: async () => objecting(),
    reviewCursor: async () => objecting(),
    checkCapability: null,
    arbitrate: async (request) => {
      if (request?.type === 'propose') return { verdict: 'answered', answer: 'RAW ARTIFACT TEXT' };
      if (request?.type === 'agreement') return { verdict: 'answered', converged: false, reason: 'not yet', feedback: 'again' };
      if (request?.type === 'pivot') {
        pivotRequests.push(request);
        return { verdict: 'answered', decision: 'fresh', reason: 'the framing is dead' };
      }
      return { verdict: 'answered' };
    },
  };
  const strategy = {
    draftRequest: (ctx) => { draftContexts.push(ctx); return { codexInput: 'draft', cursorRequest: null, claudeRequest: null }; },
    parseDraft: (text) => ({ items: [], sections: new Map(), text }),
    proposeRequest: (ctx) => { proposeContexts.push(ctx); return { type: 'propose' }; },
    parseProposal: (response) => ({ items: [{ id: 'T1' }], sections: new Map([['T1', 'body']]), text: response.answer }),
    proposalText: () => 'CANON',
    reviewRequests: () => ({ codex: {}, cursor: {} }),
    agreementRequest: () => ({ type: 'agreement' }),
    capabilityPlanText: () => null,
    writeConverged: () => ({ written: true }),
  };
  const result = await runConversation({ runId: 'conv-canon', tier: 'goal', rounds: 4, seats, strategy });
  assert.equal(result.converged, false);
  assert.equal(proposeContexts[1].previousProposal, 'CANON',
    'the next proposal sees the tier rendering, not an undefined proposal.plan');
  assert.equal(pivotRequests[0].plan, 'CANON', 'the pivot judgement reads the tier rendering');
  assert.equal(draftContexts.at(-1).failedPlan, 'CANON',
    'a FRESH re-storm hands the seats the tier-rendered discarded proposal');
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

test('a markdown-emphasized stance is a stance; prose is still silence', () => {
  // Dogfood run 2 (2026-09-02): Cursor stated AGREE: no in every round and all
  // three were read as silence, because cursor-agent wraps the marker in
  // markdown emphasis. Tolerance lives in reading only — meaning stays strict.
  const emphasized = parseSeatReview('**AGREE: no**\nS1 P0: bound the reads');
  assert.equal(emphasized.readable, true);
  assert.equal(emphasized.agree, false);
  assert.equal(emphasized.suggestions[0].id, 'S1');
  assert.equal(parseSeatReview('**AGREE:** yes').agree, true);
  assert.equal(parseSeatReview('`AGREE: yes`').agree, true);
  assert.equal(parseSeatReview('AGREE: yes').agree, true, 'plain form keeps working');
  assert.equal(parseSeatReview('I broadly agree with these tasks').readable, false,
    'prose agreement is not a stance');
  assert.equal(parseSeatReview('').readable, false);

  // Verbatim from dogfood run 3's terminal record: cursor-agent glues its
  // narration to its answer with no separator, leaving the stance behind a
  // colon mid-string. Three rounds of real stances were read as silence.
  const glued = parseSeatReview(
    'Checking the live row template one more time:AGREE: no\nS3 P0: define the omission metric precisely',
  );
  assert.equal(glued.readable, true, 'a stance glued behind narration is still a stance');
  assert.equal(glued.agree, false);
  assert.equal(glued.suggestions[0].id, 'S3');
  assert.equal(parseSeatReview('DISAGREE: yes').readable, false,
    'DISAGREE must never read as AGREE');
  const echoed = parseSeatReview(
    'AGREE: no\nRecall the contract: AGREE: yes means you are satisfied these tasks achieve the goal.',
  );
  assert.equal(echoed.agree, false,
    'the contract\'s own "AGREE: yes means" echo is not a stance');
});

test('an unlaunchable capability probe is skipped — never a crash, never a veto', async () => {
  const { seats, strategy } = seatsFor({ proposals: ['GOOD'] });
  seats.checkCapability = async () => { throw new Error('spawn ENAMETOOLONG'); };
  const result = await runConversation({
    runId: 'conv-cap-crash', tier: 'goal', seats, strategy,
  });
  assert.equal(result.converged, true,
    'judged work must never be discarded because a probe could not launch');
  assert.deepEqual(result.capabilityVetoes, []);
});

test('an unreadable stance carries its raw text into the round history', async () => {
  // When the stance cannot be parsed, the parsed fields cannot represent the
  // response — the raw text is the only evidence of what the seat said, and
  // without it (dogfood run 2) the failure was undiagnosable after the fact.
  const { seats, strategy } = seatsFor({ proposals: ['GOOD'] });
  seats.reviewCursor = async () => 'Looks good overall, ship it';
  const result = await runConversation({
    runId: 'conv-unreadable-content', tier: 'goal', seats, strategy, rounds: 1,
  });
  assert.equal(result.converged, false);
  const cursorRow = result.roundHistory[0].reviews.cursor;
  assert.equal(cursorRow.readable, false);
  assert.equal(cursorRow.content, 'Looks good overall, ship it');
  assert.equal(result.roundHistory[0].reviews.codex.content, undefined,
    'a readable review stays parsed-only');
});
