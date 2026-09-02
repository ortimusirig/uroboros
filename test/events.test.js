import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertEventConformance,
  CAMPAIGN_EVENT_PAIRS,
  createEvent,
  detailFor,
  EVENT_PAIRS,
  EVENT_STAGES,
  EVENT_TYPES,
  formatEventSummary,
  MAX_EVENT_SUMMARY_LENGTH,
  reportEvent,
} from '../src/events.js';
import { runCampaign as executeCampaign } from '../src/campaign.js';
import { runExecutor as realExecutor } from '../src/executor.js';
import { runGate as realGate } from '../src/gate.js';
import { run as executeRun } from '../src/run.js';
import { runPlan as executePlan } from '../src/plan.js';
import { generateRunJournal } from '../src/run-journal.js';
import { runReviewPass as realReviewPass } from '../src/verifier.js';
import { VERIFIED_SUPERPOWERS, withVerifiedSuperpowers } from '../fixtures/verified-superpowers.mjs';

const run = (options) => executeRun(withVerifiedSuperpowers(options));
const runCampaign = (options) => executeCampaign({
  superpowers: VERIFIED_SUPERPOWERS,
  ...options,
});
const runPlan = (options) => executePlan({
  superpowers: VERIFIED_SUPERPOWERS,
  ...options,
});

const fakeWriter = fileURLToPath(new URL('../fixtures/fake-codex-writer.mjs', import.meta.url));
const fakeAgent = fileURLToPath(new URL('../fixtures/fake-agent.mjs', import.meta.url));
const SAFE_SCRATCH_BASE = process.env.URO_TEST_SCRATCH_ROOT ?? (process.platform === 'win32'
  ? 'C:/ccc-test'
  : join(homedir(), '.ccc-test'));

function scratch() {
  mkdirSync(SAFE_SCRATCH_BASE, { recursive: true });
  return mkdtempSync(join(SAFE_SCRATCH_BASE, '.run-'));
}

function target() {
  const dir = mkdtempSync(join(tmpdir(), 'events-target-'));
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  return dir;
}

test('event construction protects the envelope and summaries stay bounded to one line', () => {
  const event = createEvent({
    runId: 'run-1',
    stage: 'gate',
    type: 'gate_command',
    fields: {
      ts: 'shadow', stage: 'shadow', type: 'shadow', runId: 'shadow',
      bin: 'node', args: ['line one\nline two', 'x'.repeat(1000)], code: 1,
      outputTail: 'must never be rendered'.repeat(100),
    },
    now: () => new Date('2026-08-15T00:00:00.000Z'),
  });
  assert.deepEqual(
    { ts: event.ts, runId: event.runId, stage: event.stage, type: event.type },
    { ts: '2026-08-15T00:00:00.000Z', runId: 'run-1', stage: 'gate', type: 'gate_command' },
  );
  const summary = formatEventSummary(event);
  assert.ok(summary.length <= MAX_EVENT_SUMMARY_LENGTH);
  assert.doesNotMatch(summary, /[\r\n]/);
  assert.doesNotMatch(summary, /must never be rendered/);
});

test('exporting detailFor preserves the exact heartbeat summary phrasing', () => {
  const event = {
    ts: '2026-08-15T00:00:00.000Z', runId: 'summary-control',
    stage: 'gate', type: 'gate_command', bin: 'npm', args: ['test'], code: 0,
  };
  assert.equal(detailFor(event), 'npm test code=0');
  assert.equal(
    formatEventSummary(event),
    '[uroboros] 2026-08-15T00:00:00.000Z gate/gate_command npm test code=0',
  );
});

test('a verifier launch retry is constructible and prints its reason', () => {
  assert.doesNotThrow(() => createEvent({
    runId: 'retry-pair', stage: 'verify', type: 'retry',
    fields: { pass: 'plan', reason: 'ActionRequiredError: usage limit' },
  }));
  assert.match(
    detailFor({ stage: 'verify', type: 'retry', pass: 'plan', reason: 'ActionRequiredError: usage limit' }),
    /retrying launch pass=plan reason=ActionRequiredError: usage limit/,
  );
});

