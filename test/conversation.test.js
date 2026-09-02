import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runConversation, RepairableArtifactError, CONVERSATION_DNA, parseSeatReview,
  stanceRepairLines, MAX_ARTIFACT_REPAIRS,
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
      // The tier's own wording of "your answer carried no stance"; the engine
      // owns the bound of exactly one re-ask per seat per round.
      reviewRepairRequest: ({ request, content }) => ({ ...request, repairContent: content }),
      agreementRequest: () => ({ type: 'agreement' }),
      capabilityPlanText: () => null,
      writeConverged: () => ({ written: true }),
    },
  };
};

test('a malformed proposal is fed back verbatim and repaired inside the same round — never a terminal', async () => {
  const { calls, seats, strategy } = seatsFor({ proposals: ['MALFORMED', 'GOOD'] });
  const proposeFeedback = [];
  const wrapped = { ...strategy, proposeRequest: (ctx) => { proposeFeedback.push(ctx.feedback ?? ''); return { type: 'propose' }; } };
  const result = await runConversation({ runId: 'conv-repair', tier: 'goal', seats, strategy: wrapped });
  assert.equal(result.converged, true);
  // F12 (dogfood run 6): this asserted `rounds === 2` while a repair burned a
  // round number for a retry in which no seat reviewed anything. A repair is
  // not deliberation, so the repaired proposal reuses the round it was asked in.
  assert.equal(result.rounds, 1, 'the repair and its retry are one round, not two');
  assert.match(proposeFeedback[1], /GOALS_JSON missing/, 'the parse error reaches the proposer verbatim');
  // The engine hands the parser the seat's response UNTOUCHED — no collapsing to
  // text on the way in, because only the tier can read its own artifact.
  assert.deepEqual(calls.rawProposals[0], { verdict: 'answered', answer: 'MALFORMED' },
    'the raw seat response reaches the tier parser, not a stringified shadow of it');
  // The repair row stays in the record and shares the round number with the
  // real round — that is the truthful account of what happened in round 1.
  assert.deepEqual(result.roundHistory.map((row) => row.round), [1, 1]);
  assert.equal(result.roundHistory[0].repair, 'GOALS_JSON missing');
});

test('a repair does not consume a deliberation round', async () => {
  // F12: with a one-round budget, a repair that ate round 1 left nothing for
  // the repaired proposal to be reviewed in, and the conversation ended
  // rounds-exhausted having never held a single round of deliberation.
  const { seats, strategy } = seatsFor({ proposals: ['BROKEN', 'GOOD'] });
  let parses = 0;
  strategy.parseProposal = (response) => {
    parses += 1;
    if (parses === 1) throw new RepairableArtifactError('missing tags');
    return { plan: response.answer };
  };
  const result = await runConversation({ runId: 'conv-repair-budget', tier: 'goal', seats, strategy, rounds: 1 });
  assert.equal(result.converged, true, 'one round budget survives one repair');
  assert.equal(result.rounds, 1, 'the repaired proposal is still round 1');
});

test('the fifth repair is still fed back — the bound is five, not four', async () => {
  const { seats, strategy } = seatsFor({ proposals: ['BROKEN'] });
  let parses = 0;
  strategy.parseProposal = (response) => {
    parses += 1;
    if (parses <= MAX_ARTIFACT_REPAIRS) throw new RepairableArtifactError(`broken ${parses}`);
    return { plan: response.answer };
  };
  const result = await runConversation({ runId: 'conv-repair-fifth', tier: 'goal', seats, strategy, rounds: 1 });
  assert.equal(MAX_ARTIFACT_REPAIRS, 5);
  assert.equal(result.converged, true, 'exhausting the budget exactly still converges');
  assert.equal(parses, MAX_ARTIFACT_REPAIRS + 1, 'five repairs, then the answered retry');
  assert.equal(result.rounds, 1, 'none of the five repairs advanced the round');
});

