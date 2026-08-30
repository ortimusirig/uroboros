import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isolate } from './isolation.js';
import {
  DEFAULT_EXECUTOR_EFFORT,
  DEFAULT_EXECUTOR_MODEL,
  EXECUTOR_PREAMBLE,
  runExecutor as realExecutor,
} from './executor.js';
import { runGate as realGate } from './gate.js';
import {
  annotateVerifierConsistency,
  DEFAULT_PROMPT,
  DEFAULT_VERIFIER_MODEL,
  INTENT_PROMPT,
  runVerifier as realVerifier,
} from './verifier.js';
import { buildRunFacts, writeReport } from './report.js';
import { spawnCapture } from './spawn.js';
import {
  addUsage,
  annotateUsageConsistency,
  checkUsageConsistency,
  EMPTY_USAGE,
  summarizeUsageConsistency,
} from './usage.js';
import { resolveTask } from './task.js';
import { resolveStageTimeouts } from './timeouts.js';
import { reportEvent } from './events.js';
import {
  createGapWatchdog,
  resolveExecutorThresholds,
  resolveStallConfig,
} from './stall-watchdog.js';
import { archiveRunArtifacts, HARNESS_ARTIFACTS } from './artifacts.js';
import { createRunMarker, releaseRunMarker } from './prune.js';
import { physicalRunIdFor } from './run-id.js';
import {
  advanceMerge,
  buildMergeTask,
  clearMergeLedger,
  concludeConflict,
  readMergeLedger,
  testCountFloorCommand,
} from './merge.js';
import { countTestFiles } from './merge-test-count.js';
import { detectChallenge } from './decision.js';
import { probeVerifierLiveness } from './preflight.js';
import {
  DebateLedger,
  detectCircling,
  PIVOT_AMEND,
  PIVOT_CONCLUDE,
  PIVOT_FRESH,
  shouldPivot,
} from './debate.js';
import { detectReview, parseReview } from './review.js';
import { buildFixPlan, validateFindings } from './fix-plan.js';
import { resolveSuperpowersDir } from './superpowers.js';
import { readEnv } from './env-compat.js';

export { HARNESS_ARTIFACTS } from './artifacts.js';

const PARTIAL_WORK_GIT_TIMEOUT_MS = 30_000;

export function resolveDebateRounds(env = process.env, override) {
  const raw = override ?? readEnv(env, 'DEBATE_ROUNDS');
  if (raw === undefined) return undefined;
  if ((typeof raw !== 'number' && (typeof raw !== 'string' || !/^\d+$/.test(raw)))
    || !Number.isSafeInteger(Number(raw))) {
    throw new Error('URO_DEBATE_ROUNDS must be a positive integer');
  }
  const value = Number(raw);
  if (value < 1) throw new Error('URO_DEBATE_ROUNDS must be a positive integer');
  return value;
}

function collectReviewFindings(dir, ...verifierResults) {
  const candidates = [];
  const detected = detectReview({ dir });
  if (detected.reviewed) candidates.push(...detected.findings);
  for (const result of verifierResults) {
    for (const content of [result?.findings, result?.plan]) {
      const parsed = parseReview(content);
      if (parsed) candidates.push(...parsed);
    }
  }

  // Finding ids are the ledger identity. If two seats use the same id, retain a
  // blocking version over a suggestion so a real blocker cannot be hidden by order.
  const byId = new Map();
  for (const finding of candidates) {
    const previous = byId.get(finding.id);
    if (!previous || (previous.severity !== 'blocking' && finding.severity === 'blocking')) {
      byId.set(finding.id, finding);
    }
  }
  return [...byId.values()];
}

function amendFixPlanWithLedger(fixPlan, ledger) {
  const history = Array.from({ length: ledger.currentRound }, (_, index) => {
    const round = index + 1;
    return `- Round ${round}: ${ledger.round(round).join(', ') || '(none)'}`;
  });
  return `${fixPlan}\n## Pivot amendment\n\n`
    + 'The prior fix approach is circling. Use a materially different implementation '
    + 'approach for the recurring blockers while preserving the original task and tests.\n\n'
    + `Recurring blockers: ${[...ledger.stuckFindings()].join(', ') || '(count plateau)'}\n\n`
    + `Round history:\n${history.join('\n')}\n`;
}

// Files the harness itself writes into the isolated directory. They must never enter
// CHANGES.diff (an artifact in the diff would make the `no-op` outcome unreachable) and
// must never be treated as shippable by the installer's payload check. Both consumers
// read this one list so a new artifact cannot be added to one and forgotten in the other.
export async function diffText(dir, baseRef = 'HEAD', { timeoutMs } = {}) {
  // Stage first so NEW (untracked) files appear — `git diff HEAD` alone omits them.
  // Reset every harness artifact from the index after staging. This removes artifacts
  // another actor pre-staged and avoids passing ignored artifact paths to `git add`.
  const spawnOptions = timeoutMs === undefined ? {} : { timeoutMs };
  const add = await spawnCapture('git', ['-C', dir, 'add', '-A'], spawnOptions);
  if (add.code !== 0) throw new Error(`git add failed in ${dir}: ${add.stderr.trim()}`);
  const unstage = await spawnCapture('git', [
    '-C', dir, 'reset', '--quiet', '--', ...HARNESS_ARTIFACTS,
  ], spawnOptions);
  if (unstage.code !== 0) {
    throw new Error(`git reset failed in ${dir}: ${unstage.stderr.trim()}`);
  }
  const r = await spawnCapture(
    'git', ['-C', dir, 'diff', '--cached', baseRef], spawnOptions,
  );
  if (r.code !== 0) throw new Error(`git diff failed in ${dir}: ${r.stderr.trim()}`);
  return r.stdout;
}

async function preservePartialExecutorWork(dir, baseRef = 'HEAD', createDiff = diffText) {
  const diff = await createDiff(dir, baseRef, { timeoutMs: PARTIAL_WORK_GIT_TIMEOUT_MS });
  if (diff.trim() === '') return null;
  writeFileSync(join(dir, 'CHANGES.diff'), diff);
  const commit = await spawnCapture('git', [
    '-C', dir,
    '-c', 'user.email=ccc@local',
    '-c', 'user.name=ccc',
    'commit', '--no-verify', '-m', 'preserve partial executor work before termination',
  ], { timeoutMs: PARTIAL_WORK_GIT_TIMEOUT_MS });
  if (commit.code !== 0) {
    throw new Error(`git commit failed while preserving executor work: ${commit.stderr.trim()}`);
  }
  return diff;
}