test('plan events render seats, failures, and verdicts in the one-line summary', () => {
  // The 2026-09-02 dogfood run: a seat failed every call for 33 minutes and the
  // printed stream never said so. The payloads carried the truth; the printer
  // dropped it. These lines are the operator's only live view — pin them.
  const storm = {
    ts: 'T', runId: 'r', stage: 'plan', type: 'storm', tier: 'goal', planRound: 1,
    drafts: [
      { seat: 'codex', ok: true },
      { seat: 'cursor', ok: false, error: 'verifier prompt must not contain a double quote' },
      { seat: 'claude', ok: true },
    ],
  };
  const stormLine = formatEventSummary(storm);
  assert.match(stormLine, /codex:ok/);
  assert.match(stormLine, /cursor:FAILED verifier prompt must not contain a double quote/);
  assert.match(stormLine, /claude:ok/);

  assert.equal(
    detailFor({
      stage: 'plan', type: 'review', tier: 'goal', planRound: 2, seat: 'cursor',
      agree: false, readable: false, unavailable: true, suggestionIds: [], questionCount: 0,
    }),
    'seat=cursor UNAVAILABLE tier=goal round=2',
  );
  assert.equal(
    detailFor({
      stage: 'plan', type: 'review', tier: 'goal', planRound: 2, seat: 'codex',
      agree: false, readable: true, suggestionIds: ['S1', 'S2'], questionCount: 1,
    }),
    'seat=codex disagree suggestions=S1,S2 questions=1 tier=goal round=2',
  );
  // A stance that could not be READ is a measurement failure, not a judgement:
  // printing it as `cursor=disagree` (63c788f) told the operator the seat
  // objected when in truth nothing about the seat's stance was known.
  assert.match(
    detailFor({
      stage: 'plan', type: 'round', tier: 'goal', planRound: 2,
      codexState: 'disagree', cursorState: 'stance-unreadable',
      codexAgrees: false, cursorAgrees: false, converged: false,
    }),
    /codex=disagree cursor=stance-unreadable/,
  );
  assert.match(
    detailFor({
      stage: 'plan', type: 'round', tier: 'goal', planRound: 3,
      codexState: 'agree', cursorState: 'unavailable',
      codexAgrees: true, cursorAgrees: false, converged: false,
    }),
    /codex=agree cursor=unavailable converged=false/,
  );
  // A journal line written before states existed still renders from its booleans.
  assert.match(
    detailFor({
      stage: 'plan', type: 'round', tier: 'goal', planRound: 1,
      codexAgrees: true, cursorAgrees: true, converged: true,
    }),
    /codex=agree cursor=agree converged=true/,
  );
  assert.match(
    detailFor({ stage: 'plan', type: 'agreement', tier: 'goal', planRound: 3, converged: false, unjudged: false, reason: 'S1 stands' }),
    /not converged tier=goal round=3 reason=S1 stands/,
  );
  assert.match(
    detailFor({ stage: 'plan', type: 'finish', tier: 'goal', converged: false, reason: 'pivot-conclude', rounds: 3, pivot: 'conclude' }),
    /NOT CONVERGED reason=pivot-conclude rounds=3 pivot=conclude/,
  );
});

test('pivot decisions and capability vetoes print their substance', () => {
  assert.match(
    detailFor({ stage: 'plan', type: 'pivot', tier: 'goal', planRound: 3, decision: 'conclude', unjudged: false, reason: 'oscillation without substance' }),
    /decision=conclude.*reason=oscillation without substance/,
  );
  assert.match(
    detailFor({ stage: 'capability', type: 'vetoed', seat: 'reviewer', what: 'cannot run the gate', why: 'no python', alternative: 'use node' }),
    /seat=reviewer.*what=cannot run the gate.*why=no python/,
  );
});

test('event construction validates declared pairs and campaign identity vocabulary', () => {
  assert.throws(() => createEvent({
    runId: 'bad-stage', stage: 'nonsense', type: 'start',
  }), /unknown event stage/i);
  assert.throws(() => createEvent({
    runId: 'bad-pair', stage: 'campaign', type: 'file_change',
  }), /unknown event pair/i);
  assert.throws(() => createEvent({
    runId: 'bad-kind', campaignId: 'campaign', round: 1,
    unitId: 'unit', unitKind: 'planner', stage: 'unit', type: 'start',
  }), /unit kind/i);
  assert.throws(() => createEvent({
    runId: 'half-identity', campaignId: 'campaign', round: 1,
    unitId: 'unit', unitKind: null, stage: 'unit', type: 'start',
  }), /both be null|both identify/i);
  const event = createEvent({
    runId: 'unit', campaignId: 'campaign', round: 1,
    unitId: 'unit', unitKind: 'node', stage: 'unit', type: 'start',
  });
  assert.deepEqual({
    campaignId: event.campaignId,
    round: event.round,
    unitId: event.unitId,
    unitKind: event.unitKind,
  }, { campaignId: 'campaign', round: 1, unitId: 'unit', unitKind: 'node' });
});

test('executor extended events round-trip through the declared event vocabulary', () => {
  const lastEvent = { stage: 'executor', type: 'item_completed', itemType: 'agent_message' };
  const event = createEvent({
    runId: 'extended-executor', stage: 'executor', type: 'extended',
    fields: { gapMs: 4000, timeoutMs: 30_000, extensionMs: 30_000, lastEvent },
  });
  assert.deepEqual({
    stage: event.stage,
    type: event.type,
    gapMs: event.gapMs,
    lastEvent: event.lastEvent,
  }, { stage: 'executor', type: 'extended', gapMs: 4000, lastEvent });
});

