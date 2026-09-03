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
import { createEvidenceWriter } from './evidence.js';
import { buildReviewerTestCommands, runGate as realGate } from './gate.js';
import {
  DEFAULT_VERIFIER_MODEL,
  REVIEW_PROMPT,
  runReviewPass as realReviewPass,
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
import { detectReview, REVIEW_DIR } from './review.js';
import { buildFixPlan, validateFindings } from './fix-plan.js';
import {
  ARBITER_UNVERIFIED,
  buildArbiterPrompt,
  DEFAULT_ARBITER_MODEL,
  parseIndependentReview,
  parsePivotJudgement,
  runArbiter as realArbiter,
} from './arbiter.js';
import { createAutonomousDecisionResolver } from './decision-resolver.js';
import {
  captureReviewSnapshot,
  restoreReviewSnapshot,
  runProtectedOperation,
  WorktreeRestorationError,
} from './review-protection.js';
import {
  applySuperpowersRequirement,
  verifySuperpowersSeats,
} from './superpowers.js';
import { readEnv } from './env-compat.js';
import { createLivenessJudge } from './liveness-judge.js';
import {
  createMutationArbiter,
  createMutationJudge,
  runMutate as realMutation,
} from './mutate.js';
import {
  DEFAULT_PLAN_CANDIDATES,
  planCandidateFacts,
  runPlanCandidateSet,
  validatePlanCandidateCount,
} from './plan.js';

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

function collectReviewFindings(dir) {
  const candidates = [];
  const detected = detectReview({ dir });
  if (detected.reviewed) candidates.push(...detected.findings);

  // Finding ids are the ledger identity. If the report repeats an id, retain a
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

async function checkedGit(cwd, args, action, spawn = spawnCapture) {
  const result = await spawn('git', ['-C', cwd, ...args]);
  if (result.code !== 0) {
    throw new Error(`${action} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export async function createFreshPivotBranch({
  cwd,
  baseCommit,
  branch,
  captureSnapshot = captureReviewSnapshot,
  restoreSnapshot = restoreReviewSnapshot,
  spawn = spawnCapture,
} = {}) {
  if (typeof cwd !== 'string' || cwd === '') throw new TypeError('fresh pivot cwd is required');
  if (typeof baseCommit !== 'string' || baseCommit === '') {
    throw new TypeError('fresh pivot baseCommit is required');
  }
  if (typeof branch !== 'string' || branch === '') throw new TypeError('fresh pivot branch is required');

  const snapshot = await captureSnapshot({ cwd, prefix: REVIEW_DIR });
  let operationError;
  try {
    // The failed implementation is deliberately abandoned. Clear the disposable
    // worktree before creating the replacement branch at the immutable base; the
    // debate ledger and append-only event history retain the evidence that matters.
    // events.jsonl is append-only run history, not part of the discarded solution.
    // Preserve it across the destructive branch reset so pre-pivot evidence remains visible.
    await checkedGit(
      cwd,
      ['clean', '-ffd', '-x', '-e', 'events.jsonl'],
      'fresh pivot clean',
      spawn,
    );
    await checkedGit(
      cwd,
      ['switch', '--discard-changes', '-c', branch, baseCommit],
      'fresh pivot branch creation',
      spawn,
    );
    await checkedGit(cwd, ['reset', '--hard', baseCommit], 'fresh pivot reset', spawn);
  } catch (error) {
    operationError = error;
  }

  let restoration;
  try {
    restoration = await restoreSnapshot({ snapshot });
  } catch (error) {
    throw new WorktreeRestorationError(
      `failed to restore reviewer tests after creating ${branch}`,
      { cause: error },
    );
  }
  if (operationError) throw operationError;
  const branchPoint = await checkedGit(
    cwd, ['rev-parse', 'HEAD'], 'fresh pivot branch inspection', spawn,
  );
  if (branchPoint !== baseCommit) {
    throw new Error(`fresh pivot branch ${branch} started at ${branchPoint}, expected ${baseCommit}`);
  }
  return {
    branch,
    branchPoint,
    restoredPaths: restoration?.restoredPaths ?? [],
    reviewPaths: [...(snapshot.entries?.keys?.() ?? [])].sort(),
  };
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
    arbiterModel = DEFAULT_ARBITER_MODEL,
    arbiterBin = 'claude',
    mode = 'manual', decisionResolver, challengeRounds = 2,
    debateRounds, tokenBudget, pivotCandidates = DEFAULT_PLAN_CANDIDATES,
    adapters = {}, reporter,
  } = opts;
  const physicalRunId = physicalRunIdFor(runId);
  if (mode !== 'manual' && mode !== 'autonomous') {
    throw new Error(`invalid mode: ${mode}; expected manual or autonomous`);
  }
  if (!Number.isInteger(challengeRounds) || challengeRounds < 1) {
    throw new Error(`invalid challengeRounds: ${challengeRounds}; expected a positive integer`);
  }
  if (tokenBudget !== undefined
    && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1)) {
    throw new Error('tokenBudget must be a positive safe integer');
  }
  validatePlanCandidateCount(pivotCandidates, 'pivotCandidates');
  const maxChallengeRounds = Math.min(challengeRounds, 2);
  const runExecutor = adapters.runExecutor ?? realExecutor;
  const runGate = adapters.runGate ?? realGate;
  // Hermetic guard, same pattern as the arbiter and reviewer seats: a test that
  // injects the executor but not the verifier must never launch the real CLI.
  // Reviews running on a red gate made that reachable for the first time.
  const runReview = adapters.runReview
    ?? (adapters.runExecutor === undefined ? realReviewPass : null);
  const runMutation = adapters.runMutation ?? realMutation;
  const isolateRun = adapters.isolate ?? isolate;
  const createDiff = adapters.diffText ?? diffText;
  const detectDebateCircling = adapters.detectCircling ?? detectCircling;
  const selectPivot = adapters.shouldPivot ?? shouldPivot;
  const createFreshBranch = adapters.createFreshPivotBranch
    ?? adapters.createFreshBranch
    ?? createFreshPivotBranch;
  const generatePlanCandidates = adapters.runPlanCandidateSet
    ?? adapters.runPlanCandidates
    ?? adapters.replan
    ?? runPlanCandidateSet;
  // Injected executor runs are test/embedding seams. They must opt into an arbiter
  // explicitly, so an otherwise hermetic test can never launch the real Claude CLI.
  const runArbiterSeat = adapters.runArbiter
    ?? (adapters.runExecutor === undefined ? realArbiter : null);
  const runEnvironment = opts.env ?? process.env;
  const verifySuperpowers = adapters.verifySuperpowers ?? verifySuperpowersSeats;
  const verification = opts.superpowers?.seats
    ? {
        ok: Object.values(opts.superpowers.seats).every((seat) => seat.verified === true),
        seats: opts.superpowers.seats,
      }
    : await verifySuperpowers({
        env: runEnvironment,
        home: opts.home ?? homedir(),
        codexBin: opts.codexBin ?? 'codex',
      });
  const superpowersRequirement = applySuperpowersRequirement(verification, runEnvironment);
  if (!superpowersRequirement.ok) {
    throw new Error(`superpowers preflight failed: ${superpowersRequirement.reason}`);
  }
  const verifiedSeats = superpowersRequirement.verification.seats;
  const superpowers = {
    required: true,
    bypassed: superpowersRequirement.bypassed,
    seats: verifiedSeats,
  };
  const cursorSuperpowersDir = verifiedSeats.cursor.verified
    ? verifiedSeats.cursor.path
    : null;
  const productionLivenessJudge = adapters.runExecutor === undefined;
  const livenessJudgeConfigured = typeof adapters.judgeLiveness === 'function'
    || productionLivenessJudge;
  let judgeLiveness = adapters.judgeLiveness ?? null;
  const maxDebateRounds = resolveDebateRounds(runEnvironment, debateRounds);
  const originalPlan = resolveTask(task);
  let plan = originalPlan;
  const commands = Array.isArray(gate) ? gate : JSON.parse(readFileSync(gate, 'utf8'));
  const stageTimeouts = resolveStageTimeouts(opts.env ?? process.env, opts);
  const probeVerifier = adapters.probeVerifier
    ?? (adapters.runExecutor === undefined ? probeVerifierLiveness : null);
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
  let livenessChecks = null;
  if (typeof reporter === 'function') {
    stallConfig = {
      ...resolveStallConfig(opts.env ?? process.env),
      ...executorThresholds,
      ...(opts.stallPolicy === undefined ? {} : { policy: opts.stallPolicy }),
      ...(opts.stallRestartLimit === undefined ? {} : { restartLimit: opts.stallRestartLimit }),
    };
    stallRecords = [];
    livenessChecks = [];
    watchdog = createGapWatchdog({
      reporter,
      runId,
      thresholdMs: stallConfig.thresholdMs,
      onStall: async (event) => {
        let action = 'report';
        const executorSlot = activeExecutor;
        if (!livenessJudgeConfigured
          && stallConfig.policy === 'restart'
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
  // Execution evidence, kept whole: every command run in this worktree writes
  // its complete output to __uro_evidence/ for the seats to read; the facts
  // carry excerpts plus paths. Records, never verdicts.
  const evidence = createEvidenceWriter({ dir: iso.dir });
  if (judgeLiveness === null && productionLivenessJudge) {
    judgeLiveness = createLivenessJudge({
      cwd: iso.dir,
      model: executorModel,
      effort: executorEffort,
      env: runEnvironment,
    });
  }
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
  let activeBranch = iso.branch;
  let freshPivotCount = 0;
  // The pessimistic default is a crashed executor: nothing else has happened
  // yet. There is no gate verdict to default to any more.
  let outcome = 'executor-failed';
  let executorUsage = EMPTY_USAGE;
  let verifierUsage = EMPTY_USAGE;
  let arbiterUsage = EMPTY_USAGE;
  const usageChecks = [];
  const timeoutEvents = [];
  let executorLaunchCount = 0;
  let noOpReason;
  const debateLedger = new DebateLedger();
  const debateRoundHistory = [];
  const independentReviews = [];
  let latestIndependentReview = null;
  let debateCirclingDetected = false;
  let debatePivotCount = 0;
  let finalPivotDecision = null;
  const pivotHistory = [];
  let debateStopReason = 'not-started';
  const accumulatedReviewTests = new Set();
  const reviewerRestorations = [];
  const executorRestorations = [];

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
      ...(typeof exec.timeoutReason?.reasoning === 'string'
        ? { reasoning: exec.timeoutReason.reasoning } : {}),
      ...(typeof exec.timeoutReason?.judged === 'boolean'
        ? { judged: exec.timeoutReason.judged } : {}),
      ...(exec.timeoutReason?.unjudged ? { unjudged: true } : {}),
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
  const arbitrate = async (request) => {
    if (typeof runArbiterSeat !== 'function') {
      return { verdict: ARBITER_UNVERIFIED, answer: '', unavailable: true };
    }
    const injected = adapters.runArbiter !== undefined;
    if (injected) {
      reportEvent(eventReporter, runId, 'arbiter', 'start', {
        bin: arbiterBin, model: arbiterModel, judgement: request.type,
      });
    }
    let result;
    try {
      result = await runArbiterSeat({
        cwd: iso.dir,
        request,
        prompt: buildArbiterPrompt(request),
        bin: arbiterBin,
        model: arbiterModel,
        timeoutMs: stageTimeouts.arbiter,
        env: runEnvironment,
        reporter: injected ? undefined : eventReporter,
        runId,
      });
    } catch (error) {
      result = {
        verdict: ARBITER_UNVERIFIED,
        answer: '',
        launchFailed: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (result?.usage) {
      result = observeUsage(result, { seat: 'arbiter', judgement: request.type, iteration: n });
      arbiterUsage = addUsage(arbiterUsage, result.usage);
    }
    if (result?.timedOut) {
      timeoutEvents.push({
        stage: 'arbiter', judgement: request.type, iteration: n,
        timeoutMs: result.timeoutMs ?? stageTimeouts.arbiter,
      });
    }
    if (injected) {
      reportEvent(eventReporter, runId, 'arbiter', 'finish', {
        code: result?.exitCode ?? null,
        verdict: result?.verdict ?? (result ? 'ANSWERED' : ARBITER_UNVERIFIED),
        timedOut: result?.timedOut === true,
        judgement: request.type,
        ...(result?.usage ? { tokens: result.usage } : {}),
      });
    }
    return result ?? { verdict: ARBITER_UNVERIFIED, answer: '' };
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
        const protectedExecution = await runProtectedOperation({
          cwd: iso.dir,
          scope: 'inside',
          prefix: REVIEW_DIR,
          stage: 'executor',
          role: 'executor',
          runId,
          reporter: eventReporter,
          captureSnapshot: adapters.captureReviewSnapshot ?? captureReviewSnapshot,
          restoreSnapshot: adapters.restoreReviewSnapshot ?? restoreReviewSnapshot,
          onRestore: (paths) => {
            if (paths.length > 0) {
              executorRestorations.push({ iteration: n, attempt, paths: [...paths] });
            }
          },
          operation: () => runExecutor({
            plan: executorPlan, cwd: iso.dir, model: executorModel, effort: executorEffort,
            env: runEnvironment,
            timeoutMs: stageTimeouts.executor,
            reporter: eventReporter, runId, attempt,
            beforeKill,
            onLiveness: () => watchdog?.touch('executor'),
            judgeLiveness: judgeLiveness ?? undefined,
            onLivenessDecision: (decision) => {
              livenessChecks?.push({ attempt, iteration: n, ...decision });
              if (decision?.status !== 'stuck'
                || stallConfig?.policy !== 'restart'
                || stallRestartCount >= stallConfig.restartLimit) return;
              stallRestartCount++;
              slot.restartEvent = decision;
            },
            livenessThresholdMs: executorThresholds.thresholdMs,
            progressThresholdMs: executorThresholds.progressThresholdMs,
            ...(controller ? { signal: controller.signal } : {}),
          }),
        });
        result = observeUsage(protectedExecution.result,
          { seat: 'executor', iteration: n, attempt });
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
  const effectiveDecisionResolver = decisionResolver
    ?? (mode === 'autonomous'
      ? createAutonomousDecisionResolver({ arbiter: arbitrate })
      : null);
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
        || typeof effectiveDecisionResolver !== 'function'
        || challengeRound >= maxChallengeRounds) {
        decision = { questions: challenge.questions, mode, challengeRound };
        break;
      }

      const resolution = await effectiveDecisionResolver({
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
  const gateCommands = () => [
    ...commands,
    ...buildReviewerTestCommands(commands, [...accumulatedReviewTests]),
    ...(merge === undefined ? [] : [testCountFloorCommand(merge.testCounts.required)]),
  ];
  if (decision === null && !executorTimedOut && !conflictingIntent
    && mergePreparationFailure === null) {
    gateResult = await runGate({
      onEvidence: (entry) => evidence.write(entry),
      commands: gateCommands(), cwd: iso.dir, timeoutMs: stageTimeouts.gate,
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
  // The verdict-driven free-retry loop is gone with the verdict: commands ran
  // once as evidence, and what to do about a non-zero exit is the debate's
  // question, not a rule's. `gateRetries` is accepted and ignored for
  // compatibility during the staged removal.
  void gateRetries;
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
      ...(executorResult.stderr ? { stderr: executorResult.stderr } : {}),
      ...(executorResult.usageConsistency
        ? { usageConsistency: executorResult.usageConsistency } : {}),
    },
    gate: iterationGate,
  });
  let iter = makeIteration(n, exec, gateResult, executorTimedOut);

  if (executorTimedOut) {
    outcome = 'timed-out';
    debateStopReason = 'executor-timed-out';
    iterations.push(iter);
  } else if (conflictingIntent) {
    outcome = 'conflicting-intent';
    debateStopReason = 'conflicting-intent';
    iterations.push(iter);
  } else if (decision !== null) {
    outcome = 'needs-decision';
    debateStopReason = 'needs-decision';
    iterations.push(iter);
  } else if (gateResult?.results?.some((result) => result.timedOut)) {
    // A hung command is a liveness matter, not a debatable result.
    outcome = 'timed-out';
    debateStopReason = 'evidence-timed-out';
    iterations.push(iter);
  } else {
    // There is no gate verdict any more. The commands ran once as evidence —
    // whole output on disk, excerpts in facts — and what a non-zero exit MEANS
    // is the seats' question: a defect, or a broken command. Nothing here reads
    // green or red, and nothing downstream may.
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
      // When a command exited non-zero the reviewer is told so, in one
      // argv-safe line, and asked to judge whether the exit indicts the change
      // or the command itself. Evidence in front of the seats, never a rule.
      const gateNote = () => {
        const failed = gateResult?.results?.find((result) => result.code !== 0);
        if (!failed) return '';
        const tail = String(failed?.outputTail ?? '')
          .replace(/["\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
        return ` EVIDENCE: ${failed?.bin ?? 'command'} exited ${failed?.code ?? 'non-zero'}.`
          + (tail ? ` Tail: ${tail}.` : '')
          + ' Judge whether that exit indicts the change or the command itself; full output is in __uro_evidence/.';
      };
      let debateRound = 0;
      while (true) {
        const consumedBeforeRound = addUsage(addUsage(executorUsage, verifierUsage), arbiterUsage);
        if (tokenBudget !== undefined
          && consumedBeforeRound.inputTokens + consumedBeforeRound.outputTokens >= tokenBudget) {
          outcome = 'needs-pivot';
          debateStopReason = 'token-budget';
          break;
        }
        debateRound++;
        evidence.setRound(debateRound);
        let reviewer = { launchFailed: false, timedOut: false, skipped: true };
        if (runReview !== null) {
          try {
            const protectedReview = await runProtectedOperation({
              cwd: iso.dir,
              scope: 'outside',
              prefix: REVIEW_DIR,
              stage: 'verify',
              role: 'reviewer',
              runId,
              reporter: eventReporter,
              captureSnapshot: adapters.captureWorktreeSnapshot,
              restoreSnapshot: adapters.restoreWorktreeSnapshot,
              onRestore: (paths) => {
                if (paths.length > 0) {
                  reviewerRestorations.push({ debateRound, paths: [...paths] });
                }
              },
              operation: () => runReview({
                cwd: iso.dir,
                bin: verifierBin,
                model: verifierModel,
                prompt: REVIEW_PROMPT + gateNote(),
                superpowersDir: cursorSuperpowersDir,
                env: runEnvironment,
                timeoutMs: stageTimeouts.verifier,
                reporter: eventReporter,
                runId,
                pass: 'review',
                onLiveness: () => watchdog?.touch('verify'),
              }),
            });
            reviewer = protectedReview.result ?? reviewer;
          } catch (error) {
            if (error instanceof WorktreeRestorationError) throw error;
            reviewer = {
              launchFailed: true,
              timedOut: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
          const detected = detectReview({ dir: iso.dir });
          if (detected.reviewed) {
            for (const testFile of detected.testFiles) accumulatedReviewTests.add(testFile);
          }
          if (reviewer.usage) {
            reviewer = observeUsage(reviewer,
              { seat: 'verifier', pass: 'review', iteration: n });
            verifierUsage = addUsage(verifierUsage, reviewer.usage);
          }
          if (reviewer.timedOut) {
            timeoutEvents.push({
              stage: 'verifier', pass: 'review', iteration: n,
              timeoutMs: reviewer.timeoutReason?.timeoutMs
                ?? reviewer.timeoutMs ?? stageTimeouts.verifier,
            });
          }
        }
        iter.reviewer = reviewer;
        const findings = collectReviewFindings(iso.dir);
        const blockingFindings = findings.filter((finding) => finding.severity === 'blocking');
        const suggestionFindings = findings.filter((finding) => finding.severity === 'suggestion');
        const findingIds = findings.map((finding) => finding.id);
        const blockingFindingIds = blockingFindings.map((finding) => finding.id);
        const roundRecord = {
          round: debateRound,
          findingIds,
          blockingFindingIds,
          suggestionFindingIds: suggestionFindings.map((finding) => finding.id),
          findings: findings.map((finding) => ({ ...finding })),
        };
        debateRoundHistory.push(roundRecord);
        reportEvent(eventReporter, runId, 'debate', 'round', {
          debateRound,
          findingIds,
          blockingFindingIds,
          suggestionFindingIds: suggestionFindings.map((finding) => finding.id),
        });
        iterations.push(iter);

        const reviewMissing = runReview !== null && !reviewer.launchFailed
          && !reviewer.timedOut && !detectReview({ dir: iso.dir }).reviewed;
        if (reviewer.timedOut || reviewer.launchFailed || reviewMissing) {
          outcome = reviewer.timedOut ? 'timed-out' : 'verifier-failed';
          debateStopReason = reviewer.timedOut
            ? 'review-timed-out'
            : reviewer.launchFailed
              ? 'review-failed'
              : 'unreviewed';
          break;
        }

        const validation = blockingFindings.length === 0
          ? { accepted: [], rejected: [], judgements: [] }
          : await validateFindings(blockingFindings, {
              arbiter: arbitrate,
              diff,
              plan,
              reporter: eventReporter,
              runId,
              debateRound,
            });
        const acceptedFindingIds = validation.accepted;
        const acceptedIdSet = new Set(acceptedFindingIds);
        const acceptedFindings = blockingFindings.filter((finding) => acceptedIdSet.has(finding.id));
        roundRecord.acceptedFindingIds = [...acceptedFindingIds];
        roundRecord.rejectedFindingIds = [...validation.rejected];
        roundRecord.arbiterJudgements = (validation.judgements ?? []).map((item) => ({ ...item }));
        debateLedger.record(debateRound, acceptedFindingIds);
        const circling = detectDebateCircling(debateLedger);

        if (acceptedFindings.length === 0) {
          const allBlockingOverruled = blockingFindings.length > 0;
          if (!allBlockingOverruled && accumulatedReviewTests.size > 0) {
            // The reviewer's own tests run once more as closing evidence — the
            // seats asked for them, so their final state belongs on the record.
            // Whatever they exited, nothing branches: the record speaks.
            gateResult = await runGate({
              onEvidence: (entry) => evidence.write(entry),
              commands: gateCommands(), cwd: iso.dir, timeoutMs: stageTimeouts.gate,
              reporter: eventReporter, runId, attempt: 1,
              captureTestCount,
            });
            iter.gate = gateResult;
            recordGateTimeout(gateResult, n, 1);
          }
          outcome = 'review-ready';
          debateStopReason = 'converged';
          reportEvent(eventReporter, runId, 'debate', 'converged', {
            debateRound,
            resolvedFindingIds: [...debateLedger.resolvedFindings()],
            overruledFindingIds: [...validation.rejected],
            suggestionFindingIds: suggestionFindings.map((finding) => finding.id),
          });
          break;
        }

        reportEvent(eventReporter, runId, 'debate', 'resist', {
          debateRound,
          findingIds: acceptedFindingIds,
        });

        let amendPlan = false;
        let freshPlan = null;
        if (circling) {
          debateCirclingDetected = true;
          const stuckFindingIds = [...debateLedger.stuckFindings()];
          reportEvent(eventReporter, runId, 'debate', 'circling', {
            debateRound,
            stuckFindingIds,
          });
          // The debate has gone on for some time without progress — the measured
          // signal, not a round count. Claude now stops refereeing the other
          // seats' claims and reads TASK.md and the diff itself, producing its
          // own findings and a stance: are the recurring objections real, or is
          // the executor's defence right? That first-hand view informs the pivot.
          const independent = parseIndependentReview(await arbitrate({
            type: 'review',
            task: originalPlan,
            diff,
            findings: acceptedFindings,
            evidence: (gateResult?.results ?? []).filter((result) => result.code !== 0),
          }));
          if (independent.verdict === 'answered') {
            latestIndependentReview = independent;
            independentReviews.push({ debateRound, ...independent });
            reportEvent(eventReporter, runId, 'debate', 'independent_review', {
              debateRound,
              stance: independent.stance,
              findingIds: independent.findings.map((finding) => finding.id),
            });
          } else {
            independentReviews.push({ debateRound, unjudged: true });
            reportEvent(eventReporter, runId, 'debate', 'independent_review', {
              debateRound, unjudged: true,
            });
          }
          const pivotJudgement = parsePivotJudgement(await arbitrate({
            type: 'pivot',
            independentReview: independent.verdict === 'answered' ? independent : null,
            ledger: Array.from({ length: debateLedger.currentRound }, (_, index) => ({
              round: index + 1,
              findingIds: debateLedger.round(index + 1),
            })),
            recurringFindings: acceptedFindings.filter(
              (finding) => stuckFindingIds.includes(finding.id),
            ),
            attempted: pivotHistory,
            plan,
          }));
          const unjudged = pivotJudgement.verdict !== 'answered';
          const pivotDecision = unjudged
            ? selectPivot(debatePivotCount)
            : pivotJudgement.decision;
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
          const ledgerAtPivot = {
            rounds: Array.from({ length: debateLedger.currentRound }, (_, index) => ({
              round: index + 1,
              findingIds: debateLedger.round(index + 1),
            })),
            allFindingIds: [...debateLedger.allFindings()],
            recurredFindingIds: [...debateLedger.stuckFindings()],
            resolvedFindingIds: [...debateLedger.resolvedFindings()],
          };
          const pivotRecord = {
            decision: pivotDecision,
            unjudged,
            ledger: ledgerAtPivot,
            ...(pivotJudgement.reason ? { reason: pivotJudgement.reason } : {}),
          };
          pivotHistory.push(pivotRecord);
          reportEvent(eventReporter, runId, 'debate', 'pivot', {
            debateRound,
            decision: pivotDecision,
            pivotCount: debatePivotCount,
            stuckFindingIds,
            ...(unjudged ? { unjudged: true } : { judged: true, reason: pivotJudgement.reason }),
          });
          if (pivotDecision === PIVOT_CONCLUDE) {
            outcome = 'needs-pivot';
            debateStopReason = 'pivot';
            break;
          }
          if (pivotDecision === PIVOT_FRESH) {
            freshPivotCount++;
            const freshBranch = `${iso.branch}-fresh-${freshPivotCount}`;
            reportEvent(eventReporter, runId, 'pivot', 'replan_start', {
              debateRound,
              branch: freshBranch,
              branchPoint: iso.baseCommit,
              candidateCount: pivotCandidates,
              recurringFindingIds: ledgerAtPivot.recurredFindingIds,
            });
            const branchResult = await createFreshBranch({
              cwd: iso.dir,
              baseCommit: iso.baseCommit,
              branch: freshBranch,
              captureSnapshot: adapters.captureReviewSnapshot ?? captureReviewSnapshot,
              restoreSnapshot: adapters.restoreReviewSnapshot ?? restoreReviewSnapshot,
            });
            activeBranch = branchResult?.branch ?? freshBranch;
            pivotRecord.branch = activeBranch;
            pivotRecord.branchPoint = branchResult?.branchPoint ?? iso.baseCommit;
            pivotRecord.reviewPaths = branchResult?.reviewPaths ?? [...accumulatedReviewTests].sort();

            const injectedCandidateDraft = adapters.draftPlanCandidate
              ?? adapters.planDraft
              ?? (adapters.runExecutor === undefined
                ? undefined
                : async () => { throw new Error('fresh planning adapter unavailable'); });
            const generated = await generatePlanCandidates({
              goal: originalPlan,
              target: iso.dir,
              count: pivotCandidates,
              mode: 'fresh',
              round: debateRound,
              ledger: ledgerAtPivot,
              failedPlan: plan,
              pivot: 'Start from the pre-debate snapshot with a genuinely different implementation strategy.',
              plannerModel: executorModel,
              timeoutMs: stageTimeouts.executor,
              gateTimeout: stageTimeouts.gate,
              runId,
              env: runEnvironment,
              ...(injectedCandidateDraft === undefined ? {} : { draft: injectedCandidateDraft }),
              ...((adapters.selectPlanCandidate ?? adapters.selectCandidate) === undefined
                ? {}
                : { select: adapters.selectPlanCandidate ?? adapters.selectCandidate }),
            });
            for (const [candidateIndex, candidate] of (generated?.candidates ?? []).entries()) {
              if (candidate?.usage === undefined) continue;
              const observed = observeUsage(
                { usage: candidate.usage },
                {
                  seat: 'executor', pass: 'pivot-plan', iteration: n,
                  candidateId: candidate.id ?? `candidate-${candidateIndex + 1}`,
                },
              );
              executorUsage = addUsage(executorUsage, observed.usage);
            }
            if (generated?.selectionUsage !== undefined) {
              const observed = observeUsage(
                { usage: generated.selectionUsage },
                { seat: 'executor', pass: 'pivot-selection', iteration: n },
              );
              executorUsage = addUsage(executorUsage, observed.usage);
            }
            const normalizedCandidates = (generated?.candidates ?? []).map((candidate, index) => ({
              ...candidate,
              id: candidate.id ?? `candidate-${index + 1}`,
              perspective: candidate.perspective ?? `candidate perspective ${index + 1}`,
              gateResult: candidate.gateResult ?? candidate.planGate ?? {
                passed: candidate.gatePassed === true,
                failures: candidate.failures ?? [],
              },
            }));
            let selectedCandidate = generated?.selected ?? null;
            if (selectedCandidate === null && generated?.selectedCandidateId) {
              selectedCandidate = normalizedCandidates.find(
                (candidate) => candidate.id === generated.selectedCandidateId,
              ) ?? null;
            }
            if (selectedCandidate === null && typeof generated?.plan === 'string') {
              selectedCandidate = {
                id: generated.selectedCandidateId ?? 'candidate-1',
                perspective: generated.perspective ?? 'selected fresh perspective',
                plan: generated.plan,
                gate: generated.gate ?? [],
                gateResult: generated.planGate ?? { passed: true, failures: [] },
              };
              if (normalizedCandidates.length === 0) normalizedCandidates.push(selectedCandidate);
            }
            if (selectedCandidate !== null) {
              selectedCandidate = normalizedCandidates.find(
                (candidate) => candidate.id === selectedCandidate.id,
              ) ?? selectedCandidate;
            }
            const selectedId = selectedCandidate?.id ?? null;
            const candidateFacts = normalizedCandidates.map((candidate) => (
              planCandidateFacts(candidate, selectedId)
            ));
            pivotRecord.candidates = candidateFacts;
            pivotRecord.selectedCandidateId = selectedId;
            for (const candidate of candidateFacts) {
              reportEvent(eventReporter, runId, 'pivot', 'candidate', {
                debateRound,
                candidateId: candidate.id,
                perspective: candidate.perspective,
                gatePassed: candidate.gatePassed,
                failures: candidate.failures,
              });
            }
            if (generated?.exhausted === true || selectedCandidate === null) {
              pivotRecord.exhausted = true;
              pivotRecord.escalatedTo = PIVOT_CONCLUDE;
              finalPivotDecision = PIVOT_CONCLUDE;
              outcome = 'needs-pivot';
              debateStopReason = 'pivot-exhausted';
              reportEvent(eventReporter, runId, 'pivot', 'exhausted', {
                debateRound,
                branch: activeBranch,
                decision: PIVOT_CONCLUDE,
                candidateCount: candidateFacts.length,
                reason: 'no fresh plan candidate produced artifacts',
              });
              break;
            }
            pivotRecord.exhausted = false;
            freshPlan = selectedCandidate.plan;
            reportEvent(eventReporter, runId, 'pivot', 'selected', {
              debateRound,
              branch: activeBranch,
              candidateId: selectedCandidate.id,
              perspective: selectedCandidate.perspective,
            });
          } else {
            amendPlan = true;
          }
        }

        if (freshPlan === null && maxDebateRounds !== undefined && debateRound >= maxDebateRounds) {
          outcome = 'needs-pivot';
          debateStopReason = 'rounds-exhausted';
          break;
        }

        let fixPlan = freshPlan ?? buildFixPlan({
          findings: blockingFindings,
          accepted: validation.accepted,
          rejected: validation.rejected,
          originalTask: originalPlan,
        });
        if (amendPlan) fixPlan = amendFixPlanWithLedger(fixPlan, debateLedger);
        // A non-zero exit is part of the argument now, so the fix plan carries
        // it: Codex may fix the code, or defend it and name the command as the
        // defect — the reviewers see the same evidence and judge.
        if ((gateResult.results ?? []).some((result) => result.code !== 0)) {
          fixPlan = planWithGateFailure(fixPlan, gateResult);
        }
        if (latestIndependentReview !== null) {
          fixPlan = [
            fixPlan,
            '',
            '## Claude independent review (read the change itself)',
            `Stance: ${latestIndependentReview.stance}`,
            ...latestIndependentReview.findings.map(
              (finding) => `- ${finding.id} ${finding.severity}: ${finding.text}`,
            ),
            latestIndependentReview.reasoning,
          ].join('\n');
        }
        plan = fixPlan;
        n++;
        iterationExecutorUsage = EMPTY_USAGE;
        exec = await executePlan(plan);
        executorTimedOut = Boolean(exec.timedOut);
        await routeChallenges();

        gateResult = null;
        if (decision === null && !executorTimedOut && !conflictingIntent
          && mergePreparationFailure === null) {
          gateResult = await runGate({
      onEvidence: (entry) => evidence.write(entry),
            commands: gateCommands(), cwd: iso.dir, timeoutMs: stageTimeouts.gate,
            reporter: eventReporter, runId, attempt: 1,
            captureTestCount,
          });
          recordGateTimeout(gateResult, n, 1);
        }
        iter = makeIteration(n, exec, gateResult, executorTimedOut);
        if (executorTimedOut) {
          outcome = 'timed-out';
          debateStopReason = 'executor-timed-out';
          iterations.push(iter);
          break;
        }
        if (conflictingIntent) {
          outcome = 'conflicting-intent';
          debateStopReason = 'conflicting-intent';
          iterations.push(iter);
          break;
        }
        if (decision !== null) {
          outcome = 'needs-decision';
          debateStopReason = 'needs-decision';
          iterations.push(iter);
          break;
        }
        if (gateResult?.results?.some((result) => result.timedOut)) {
          // A hung command is a liveness matter; the debate cannot argue with it.
          outcome = 'timed-out';
          debateStopReason = 'evidence-timed-out';
          iterations.push(iter);
          break;
        }
        // Whatever the commands exited, the debate continues: the next review
        // round reads the evidence and judges. Termination is convergence, the
        // arbiter's pivot, the token budget, or the round bound — never a rule
        // about an exit code.
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

  const tokens = {
    executor: executorUsage,
    verifier: verifierUsage,
    arbiter: arbiterUsage,
    total: addUsage(addUsage(executorUsage, verifierUsage), arbiterUsage),
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
    independentReviews: independentReviews.map((item) => ({ ...item })),
    pivotCount: debatePivotCount,
    finalPivotDecision,
    pivotHistory: pivotHistory.map((item) => ({ ...item })),
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
  let mutation = null;
  if (outcome === 'review-ready' && opts.mutation !== undefined) {
    const mutationOptions = opts.mutation === true ? {} : opts.mutation;
    try {
      mutation = await runMutation({
        target: iso.dir,
        base: merge === undefined ? iso.baseCommit : merge.mergeBase,
        runId,
        reporter: eventReporter,
        ...(adapters.runMutation === undefined ? {
          judge: createMutationJudge({ cwd: iso.dir }),
          arbiter: createMutationArbiter({ cwd: iso.dir }),
        } : {}),
        ...mutationOptions,
      });
    } catch (error) {
      // Mutation evidence is advisory. An unavailable measurement must not rewrite the
      // already-observed gate result or the run outcome.
      mutation = { status: 'error', reason: error instanceof Error ? error.message : String(error) };
    }
  }
  const facts = buildRunFacts({ runId,
    ...(physicalRunId === runId ? {} : { physicalRunId }),
    target, targetPath: resolve(target),
    dir: iso.dir, isRepo: iso.isRepo,
    baseRef: iso.baseRef, baseCommit: iso.baseCommit, branch: activeBranch,
    iterations,
    evidence: evidence.records(),
    tokens, usageConsistency, outcome, debate,
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
      stallEvents: stallRecords,
      livenessChecks,
    } : null,
    ...(unitKind === undefined ? {} : { unitKind }),
    ...(mergeFacts === null ? {} : { merge: mergeFacts }),
    ...(mutation === null ? {} : { mutation }),
    models: {
      executor: executorModel,
      executorEffort,
      verifier: verifierModel,
      arbiter: arbiterModel,
    },
    skills: cursorSuperpowersDir,
    superpowers,
  });
  if (outcome === 'needs-decision') facts.decision = decision;
  else if (resolvedDecision !== null) facts.decision = resolvedDecision;
  if (assumedDecision !== null) {
    facts.assumedDecision = assumedDecision;
    facts.escalation = 'operator-absent';
  }
  facts.reviewProtection = {
    accumulatedTestFiles: [...accumulatedReviewTests].sort(),
    reviewerRestorations,
    executorRestorations,
  };
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