export function mergeVerifierVerdicts(correctnessVerdict, intentVerdict) {
  if (correctnessVerdict === 'NO_BLOCKERS' && intentVerdict === 'NO_BLOCKERS') {
    return 'NO_BLOCKERS';
  }
  if ((correctnessVerdict === 'UNVERIFIED' && intentVerdict !== 'ISSUES')
    || (intentVerdict === 'UNVERIFIED' && correctnessVerdict !== 'ISSUES')) {
    return 'UNVERIFIED';
  }
  return 'ISSUES';
}

export function reviewOutcomeFor(correctness, intent) {
  if (correctness.timedOut || intent.timedOut) return 'timed-out';
  if (correctness.launchFailed || intent.launchFailed
    || correctness.verdict === 'UNVERIFIED' || intent.verdict === 'UNVERIFIED') {
    return 'verifier-failed';
  }
  return 'review-ready';
}

function planWithGateFailure(plan, gateResult) {
  const failed = gateResult.results.find((result) => result.code !== 0);
  if (!failed) {
    return `${plan}\n\n## Previous gate attempt failed\n\n` +
      'The previous executor attempt failed the gate, but no failing command details were ' +
      'available. Repair the previous attempt while continuing to follow the original task above.';
  }

  const command = JSON.stringify({ bin: failed.bin, args: failed.args });
  return `${plan}\n\n## Previous gate attempt failed\n\n` +
    'The previous executor attempt failed the gate. Repair this failure while continuing to ' +
    'follow the original task above. This section is retry context, not a new task requirement.\n\n' +
    `Command: ${command}\n` +
    `Exit code: ${failed.code}\n\n` +
    `### Output tail\n\n${failed.outputTail}`;
}

export function planWithStallNotice(plan, stall) {
  const last = stall?.lastEvent ?? {};
  const lastEvent = `${last.stage ?? 'unknown'}/${last.type ?? 'unknown'}`;
  return `${plan}\n\n## Previous executor attempt stalled\n\n` +
    `The previous executor attempt was stopped after ${stall?.gapMs ?? 'an unknown number of'} ` +
    'milliseconds without an event. Continue the original task above, but first inspect the ' +
    'partial work already present in the isolated directory. This section is retry context, ' +
    'not a new task requirement.\n\n' +
    `Last event: ${lastEvent}`;
}

function planWithDecision(plan, questions, resolution) {
  const answers = Array.isArray(resolution?.answers) ? resolution.answers : [];
  const basePlan = typeof resolution?.amendedPlan === 'string'
    ? resolution.amendedPlan
    : plan;
  const pairs = questions.map((question) => {
    const answer = answers.find((candidate) => candidate?.id === question.id);
    const lines = [
      `### ${question.id}`,
      '',
      `Question: ${question.question}`,
      `Answer: ${answer?.answer ?? '(no answer provided)'}`,
    ];
    if (answer?.assumption) lines.push(`Assumption: ${answer.assumption}`);
    if (answer?.flaggedForHuman !== undefined) {
      lines.push(`Flagged for human: ${answer.flaggedForHuman ? 'yes' : 'no'}`);
    }
    return lines.join('\n');
  });
  return `${basePlan}\n\n## Decision — resolved autonomously\n\n${pairs.join('\n\n')}` +
    '\n\nProceed with the original task above, incorporating these decisions.';
}

function validatedResolution(questions, resolution) {
  const supplied = Array.isArray(resolution?.answers) ? resolution.answers : [];
  const answers = questions.map((question) => supplied.find((answer) => (
    answer?.id === question.id
      && typeof answer.answer === 'string'
      && answer.answer.trim() !== ''
  )));
  if (answers.some((answer) => answer === undefined)) return null;

  const hasAuthorityQuestion = questions.some((question) => question.kind === 'authority');
  if (!hasAuthorityQuestion) return { answers };
  const operatorAbsent = resolution?.escalation === 'operator-absent'
    && resolution?.presenceEvidence?.ttyAttached === false
    && resolution?.presenceEvidence?.invocation === 'non-interactive'
    && typeof resolution?.reasoning === 'string'
    && resolution.reasoning.trim() !== '';
  if (!operatorAbsent) return null;
  return {
    answers,
    escalation: 'operator-absent',
    presenceEvidence: resolution.presenceEvidence,
    reasoning: resolution.reasoning.trim(),
  };
}

const APPROVAL_REQUEST = /(?:^|[.!?]\s+|\n\s*)(?:please\s+)?approve\s+(?:this|the)\s+(?:design|plan|proposal|approach)(?=\s*(?:[,.!?;:]|$|\band\b|\bso\b|\bbefore\b))/i;

function executorRequestedApproval(result) {
  const messages = Array.isArray(result?.agentMessages) ? [...result.agentMessages] : [];
  if (messages.length === 0 && typeof result?.lastMessage === 'string') {
    messages.push(result.lastMessage);
  }
  return messages.some((message) => typeof message === 'string' && APPROVAL_REQUEST.test(message));
}

