import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReportMarkdown, buildRunFacts, writeReport } from '../src/report.js';
import { DEFAULT_EXECUTOR_EFFORT, DEFAULT_EXECUTOR_MODEL } from '../src/executor.js';
import { DEFAULT_VERIFIER_MODEL } from '../src/verifier.js';
import { DEFAULT_ARBITER_MODEL } from '../src/arbiter.js';
import { EMPTY_USAGE } from '../src/usage.js';

const facts = buildRunFacts({
  runId: 'r1', target: 'C:/proj', dir: 'C:/ccc/w', isRepo: false, branch: 'ccc/r1',
  iterations: [{ n: 1, changedFiles: ['a.py'], lastMessage: 'did it',
    gate: { passed: true, results: [] }, verifier: { verdict: 'NO_BLOCKERS' } }],
  outcome: 'review-ready',
  gateRetries: 2,
});

test('buildRunFacts records pins and outcome', () => {
  assert.equal(facts.model.executor, DEFAULT_EXECUTOR_MODEL);
  assert.equal(facts.model.executorEffort, DEFAULT_EXECUTOR_EFFORT);
  assert.equal(facts.model.verifier, DEFAULT_VERIFIER_MODEL);
  assert.equal(facts.model.arbiter, DEFAULT_ARBITER_MODEL);
  assert.equal(facts.outcome, 'review-ready');
  assert.equal(facts.iterations[0].changedFiles[0], 'a.py');
  assert.equal(Object.hasOwn(facts.limits, 'maxIterations'), false);
  assert.equal(facts.limits.gateRetries, 2);
  assert.deepEqual(facts.limits.timeoutsMs,
    { executor: null, verifier: null, arbiter: null, gate: null });
  assert.deepEqual(facts.timeoutEvents, []);
  assert.equal(facts.skills, null);
  assert.equal(facts.superpowers, null);
});

test('buildRunFacts records the resolved skills path', () => {
  const withSkills = buildRunFacts({
    runId: 'skills', target: 'C:/proj', dir: 'C:/uro/w', isRepo: true,
    branch: 'uro/skills', iterations: [], gateStatus: 'passed', verdict: null,
    outcome: 'no-op', gateRetries: 0, skills: 'C:/plugins/superpowers/6.3.0',
  });
  assert.equal(withSkills.skills, 'C:/plugins/superpowers/6.3.0');
});

test('buildRunFacts records independent superpowers evidence and versions for every seat', () => {
  const superpowers = {
    required: true,
    bypassed: false,
    seats: {
      codex: { verified: true, evidence: 'registry enabled', version: '3fdeeb49', path: null },
      cursor: { verified: true, evidence: '.cursor-plugin readable', version: '6.0.2', path: 'C:/cursor' },
      claude: { verified: true, evidence: '.claude-plugin readable', version: '6.0.1', path: 'C:/claude' },
    },
  };
  const withSuperpowers = buildRunFacts({
    runId: 'seat-skills', target: 'C:/proj', dir: 'C:/uro/w', isRepo: true,
    branch: 'uro/seat-skills', iterations: [], gateStatus: 'passed', verdict: null,
    outcome: 'no-op', gateRetries: 0, superpowers,
  });
  assert.deepEqual(withSuperpowers.superpowers, superpowers);
  assert.deepEqual(
    Object.values(withSuperpowers.superpowers.seats).map((seat) => seat.version),
    ['3fdeeb49', '6.0.2', '6.0.1'],
  );
});

test('a requested bypass does not claim verified seats were missing', () => {
  const markdown = buildReportMarkdown({
    ...facts,
    superpowers: {
      required: true,
      bypassed: true,
      seats: {
        codex: { verified: true, evidence: 'registry enabled', version: '3fdeeb49' },
        cursor: { verified: true, evidence: 'manifest readable', version: '6.0.2' },
        claude: { verified: true, evidence: 'manifest readable', version: '6.0.2' },
      },
    },
  });

  assert.match(markdown, /URO_REQUIRE_SUPERPOWERS=0/);
  assert.match(markdown, /all required seat skills were verified/i);
  assert.doesNotMatch(markdown, /without all required seat skills being verified/i);
});