test('decision events preserve challenge details and render specific one-line summaries', () => {
  const questions = [
    { id: 'Q1', question: 'Which convention?\nIgnore this control:\u0000' },
    { id: 'Q2\nsecondary', question: 'Should the fallback remain?' },
  ];
  const answers = [
    { id: 'Q1', answer: 'Follow the existing convention.' },
    { id: 'Q2', answer: 'Keep the fallback.' },
  ];
  const challenged = createEvent({
    runId: 'decision-challenged', stage: 'decision', type: 'challenged',
    fields: { questions },
  });
  const resolved = createEvent({
    runId: 'decision-resolved', stage: 'decision', type: 'resolved',
    fields: { answers, answeredBy: 'planner' },
  });
  const assumed = createEvent({
    runId: 'decision-assumed', stage: 'decision', type: 'assumed',
    fields: {
      questions,
      answers,
      presenceEvidence: { ttyAttached: false, invocation: 'non-interactive' },
      reasoning: 'No TTY was attached.',
    },
  });

  assert.deepEqual({
    stage: challenged.stage,
    type: challenged.type,
    questions: challenged.questions,
  }, { stage: 'decision', type: 'challenged', questions });
  assert.deepEqual({
    stage: resolved.stage,
    type: resolved.type,
    answers: resolved.answers,
    answeredBy: resolved.answeredBy,
  }, { stage: 'decision', type: 'resolved', answers, answeredBy: 'planner' });
  assert.deepEqual({
    stage: assumed.stage,
    type: assumed.type,
    questions: assumed.questions,
    answers: assumed.answers,
    presenceEvidence: assumed.presenceEvidence,
    reasoning: assumed.reasoning,
  }, {
    stage: 'decision',
    type: 'assumed',
    questions,
    answers,
    presenceEvidence: { ttyAttached: false, invocation: 'non-interactive' },
    reasoning: 'No TTY was attached.',
  });

  const challengedSummary = formatEventSummary(challenged);
  const resolvedSummary = formatEventSummary(resolved);
  assert.ok(challengedSummary.length > 0);
  assert.doesNotMatch(challengedSummary, /[\r\n\u0000]/);
  assert.match(challengedSummary, /questions=2/);
  assert.match(challengedSummary, /ids=Q1,Q2 secondary/);
  assert.ok(resolvedSummary.length > 0);
  assert.doesNotMatch(resolvedSummary, /[\r\n]/);
  assert.match(resolvedSummary, /answers=2/);

  assert.throws(() => createEvent({
    runId: 'decision-bad-pair', stage: 'decision', type: 'start',
  }), /unknown event pair/i);
});