export async function run(opts) {
  const startedAt = new Date();
  const {
    task, target, gate, gateRetries, scratchRoot, runId,
    baseRef = 'HEAD', branch, branchName, correctsRunId, campaignId, campaignBase,
    round, unitId, campaignUnitKind, perspective, unitKind, merge,
    captureTestCount = false,
    executorModel = DEFAULT_EXECUTOR_MODEL,
    executorEffort = DEFAULT_EXECUTOR_EFFORT,
    verifierModel = DEFAULT_VERIFIER_MODEL,
    verifierBin = 'agent', verifierProbeCompleted = false,
    mode = 'manual', decisionResolver, challengeRounds = 2,
    debateRounds,
    adapters = {}, reporter,
  } = opts;
  const physicalRunId = physicalRunIdFor(runId);
  if (mode !== 'manual' && mode !== 'autonomous') {
    throw new Error(`invalid mode: ${mode}; expected manual or autonomous`);
  }
  if (!Number.isInteger(challengeRounds) || challengeRounds < 1) {
    throw new Error(`invalid challengeRounds: ${challengeRounds}; expected a positive integer`);
  }
  const maxChallengeRounds = Math.min(challengeRounds, 2);
  const runExecutor = adapters.runExecutor ?? realExecutor;
  const runGate = adapters.runGate ?? realGate;
  const runVerifier = adapters.runVerifier ?? realVerifier;
  const isolateRun = adapters.isolate ?? isolate;
  const createDiff = adapters.diffText ?? diffText;
  const detectDebateCircling = adapters.detectCircling ?? detectCircling;
  const selectPivot = adapters.shouldPivot ?? shouldPivot;
  const maxDebateRounds = resolveDebateRounds(opts.env ?? process.env, debateRounds);
  const superpowersDir = opts.superpowersDir === undefined
    ? resolveSuperpowersDir({ env: opts.env ?? process.env, home: opts.home ?? homedir() })
    : opts.superpowersDir;
  const originalPlan = resolveTask(task);
  let plan = originalPlan;
  const commands = Array.isArray(gate) ? gate : JSON.parse(readFileSync(gate, 'utf8'));
  const stageTimeouts = resolveStageTimeouts(opts.env ?? process.env, opts);
  const probeVerifier = adapters.probeVerifier
    ?? (adapters.runVerifier === undefined ? probeVerifierLiveness : null);
  if (!verifierProbeCompleted && probeVerifier) {
    const probe = await probeVerifier({ bin: verifierBin });
    if (!probe?.ok) throw new Error(`preflight failed: ${probe?.reason
      ?? `verifier liveness probe failed for ${verifierBin}`}`);
  }

  // The reporter is the policy/restart boundary. Seat liveness thresholds are always resolved,
  // but without a reporter the run allocates no event watchdog or restart controller.
  let watchdog = null;
  let eventReporter = reporter;
  let stallConfig = null;
  const executorThresholds = {
    ...resolveExecutorThresholds(opts.env ?? process.env),
    ...(opts.stallThresholdMs === undefined ? {} : { thresholdMs: opts.stallThresholdMs }),
    ...(opts.progressThresholdMs === undefined
      ? {} : { progressThresholdMs: opts.progressThresholdMs }),
  };
  let activeExecutor = null;
  let stallRestartCount = 0;
  let stallRecords = null;
  if (typeof reporter === 'function') {
    stallConfig = {
      ...resolveStallConfig(opts.env ?? process.env),
      ...executorThresholds,
      ...(opts.stallPolicy === undefined ? {} : { policy: opts.stallPolicy }),
      ...(opts.stallRestartLimit === undefined ? {} : { restartLimit: opts.stallRestartLimit }),
    };
    stallRecords = [];
    watchdog = createGapWatchdog({
      reporter,
      runId,
      thresholdMs: stallConfig.thresholdMs,
      onStall: async (event) => {
        let action = 'report';
        const executorSlot = activeExecutor;
        if (stallConfig.policy === 'restart'
          && executorSlot?.controller
          && stallRestartCount < stallConfig.restartLimit) {
          stallRestartCount++;
          action = 'restart';
          executorSlot.restartEvent = event;
        }
        stallRecords.push({
          ts: event.ts,
          stage: event.stage,
          gapMs: event.gapMs,
          thresholdMs: event.thresholdMs,
          lastEvent: event.lastEvent,
          setting: event.setting,
          policy: stallConfig.policy,
          action,
          ...(action === 'restart' ? { restart: stallRestartCount } : {}),
        });
        if (action === 'restart') {
          await executorSlot.beforeKill(event);
          if (activeExecutor === executorSlot) executorSlot.controller.abort(event);
        }
      },
    });
    eventReporter = watchdog.reporter;
  }

  const runMarker = createRunMarker({ scratchRoot, runId, target });
  try {
  const iso = await isolateRun({
    target,
    runId,
    physicalRunId,
    scratchRoot,
    reporter: eventReporter,
    baseRef,
    branch,
    branchName,
    correctsRunId,
    campaignId,
    campaignBase,
  });
  const mergeConflicts = [];
  const mergeResolutions = [];
  let mergeProgress = null;
  let activeConflict = null;
  let observedAdvanceMerge;
  if (merge !== undefined) observedAdvanceMerge = async (options) => {
    reportEvent(eventReporter, runId, 'merge', 'start', {
      operation: 'advance',
      parentUnitIds: options.parents.map((parent) => parent.unitId),
      nextParentIndex: options.nextParentIndex ?? 1,
    });
    try {
      const progress = await advanceMerge(options);
      reportEvent(eventReporter, runId, 'merge', 'finish', {
        operation: 'advance',
        verdict: progress.complete ? 'merged' : 'conflict',
        nextParentIndex: progress.nextParentIndex,
        ...(progress.conflict ? { conflict: progress.conflict } : {}),
      });
      return progress;
    } catch (error) {
      reportEvent(eventReporter, runId, 'merge', 'finish', {
        operation: 'advance',
        verdict: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  if (merge !== undefined) {
    if (unitKind !== 'merge') throw new Error('merge context requires unitKind "merge"');
    if (!Array.isArray(merge.parents) || merge.parents.length < 2) {
      throw new Error('merge unit requires at least two ordered parents');
    }
    if (!merge.testCounts || !Number.isSafeInteger(merge.testCounts.required)) {
      throw new Error('merge unit requires derived test counts');
    }
    mergeProgress = await observedAdvanceMerge({
      cwd: iso.dir,
      parents: merge.parents,
      unitId: runId,
    });
    activeConflict = mergeProgress.conflict;
    if (activeConflict) mergeConflicts.push(activeConflict);
    plan = buildMergeTask(originalPlan, merge, activeConflict);
  }
  const iterations = [];
  let gateStatus = 'failed';
  let verdict = null;
  let outcome = 'gate-failed';
  let executorUsage = EMPTY_USAGE;
  let verifierUsage = EMPTY_USAGE;
  const usageChecks = [];
  let gateFailure = null;
  const timeoutEvents = [];
  let gateRetryCount = 0;
  let executorLaunchCount = 0;
  let noOpReason;
  const debateLedger = new DebateLedger();
  const debateRoundHistory = [];
  let debateCirclingDetected = false;
  let debatePivotCount = 0;
  let finalPivotDecision = null;
  let debateStopReason = 'not-started';

  const recordExecutorTimeout = (exec, iteration, attempt) => {
    if (!exec.timedOut) return;
    timeoutEvents.push({
      stage: 'executor', iteration, attempt,
      timeoutMs: exec.timeoutReason?.timeoutMs ?? exec.timeoutMs ?? stageTimeouts.executor,
      ...(exec.timeoutReason?.kind ? { reason: exec.timeoutReason.kind } : {}),
      ...(Number.isFinite(exec.timeoutReason?.gapMs)
        ? { gapMs: exec.timeoutReason.gapMs } : {}),
      ...(exec.timeoutReason?.lastEvent
        ? { lastEvent: exec.timeoutReason.lastEvent } : {}),
      ...(exec.timeoutReason?.setting ? { setting: exec.timeoutReason.setting } : {}),
    });
  };
  const recordGateTimeout = (gateResult, iteration, attempt) => {
    for (const result of gateResult?.results ?? []) {
      if (!result.timedOut) continue;
      timeoutEvents.push({
        stage: 'gate', iteration, attempt,
        timeoutMs: result.timeoutMs ?? stageTimeouts.gate,
        bin: result.bin,
        args: result.args,
      });
    }
  };

  let n = 1;
  const observeUsage = (result, context) => {
    const annotated = annotateUsageConsistency(result);
    const consistency = annotated?.usageConsistency ?? checkUsageConsistency(result?.usage);
    usageChecks.push({ ...context, ...consistency });
    return annotated;
  };
  let iterationExecutorUsage = EMPTY_USAGE;
  const executePlan = async (basePlan) => {
    let attemptPlan = basePlan;
    while (true) {
      const attempt = ++executorLaunchCount;
      const executorPlan = `${EXECUTOR_PREAMBLE}\n\n${attemptPlan}`;
      writeFileSync(join(iso.dir, 'TASK.md'), executorPlan);
      const controller = stallConfig?.policy === 'restart'
        && stallRestartCount < stallConfig.restartLimit
        ? new AbortController()
        : null;
      let preservation = null;
      const beforeKill = () => {
        if (!preservation) {
          const diffBase = merge === undefined ? iso.baseCommit : merge.mergeBase;
          preservation = preservePartialExecutorWork(iso.dir, diffBase, createDiff).catch(() => null);
        }
        return preservation;
      };
      const slot = { controller, restartEvent: null, beforeKill };
      activeExecutor = slot;
      let result;
      try {
        result = observeUsage(await runExecutor({
          plan: executorPlan, cwd: iso.dir, model: executorModel, effort: executorEffort,
          superpowersDir,
          env: opts.env ?? process.env,
          timeoutMs: stageTimeouts.executor,
          reporter: eventReporter, runId, attempt,
          beforeKill,
          onLiveness: () => watchdog?.touch('executor'),
          livenessThresholdMs: executorThresholds.thresholdMs,
          progressThresholdMs: executorThresholds.progressThresholdMs,
          ...(controller ? { signal: controller.signal } : {}),
        }), { seat: 'executor', iteration: n, attempt });
      } finally {
        if (activeExecutor === slot) activeExecutor = null;
      }
      iterationExecutorUsage = addUsage(iterationExecutorUsage, result.usage);
      executorUsage = addUsage(executorUsage, result.usage);
      recordExecutorTimeout(result, n, attempt);
      if (!slot?.restartEvent) return result;

      reportEvent(eventReporter, runId, 'executor', 'retry', {
        attempt: attempt + 1,
        source: 'stall',
        reason: `no event for ${slot.restartEvent.gapMs} ms`,
        gapMs: slot.restartEvent.gapMs,
        lastEvent: slot.restartEvent.lastEvent,
      });
      attemptPlan = planWithStallNotice(basePlan, slot.restartEvent);
    }
  };

  let exec;
  let conflictingIntent = false;
  let mergePreparationFailure = null;
  while (true) {
    exec = await executePlan(plan);
    if (exec.timedOut || !activeConflict) break;

    const ledger = readMergeLedger({ cwd: iso.dir, conflict: activeConflict, executorResult: exec });
    reportEvent(eventReporter, runId, 'merge', 'start', {
      operation: 'review-resolution',
      parentUnitIds: [activeConflict.parentUnitId],
      paths: activeConflict.paths,
    });
    if (!ledger.ok) {
      mergePreparationFailure = ledger.reason;
      reportEvent(eventReporter, runId, 'merge', 'finish', {
        operation: 'review-resolution',
        verdict: 'failed',
        reason: ledger.reason,
      });
      break;
    }
    mergeResolutions.push(...ledger.resolutions);
    reportEvent(eventReporter, runId, 'merge', 'finish', {
      operation: 'review-resolution',
      verdict: ledger.status,
      reasoning: ledger.resolutions.map((resolution) => ({
        path: resolution.path,
        chosen: resolution.chosen,
        reason: resolution.reason,
      })),
    });
    if (ledger.status === 'conflicting-intent') {
      conflictingIntent = true;
      break;
    }
    reportEvent(eventReporter, runId, 'merge', 'start', {
      operation: 'conclude-conflict',
      parentUnitIds: [activeConflict.parentUnitId],
      paths: activeConflict.paths,
    });
    let concludedConflict;
    try {
      concludedConflict = await concludeConflict({
        cwd: iso.dir,
        conflict: activeConflict,
        unitId: runId,
      });
      reportEvent(eventReporter, runId, 'merge', 'finish', {
        operation: 'conclude-conflict',
        verdict: concludedConflict.ok ? 'resolved' : 'failed',
        ...(concludedConflict.reason ? { reason: concludedConflict.reason } : {}),
      });
    } catch (error) {
      reportEvent(eventReporter, runId, 'merge', 'finish', {
        operation: 'conclude-conflict',
        verdict: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (!concludedConflict.ok) {
      mergePreparationFailure = concludedConflict.reason;
      break;
    }
    clearMergeLedger(iso.dir);
    mergeProgress = await observedAdvanceMerge({
      cwd: iso.dir,
      parents: merge.parents,
      nextParentIndex: mergeProgress.nextParentIndex + 1,
      unitId: runId,
    });
    activeConflict = mergeProgress.conflict;
    if (!activeConflict) break;
    mergeConflicts.push(activeConflict);
    plan = buildMergeTask(originalPlan, merge, activeConflict);
  }
  let retries = 0;
  let executorTimedOut = Boolean(exec.timedOut);
  let challengeRound = 0;
  let decision = null;
  let resolvedDecision = null;
  let assumedDecision = null;
  const routeChallenges = async () => {
    while (!executorTimedOut && !conflictingIntent && mergePreparationFailure === null) {
      const challenge = detectChallenge({ dir: iso.dir });
      if (!challenge.challenged) break;

      const substantiveDiff = await createDiff(
        iso.dir,
        merge === undefined ? iso.baseCommit : merge.mergeBase,
      );
      if (substantiveDiff.trim() !== '') break;

      challengeRound++;
      reportEvent(eventReporter, runId, 'decision', 'challenged', {
        questions: challenge.questions,
      });
      if (mode !== 'autonomous'
        || typeof decisionResolver !== 'function'
        || challengeRound >= maxChallengeRounds) {
        decision = { questions: challenge.questions, mode, challengeRound };
        break;
      }

      const resolution = await decisionResolver({
        questions: challenge.questions,
        plan,
        task: originalPlan,
      });
      const validated = validatedResolution(challenge.questions, resolution);
      if (validated === null) {
        decision = { questions: challenge.questions, mode, challengeRound };
        break;
      }
      const answeredBy = 'planner';
      const answers = validated.answers;
      resolvedDecision = {
        questions: challenge.questions,
        answers,
        answeredBy,
        mode,
        challengeRound,
        ...(validated.escalation === undefined ? {} : {
          escalation: validated.escalation,
          presenceEvidence: validated.presenceEvidence,
          reasoning: validated.reasoning,
        }),
      };
      if (validated.escalation === 'operator-absent') assumedDecision = resolvedDecision;
      plan = planWithDecision(plan, challenge.questions, { ...resolution, answers });
      unlinkSync(join(iso.dir, 'DECISION.md'));
      reportEvent(eventReporter, runId, 'decision', 'resolved', { answers, answeredBy });
      if (validated.escalation === 'operator-absent') {
        reportEvent(eventReporter, runId, 'decision', 'assumed', {
          questions: challenge.questions,
          answers,
          answeredBy,
          escalation: validated.escalation,
          presenceEvidence: validated.presenceEvidence,
          reasoning: validated.reasoning,
        });
      }
      exec = await executePlan(plan);
      executorTimedOut = Boolean(exec.timedOut);
    }
  };
  await routeChallenges();
  // Gate retries rerun the executor within this single controller-driven pass.
  let gateResult = null;
  const mergeGateCommands = merge === undefined
    ? commands
    : [...commands, testCountFloorCommand(merge.testCounts.required)];
  if (decision === null && !executorTimedOut && !conflictingIntent
    && mergePreparationFailure === null) {
    gateResult = await runGate({
      commands: mergeGateCommands, cwd: iso.dir, timeoutMs: stageTimeouts.gate,
      reporter: eventReporter, runId, attempt: 1,
      captureTestCount,
    });
    recordGateTimeout(gateResult, n, 1);
  } else if (!executorTimedOut && mergePreparationFailure !== null) {
    gateResult = {
      passed: false,
      results: [{
        bin: 'ccc-merge-ledger',
        args: [],
        code: 1,
        outputTail: mergePreparationFailure,
      }],
    };
  }
  while (decision === null && !executorTimedOut && !conflictingIntent
    && mergePreparationFailure === null
    && !gateResult.passed && retries < gateRetries) {
    retries++;
    gateRetryCount++;
    const retryPlan = planWithGateFailure(plan, gateResult);
    const failed = gateResult.results.find((result) => result.code !== 0);
    reportEvent(eventReporter, runId, 'executor', 'retry', {
      attempt: executorLaunchCount + 1,
      source: 'gate',
      reason: failed ? `gate command exited ${failed.code}` : 'gate did not pass',
      ...(failed ? { bin: failed.bin, args: failed.args, code: failed.code } : {}),
    });
    exec = await executePlan(retryPlan);
    executorTimedOut = Boolean(exec.timedOut);
    await routeChallenges();
    if (decision === null && !executorTimedOut) {
      gateResult = await runGate({
        commands: mergeGateCommands, cwd: iso.dir, timeoutMs: stageTimeouts.gate,
        reporter: eventReporter, runId, attempt: retries + 1,
        captureTestCount,
      });
      recordGateTimeout(gateResult, n, retries + 1);
    }
  }
  const makeIteration = (iteration, executorResult, iterationGate, timedOut) => ({
    n: iteration,
    changedFiles: executorResult.changedFiles,
    lastMessage: executorResult.lastMessage,
    executorUsage: iterationExecutorUsage,
    executor: {
      exitCode: Number.isInteger(executorResult.exitCode) ? executorResult.exitCode : null,
      timedOut,
      timeoutMs: executorResult.timeoutReason?.timeoutMs
        ?? executorResult.timeoutMs ?? stageTimeouts.executor,
      ...(executorResult.timeoutReason ? { timeoutReason: executorResult.timeoutReason } : {}),
      ...(executorResult.usageConsistency
        ? { usageConsistency: executorResult.usageConsistency } : {}),
    },
    gate: iterationGate,
    verifier: null,
    intentVerifier: null,
  });
  let iter = makeIteration(n, exec, gateResult, executorTimedOut);

  if (executorTimedOut) {
    gateStatus = gateResult ? 'failed' : 'not-run';
    outcome = 'timed-out';
    debateStopReason = 'executor-timed-out';
    iterations.push(iter);
  } else if (conflictingIntent) {
    gateStatus = 'not-run';
    outcome = 'conflicting-intent';
    debateStopReason = 'conflicting-intent';
    iterations.push(iter);
  } else if (decision !== null) {
    gateStatus = 'not-run';
    outcome = 'needs-decision';
    debateStopReason = 'needs-decision';
    iterations.push(iter);
  } else if (!gateResult.passed) {
    gateStatus = 'failed';
    const failed = gateResult.results.find((result) => result.code !== 0);
    outcome = failed?.timedOut ? 'timed-out' : 'gate-failed';
    debateStopReason = 'gate-failed';
    if (failed) {
      gateFailure = {
        bin: failed.bin,
        args: failed.args,
        ...(failed.harness === undefined ? {} : { harness: failed.harness }),
        code: failed.code,
        ...(failed.timedOut ? { timedOut: true, timeoutMs: failed.timeoutMs } : {}),
        outputTail: failed.outputTail,
      };
    }
    iterations.push(iter);
  } else {
    gateStatus = 'passed';
    const refreshDiff = async () => {
      reportEvent(eventReporter, runId, 'diff', 'start');
      const value = await createDiff(
        iso.dir,
        merge === undefined ? iso.baseCommit : merge.mergeBase,
      );
      if (value.trim() === '') {
        reportEvent(eventReporter, runId, 'diff', 'finish', { verdict: 'empty' });
      } else {
        writeFileSync(join(iso.dir, 'CHANGES.diff'), value);
        reportEvent(eventReporter, runId, 'diff', 'finish', {
          verdict: 'produced', file: 'CHANGES.diff',
        });
      }
      return value;
    };
    let diff = await refreshDiff();
    if (diff.trim() === '') {
      // A non-zero exit with no diff is a crashed/aborted executor, not a legitimate no-op.
      outcome = Number.isInteger(iter.executor.exitCode) && iter.executor.exitCode !== 0
        ? 'executor-failed'
        : 'no-op';
      debateStopReason = 'no-substantive-diff';
      if (outcome === 'no-op'
        && iter.executor.exitCode === 0
        && !existsSync(join(iso.dir, 'DECISION.md'))
        && executorRequestedApproval(exec)) {
        noOpReason = 'approval-requested';
      }
      iterations.push(iter);
    } else {
      let debateRound = 0;
      while (true) {
        debateRound++;
        const v = annotateVerifierConsistency(observeUsage(await runVerifier({
          cwd: iso.dir, bin: verifierBin, model: verifierModel, prompt: DEFAULT_PROMPT,
          superpowersDir,
          env: opts.env ?? process.env,
          timeoutMs: stageTimeouts.verifier,
          reporter: eventReporter, runId, pass: 'correctness',
          onLiveness: () => watchdog?.touch('verify'),
          livenessThresholdMs: executorThresholds.thresholdMs,
          progressThresholdMs: executorThresholds.progressThresholdMs,
        }), { seat: 'verifier', pass: 'correctness', iteration: n }));
        const intentVerifier = annotateVerifierConsistency(observeUsage(await runVerifier({
          cwd: iso.dir, bin: verifierBin, model: verifierModel, prompt: INTENT_PROMPT,
          superpowersDir,
          env: opts.env ?? process.env,
          timeoutMs: stageTimeouts.verifier,
          reporter: eventReporter, runId, pass: 'intent',
          onLiveness: () => watchdog?.touch('verify'),
          livenessThresholdMs: executorThresholds.thresholdMs,
          progressThresholdMs: executorThresholds.progressThresholdMs,
        }), { seat: 'verifier', pass: 'intent', iteration: n }));
        const recordVerifierTimeout = (result, pass) => {
          if (!result.timedOut) return;
          timeoutEvents.push({
            stage: 'verifier', pass, iteration: n,
            timeoutMs: result.timeoutReason?.timeoutMs
              ?? result.timeoutMs ?? stageTimeouts.verifier,
            ...(result.timeoutReason?.kind ? { reason: result.timeoutReason.kind } : {}),
            ...(Number.isFinite(result.timeoutReason?.gapMs)
              ? { gapMs: result.timeoutReason.gapMs } : {}),
            ...(result.timeoutReason?.lastEvent
              ? { lastEvent: result.timeoutReason.lastEvent } : {}),
            ...(result.timeoutReason?.setting
              ? { setting: result.timeoutReason.setting } : {}),
          });
        };
        recordVerifierTimeout(v, 'correctness');
        recordVerifierTimeout(intentVerifier, 'intent');
        verifierUsage = addUsage(verifierUsage, v.usage);
        verifierUsage = addUsage(verifierUsage, intentVerifier.usage);
        iter.verifier = v;
        iter.intentVerifier = intentVerifier;
        verdict = mergeVerifierVerdicts(v.verdict, intentVerifier.verdict);
        reportEvent(eventReporter, runId, 'verify', 'verdict', {
          verdict, source: 'merged',
        });

        const findings = collectReviewFindings(iso.dir, v, intentVerifier);
        const blockingFindings = findings.filter((finding) => finding.severity === 'blocking');
        const suggestionFindings = findings.filter((finding) => finding.severity === 'suggestion');
        const findingIds = findings.map((finding) => finding.id);
        const blockingFindingIds = blockingFindings.map((finding) => finding.id);
        debateLedger.record(debateRound, blockingFindingIds);
        debateRoundHistory.push({
          round: debateRound,
          findingIds,
          blockingFindingIds,
          suggestionFindingIds: suggestionFindings.map((finding) => finding.id),
          findings: findings.map((finding) => ({ ...finding })),
          verdict,
        });
        reportEvent(eventReporter, runId, 'debate', 'round', {
          debateRound,
          findingIds,
          blockingFindingIds,
          suggestionFindingIds: suggestionFindings.map((finding) => finding.id),
          verdict,
        });
        iterations.push(iter);
        const circling = detectDebateCircling(debateLedger);

        const reviewOutcome = reviewOutcomeFor(v, intentVerifier);
        if (reviewOutcome !== 'review-ready') {
          outcome = reviewOutcome;
          debateStopReason = v.verdict === 'UNVERIFIED' || intentVerifier.verdict === 'UNVERIFIED'
            ? 'unverified'
            : reviewOutcome;
          break;
        }

        if (blockingFindings.length === 0) {
          outcome = 'review-ready';
          debateStopReason = 'converged';
          reportEvent(eventReporter, runId, 'debate', 'converged', {
            debateRound,
            resolvedFindingIds: [...debateLedger.resolvedFindings()],
            suggestionFindingIds: suggestionFindings.map((finding) => finding.id),
          });
          break;
        }

        reportEvent(eventReporter, runId, 'debate', 'resist', {
          debateRound,
          findingIds: blockingFindingIds,
        });

        let amendPlan = false;
        if (circling) {
          debateCirclingDetected = true;
          const stuckFindingIds = [...debateLedger.stuckFindings()];
          reportEvent(eventReporter, runId, 'debate', 'circling', {
            debateRound,
            stuckFindingIds,
          });
          const pivotDecision = selectPivot(debatePivotCount);
          if (![PIVOT_AMEND, PIVOT_FRESH, PIVOT_CONCLUDE].includes(pivotDecision)) {
            throw new Error(`invalid debate pivot decision: ${pivotDecision}`);
          }
          // AMEND promises another executor/review round, so it is not a taken pivot
          // when the configured round bound makes that retry impossible.
          if (pivotDecision === PIVOT_AMEND && maxDebateRounds !== undefined
            && debateRound >= maxDebateRounds) {
            outcome = 'needs-pivot';
            debateStopReason = 'rounds-exhausted';
            break;
          }
          finalPivotDecision = pivotDecision;
          debatePivotCount++;
          reportEvent(eventReporter, runId, 'debate', 'pivot', {
            debateRound,
            decision: pivotDecision,
            pivotCount: debatePivotCount,
            stuckFindingIds,
          });
          if (pivotDecision === PIVOT_FRESH || pivotDecision === PIVOT_CONCLUDE) {
            outcome = 'needs-pivot';
            debateStopReason = 'pivot';
            break;
          }
          amendPlan = true;
        }

        if (maxDebateRounds !== undefined && debateRound >= maxDebateRounds) {
          outcome = 'needs-pivot';
          debateStopReason = 'rounds-exhausted';
          break;
        }

        const validation = validateFindings(blockingFindings);
        let fixPlan = buildFixPlan({
          findings: blockingFindings,
          accepted: validation.accepted,
          rejected: validation.rejected,
          originalTask: originalPlan,
        });
        if (amendPlan) fixPlan = amendFixPlanWithLedger(fixPlan, debateLedger);
        plan = fixPlan;
        n++;
        iterationExecutorUsage = EMPTY_USAGE;
        exec = await executePlan(plan);
        executorTimedOut = Boolean(exec.timedOut);
        await routeChallenges();

        let fixGateRetries = 0;
        gateResult = null;
        if (decision === null && !executorTimedOut && !conflictingIntent
          && mergePreparationFailure === null) {
          gateResult = await runGate({
            commands: mergeGateCommands, cwd: iso.dir, timeoutMs: stageTimeouts.gate,
            reporter: eventReporter, runId, attempt: 1,
            captureTestCount,
          });
          recordGateTimeout(gateResult, n, 1);
        }
        while (decision === null && !executorTimedOut && !conflictingIntent
          && mergePreparationFailure === null && !gateResult.passed
          && fixGateRetries < gateRetries) {
          fixGateRetries++;
          gateRetryCount++;
          const retryPlan = planWithGateFailure(plan, gateResult);
          const failed = gateResult.results.find((result) => result.code !== 0);
          reportEvent(eventReporter, runId, 'executor', 'retry', {
            attempt: executorLaunchCount + 1,
            source: 'gate',
            reason: failed ? `gate command exited ${failed.code}` : 'gate did not pass',
            ...(failed ? { bin: failed.bin, args: failed.args, code: failed.code } : {}),
          });
          exec = await executePlan(retryPlan);
          executorTimedOut = Boolean(exec.timedOut);
          await routeChallenges();
          if (decision === null && !executorTimedOut) {
            gateResult = await runGate({
              commands: mergeGateCommands, cwd: iso.dir, timeoutMs: stageTimeouts.gate,
              reporter: eventReporter, runId, attempt: fixGateRetries + 1,
              captureTestCount,
            });
            recordGateTimeout(gateResult, n, fixGateRetries + 1);
          }
        }

        iter = makeIteration(n, exec, gateResult, executorTimedOut);
        if (executorTimedOut) {
          gateStatus = gateResult ? 'failed' : 'not-run';
          outcome = 'timed-out';
          debateStopReason = 'executor-timed-out';
          iterations.push(iter);
          break;
        }
        if (conflictingIntent) {
          gateStatus = 'not-run';
          outcome = 'conflicting-intent';
          debateStopReason = 'conflicting-intent';
          iterations.push(iter);
          break;
        }
        if (decision !== null) {
          gateStatus = 'not-run';
          outcome = 'needs-decision';
          debateStopReason = 'needs-decision';
          iterations.push(iter);
          break;
        }
        if (!gateResult.passed) {
          gateStatus = 'failed';
          const failed = gateResult.results.find((result) => result.code !== 0);
          outcome = failed?.timedOut ? 'timed-out' : 'gate-failed';
          debateStopReason = 'gate-failed';
          if (failed) {
            gateFailure = {
              bin: failed.bin,
              args: failed.args,
              ...(failed.harness === undefined ? {} : { harness: failed.harness }),
              code: failed.code,
              ...(failed.timedOut
                ? { timedOut: true, timeoutMs: failed.timeoutMs } : {}),
              outputTail: failed.outputTail,
            };
          }
          iterations.push(iter);
          break;
        }

        gateStatus = 'passed';
        diff = await refreshDiff();
        if (diff.trim() === '') {
          outcome = Number.isInteger(iter.executor.exitCode) && iter.executor.exitCode !== 0
            ? 'executor-failed'
            : 'no-op';
          debateStopReason = 'no-substantive-diff';
          iterations.push(iter);
          break;
        }
      }
    }
  }

  const lastVerifier = iterations.findLast((iteration) => iteration.verifier)?.verifier;
  const verifierFindings = lastVerifier?.findings ?? null;
  const correctnessVerdict = lastVerifier?.verdict ?? null;
  const correctnessVerdictSource = lastVerifier?.verdictSource ?? null;
  const verdictSource = lastVerifier?.verdictSource ?? null;
  const verifierPlan = lastVerifier?.plan ?? null;
  const verifierEvidence = lastVerifier?.verdictEvidence ?? null;
  const verifierConsistency = lastVerifier?.verdictConsistency ?? null;
  const lastIntentVerifier = iterations.findLast(
    (iteration) => iteration.intentVerifier,
  )?.intentVerifier;
  const intentVerifierFindings = lastIntentVerifier?.findings ?? null;
  const intentVerdict = lastIntentVerifier?.verdict ?? null;
  const intentVerdictSource = lastIntentVerifier?.verdictSource ?? null;
  const intentVerifierPlan = lastIntentVerifier?.plan ?? null;
  const intentVerifierEvidence = lastIntentVerifier?.verdictEvidence ?? null;
  const intentVerifierConsistency = lastIntentVerifier?.verdictConsistency ?? null;
  const tokens = {
    executor: executorUsage,
    verifier: verifierUsage,
    total: addUsage(executorUsage, verifierUsage),
  };
  const usageConsistency = summarizeUsageConsistency(usageChecks);
  const blockingOccurrences = new Map();
  const observedOccurrences = new Map();
  for (const roundRecord of debateRoundHistory) {
    for (const findingId of roundRecord.findingIds) {
      observedOccurrences.set(findingId, (observedOccurrences.get(findingId) ?? 0) + 1);
    }
    for (const findingId of roundRecord.blockingFindingIds) {
      blockingOccurrences.set(findingId, (blockingOccurrences.get(findingId) ?? 0) + 1);
    }
  }
  const ledgerHistory = debateRoundHistory.map((roundRecord) => ({
    round: roundRecord.round,
    findingIds: [...roundRecord.blockingFindingIds],
  }));
  const debate = {
    roundsRun: debateRoundHistory.length,
    maxRounds: maxDebateRounds ?? null,
    findingsPerRound: debateRoundHistory.map((roundRecord) => [...roundRecord.findingIds]),
    roundHistory: debateRoundHistory.map((roundRecord) => ({
      ...roundRecord,
      findingIds: [...roundRecord.findingIds],
      blockingFindingIds: [...roundRecord.blockingFindingIds],
      suggestionFindingIds: [...roundRecord.suggestionFindingIds],
      findings: roundRecord.findings.map((finding) => ({ ...finding })),
    })),
    allFindingIds: [...observedOccurrences.keys()],
    recurredFindingIds: [...observedOccurrences.entries()]
      .filter(([, count]) => count > 1)
      .map(([findingId]) => findingId),
    resolvedFindingIds: [...debateLedger.resolvedFindings()],
    stuckFindingIds: [...debateLedger.stuckFindings()],
    circlingDetected: debateCirclingDetected,
    pivotCount: debatePivotCount,
    finalPivotDecision,
    stopReason: debateStopReason,
    ledger: {
      rounds: ledgerHistory,
      allFindingIds: [...debateLedger.allFindings()],
      recurredFindingIds: [...blockingOccurrences.entries()]
        .filter(([, count]) => count > 1)
        .map(([findingId]) => findingId),
      resolvedFindingIds: [...debateLedger.resolvedFindings()],
      stuckFindingIds: [...debateLedger.stuckFindings()],
    },
  };
  const mergeFacts = merge === undefined ? null : {
    parentOrder: [...merge.parentOrder],
    parents: merge.parents.map((parent) => ({ ...parent })),
    mergeBase: merge.mergeBase,
    conflicts: mergeConflicts.map((conflict) => ({
      parentUnitId: conflict.parentUnitId,
      parentCommit: conflict.parentCommit,
      paths: [...conflict.paths],
    })),
    resolutions: mergeResolutions.map((resolution) => ({ ...resolution })),
    testCounts: {
      ...merge.testCounts,
      parents: merge.testCounts.parents.map((parent) => ({ ...parent })),
      actual: Number.isSafeInteger(gateResult?.testCount)
        ? gateResult.testCount
        : merge.testCounts.source === 'gate-output' ? null : countTestFiles(iso.dir),
    },
  };
  const facts = buildRunFacts({ runId,
    ...(physicalRunId === runId ? {} : { physicalRunId }),
    target, targetPath: resolve(target),
    dir: iso.dir, isRepo: iso.isRepo,
    baseRef: iso.baseRef, baseCommit: iso.baseCommit, branch: iso.branch,
    iterations, gateStatus, verdict, verdictSource,
    correctnessVerdict, correctnessVerdictSource, verifierFindings,
    verifierPlan, verifierEvidence, verifierConsistency,
    intentVerifierFindings, intentVerdict, intentVerdictSource,
    intentVerifierPlan, intentVerifierEvidence, intentVerifierConsistency,
    gateFailure, tokens, usageConsistency, outcome, gateRetries, debate,
    ...(noOpReason === undefined ? {} : { noOpReason }),
    timeouts: stageTimeouts, timeoutEvents,
    ...(campaignId === undefined
      ? {}
      : { campaignId, round, unitId, campaignUnitKind, perspective }),
    supervision: stallConfig ? {
      policy: stallConfig.policy,
      thresholdMs: stallConfig.thresholdMs,
      progressThresholdMs: stallConfig.progressThresholdMs,
      restartLimit: stallConfig.restartLimit,
      restartCount: stallRestartCount,
      gateRetryCount,
      stallEvents: stallRecords,
    } : null,
    ...(unitKind === undefined ? {} : { unitKind }),
    ...(mergeFacts === null ? {} : { merge: mergeFacts }),
    models: {
      executor: executorModel,
      executorEffort,
      verifier: verifierModel,
    },
    skills: superpowersDir,
  });
  if (outcome === 'needs-decision') facts.decision = decision;
  else if (resolvedDecision !== null) facts.decision = resolvedDecision;
  if (assumedDecision !== null) {
    facts.assumedDecision = assumedDecision;
    facts.escalation = 'operator-absent';
  }
  writeReport({ dir: iso.dir, facts, reporter: eventReporter, runId });
  const endedAt = new Date();
  try {
    archiveRunArtifacts({
      dir: iso.dir,
      runId,
      facts,
      scratchRoot,
      artifactRoot: opts.artifactRoot,
      env: opts.env ?? process.env,
      startedAt,
      endedAt,
    });
  } catch (error) {
    facts.artifacts = {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
    try { writeFileSync(join(iso.dir, 'uro-runfacts.json'), JSON.stringify(facts, null, 2)); }
    catch { /* artifact retention is non-fatal */ }
  }
  return facts;
  } finally {
    releaseRunMarker(runMarker);
    watchdog?.dispose();
  }
}
