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
import { runCampaign } from '../src/campaign.js';
import { runExecutor as realExecutor } from '../src/executor.js';
import { runGate as realGate } from '../src/gate.js';
import { run } from '../src/run.js';
import { generateRunJournal } from '../src/run-journal.js';
import { runVerifier as realVerifier } from '../src/verifier.js';

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
      'debate/circling', 'debate/converged', 'debate/pivot', 'debate/resist', 'debate/round',
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
        runVerifier: (opts) => realVerifier({
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
      'verify/start:correctness',
      'verify/finish:correctness',
      'verify/start:intent',
      'verify/finish:intent',
      'verify/verdict',
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

test('a retry event says which gate failure started the next attempt', async () => {
  const scr = scratch();
  const tgt = target();
  const events = [];
  let gateAttempt = 0;
  try {
    const facts = await run({
      task: 'Repair the gate.', target: tgt, gate: [], gateRetries: 1,
      scratchRoot: scr, runId: 'retry-event', reporter: (event) => events.push(event),
      adapters: {
        runExecutor: async ({ cwd }) => {
          writeFileSync(join(cwd, 'repair.txt'), 'repaired\n');
          return { changedFiles: ['repair.txt'], lastMessage: 'repaired' };
        },
        runGate: async () => gateAttempt++ === 0
          ? { passed: false, results: [{ bin: 'node', args: ['--test'], code: 9,
              outputTail: 'details intentionally absent from the event' }] }
          : { passed: true, results: [] },
        runVerifier: async () => ({ verdict: 'NO_BLOCKERS', launchFailed: false }),
      },
    });
    assert.equal(facts.outcome, 'review-ready');
    const retry = events.find((event) => event.type === 'retry');
    assert.deepEqual({
      stage: retry.stage,
      attempt: retry.attempt,
      source: retry.source,
      reason: retry.reason,
      bin: retry.bin,
      args: retry.args,
      code: retry.code,
    }, {
      stage: 'executor',
      attempt: 2,
      source: 'gate',
      reason: 'gate command exited 9',
      bin: 'node',
      args: ['--test'],
      code: 9,
    });
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
  let generatedNote;
  const success = (runId, tokens = {}) => ({
    runId,
    outcome: 'review-ready',
    gateStatus: 'passed',
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
          runVerifier: (opts) => realVerifier({
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

    const deliberatelyUncovered = Object.freeze({
      // A real isolation stall requires withholding Git completion past the watchdog threshold.
      'isolate/stalled': 'Covered by the watchdog fault-injection suite, not this healthy run.',
      // A merge stall requires a deliberately hung Git merge operation.
      'merge/stalled': 'Covered by the generic watchdog contract; no merge process is hung here.',
      // The healthy executor emits progress, so silence is tested in executor-watchdog.test.js.
      'executor/stalled': 'Requires deliberate executor silence longer than the threshold.',
      // The healthy conformance run finishes before its first deadline needs an extension.
      'executor/extended': 'Requires a healthy executor to outlive its configured deadline.',
      // Hanging a gate command changes this conformance run into a timeout scenario.
      'gate/stalled': 'Requires a deliberately hung gate process.',
      // Diff production uses Git and is not deliberately hung in this healthy run.
      'diff/stalled': 'Requires a deliberately hung diff process.',
      // Both verifier passes complete; their stall path has separate supervision coverage.
      'verify/stalled': 'Requires a deliberately silent verifier process.',
      // The clean verifier presents no blocking finding for the executor to resist.
      'debate/resist': 'Requires at least one structured blocking review finding.',
      // Healthy conformance converges on its first review and therefore cannot circle.
      'debate/circling': 'Requires unresolved blockers across three consecutive review rounds.',
      // A pivot is only selected after the debate has been detected as circling.
      'debate/pivot': 'Requires a circling debate before a pivot strategy can be selected.',
      // Report writes are synchronous, so the event loop cannot observe a mid-write timer gap.
      'report/stalled': 'Unreachable during synchronous report writes.',
    });
    assert.equal(Object.keys(deliberatelyUncovered).length, 11,
      'the deliberately-uncovered ratchet must not grow without an explicit test change');
    assert.ok(Object.values(deliberatelyUncovered).every((reason) => reason.length >= 24),
      'every allowlisted pair must carry a substantive reason');

    const allEvents = [
      ...campaignEvents,
      ...unitEvents,
      ...auxiliaryCampaignEvents,
      ...journalEvents,
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
    rmSync(tgt, { recursive: true, force: true });
    rmSync(scr, { recursive: true, force: true });
  }
});