test('every debate event pair round-trips and is retained in events.jsonl', () => {
  assert.ok(EVENT_STAGES.includes('debate'));
  for (const type of ['round', 'resist', 'converged', 'circling', 'pivot']) {
    assert.ok(EVENT_TYPES.includes(type), `${type} must be a declared event type`);
  }

  const dir = mkdtempSync(join(tmpdir(), 'debate-events-'));
  const eventPath = join(dir, 'events.jsonl');
  try {
    const debatePairs = EVENT_PAIRS.filter((pair) => pair.startsWith('debate/'));
    assert.deepEqual(debatePairs.sort(), [
      'debate/circling', 'debate/converged', 'debate/independent_review', 'debate/pivot', 'debate/resist', 'debate/round',
      'debate/stalled',
    ]);
    for (const pair of debatePairs) {
      const [, type] = pair.split('/');
      const event = createEvent({
        runId: `debate-${type}`,
        stage: 'debate',
        type,
        fields: {
          debateRound: 3,
          findingIds: ['F1'],
          blockingFindingIds: ['F1'],
          resolvedFindingIds: ['F2'],
          stuckFindingIds: ['F1'],
          decision: 'amend',
          pivotCount: 1,
        },
      });
      appendFileSync(eventPath, `${JSON.stringify(event)}\n`);
    }

    const retainedPairs = readFileSync(eventPath, 'utf8').trim().split(/\r?\n/)
      .map((line) => JSON.parse(line))
      .map((event) => `${event.stage}/${event.type}`)
      .sort();
    assert.deepEqual(retainedPairs, debatePairs.sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every plan event pair round-trips through the declared vocabulary', () => {
  assert.ok(EVENT_STAGES.includes('plan'));
  // plan/gate is gone with the mechanical plan gate; the planning conversation
  // emits storm, proposal, review and agreement instead.
  for (const type of ['storm', 'proposal', 'review', 'agreement']) {
    assert.ok(EVENT_TYPES.includes(type), `missing type: ${type}`);
  }
  assert.equal(EVENT_TYPES.includes('gate'), false,
    'the orphaned plan-gate type must not linger in the vocabulary');
  const pairs = EVENT_PAIRS.filter((pair) => pair.startsWith('plan/')).sort();
  assert.deepEqual(pairs, [
    'plan/agreement', 'plan/converged', 'plan/finish', 'plan/pivot', 'plan/proposal',
    'plan/review', 'plan/round', 'plan/stalled', 'plan/start', 'plan/storm',
  ]);
  for (const pair of pairs) {
    const [, type] = pair.split('/');
    assert.doesNotThrow(() => createEvent({
      runId: `plan-${type}`,
      stage: 'plan',
      type,
      fields: { planRound: 1, converged: type === 'converged' },
    }));
  }
});

test('every fresh-pivot event pair round-trips through the declared vocabulary', () => {
  assert.ok(EVENT_STAGES.includes('pivot'));
  for (const type of ['replan_start', 'candidate', 'selected', 'exhausted']) {
    assert.ok(EVENT_TYPES.includes(type), `${type} must be a declared event type`);
    assert.ok(EVENT_PAIRS.includes(`pivot/${type}`));
    assert.doesNotThrow(() => createEvent({
      runId: `pivot-${type}`,
      stage: 'pivot',
      type,
      fields: { candidateId: 'candidate-1', perspective: 'boundary redesign' },
    }));
  }
});

test('every arbiter and capability event pair round-trips through the vocabulary', () => {
  for (const pair of [
    'arbiter/start', 'arbiter/finish', 'arbiter/overruled', 'capability/vetoed',
  ]) {
    const [stage, type] = pair.split('/');
    assert.ok(EVENT_PAIRS.includes(pair));
    assert.doesNotThrow(() => createEvent({ runId: pair, stage, type }));
  }
});

test('every liveness event pair round-trips through the declared vocabulary', () => {
  assert.ok(EVENT_STAGES.includes('liveness'));
  for (const type of ['asked', 'working', 'stuck']) {
    assert.ok(EVENT_TYPES.includes(type), `${type} must be a declared event type`);
    assert.doesNotThrow(() => createEvent({
      runId: `liveness-${type}`,
      stage: 'liveness',
      type,
      fields: {
        seat: 'executor', gapMs: 900_000, nextIntervalMs: 2_400_000,
        reasoning: 'The judgement remains human-readable.',
      },
    }));
  }
  assert.deepEqual(EVENT_PAIRS.filter((pair) => pair.startsWith('liveness/')).sort(), [
    'liveness/asked', 'liveness/stalled', 'liveness/stuck', 'liveness/working',
  ]);
});

test('stage transitions and executor file changes reach the reporter in order', async () => {
  const scr = scratch();
  const tgt = target();
  const events = [];
  try {
    const facts = await run({
      task: 'Write observed.txt.', target: tgt, gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'ordered-events', reporter: (event) => events.push(event),
      adapters: {
        runExecutor: (opts) => realExecutor({
          ...opts, bin: process.execPath, extraArgv: [fakeWriter],
        }),
        runGate: realGate,
        runReview: (opts) => realReviewPass({
          ...opts, bin: process.execPath, extraArgv: [fakeAgent, 'clean'],
        }),
      },
    });
    assert.equal(facts.outcome, 'review-ready');
    assert.deepEqual(events.map((event) => `${event.stage}/${event.type}${event.pass ? `:${event.pass}` : ''}`), [
      'isolate/start',
      'isolate/finish',
      'executor/start',
      'executor/file_change',
      'executor/item_completed',
      'executor/finish',
      'gate/start',
      'gate/finish',
      'diff/start',
      'diff/finish',
      'verify/start:review',
      'verify/finish:review',
      'debate/round',
      'debate/converged',
      'report/start',
      'report/finish',
    ]);
    const fileChange = events.find((event) => event.type === 'file_change');
    assert.equal(fileChange.file, 'observed.txt');
    assert.equal(fileChange.runId, 'ordered-events');
    const isolateFinish = events.find((event) => (
      event.stage === 'isolate' && event.type === 'finish'
    ));
    assert.equal(isolateFinish.baseRef, 'HEAD');
    assert.equal(isolateFinish.branch, 'uro/ordered-events');
    assert.match(isolateFinish.baseCommit, /^[0-9a-f]{40,64}$/);
  } finally {
    rmSync(tgt, { recursive: true, force: true });
    rmSync(scr, { recursive: true, force: true });
  }
});

test('each gate command reports its exit code without its output tail', async () => {
  const events = [];
  const result = await realGate({
    cwd: tmpdir(), runId: 'gate-events', reporter: (event) => events.push(event),
    commands: [
      { bin: process.execPath, args: ['-e', 'process.exit(0)'] },
      { bin: process.execPath, args: ['-e', 'process.stderr.write("huge details");process.exit(7)'] },
    ],
  });
  assert.equal(result.passed, false);
  const commands = events.filter((event) => event.type === 'gate_command');
  assert.deepEqual(commands.map((event) => event.code), [0, 7]);
  assert.ok(commands.every((event) => !Object.hasOwn(event, 'outputTail')));
});

test('a retry event says which stall started the next attempt', async () => {
  const scr = scratch();
  const tgt = target();
  const events = [];
  let executorCalls = 0;
  try {
    const facts = await run({
      task: 'Recover from a stalled launch.', target: tgt, gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'retry-event', reporter: (event) => events.push(event),
      stallPolicy: 'restart', stallThresholdMs: 25, stallRestartLimit: 1,
      adapters: {
        runExecutor: async (opts) => {
          executorCalls++;
          reportEvent(opts.reporter, opts.runId, 'executor', 'start', { attempt: opts.attempt });
          if (executorCalls === 1) {
            // Go silent past the watchdog threshold; the restart abort releases us.
            await new Promise((resolve) => opts.signal.addEventListener('abort', resolve,
              { once: true }));
            return { changedFiles: [], lastMessage: 'stopped', aborted: true };
          }
          writeFileSync(join(opts.cwd, 'repair.txt'), 'repaired\n');
          return { changedFiles: ['repair.txt'], lastMessage: 'repaired' };
        },
        runGate: async () => ({ passed: true, results: [] }),
        runVerifier: async () => ({ verdict: 'NO_BLOCKERS', launchFailed: false }),
      },
    });
    assert.equal(facts.outcome, 'review-ready');
    const retry = events.find((event) => event.type === 'retry');
    assert.equal(retry.stage, 'executor');
    assert.equal(retry.attempt, 2);
    assert.equal(retry.source, 'stall');
    assert.match(retry.reason, /^no event for \d+ ms$/);
    assert.ok(Number.isSafeInteger(retry.gapMs) && retry.gapMs >= 25,
      'the event carries the measured silence, not a command payload');
    // The event names the trigger; command output stays in the evidence files.
    assert.equal(Object.hasOwn(retry, 'bin'), false);
    assert.equal(Object.hasOwn(retry, 'outputTail'), false);
  } finally {
    rmSync(tgt, { recursive: true, force: true });
    rmSync(scr, { recursive: true, force: true });
  }
});

test('omitting reporter emits nothing and creates no events artifact', async () => {
  const scr = scratch();
  const tgt = target();
  try {
    const facts = await run({
      task: 'Do nothing.', target: tgt, gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'no-reporter',
      adapters: {
        runExecutor: async () => ({ changedFiles: [], lastMessage: 'no changes' }),
        runGate: async () => ({ passed: true, results: [] }),
        runVerifier: async () => { throw new Error('no-op must not verify'); },
      },
    });
    assert.equal(facts.outcome, 'no-op');
    assert.equal(existsSync(join(facts.dir, 'events.jsonl')), false);
  } finally {
    rmSync(tgt, { recursive: true, force: true });
    rmSync(scr, { recursive: true, force: true });
  }
});

test('a throwing reporter cannot change a run outcome', async () => {
  const scr = scratch();
  const tgt = target();
  try {
    const facts = await run({
      task: 'Do nothing.', target: tgt, gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'throwing-reporter',
      reporter: () => { throw new Error('logging is broken'); },
      adapters: {
        runExecutor: async () => ({ changedFiles: [], lastMessage: 'no changes' }),
        runGate: async () => ({ passed: true, results: [] }),
        runVerifier: async () => { throw new Error('no-op must not verify'); },
      },
    });
    assert.equal(facts.outcome, 'no-op');
  } finally {
    rmSync(tgt, { recursive: true, force: true });
    rmSync(scr, { recursive: true, force: true });
  }
});

test('events.jsonl is excluded from CHANGES.diff while a real changed file remains', async () => {
  const scr = scratch();
  const tgt = target();
  const eventPath = join(scr, 'artifact-exclusion', 'w', 'events.jsonl');
  const reporter = (event) => {
    if (!existsSync(dirname(eventPath))) return;
    appendFileSync(eventPath, `${JSON.stringify(event)}\n`);
  };
  try {
    const facts = await run({
      task: 'Add new.txt.', target: tgt, gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'artifact-exclusion', reporter,
      adapters: {
        runExecutor: async ({ cwd }) => {
          writeFileSync(join(cwd, 'new.txt'), 'real change\n');
          return { changedFiles: ['new.txt'], lastMessage: 'added new.txt' };
        },
        runGate: async () => ({ passed: true, results: [] }),
        runVerifier: async () => ({ verdict: 'NO_BLOCKERS', launchFailed: false }),
      },
    });
    const diff = readFileSync(join(facts.dir, 'CHANGES.diff'), 'utf8');
    assert.match(diff, /new[.]txt/, 'positive control: a real change must remain in the diff');
    assert.doesNotMatch(diff, /events[.]jsonl/);
    assert.ok(readFileSync(eventPath, 'utf8').trim().split('\n').length > 1,
      'the excluded event artifact must actually exist and contain events');
  } finally {
    rmSync(tgt, { recursive: true, force: true });
    rmSync(scr, { recursive: true, force: true });
  }
});

test('reportEvent also swallows an asynchronous reporter rejection', async () => {
  reportEvent(async () => { throw new Error('async logging failure'); },
    'async-reporter', 'report', 'finish', { file: 'x' });
  await new Promise((resolve) => setImmediate(resolve));
});

test('fully exercised runs have exact pair equality with both event vocabularies', async () => {
  const scr = scratch();
  const tgt = target();
  const campaignEvents = [];
  const unitEvents = [];
  const auxiliaryCampaignEvents = [];
  const journalEvents = [];
  const planEvents = [];
  let planTarget;
  let generatedNote;
  const success = (runId, tokens = {}) => ({
    runId,
    outcome: 'review-ready',
    evidence: [],
    verdict: 'NO_BLOCKERS',
    verdictSource: 'result',
    verifierFindings: 'correctness review',
    intentVerdict: 'NO_BLOCKERS',
    intentVerdictSource: 'result',
    intentVerifierFindings: 'intent review',
    tokens: { total: tokens },
  });
  try {
    const result = await runCampaign({
      campaignId: 'event-conformance',
      tasks: [
        {
          task: 'Write observed.txt.',
          unitKind: 'candidate',
          unitId: '2026-08-15T12-00-00-000Z-conformance-parent',
          perspective: 'test-first',
        },
        {
          task: 'Observe the predecessor result.',
          unitKind: 'node',
          unitId: '2026-08-15T12-00-01-000Z-conformance-child',
          dependsOn: '2026-08-15T12-00-00-000Z-conformance-parent',
        },
      ],
      target: tgt,
      gate: [{
        bin: process.execPath,
        args: ['-e', [
          "const fs = require('node:fs');",
          "if (fs.existsSync('.conformance-gate')) process.exit(0);",
          "fs.writeFileSync('.conformance-gate', 'retry\\n');",
          'process.exit(1);',
        ].join('')],
      }],
      concurrency: 1,
      tokenBudget: 1000,
      scratchRoot: scr,
      reporter: (event) => campaignEvents.push(event),
      unitReporterFactory: () => (event) => unitEvents.push(event),
      runOptions: {
        gateRetries: 1,
        adapters: {
          runExecutor: (opts) => realExecutor({
            ...opts, bin: process.execPath, extraArgv: [fakeWriter],
          }),
          runGate: realGate,
          runReview: (opts) => realReviewPass({
            ...opts, bin: process.execPath, extraArgv: [fakeAgent, 'clean'],
          }),
        },
      },
    });
    assert.equal(result.rollup.outcome, 'review-ready');

    await runCampaign({
      campaignId: 'conformance-merge',
      tasks: [
        { task: 'parent a', unitId: 'merge-parent-a', unitKind: 'node' },
        { task: 'parent b', unitId: 'merge-parent-b', unitKind: 'node' },
        { task: 'merge', unitId: 'merge-child', dependsOn: ['merge-parent-a', 'merge-parent-b'] },
      ],
      target: 'adapter-target', gate: [], concurrency: 2, tokenBudget: 1000,
      reporter: (event) => auxiliaryCampaignEvents.push(event),
      runUnit: async ({ runId }) => success(runId),
    });

    await runCampaign({
      campaignId: 'conformance-skip',
      tasks: [
        { task: 'fail', unitId: 'skip-parent', unitKind: 'node' },
        { task: 'blocked', unitId: 'skip-child', unitKind: 'node', dependsOn: 'skip-parent' },
      ],
      target: 'adapter-target', gate: [], concurrency: 1, tokenBudget: 1000,
      reporter: (event) => auxiliaryCampaignEvents.push(event),
      runUnit: async ({ runId }) => runId === 'skip-parent'
        ? { ...success(runId), outcome: 'gate-failed', gateStatus: 'failed' }
        : success(runId),
    });

    await runCampaign({
      campaignId: 'conformance-budget',
      tasks: [
        { task: 'over budget', unitId: 'budget-first', unitKind: 'node' },
        { task: 'must not dispatch', unitId: 'budget-second', unitKind: 'node' },
      ],
      target: 'adapter-target', gate: [], concurrency: 1, tokenBudget: 1,
      reporter: (event) => auxiliaryCampaignEvents.push(event),
      runUnit: async ({ runId }) => success(runId, { inputTokens: 2 }),
    });

    let decisionExecutorCalls = 0;
    const decisionFacts = await run({
      task: 'Resolve the authority challenge in isolation.',
      target: tgt,
      gate: [],
      gateRetries: 0,
      scratchRoot: scr,
      runId: 'conformance-decision-assumed',
      mode: 'autonomous',
      reporter: (event) => unitEvents.push(event),
      decisionResolver: async () => ({
        answers: [{ id: 'Q1', answer: 'Proceed only in the isolated worktree.' }],
        escalation: 'operator-absent',
        presenceEvidence: {
          ttyAttached: false,
          invocation: 'non-interactive',
          operatorWait: 'not-acknowledged',
        },
        reasoning: 'No TTY was attached, so no operator was available to answer.',
      }),
      adapters: {
        runExecutor: async ({ cwd }) => {
          decisionExecutorCalls++;
          if (decisionExecutorCalls === 1) {
            writeFileSync(join(cwd, 'DECISION.md'), [
              '## Q1',
              'Kind: authority',
              'Question: May this proceed in the isolated worktree?',
              'Recommendation: Proceed only in the isolated worktree.',
              '',
            ].join('\n'));
            return { changedFiles: ['DECISION.md'], lastMessage: 'authority needed' };
          }
          writeFileSync(join(cwd, 'assumed.txt'), 'isolated decision\n');
          return { changedFiles: ['assumed.txt'], lastMessage: 'continued in isolation' };
        },
        runGate: async () => ({ passed: true, results: [] }),
        runVerifier: async () => ({ verdict: 'NO_BLOCKERS', launchFailed: false }),
      },
    });
    assert.equal(decisionFacts.outcome, 'review-ready');

    const journalFacts = result.units[0].facts;
    generatedNote = generateRunJournal(join(journalFacts.dir, 'uro-runfacts.json'), {
      reporter: (event) => journalEvents.push(event),
    }).notePath;

    planTarget = mkdtempSync(join(process.cwd(), '.ccc-test-event-plan-'));
    await runPlan({
      goal: 'Exercise plan event conformance',
      target: planTarget,
      out: join(planTarget, 'generated'),
      reporter: (event) => planEvents.push(event),
      adapters: {
        draft: async () => ({ plan: 'event conformance\n', gate: [] }),
        cursorDraft: async () => ({ plan: 'cursor conformance\n', gate: [] }),
        codexReview: async () => 'AGREE: yes',
        review: async () => 'AGREE: yes',
        runArbiter: async ({ request }) => {
          if (request.type === 'draft') return { plan: 'claude conformance\n', gate: [] };
          if (request.type === 'propose') return { plan: 'event conformance\n', gate: [] };
          if (request.type === 'agreement') return { converged: true, reason: 'conformance' };
          return { verdict: 'UNVERIFIED' };
        },
      },
    });

    const stalledFamily = Object.fromEntries(EVENT_PAIRS
      .filter((pair) => pair.endsWith('/stalled'))
      .map((pair) => [pair,
        'Requires deliberate silence in that stage; the stage-agnostic watchdog contract is proved in stall-watchdog.test.js.']));
    const deliberatelyUncovered = Object.freeze({
      // Silence reports exist for EVERY stage because the watchdog arms for
      // whatever stage last emitted (the debate/stalled crash regression);
      // none of them can fire in a healthy conformance run.
      ...stalledFamily,
      // The healthy conformance run finishes before its first deadline needs an extension.
      'executor/extended': 'Requires a healthy executor to outlive its configured deadline.',
      // Scope violations are exercised with injected file mutation in review-protection.test.js.
      'verify/scope_violation': 'Requires a reviewer to write outside its dedicated artifact directory.',
      // The healthy executor follows the review-file restriction in this conformance run.
      'executor/scope_violation': 'Requires an executor to modify or delete a protected reviewer file.',
      // The clean verifier presents no blocking finding for the executor to resist.
      'debate/resist': 'Requires at least one structured blocking review finding.',
      // Claude's first-hand review fires only when the debate circles; the
      // healthy conformance run converges on its first round.
      'debate/independent_review': 'Requires a circling debate; covered by the circling suite in run.test.js.',
      // Healthy conformance converges on its first review and therefore cannot circle.
      'debate/circling': 'Requires unresolved blockers across three consecutive review rounds.',
      // A pivot is only selected after the debate has been detected as circling.
      'debate/pivot': 'Requires a circling debate before a pivot strategy can be selected.',
      // Retries now start only from a stall restart, which needs deliberate
      // executor silence; the payload is proved in the stall retry test above.
      'executor/retry': 'Requires a stalled executor restart; payload proved by the stall retry test.',
    });
    assert.equal(Object.keys(stalledFamily).length, EVENT_STAGES.length,
      'every stage must carry a silence pair — the watchdog arms for any of them');
    assert.equal(Object.keys(deliberatelyUncovered).length, Object.keys(stalledFamily).length + 8,
      'the deliberately-uncovered ratchet must not grow without an explicit test change');
    assert.ok(Object.values(deliberatelyUncovered).every((reason) => reason.length >= 24),
      'every allowlisted pair must carry a substantive reason');

    const livenessEvents = ['asked', 'working', 'stuck'].map((type) => createEvent({
      runId: `conformance-liveness-${type}`,
      stage: 'liveness',
      type,
      fields: {
        seat: 'executor', gapMs: 900_000, nextIntervalMs: 2_400_000,
        reasoning: 'Vocabulary conformance fixture.',
      },
    }));
    const mutationEvents = ['start', 'unit', 'survivor', 'finish'].map((type) => createEvent({
      runId: `conformance-mutate-${type}`,
      stage: 'mutate',
      type,
      fields: { name: 'conformance unit', status: 'finished' },
    }));
    const arbiterEvents = [
      ['arbiter', 'start'],
      ['arbiter', 'finish'],
      ['arbiter', 'overruled'],
      ['capability', 'vetoed'],
    ].map(([stage, type]) => createEvent({
      runId: `conformance-${stage}-${type}`, stage, type,
      fields: { judgement: 'finding', findingId: 'F1', seat: 'executor' },
    }));
    const pivotEvents = ['replan_start', 'candidate', 'selected', 'exhausted'].map((type) => (
      createEvent({
        runId: `conformance-pivot-${type}`, stage: 'pivot', type,
        fields: { candidateId: 'candidate-1', perspective: 'boundary redesign' },
      })
    ));
    const verifyRetryEvents = [createEvent({
      runId: 'conformance-verify-retry', stage: 'verify', type: 'retry',
      fields: { pass: 'plan', reason: 'ActionRequiredError: usage limit' },
    })];
    const pivotDecisionEvents = [createEvent({
      runId: 'conformance-plan-pivot', stage: 'plan', type: 'pivot',
      fields: { tier: 'goal', planRound: 3, decision: 'conclude', unjudged: false, reason: 'conformance fixture' },
    })];
    const allEvents = [
      ...campaignEvents,
      ...unitEvents,
      ...auxiliaryCampaignEvents,
      ...journalEvents,
      ...planEvents,
      ...livenessEvents,
      ...mutationEvents,
      ...arbiterEvents,
      ...pivotEvents,
      ...verifyRetryEvents,
      ...pivotDecisionEvents,
    ];
    assert.doesNotThrow(() => assertEventConformance(allEvents, {
      allowUnemitted: Object.keys(deliberatelyUncovered),
    }));

    const emittedCampaignPairs = new Set([
      ...campaignEvents,
      ...auxiliaryCampaignEvents,
    ].map((event) => `${event.stage}/${event.type}`));
    assert.deepEqual([...emittedCampaignPairs].sort(), [...CAMPAIGN_EVENT_PAIRS].sort(),
      'campaign lifecycle, planner, merge, and round vocabulary must have exact coverage');

    // Demonstrate the ratchet firing: this temporary declaration has no emitter in the
    // exercised campaign, so equality must reject it as missing.
    assert.throws(() => assertEventConformance(allEvents, {
      declaredStages: [...EVENT_STAGES, 'future-stage'],
      declaredPairs: [...EVENT_PAIRS, 'future-stage/start'],
      allowUnemitted: Object.keys(deliberatelyUncovered),
    }), /missing:.*future-stage\/start/);
  } finally {
    if (generatedNote) rmSync(generatedNote, { force: true });
    if (planTarget) rmSync(planTarget, { recursive: true, force: true });
    rmSync(tgt, { recursive: true, force: true });
    rmSync(scr, { recursive: true, force: true });
  }
});

test('every stage can construct its silence report — the debate/stalled crash regression', () => {
  // The watchdog arms for whatever stage last emitted. A stage whose stalled
  // pair is missing turns the silence report into a timer-borne crash, which
  // is exactly how a live run died. The completion is structural; this pins it.
  for (const stage of EVENT_STAGES) {
    assert.doesNotThrow(() => createEvent({
      runId: `stalled-${stage}`,
      stage,
      type: 'stalled',
      fields: { gapMs: 1000, thresholdMs: 500 },
    }), `${stage}/stalled must be constructible`);
  }
});