test('repairs are bounded: the sixth ends the conversation as proposal-irreparable', async () => {
  const { seats, strategy } = seatsFor({ proposals: ['BROKEN'] });
  let parses = 0;
  strategy.parseProposal = () => { parses += 1; throw new RepairableArtifactError('always broken'); };
  let written = false;
  strategy.writeConverged = () => { written = true; return { written: true }; };
  const result = await runConversation({ runId: 'conv-repair-cap', tier: 'goal', seats, strategy, rounds: 3 });
  assert.equal(result.converged, false);
  assert.equal(result.reason, 'proposal-irreparable');
  assert.equal(parses, MAX_ARTIFACT_REPAIRS + 1, 'the sixth malformed artifact ends it');
  assert.equal(written, false, 'nothing is written when the artifact never became readable');
  // No silent cap: every repair the bound withheld is still in the record,
  // including the sixth that ended the conversation.
  assert.equal(result.roundHistory.length, MAX_ARTIFACT_REPAIRS + 1);
  assert.equal(result.roundHistory.at(-1).repair, 'always broken');
  assert.equal(result.rounds, 1, 'a repair loop never advances the round it is stuck in');
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

test('the agreement judge is told a stance was unreadable, with the raw text', async () => {
  // Every dogfood run's judge was told "Both seats say AGREE: no" when one seat's
  // stance was in fact UNREADABLE. The request never carried the difference, so
  // the judge could not weigh a measurement failure as anything but a refusal.
  const { seats, strategy } = seatsFor({ proposals: ['GOOD'] });
  seats.reviewCursor = async () => 'Looks great, ship it';
  let seen;
  strategy.agreementRequest = (ctx) => { seen = ctx; return { type: 'agreement' }; };
  await runConversation({ runId: 'conv-agreement-context', tier: 'goal', seats, strategy, rounds: 1 });
  assert.equal(seen.reviews.cursor.readable, false);
  assert.match(seen.reviews.cursor.content, /Looks great/);
  assert.equal(seen.reviews.codex.readable, true);
});

test('the round event carries each seat STATE, never a collapsed boolean', async () => {
  // Peer-observed at 63c788f: an unreadable stance printed as `cursor=disagree`,
  // collapsing a measurement failure into a judgement on the merits.
  const { seats, strategy } = seatsFor({ proposals: ['GOOD'] });
  seats.reviewCodex = async () => 'AGREE: no\nS1 P0: split it';
  seats.reviewCursor = async () => 'Looks great, ship it';
  const events = [];
  await runConversation({
    runId: 'conv-round-states', tier: 'goal', seats, strategy, rounds: 1,
    reporter: (event) => events.push(event),
  });
  const roundEvent = events.find((event) => event.stage === 'plan' && event.type === 'round');
  assert.equal(roundEvent.codexState, 'disagree');
  assert.equal(roundEvent.cursorState, 'stance-unreadable');
  assert.equal(roundEvent.cursorAgrees, false, 'the boolean stays for compatibility');

  const absent = seatsFor({ proposals: ['GOOD'] });
  absent.seats.reviewCursor = null;
  const absentEvents = [];
  await runConversation({
    runId: 'conv-round-absent', tier: 'goal', seats: absent.seats, strategy: absent.strategy, rounds: 1,
    reporter: (event) => absentEvents.push(event),
  });
  assert.equal(
    absentEvents.find((event) => event.stage === 'plan' && event.type === 'round').cursorState,
    'unavailable',
    'a seat that never ran is absent, not a disagreement',
  );
});

test('an unjudged agreement keeps the raw answer for diagnosis', async () => {
  // Dogfood run 3, round 3: the agreement came back ANSWERED-but-unparseable and
  // the answer was dropped on the floor, leaving nothing to diagnose. A parsed
  // judgement that says UNVERIFIED cannot represent what the seat actually said,
  // so exactly then the raw text travels — verbatim, untrimmed.
  const { seats, strategy } = seatsFor({ proposals: ['GOOD'], agrees: true });
  seats.arbitrate = async (request) => {
    if (request.type === 'propose') return { verdict: 'answered', answer: 'GOOD' };
    if (request.type === 'agreement') return { verdict: 'answered', answer: 'prose that fails the agreement parse' };
    return { verdict: 'answered' };
  };
  const result = await runConversation({ runId: 'conv-unjudged-raw', tier: 'goal', seats, strategy, rounds: 1 });
  assert.equal(result.converged, false);
  const agreement = result.roundHistory[0].agreement;
  assert.notEqual(agreement.verdict, 'answered');
  assert.equal(agreement.raw, 'prose that fails the agreement parse');
});

test('a judged agreement carries no raw text — the parsed judgement IS the answer', async () => {
  const { seats, strategy } = seatsFor({ proposals: ['GOOD'] });
  const result = await runConversation({ runId: 'conv-judged-no-raw', tier: 'goal', seats, strategy, rounds: 1 });
  assert.equal(result.converged, true);
  assert.equal(result.roundHistory[0].agreement.raw, undefined);
});

test('an unjudged pivot keeps the raw answer for diagnosis', async () => {
  // Same law one judgement over: when the pivot decision cannot be read, the
  // engine falls back to its own bounded ladder — and the answer that could not
  // be read is the only evidence of why.
  const objecting = () => ({
    agree: false, readable: true, content: '', questions: [],
    suggestions: [{ id: 'S1', severity: 'P0', text: 'the same objection every round' }],
  });
  const { seats, strategy } = seatsFor({ proposals: ['GOOD'] });
  seats.reviewCodex = objecting;
  seats.reviewCursor = objecting;
  seats.arbitrate = async (request) => {
    if (request.type === 'propose') return { verdict: 'answered', answer: 'GOOD' };
    if (request.type === 'agreement') return { verdict: 'answered', converged: false, reason: 'not yet', feedback: 'again' };
    if (request.type === 'pivot') return { verdict: 'answered', answer: 'I would keep going, honestly' };
    return { verdict: 'answered' };
  };
  const result = await runConversation({ runId: 'conv-pivot-raw', tier: 'goal', seats, strategy, rounds: 3 });
  assert.equal(result.converged, false);
  assert.equal(result.pivotHistory[0].unjudged, true);
  assert.equal(result.pivotHistory[0].raw, 'I would keep going, honestly');
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

test('an unreadable stance is re-asked once with the failure fed back', async () => {
  // F20, live at 63c788f: the seat promised "the required AGREE/S/Q block",
  // never emitted it, and its genuine verified review was discarded as a
  // content-free disagreement. The seat RAN and answered; the answer just does
  // not parse — so the proposal-repair law applies and the text goes back to it.
  const { seats, strategy } = seatsFor({ proposals: ['GOOD'] });
  let asks = 0;
  const promise = 'User-facing response is only the AGREE / S* / Q* block.';
  seats.reviewCursor = async (request) => {
    asks += 1;
    if (asks === 1) return promise; // promises, never delivers
    assert.match(String(request.repairContent ?? request.prompt ?? ''), /did not contain a parseable stance|AGREE/);
    assert.equal(request.repairContent, promise,
      'the unparseable answer goes back verbatim, not summarized');
    return 'AGREE: yes';
  };
  const result = await runConversation({ runId: 'conv-stance-reask', tier: 'goal', seats, strategy, rounds: 1 });
  assert.equal(asks, 2);
  assert.equal(result.converged, true, 'the repaired stance counts');
  assert.equal(result.roundHistory[0].reviews.cursor.stanceRepaired, true,
    'the record says the reading was repaired, never that the seat changed its mind');
});

test('a second unreadable answer travels as stance-unreadable with raw content', async () => {
  const { seats, strategy } = seatsFor({ proposals: ['GOOD'] });
  let asks = 0;
  seats.reviewCursor = async () => { asks += 1; return 'still no block here'; };
  const result = await runConversation({ runId: 'conv-stance-still-dead', tier: 'goal', seats, strategy, rounds: 1 });
  assert.equal(result.converged, false);
  assert.equal(result.roundHistory[0].reviews.cursor.readable, false);
  assert.match(result.roundHistory[0].reviews.cursor.content, /still no block/);
  // The bound in the audit table: exactly one re-ask per seat per round. A
  // second failure is not re-asked again — reading is repaired once, meaning
  // never, and a still-unreadable stance stays non-consenting.
  assert.equal(asks, 2);
  assert.equal(result.roundHistory[0].reviews.cursor.stanceRepaired, undefined);
  assert.equal(result.roundHistory[0].reviews.cursor.stanceReasked, true);
});

test('a repaired stance keeps the answer it repaired — the first words are not deleted', async () => {
  // F20's whole lesson is that the first answer is where the genuine review
  // lives. A FAILED re-ask kept both answers; a SUCCESSFUL one must not throw
  // the original prose away just because the second answer finally parses.
  const { seats, strategy } = seatsFor({ proposals: ['GOOD'] });
  const first = 'Verified the cited seams; composing T9 without T4 is the structural gap.';
  let asks = 0;
  seats.reviewCursor = async () => (++asks === 1 ? first : 'AGREE: yes\nS1 P1: name the gap');
  const result = await runConversation({ runId: 'conv-stance-prior', tier: 'goal', seats, strategy, rounds: 1 });
  assert.equal(result.converged, true);
  const cursorRow = result.roundHistory[0].reviews.cursor;
  assert.equal(cursorRow.readable, true);
  assert.equal(cursorRow.stanceRepaired, true);
  assert.equal(cursorRow.priorContent, first,
    'the pre-repair answer travels verbatim beside the repaired one');
  assert.deepEqual(cursorRow.suggestions.map((item) => item.id), ['S1']);
});

test('a repair hook that throws is not recorded as a re-ask that happened', async () => {
  const { seats, strategy } = seatsFor({ proposals: ['GOOD'] });
  let asks = 0;
  seats.reviewCursor = async () => { asks += 1; return 'no stance in this prose'; };
  strategy.reviewRepairRequest = () => { throw new Error('the tier could not build a repair request'); };
  const result = await runConversation({ runId: 'conv-stance-hook-threw', tier: 'goal', seats, strategy, rounds: 1 });
  assert.equal(asks, 1, 'no second call was made');
  const cursorRow = result.roundHistory[0].reviews.cursor;
  assert.equal(cursorRow.stanceReasked, undefined,
    'a check that did not run must never read as one that ran and failed');
  assert.equal(cursorRow.content, 'no stance in this prose');
});

test('an empty answer is not re-asked — there is nothing to feed back', async () => {
  const { seats, strategy } = seatsFor({ proposals: ['GOOD'] });
  let asks = 0;
  const seen = [];
  seats.reviewCursor = async (request) => { asks += 1; seen.push(request); return ''; };
  const result = await runConversation({ runId: 'conv-stance-empty', tier: 'goal', seats, strategy, rounds: 1 });
  assert.equal(asks, 1,
    'a re-ask with no text to feed back is byte-identical to the first: a seat call spent to learn nothing');
  const cursorRow = result.roundHistory[0].reviews.cursor;
  assert.equal(cursorRow.readable, false);
  assert.equal(cursorRow.content, '');
  assert.equal(cursorRow.stanceReasked, undefined);
  assert.equal(result.converged, false, 'silence is still not consent');
});

test('the re-ask is bounded per round, not per conversation', async () => {
  const { seats, strategy } = seatsFor({ proposals: ['GOOD', 'GOOD'] });
  let asks = 0;
  seats.reviewCursor = async () => { asks += 1; return 'no stance in here either'; };
  await runConversation({ runId: 'conv-stance-per-round', tier: 'goal', seats, strategy, rounds: 2 });
  assert.equal(asks, 4, 'each round gets its own single re-ask');
});

test('a seat that never ran is never re-asked — there is no reading to repair', async () => {
  const { seats, strategy } = seatsFor({ proposals: ['GOOD'] });
  let asks = 0;
  seats.reviewCursor = async () => { asks += 1; throw new Error('cursor seat failed to launch'); };
  const result = await runConversation({ runId: 'conv-stance-absent', tier: 'goal', seats, strategy, rounds: 1 });
  assert.equal(asks, 1, 'refusal is reserved for a seat that did not run; nothing to feed back');
  assert.equal(result.roundHistory[0].reviews.cursor.unavailable, true);
  assert.equal(result.roundHistory[0].reviews.cursor.stanceReasked, undefined);
});

test('a re-ask that keeps different words retains both answers verbatim', async () => {
  const { seats, strategy } = seatsFor({ proposals: ['GOOD'] });
  let asks = 0;
  seats.reviewCursor = async () => (++asks === 1 ? 'first prose, with the real review' : 'second prose, still no stance');
  const result = await runConversation({ runId: 'conv-stance-both', tier: 'goal', seats, strategy, rounds: 1 });
  const cursorRow = result.roundHistory[0].reviews.cursor;
  assert.equal(cursorRow.content, 'first prose, with the real review');
  assert.equal(cursorRow.reaskContent, 'second prose, still no stance',
    'a bound states what it withheld: the second answer is evidence too');
});

test('the F20 seat answer is absence, not a parseable stance variant', () => {
  // Verbatim from the peer run at 63c788f (G-NIW1 round 2): meta-commentary
  // about the required block, block never emitted — including the missing
  // sentence boundary and the U+FFFD where an em dash was. Tolerance lives in
  // READING, so this shape must keep reading as no-stance: it is the exact
  // input the bounded re-ask exists to answer, and a parser that "helpfully"
  // found consent in it would consent on the seat's behalf.
  const f20 = [
    'Reading the goal spec, proposed tasks, and repo map to independently review this decomposition.Verifying cited seams and whether the decomposition covers the goal without gaps.Verified the cited seams (`_multi_table_sql_failure` mask, AST drop at `8256-8265`, `policy_metadata` omitting `candidate_origin`, `graph.py` forced `break` + stale `exact_compute_clarification` final override, `MODEL_ERROR_LIMIT=512` on `row["error"]`). The decomposition covers the goal; composing T9 without T4 is the main structural gap.',
    '# Seat review only',
    '',
    'Round-2 goal-decomposition review seat output only \uFFFD no implementation. Final user-visible answer is the required AGREE/S/Q block.',
    '',
    '# Round 2 decomposition review (seat output)',
    '',
    'This seat does not implement code. Independent review of [PROPOSED_TASKS.md](C:\\Users\\aiuser4\\AppData\\Local\\Temp\\uro-plan-seat-h9Az3L\\PROPOSED_TASKS.md) against [GOAL_SPEC.md](C:\\Users\\aiuser4\\AppData\\Local\\Temp\\uro-plan-seat-h9Az3L\\GOAL_SPEC.md).',
    '',
    'Evidence checked: `_multi_table_sql_failure` regex mask; AST rejection return; `policy_metadata` without `candidate_origin`; `graph.py` post-failure `break` and final `exact_compute_clarification` override; `MODEL_ERROR_LIMIT=512` on `row["error"]` vs `ERROR_CHARS=1500` in `react_context`.',
    '',
    'User-facing response for this seat is only the AGREE / S* / Q* block required by INSTRUCTIONS.md.',
  ].join('\n');
  const review = parseSeatReview(f20);
  assert.equal(review.readable, false, 'a promise of the block is not the block');
  assert.equal(review.agree, false, 'silence is never consent');
  assert.equal(review.content, f20, 'the whole answer is retained, untrimmed');
});

test('the required-structure instruction echoed back is not a stance', () => {
  // The repair paragraph and every review contract carry the literal
  // "AGREE: yes or AGREE: no". A seat prone to meta-commentary quotes the
  // instruction back instead of answering it — and under last-stance-wins that
  // echo used to land as a REAL disagreement. Reading is tolerant; it must not
  // invent a stance the seat never took.
  const echoed = parseSeatReview(
    'Understood. I will respond again in EXACTLY the required structure: AGREE: yes or AGREE: no, then the S<id> lines.',
  );
  assert.equal(echoed.readable, false, 'quoting the instruction is not answering it');
  assert.equal(echoed.agree, false, 'and it is never consent');
  assert.equal(parseSeatReview(stanceRepairLines('nothing parseable here').join('\n')).readable, false,
    'the repair paragraph itself carries no stance a seat could be credited with');

  // A real stance stated beside the echo still wins.
  const both = parseSeatReview('AGREE: yes\nThe instruction said: AGREE: yes or AGREE: no.');
  assert.equal(both.readable, true);
  assert.equal(both.agree, true);
  const objecting = parseSeatReview('The structure is AGREE: yes or AGREE: no.\nAGREE: no\nS1 P0: unresolved');
  assert.equal(objecting.readable, true);
  assert.equal(objecting.agree, false, 'a stated refusal after the echo is still a refusal');
});

test('the stance repair paragraph feeds the failure back and never re-asks for meaning', () => {
  const lines = stanceRepairLines('AGREE line? I simply never wrote one.');
  const text = lines.join('\n');
  assert.match(text, /did not contain a parseable stance/);
  assert.ok(text.includes('AGREE line? I simply never wrote one.'), 'verbatim, untrimmed');
  assert.match(text, /AGREE: yes or AGREE: no/);
  assert.match(text, /does not ask you to change what you judged/);
});