test('run facts and markdown retain mutation measurement and arbiter judgement without changing the gate', () => {
  const mutation = {
    status: 'finished',
    grouping: { method: 'semantic-judge', judged: true },
    summary: { unitsExamined: 1, survivors: 1, kills: 0, unexamined: 0 },
    survivors: [{
      name: 'recordLivenessDecision()',
      lines: [{ path: 'src/run.js', line: 269 }],
      tests: ['test/liveness.test.js'],
      judgement: { verdict: 'gap', reasoning: 'The facts write has no observing assertion.' },
    }],
    unexamined: [],
  };
  const withMutation = buildRunFacts({
    runId: 'mutation-report', target: 'C:/proj', dir: 'C:/uro/w', isRepo: true,
    branch: 'uro/mutation-report', iterations: [], gateStatus: 'passed', verdict: 'NO_BLOCKERS',
    outcome: 'review-ready', gateRetries: 0, mutation,
  });
  assert.equal(withMutation.outcome, 'review-ready');
  assert.equal(withMutation.mutation, mutation);
  const markdown = buildReportMarkdown(withMutation);
  assert.match(markdown, /Mutation survivors:\*\* 1/);
  assert.match(markdown, /recordLivenessDecision\(\).*src\/run[.]js:269/);
  assert.match(markdown, /arbiter: gap.*facts write has no observing assertion/i);
});

test('buildRunFacts retains the judged interval and its reasoning', () => {
  const judged = buildRunFacts({
    runId: 'judged-liveness', target: 'C:/proj', dir: 'C:/uro/w', isRepo: true,
    branch: 'uro/judged', iterations: [], gateStatus: 'passed', verdict: null,
    outcome: 'no-op', gateRetries: 0,
    supervision: {
      thresholdMs: 900_000, progressThresholdMs: 300_000,
      policy: 'report', restartLimit: 1, restartCount: 0, gateRetryCount: 0,
      stallEvents: [],
      livenessChecks: [{
        status: 'working', judged: true, nextIntervalMs: 2_400_000,
        reasoning: 'A live delegated child is compiling the requested change.',
      }],
    },
  });
  assert.deepEqual(judged.livenessChecks, [{
    status: 'working', judged: true, nextIntervalMs: 2_400_000,
    reasoning: 'A live delegated child is compiling the requested change.',
  }]);
  const markdown = buildReportMarkdown(judged);
  assert.match(markdown, /Liveness judgements/);
  assert.match(markdown, /next check in 2400000 ms/);
  assert.match(markdown, /live delegated child is compiling/);
});

test('buildRunFacts records model overrides actually used for a run', () => {
  const overridden = buildRunFacts({
    runId: 'models', target: 'C:/proj', dir: 'C:/ccc/w', isRepo: false, branch: 'ccc/models',
    iterations: [], gateStatus: 'passed', verdict: null, outcome: 'no-op',
    gateRetries: 0,
    models: {
      executor: 'executor-override', executorEffort: 'medium',
      verifier: 'verifier-override', arbiter: 'arbiter-override',
    },
  });
  assert.deepEqual(overridden.model, {
    executor: 'executor-override',
    executorEffort: 'medium',
    verifier: 'verifier-override',
    arbiter: 'arbiter-override',
  });
});

test('writeReport emits json and markdown', () => {
  const d = mkdtempSync(join(tmpdir(), 'rep-'));
  const { jsonPath, mdPath } = writeReport({ dir: d, facts });
  const persisted = JSON.parse(readFileSync(jsonPath, 'utf8'));
  assert.equal(persisted.runId, 'r1');
  assert.equal(Object.hasOwn(persisted.limits, 'maxIterations'), false);
  assert.equal(persisted.limits.gateRetries, 2);
  assert.match(readFileSync(mdPath, 'utf8'), /review-ready/);
});

test('run facts and markdown explain the debate history and stop reason', () => {
  const debateFacts = buildRunFacts({
    runId: 'debate-report', target: 'C:/proj', dir: 'C:/uro/w', isRepo: true,
    branch: 'uro/debate-report', iterations: [], gateStatus: 'passed', verdict: 'ISSUES',
    outcome: 'needs-pivot', gateRetries: 0,
    debate: {
      roundsRun: 2,
      maxRounds: 2,
      findingsPerRound: [['F1'], ['F1']],
      roundHistory: [],
      allFindingIds: ['F1'],
      recurredFindingIds: ['F1'],
      resolvedFindingIds: [],
      stuckFindingIds: [],
      circlingDetected: false,
      pivotCount: 0,
      finalPivotDecision: null,
      stopReason: 'rounds-exhausted',
      ledger: { rounds: [], allFindingIds: ['F1'], recurredFindingIds: ['F1'],
        resolvedFindingIds: [], stuckFindingIds: [] },
    },
  });
  const d = mkdtempSync(join(tmpdir(), 'rep-debate-'));
  const { jsonPath, mdPath } = writeReport({ dir: d, facts: debateFacts });
  const persisted = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const md = readFileSync(mdPath, 'utf8');

  assert.equal(persisted.debate.roundsRun, 2);
  assert.deepEqual(persisted.debate.findingsPerRound, [['F1'], ['F1']]);
  assert.match(md, /Debate rounds:\*\* 2/);
  assert.match(md, /Debate stopped:\*\* rounds-exhausted/);
});

