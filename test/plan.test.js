import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runPlan as executePlan } from '../src/plan.js';

const VERIFIED_SUPERPOWERS = {
  ok: true,
  seats: {
    codex: { seat: 'codex', verified: true, evidence: 'registry', version: '6.3.0', path: null },
    cursor: { seat: 'cursor', verified: true, evidence: 'manifest', version: '6.0.2', path: 'C:/cursor-superpowers' },
    claude: { seat: 'claude', verified: true, evidence: 'manifest', version: '6.0.2', path: 'C:/claude-superpowers' },
  },
};

const planText = [
  '## Title', '', 'Plan test', '',
  '## Required behavior', '', 'Implement the goal.', '',
  '## Invariants', '', 'Keep compatibility.', '',
  '## Test requirements', '', '1. Exercise the behavior.', '',
  '## Out of scope', '', 'Unrelated work.', '',
].join('\n');

function fixture() {
  const directory = mkdtempSync(join(process.cwd(), '.ccc-test-plan-'));
  return {
    target: directory,
    out: join(directory, 'generated'),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

// Claude in one injectable seat: draft / propose / agreement / pivot are all
// arbiter request types, exactly as production routes them.
function makeArbiter(handlers = {}) {
  return async ({ request }) => {
    const handler = handlers[request.type];
    if (handler === undefined) return { verdict: 'UNVERIFIED' };
    return typeof handler === 'function' ? handler(request) : handler;
  };
}

const agreeingReview = () => 'AGREE: yes';

function seats({ arbiter = {}, codexReview, review, draft, cursorDraft } = {}) {
  return {
    verifySuperpowers: async () => VERIFIED_SUPERPOWERS,
    draft: draft ?? (async () => ({ plan: planText, gate: [] })),
    cursorDraft: cursorDraft ?? (async () => ({ plan: `${planText}cursor view\n`, gate: [] })),
    codexReview: codexReview ?? (async () => agreeingReview()),
    review: review ?? (async () => agreeingReview()),
    runArbiter: makeArbiter({
      draft: { plan: `${planText}claude view\n`, gate: [] },
      propose: { plan: planText, gate: [] },
      agreement: { converged: true, reason: 'all seats satisfied' },
      ...arbiter,
    }),
  };
}

const runPlan = (options) => executePlan({ ...options, adapters: { ...seats(), ...options.adapters } });

test('three seats storm, Claude proposes, both seats agree, Claude converges', async () => {
  const item = fixture();
  const events = [];
  const stormInputs = [];
  try {
    const result = await executePlan({
      goal: 'Implement the approved behavior',
      target: item.target,
      out: item.out,
      reporter: (event) => events.push(event),
      adapters: seats({
        draft: async (request) => {
          stormInputs.push(request.input);
          assert.equal(request.sandbox, 'read-only');
          return { plan: planText, gate: [] };
        },
      }),
    });
    assert.equal(result.converged, true);
    assert.equal(result.reason, 'converged');
    assert.equal(result.rounds, 1);
    assert.equal(readFileSync(result.planPath, 'utf8'), planText);
    assert.deepEqual(JSON.parse(readFileSync(result.gatePath, 'utf8')), []);
    // Every seat drafted from the RAW goal, not a paraphrase.
    assert.match(stormInputs[0], /Implement the approved behavior/);
    // arbiter/start+finish bracket each of Claude's judgements — the draft, the
    // proposal, and the agreement. That is the live transcript of the third seat.
    assert.deepEqual(events.map((event) => `${event.stage}/${event.type}`), [
      'plan/start',
      'arbiter/start', 'arbiter/finish',
      'plan/storm',
      'arbiter/start', 'arbiter/finish',
      'plan/proposal',
      'plan/review', 'plan/review',
      'arbiter/start', 'arbiter/finish',
      'plan/agreement',
      'plan/round',
      'plan/converged',
      'plan/finish',
    ]);
    assert.deepEqual(
      result.storm[0].drafts.map((draftRecord) => `${draftRecord.seat}:${draftRecord.ok}`),
      ['codex:true', 'cursor:true', 'claude:true'],
    );
  } finally { item.cleanup(); }
});

test('mutation control: convergence requires the codex seat to actually agree', async () => {
  const item = fixture();
  try {
    const result = await runPlan({
      goal: 'Needs all three', target: item.target, out: item.out, rounds: 1,
      adapters: seats({ codexReview: async () => 'AGREE: no\nS1 P1: unclear rollout' }),
    });
    assert.equal(result.converged, false,
      'codex withheld agreement, so two agreeing seats must not converge the plan');
    assert.equal(existsSync(join(item.out, 'plan.md')), false);
    assert.equal(result.roundHistory[0].reviews.codex.agree, false);
  } finally { item.cleanup(); }
});

test('mutation control: convergence requires the cursor seat to actually agree', async () => {
  const item = fixture();
  try {
    const result = await runPlan({
      goal: 'Needs all three', target: item.target, out: item.out, rounds: 1,
      adapters: seats({ review: async () => 'AGREE: no\nS1 P0: goal not achieved' }),
    });
    assert.equal(result.converged, false);
    assert.equal(existsSync(join(item.out, 'plan.md')), false);
  } finally { item.cleanup(); }
});

test('Claude is the final arbiter: both seats agreeing does not converge without it', async () => {
  const item = fixture();
  try {
    const result = await runPlan({
      goal: 'Claude still judges', target: item.target, out: item.out, rounds: 1,
      adapters: seats({
        arbiter: { agreement: { converged: false, reason: 'proposal drifts from the goal', feedback: 'realign with the goal' } },
      }),
    });
    assert.equal(result.converged, false);
    assert.equal(result.roundHistory[0].agreement.converged, false);
    assert.equal(result.roundHistory[0].agreement.reason, 'proposal drifts from the goal');
  } finally { item.cleanup(); }
});

test('silence is not consent: an unreadable agreement cannot converge the round', async () => {
  const item = fixture();
  try {
    const result = await runPlan({
      goal: 'No judged agreement', target: item.target, out: item.out, rounds: 1,
      adapters: seats({ arbiter: { agreement: { verdict: 'UNVERIFIED' } } }),
    });
    assert.equal(result.converged, false);
    assert.equal(result.roundHistory[0].agreement.verdict, 'UNVERIFIED');
  } finally { item.cleanup(); }
});

test('severities are carried verbatim and never filtered or validated', async () => {
  const item = fixture();
  let agreementRequest = null;
  try {
    const result = await runPlan({
      goal: 'Severity is input, not a rule', target: item.target, out: item.out, rounds: 1,
      adapters: seats({
        codexReview: async () => 'AGREE: yes\nS1 P0: risky migration\nS2 CRITICAL: made-up level',
        review: async () => 'AGREE: yes\nSx P2: naming nit',
        arbiter: {
          agreement: (request) => {
            agreementRequest = request;
            return { converged: true, reason: 'P0 noted and acceptable' };
          },
        },
      }),
    });
    // A P0 blocks nothing by rule: with all three agreeing, the plan converges.
    assert.equal(result.converged, true);
    // The made-up severity travels untouched to the arbiter and the facts.
    assert.deepEqual(
      agreementRequest.reviews.codex.suggestions.map((item2) => item2.severity),
      ['P0', 'CRITICAL'],
    );
    assert.deepEqual(
      result.roundHistory[0].reviews.codex.suggestions.map((item2) => `${item2.id} ${item2.severity}`),
      ['S1 P0', 'S2 CRITICAL'],
    );
    assert.equal(result.roundHistory[0].reviews.cursor.suggestions[0].severity, 'P2');
  } finally { item.cleanup(); }
});

test('every draft failing is storm-exhausted: inability, not a mechanical verdict', async () => {
  const item = fixture();
  try {
    const result = await runPlan({
      goal: 'Nothing drafted', target: item.target, out: item.out,
      adapters: seats({
        draft: async () => { throw new Error('codex draft failed'); },
        cursorDraft: async () => { throw new Error('cursor draft failed'); },
        arbiter: { draft: { verdict: 'UNVERIFIED' } },
      }),
    });
    assert.equal(result.converged, false);
    assert.equal(result.reason, 'storm-exhausted');
    assert.deepEqual(
      result.storm[0].drafts.map((draftRecord) => draftRecord.ok),
      [false, false, false],
    );
  } finally { item.cleanup(); }
});

test('a missing proposal ends the round as arbiter-unavailable, never a substitute rule', async () => {
  const item = fixture();
  try {
    const result = await runPlan({
      goal: 'No proposer', target: item.target, out: item.out,
      adapters: seats({ arbiter: { propose: { verdict: 'UNVERIFIED' } } }),
    });
    assert.equal(result.converged, false);
    assert.equal(result.reason, 'arbiter-unavailable');
    assert.equal(existsSync(join(item.out, 'plan.md')), false);
  } finally { item.cleanup(); }
});

test('a seat question reaches the next proposal instead of blocking or vanishing', async () => {
  const item = fixture();
  const proposeRequests = [];
  let cursorRound = 0;
  try {
    const result = await runPlan({
      goal: 'Ask then converge', target: item.target, out: item.out,
      adapters: seats({
        review: async () => {
          cursorRound++;
          return cursorRound === 1
            ? 'AGREE: no\nQ1: which store holds the sessions?'
            : agreeingReview();
        },
        arbiter: {
          propose: (request) => {
            proposeRequests.push(request);
            return { plan: planText, gate: [] };
          },
          agreement: (request) => ({
            converged: request.reviews.cursor.agree === true,
            reason: request.reviews.cursor.agree ? 'ready' : 'cursor still asking',
            feedback: 'answer the session-store question in the plan',
          }),
        },
      }),
    });
    assert.equal(result.converged, true);
    assert.equal(result.rounds, 2);
    assert.deepEqual(proposeRequests[1].questions, [
      { seat: 'cursor', id: 'Q1', text: 'which store holds the sessions?' },
    ]);
    assert.match(proposeRequests[1].feedback, /answer the session-store question/);
  } finally { item.cleanup(); }
});

test('seat suggestions reach the next proposal verbatim behind Claude feedback', async () => {
  const item = fixture();
  const proposeRequests = [];
  let round = 0;
  try {
    await runPlan({
      goal: 'Feedback carries the words', target: item.target, out: item.out, rounds: 2,
      adapters: seats({
        codexReview: async () => {
          round++;
          return round === 1 ? 'AGREE: no\nS7 P1: split the migration into two steps' : agreeingReview();
        },
        arbiter: {
          propose: (request) => { proposeRequests.push(request); return { plan: planText, gate: [] }; },
          agreement: { converged: false, reason: 'not yet', feedback: 'address the codex migration concern' },
        },
      }),
    });
    assert.match(proposeRequests[1].feedback, /address the codex migration concern/);
    assert.match(proposeRequests[1].feedback, /codex S7 P1: split the migration into two steps/);
  } finally { item.cleanup(); }
});

test('circling is measured, the pivot is judged, and FRESH re-storms all three seats', async () => {
  const item = fixture();
  let stormCount = 0;
  const pivotRequests = [];
  try {
    const result = await executePlan({
      goal: 'Recurring disagreement pivots', target: item.target, out: item.out, rounds: 4,
      adapters: seats({
        draft: async () => { stormCount++; return { plan: planText, gate: [] }; },
        codexReview: async () => 'AGREE: no\nS1 P0: same objection every round',
        arbiter: {
          agreement: { converged: false, reason: 'codex still objects', feedback: 'try again' },
          pivot: (request) => {
            pivotRequests.push(request);
            return { decision: 'fresh', reason: 'the framing is dead, restart' };
          },
        },
      }),
    });
    assert.equal(result.converged, false);
    // Three identical rounds of S1 is the deterministic evidence...
    assert.ok(pivotRequests.length >= 1, 'circling must reach the arbiter');
    // ...and the judged FRESH decision re-storms: codex drafted more than once.
    assert.ok(stormCount >= 2, `FRESH must re-storm the seats (drafted ${stormCount} times)`);
    assert.equal(result.pivotHistory[0].decision, 'fresh');
    assert.equal(result.pivotHistory[0].unjudged, false);
    assert.equal(result.pivotHistory[0].reason, 'the framing is dead, restart');
  } finally { item.cleanup(); }
});

test('a judged conclude ends the plan as pivot-conclude', async () => {
  const item = fixture();
  try {
    const result = await runPlan({
      goal: 'Concluded by judgement', target: item.target, out: item.out,
      adapters: seats({
        codexReview: async () => 'AGREE: no\nS1 P0: unresolvable here',
        arbiter: {
          agreement: { converged: false, reason: 'stuck' },
          pivot: { decision: 'conclude', reason: 'no framing survives this constraint' },
        },
      }),
    });
    assert.equal(result.converged, false);
    assert.equal(result.reason, 'pivot-conclude');
  } finally { item.cleanup(); }
});

test('an unjudged pivot falls back to the ladder and says so', async () => {
  const item = fixture();
  try {
    const result = await runPlan({
      goal: 'Ladder fallback', target: item.target, out: item.out, rounds: 5,
      adapters: seats({
        codexReview: async () => 'AGREE: no\nS1 P0: recurring',
        arbiter: {
          agreement: { converged: false, reason: 'stuck' },
          pivot: { verdict: 'UNVERIFIED' },
        },
      }),
    });
    assert.equal(result.converged, false);
    assert.ok(result.pivotHistory.length >= 1);
    assert.equal(result.pivotHistory[0].unjudged, true);
  } finally { item.cleanup(); }
});

test('round exhaustion reports rounds-exhausted and writes nothing', async () => {
  const item = fixture();
  try {
    const result = await runPlan({
      goal: 'Bounded rounds', target: item.target, out: item.out, rounds: 2,
      adapters: seats({ codexReview: async () => 'AGREE: no' }),
    });
    assert.equal(result.converged, false);
    assert.equal(result.reason, 'rounds-exhausted');
    assert.equal(result.rounds, 2);
    assert.equal(existsSync(join(item.out, 'plan.md')), false);
  } finally { item.cleanup(); }
});

test('a capability veto is unoverrulable and its remedy drives the next round', async () => {
  const item = fixture();
  const feedbackSeen = [];
  let vetoed = false;
  try {
    const result = await runPlan({
      goal: 'Veto loops with remedy', target: item.target, out: item.out,
      adapters: {
        ...seats({
          arbiter: {
            propose: (request) => {
              feedbackSeen.push(request.feedback ?? '');
              return { plan: planText, gate: [] };
            },
            agreement: { converged: true, reason: 'seats agree' },
          },
        }),
        checkCapability: async ({ seat }) => {
          if (seat === 'reviewer' && !vetoed) {
            vetoed = true;
            return { capable: false, what: 'cannot run the named harness', why: 'no binary', alternative: 'use node --test' };
          }
          return { capable: true };
        },
      },
    });
    assert.equal(result.converged, true);
    assert.equal(result.rounds, 2, 'the veto must consume a round and redraft');
    assert.equal(result.capabilityVetoes.length, 1);
    assert.match(feedbackSeen[1], /Capability veto remedies/);
    assert.match(feedbackSeen[1], /use node --test/);
  } finally { item.cleanup(); }
});

test('dry-run validates output without invoking any seat', async () => {
  const item = fixture();
  let touched = 0;
  try {
    const result = await executePlan({
      goal: 'Dry run only', target: item.target, out: item.out, dryRun: true,
      adapters: {
        verifySuperpowers: async () => VERIFIED_SUPERPOWERS,
        draft: async () => { touched++; return { plan: planText, gate: [] }; },
        runArbiter: async () => { touched++; return {}; },
      },
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.converged, false);
    assert.equal(touched, 0);
  } finally { item.cleanup(); }
});

test('plan refuses an unverified seat before invoking any agent', async () => {
  const item = fixture();
  let touched = 0;
  try {
    await assert.rejects(executePlan({
      goal: 'Refuse early', target: item.target, out: item.out,
      adapters: {
        verifySuperpowers: async () => ({
          ok: false,
          seats: {
            ...VERIFIED_SUPERPOWERS.seats,
            cursor: { seat: 'cursor', verified: false, evidence: 'missing manifest', version: null, path: null },
          },
        }),
        draft: async () => { touched++; return { plan: planText, gate: [] }; },
      },
    }), /superpowers preflight failed/);
    assert.equal(touched, 0);
  } finally { item.cleanup(); }
});

test('the verified Cursor directory and raw goal reach the cursor seats', async () => {
  const item = fixture();
  const cursorCalls = [];
  try {
    await runPlan({
      goal: 'Cursor gets the goal and the directory', target: item.target, out: item.out, rounds: 1,
      adapters: seats({
        review: async (request) => {
          cursorCalls.push(request);
          return agreeingReview();
        },
      }),
    });
    assert.equal(cursorCalls.length, 1);
    assert.equal(cursorCalls[0].superpowersDir, 'C:/cursor-superpowers');
    assert.equal(cursorCalls[0].goal, 'Cursor gets the goal and the directory');
    assert.equal(typeof cursorCalls[0].plan, 'string');
  } finally { item.cleanup(); }
});

test('a plan that never converges still reports what it spent', async () => {
  // R1 from the field: queue summaries printed "Total tokens: 0" after hours
  // of planning, because usage was only tallied on landed paths. The meter
  // runs whether or not you arrive.
  const usage = (inputTokens, outputTokens) => ({
    inputTokens, cachedInputTokens: 0, outputTokens, reasoningOutputTokens: 0, cacheWriteTokens: 0,
  });
  const item = fixture();
  try {
    const result = await runPlan({
      goal: 'Spend and fail honestly', target: item.target, out: item.out, rounds: 1,
      adapters: seats({
        draft: async () => ({ plan: planText, gate: [], usage: usage(1000, 50) }),
        cursorDraft: async () => ({ plan: planText, gate: [], usage: usage(600, 30) }),
        codexReview: async () => ({ agree: false, suggestions: [], questions: [], content: 'AGREE: no', usage: usage(200, 10) }),
        arbiter: {
          draft: { plan: planText, gate: [], usage: usage(400, 20) },
          propose: { plan: planText, gate: [], usage: usage(300, 15) },
          agreement: { converged: false, reason: 'codex declined', usage: usage(100, 5) },
        },
      }),
    });
    assert.equal(result.converged, false);
    assert.equal(result.tokens.total.inputTokens, 2600,
      'every seat call must be tallied: 1000+600+400+300+200+100');
    assert.equal(result.tokens.total.outputTokens, 130);
  } finally { item.cleanup(); }
});