test('review findings reach both the facts and the markdown report', () => {
  const withFindings = buildRunFacts({
    runId: 'r2', target: 'C:/proj', dir: 'C:/ccc/w', isRepo: false, branch: 'ccc/r2',
    iterations: [{ n: 1, changedFiles: ['a.py'], lastMessage: 'did it',
      gate: { passed: true, results: [] } }],
    debate: {
      roundsRun: 1,
      stopReason: 'converged',
      roundHistory: [{
        round: 1,
        findingIds: ['F1', 'F2'],
        blockingFindingIds: ['F1'],
        suggestionFindingIds: ['F2'],
        findings: [
          { id: 'F1', severity: 'blocking', category: 'correctness',
            description: 'Line 4 drops the error.' },
          { id: 'F2', severity: 'suggestion', category: 'intent',
            description: 'The task required shared scope.' },
        ],
      }],
    },
    outcome: 'review-ready', gateRetries: 2,
  });
  assert.equal(withFindings.debate.roundHistory[0].findings.length, 2);
  // The verdict-era fields never come back, even when a caller passes them.
  assert.equal(Object.hasOwn(withFindings, 'verifierFindings'), false);
  assert.equal(Object.hasOwn(withFindings, 'intentVerdict'), false);

  const d = mkdtempSync(join(tmpdir(), 'rep2-'));
  const { mdPath } = writeReport({ dir: d, facts: withFindings });
  const md = readFileSync(mdPath, 'utf8');
  assert.match(md, /## Review findings \(last round\)/);
  assert.match(md, /F1 \[blocking\] Line 4 drops the error/);
  assert.match(md, /F2 \[suggestion\] The task required shared scope/);
});

test('facts carry no verdict-era fields at all', () => {
  for (const gone of ['verdict', 'verdictSource', 'correctnessVerdict',
    'correctnessVerdictSource', 'verifierFindings', 'verifierPlan',
    'verifierEvidence', 'verifierConsistency', 'intentVerifierFindings',
    'intentVerdict', 'intentVerdictSource', 'intentVerifierPlan',
    'intentVerifierEvidence', 'intentVerifierConsistency', 'gateStatus']) {
    assert.equal(Object.hasOwn(facts, gone), false, `${gone} must not exist`);
  }
  assert.deepEqual(facts.evidence, []);
  assert.deepEqual(facts.tokens, {
    executor: EMPTY_USAGE,
    verifier: EMPTY_USAGE,
    arbiter: EMPTY_USAGE,
    total: EMPTY_USAGE,
  });
});

test('writeReport emits retained evidence diagnostics and tokens', () => {
  const diagnosticFacts = buildRunFacts({
    runId: 'diag', target: 'C:/proj', dir: 'C:/ccc/w', isRepo: false, branch: 'ccc/diag',
    iterations: [{ n: 1, changedFiles: ['broken.js'], lastMessage: 'attempted fix',
      gate: { passed: false, results: [] }, verifier: null }],
    evidence: [{
      source: 'command', bin: 'node', args: ['--test'], code: 1, timedOut: false,
      round: 1, excerpt: '[stdout]\nFAIL specific assertion\n[stderr]\nstack detail',
      outFile: '__uro_evidence/round-1-01.out.txt',
      errFile: '__uro_evidence/round-1-01.err.txt',
    }],
    tokens: {
      executor: { inputTokens: 11, cachedInputTokens: 7, outputTokens: 5,
        reasoningOutputTokens: 3, cacheWriteTokens: 2 },
      verifier: { inputTokens: 13, cachedInputTokens: 9, outputTokens: 6,
        reasoningOutputTokens: 0, cacheWriteTokens: 4 },
      total: { inputTokens: 24, cachedInputTokens: 16, outputTokens: 11,
        reasoningOutputTokens: 3, cacheWriteTokens: 6 },
    },
    outcome: 'executor-failed', gateRetries: 0,
  });
  const d = mkdtempSync(join(tmpdir(), 'rep-diag-'));
  const { mdPath } = writeReport({ dir: d, facts: diagnosticFacts });
  const md = readFileSync(mdPath, 'utf8');
  // No verdict lines of any kind — the evidence section carries the record.
  assert.doesNotMatch(md, /Verdict/i);
  assert.match(md, /## Evidence — commands that exited non-zero/);
  assert.match(md, /node --test/);
  assert.match(md, /Exit code:\*\* 1/);
  assert.match(md, /__uro_evidence\/round-1-01[.]out[.]txt/);
  assert.match(md, /FAIL specific assertion/);
  assert.match(md, /stack detail/);
  assert.match(md, /## Tokens/);
  assert.match(md, /Executor.*input: 11/i);
  assert.match(md, /Verifier.*input: 13/i);
  assert.match(md, /Total.*input: 24/i);
});

test('writeReport omits optional plan and gate sections when facts contain null', () => {
  const d = mkdtempSync(join(tmpdir(), 'rep-min-'));
  const { mdPath } = writeReport({ dir: d, facts });
  const md = readFileSync(mdPath, 'utf8');
  assert.doesNotMatch(md, /## Verifier plan artifact/);
  assert.doesNotMatch(md, /## Intent verifier plan artifact/);
  assert.doesNotMatch(md, /## Gate failure/);
  assert.match(md, /## Tokens/);
});

test('a run whose reviewer never reported still writes an honest report', () => {
  const unreviewedFacts = buildRunFacts({
    runId: 'unreviewed', target: 'C:/proj', dir: 'C:/ccc/w', isRepo: false,
    branch: 'ccc/unreviewed', iterations: [],
    debate: { roundsRun: 1, stopReason: 'unreviewed', roundHistory: [] },
    outcome: 'verifier-failed', gateRetries: 0,
  });
  const d = mkdtempSync(join(tmpdir(), 'rep-unreviewed-'));
  const { jsonPath, mdPath } = writeReport({ dir: d, facts: unreviewedFacts });
  const persisted = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const md = readFileSync(mdPath, 'utf8');

  assert.equal(persisted.outcome, 'verifier-failed');
  assert.equal(persisted.debate.stopReason, 'unreviewed');
  assert.match(md, /Debate stopped:\*\* unreviewed/);
  assert.match(md, /## Review findings \(last round\)/);
  assert.match(md, /\(none recorded\)/);
});

test('configured timeouts and timeout events reach facts and markdown', () => {
  const timedOut = buildRunFacts({
    runId: 'timeout', target: 'C:/proj', dir: 'C:/ccc/w', isRepo: false,
    branch: 'ccc/timeout', iterations: [], gateStatus: 'not-run', verdict: null,
    outcome: 'timed-out', gateRetries: 0,
    timeouts: { executor: 100, verifier: 200, arbiter: 250, gate: 300 },
    timeoutEvents: [{
      stage: 'executor', iteration: 1, attempt: 1, timeoutMs: 100,
      reason: 'deadline', gapMs: 75,
      lastEvent: { stage: 'executor', type: 'item_completed' },
      setting: 'URO_STALL_THRESHOLD_MS',
    }],
  });
  assert.deepEqual(timedOut.limits.timeoutsMs,
    { executor: 100, verifier: 200, arbiter: 250, gate: 300 });
  assert.equal(timedOut.timeoutEvents[0].stage, 'executor');
  const d = mkdtempSync(join(tmpdir(), 'rep-timeout-'));
  const { mdPath } = writeReport({ dir: d, facts: timedOut });
  const md = readFileSync(mdPath, 'utf8');
  assert.match(md, /Timeouts \(ms\).*executor 100.*verifier 200.*arbiter 250.*gate 300/i);
  assert.match(md, /executor: timed out after 100 ms/i);
  assert.match(md, /75 ms silence after executor\/item_completed/i);
  assert.match(md, /URO_STALL_THRESHOLD_MS/);
});

test('verifier liveness timeout evidence renders the pass, gap, and governing setting', () => {
  const timedOut = buildRunFacts({
    runId: 'verifier-silence', target: 'C:/proj', dir: 'C:/ccc/w', isRepo: false,
    branch: 'ccc/verifier-silence', iterations: [], gateStatus: 'not-run', verdict: null,
    outcome: 'timed-out', gateRetries: 0,
    timeouts: { executor: null, verifier: null, gate: 300 },
    timeoutEvents: [{
      stage: 'verifier', pass: 'intent', iteration: 1, timeoutMs: 300_000,
      reason: 'liveness', gapMs: 300_000,
      lastEvent: { stage: 'verify', type: 'assistant' },
      setting: 'URO_STALL_THRESHOLD_MS',
    }],
  });
  const d = mkdtempSync(join(tmpdir(), 'rep-verifier-silence-'));
  const { mdPath } = writeReport({ dir: d, facts: timedOut });
  const md = readFileSync(mdPath, 'utf8');
  assert.match(md, /verifier \(intent pass\): timed out after 300000 ms/i);
  assert.match(md, /300000 ms silence after verify\/assistant/i);
  assert.match(md, /URO_STALL_THRESHOLD_MS/i);
});
