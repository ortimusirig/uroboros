import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync, realpathSync, lstatSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { isolate } from './isolation.js';
import {
  DEFAULT_EXECUTOR_EFFORT,
  DEFAULT_EXECUTOR_MODEL,
  EXECUTOR_PREAMBLE,
  runExecutor as realExecutor,
} from './executor.js';
import { createEvidenceWriter, EVIDENCE_DIR } from './evidence.js';
import { buildReviewerTestCommands, runGate as realGate } from './gate.js';
import {
  DEFAULT_VERIFIER_MODEL,
  REVIEW_PROMPT,
  runReviewPass as realReviewPass,
} from './verifier.js';
import { buildRunFacts, refreshReportProjection, writeReport } from './report.js';
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
import { archiveRunArtifacts, HARNESS_ARTIFACTS, resolveArtifactRoot } from './artifacts.js';
import { saveCheckpoint, nativeHumanQuestion } from './checkpoint.js';
import { runExecutionDialogue } from './execution-dialogue.js';
import { canApproveDialogue, parseDialogueEnvelope } from './dialogue.js';
import { captureEvidence, validateEvidence } from './context-evidence.js';
import { contextDigest, readSharedContextReference } from './shared-context.js';
import { contextLifecycle, assertPlanningSidecars, reopenPlanningContext, applyScopedHumanRuling, resumeTechnicalDialogue } from './planning-dialogue.js';
import { EXECUTION_REVIEW_PROMPT, completeReviewPass } from './verifier.js';
import { createRunMarker, releaseRunMarker } from './prune.js';
import { physicalRunIdFor } from './run-id.js';
import {
  advanceMerge,
  buildMergeTask,
  clearMergeLedger,
  concludeConflict,
  readMergeLedger,
  MERGE_LEDGER_FILENAME,
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
} from './debate.js';
import { assertReviewDestination, detectReview, materializeReviewBundle, reviewDigest, REVIEW_DIR } from './review.js';
import { buildFixPlan, executorFindingResponses } from './fix-plan.js';
import { decisionAuthority } from './decision-policy.js';
import { planningArtifactDigest } from './conversation.js';
import {
  ARBITER_UNVERIFIED,
  buildArbiterPrompt,
  DEFAULT_ARBITER_MODEL,
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
  isTestFile,
  resolveMutationTestSupport,
  runMutate as realMutation,
} from './mutate.js';
import {
  DEFAULT_PIVOT_CANDIDATES,
  planCandidateFacts,
  runPlanCandidateSet,
  continuePlanCandidateSet,
  validatePlanCandidateCount,
} from './plan.js';

export { HARNESS_ARTIFACTS } from './artifacts.js';

function rulingEvidenceDigest(gateResult) {
  return reviewDigest(JSON.stringify((gateResult?.results ?? []).map(result =>
    Object.fromEntries(['bin', 'args', 'code', 'outputTail', 'stdout', 'stderr', 'error']
      .filter(key => result[key] !== undefined).map(key => [key, result[key]])))));
}

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
    // debate ledger, append-only events and complete command-output files remain
    // run evidence, independent of the discarded solution. Keep evidence paths
    // valid; the same writer continues with a monotonically increasing sequence.
    await checkedGit(
      cwd,
      ['clean', '-ffd', '-x', '-e', 'events.jsonl', '-e', '.uro-tmp', '-e', `${EVIDENCE_DIR}/`],
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

async function preservePartialExecutorWork(dir, baseRef = 'HEAD', createDiff = diffText, receipt = false) {
  const diff = await createDiff(dir, baseRef, { timeoutMs: PARTIAL_WORK_GIT_TIMEOUT_MS });
  if (!receipt && diff.trim() === '') return null;
  writeFileSync(join(dir, 'CHANGES.diff'), diff);
  const staged = receipt ? await spawnCapture('git', ['-C', dir, 'diff', '--cached', '--quiet'], { timeoutMs: PARTIAL_WORK_GIT_TIMEOUT_MS }) : null;
  if (staged && ![0, 1].includes(staged.code)) throw new Error('cannot observe staged partial work');
  if (!staged || staged.code === 1) {
  const commit = await spawnCapture('git', [
    '-C', dir,
    '-c', 'user.email=ccc@local',
    '-c', 'user.name=ccc',
    'commit', '--no-verify', '-m', 'preserve partial executor work before termination',
  ], { timeoutMs: PARTIAL_WORK_GIT_TIMEOUT_MS });
  if (commit.code !== 0) {
    throw new Error(`git commit failed while preserving executor work: ${commit.stderr.trim()}`);
  }
  }
  if (receipt) {
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
    const affectedFiles = execFileSync('git', ['-C', dir, 'diff', '--name-only', baseRef, '--', '.', ...HARNESS_ARTIFACTS.map(path => `:(exclude)${path}`)], { encoding: 'utf8', windowsHide: true }).trim().split('\n').filter(Boolean);
    return { status: 'completed', cwd: dir, baseCommit: baseRef, head, diff, diffDigest: reviewDigest(diff), affectedFiles,
      committed: staged.code === 1, writerOutcome: 'unknown' };
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
      `Question: ${question.question ?? question.text}`,
      `Answer: ${answer?.answer ?? '(no answer provided)'}`,
    ];
    if (answer?.assumption) lines.push(`Assumption: ${answer.assumption}`);
    if (answer?.flaggedForHuman !== undefined) {
      lines.push(`Flagged for human: ${answer.flaggedForHuman ? 'yes' : 'no'}`);
    }
    return lines.join('\n');
  });
  return `${basePlan}\n\n## Recorded decision\n\n${pairs.join('\n\n')}` +
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

  return { answers };
}

const APPROVAL_REQUEST = /(?:^|[.!?]\s+|\n\s*)(?:please\s+)?approve\s+(?:this|the)\s+(?:design|plan|proposal|approach)(?=\s*(?:[,.!?;:]|$|\band\b|\bso\b|\bbefore\b))/i;

function executorRequestedApproval(result) {
  const messages = Array.isArray(result?.agentMessages) ? [...result.agentMessages] : [];
  if (messages.length === 0 && typeof result?.lastMessage === 'string') {
    messages.push(result.lastMessage);
  }
  return messages.some((message) => typeof message === 'string' && APPROVAL_REQUEST.test(message));
}

// Called only after Task 4 validates the durable envelope/workspace. This entry
// point attaches to the saved controller state; it never invokes isolation.
function recordManualRuling(state, humanRuling, phase = 'execution') {
  if (!state.messages.some(message => message.speaker === 'human' && message.decisionId === humanRuling.decisionId)) {
    state.messages.push({ speaker: 'human', role: 'decision-authority', phase, turn: state.messages.length + 1,
      decisionId: humanRuling.decisionId, content: JSON.stringify(humanRuling), response: humanRuling });
  }
}

function stopManualExecution(state, humanRuling, reason = 'human-stopped', planning) {
  recordManualRuling(state, humanRuling);
  const facts = JSON.parse(readFileSync(join(state.workspace.dir, 'uro-runfacts.json'), 'utf8'));
  if (facts.runId !== state.runId || resolve(facts.dir) !== resolve(state.workspace.dir)) throw new Error('saved execution facts do not match the stopped phase');
  delete facts.checkpointState;
  delete facts.checkpoint;
  return { ...facts, phase: 'execution', outcome: 'needs-pivot', reason, approved: false, approval: null,
    messages: state.messages, ...(planning ? { planningMessages: planning.messages } : {}),
    ...(planning ? { tokens: { ...facts.tokens, planning: addUsage(facts.tokens.planning, planning.tokens.total),
      total: addUsage(facts.tokens.total, planning.tokens.total) } } : {}),
    decision: { ...state.decision, ...humanRuling, answeredBy: 'human' },
    debate: { ...facts.debate, stopReason: reason,
      ...(planning ? { pivotHistory: [...facts.debate.pivotHistory,
        { decision: PIVOT_FRESH, preservedWorkspace: true, reason, planning }] } : {}) } };
}

function manualPlanningOptions(state, adapters, env, reporter) {
  return { target: state.workspace.dir, claudeModel: state.options.arbiterModel,
    codexModel: state.options.executorModel, codexEffort: state.options.executorEffort,
    executorTimeout: state.stageTimeouts.executor, timeoutMs: state.stageTimeouts.arbiter,
    runId: state.runId, env, reporter,
    ...(adapters.draftPlanCandidate ? { draft: adapters.draftPlanCandidate }
      : adapters.runExecutor ? { draft: async () => { throw new Error('fresh planning author adapter unavailable'); } } : {}),
    ...(adapters.reviewPlanCandidate ? { review: adapters.reviewPlanCandidate } : {}),
    ...(adapters.selectPlanCandidate ? { select: adapters.selectPlanCandidate } : {}) };
}

async function finishManualPlanning(state, generated, { adapters, reporter, env }) {
  if (generated.reason === 'needs-decision') {
    return { ...generated, phase: 'planning', outcome: 'needs-decision', dir: state.workspace.dir,
      checkpointState: { ...generated.checkpointState, executionContinuation: state } };
  }
  const approved = generated.approved === true && generated.selected
    && generated.approval?.artifactDigest === planningArtifactDigest(state.originalPlan,
      { plan: generated.selected.plan, gate: generated.selected.gate });
  if (!approved || generated.selected.plan.trim() === state.plan.trim()) {
    return stopManualExecution(state, state.manualPivotRuling,
      !approved ? generated.reason ?? 'fresh-plan-unapproved' : 'fresh-plan-unchanged', generated);
  }
  state.plan = generated.selected.plan;
  state.commands = generated.selected.gate;
  state.planningCheckpoint = generated.checkpointState;
  state.tokens.planning = addUsage(state.tokens.planning, generated.tokens.total);
  state.debate.pivotHistory.push({ decision: PIVOT_FRESH, reason: 'Human requested a reviewed replacement plan over the saved workspace.',
    preservedWorkspace: true, planning: generated, selectedCandidateId: generated.selected.id });
  for (const message of generated.messages.filter(message => message.speaker === 'human')) {
    if (!state.messages.some(existing => existing.decisionId === message.decisionId)) state.messages.push(message);
  }
  state.stage = 'executor-challenge';
  return continueExecution({ checkpointState: state, humanRuling: state.manualPivotRuling, adapters, reporter, env });
}

export async function continueExecutionPlanning({ checkpointState, humanRuling, technicalContinue = false, adapters = {}, reporter, env }) {
  if (checkpointState.version === 2 && checkpointState.workspace && !checkpointState.executionContinuation) {
    return resumeNativeExecution({ checkpointState, humanRuling, technicalContinue, adapters, reporter, env });
  }
  const state = structuredClone(checkpointState.executionContinuation);
  const generated = await continuePlanCandidateSet({ checkpointState, humanRuling,
    ...manualPlanningOptions(state, adapters, env, reporter) });
  return finishManualPlanning(state, generated, { adapters, reporter, env });
}

const nativeRecovery = Symbol('validated native recovery');
function resumeNativeExecution({ checkpointState: state, humanRuling, technicalContinue, adapters, reporter, env }) {
  state = structuredClone(state);
  if (!['execution', 'planning'].includes(state.phase) || !(state.dialogue?.schemaVersion === 2 || state.preparationSnapshot?.schemaVersion === 1) || !state.workspace?.dir) throw new Error('invalid native execution continuation');
  return run({ ...state.options, task: state.originalPlan, gate: state.commands, runId: state.rootRunId ?? state.runId,
    mode: state.interactionMode, merge: state.mergeState?.merge, adapters, reporter, ...(env ? { env } : {}),
    [nativeRecovery]: { state, humanRuling, technicalContinue }, verifierProbeCompleted: true });
}
export async function continueExecution({ checkpointState, humanRuling, technicalContinue = false, adapters = {}, reporter, env }) {
  const state = JSON.parse(JSON.stringify(checkpointState));
  if (state.version === 2) {
    return resumeNativeExecution({ checkpointState: state, humanRuling, technicalContinue, adapters, reporter, env });
  }
  if (state?.version !== 1 || state.phase !== 'execution' || state.interactionMode !== 'manual'
    || !state.workspace?.dir || !state.decision?.questions?.length) throw new Error('invalid execution continuation');
  const resolution = validatedResolution(state.decision.questions, humanRuling);
  if (!resolution) throw new Error('manual continuation requires answers to every pending question');
  if (state.stage === 'execution-pivot') {
    const question = state.decision.questions.find(question => question.id === 'pivot');
    const answer = resolution.answers.find(answer => answer.id === 'pivot')?.answer.trim() ?? '';
    const disposition = question?.options?.find(option => answer === option || answer.startsWith(`${option}:`));
    if (disposition === 'stop') return stopManualExecution(state, humanRuling);
    if (disposition === 'fresh plan') {
      recordManualRuling(state, humanRuling);
      state.manualPivotRuling = humanRuling;
      const generated = await runPlanCandidateSet({ ...manualPlanningOptions(state, adapters, env, reporter),
        goal: state.originalPlan, count: state.options.pivotCandidates, mode: 'fresh', interactionMode: 'manual',
        failedPlan: state.plan, feedback: `Authoritative human ruling: ${answer}`,
        pivot: 'Author a genuinely revised plan over the existing saved workspace. Preserve its code and evidence; do not reset to the pre-debate base.',
        priorMessages: state.messages });
      return finishManualPlanning(state, generated, { adapters, reporter, env });
    }
  }
  return run({ ...state.options, task: state.originalPlan, gate: state.commands, runId: state.runId,
    merge: state.mergeState?.merge,
    mode: state.interactionMode, adapters, reporter, ...(env ? { env } : {}),
    continuation: state, humanRuling: { ...humanRuling, answers: resolution.answers }, verifierProbeCompleted: true });
}

export async function run(opts) {
  const nativeSaved = opts[nativeRecovery]?.state;
  const continuation = nativeSaved ?? opts.continuation ?? null;
  if (continuation && !nativeSaved && (continuation.version !== 1 || continuation.phase !== 'execution'
    || continuation.interactionMode !== 'manual' || !continuation.workspace?.dir
    || !continuation.decision?.questions?.length
    || !validatedResolution(continuation.decision.questions, opts.humanRuling))) {
    throw new Error('invalid execution continuation; native recovery requires the validated Task5 bridge');
  }
  const nativeExecution = continuation === null || Boolean(nativeSaved);
  const startedAt = new Date();
  const {
    task, target, gate, gateRetries, scratchRoot, runId,
    baseRef = 'HEAD', branch, branchName, correctsRunId, campaignId, campaignBase,
    round, unitId, campaignUnitKind, perspective, unitKind, merge,
    captureTestCount = false,
    executorModel = DEFAULT_EXECUTOR_MODEL,
    executorEffort = DEFAULT_EXECUTOR_EFFORT,
    verifierModel = DEFAULT_VERIFIER_MODEL,
    verifierBin = 'claude', verifierProbeCompleted = false,
    arbiterModel = DEFAULT_ARBITER_MODEL,
    arbiterBin = 'claude',
    mode = 'manual', decisionResolver, challengeRounds,
    debateRounds, tokenBudget, pivotCandidates = DEFAULT_PIVOT_CANDIDATES,
    adapters = {}, reporter,
  } = opts;
  const parentContext = opts.contextRef ? readSharedContextReference({ reference: opts.contextRef, target }) : null;
  const physicalRunId = physicalRunIdFor(runId);
  if (mode !== 'manual' && mode !== 'autonomous') {
    throw new Error(`invalid mode: ${mode}; expected manual or autonomous`);
  }
  if (challengeRounds !== undefined && (!Number.isInteger(challengeRounds) || challengeRounds < 1)) {
    throw new Error(`invalid challengeRounds: ${challengeRounds}; expected a positive integer`);
  }
  if (tokenBudget !== undefined
    && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1)) {
    throw new Error('tokenBudget must be a positive safe integer');
  }
  validatePlanCandidateCount(pivotCandidates, 'pivotCandidates');
  const maxChallengeRounds = Math.min(challengeRounds ?? 2, 2); // Explicit v1 reader only.
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
        requiredSeats: ['codex', 'claude'],
      });
  const superpowersRequirement = applySuperpowersRequirement(verification, runEnvironment, { requiredSeats: ['codex', 'claude'] });
  if (!superpowersRequirement.ok) {
    throw new Error(`superpowers preflight failed: ${superpowersRequirement.reason}`);
  }
  const verifiedSeats = superpowersRequirement.verification.seats;
  const superpowers = {
    required: true,
    bypassed: superpowersRequirement.bypassed,
    seats: verifiedSeats,
  };
  const claudeSuperpowersDir = verifiedSeats.claude?.verified
    ? verifiedSeats.claude.path
    : null;
  const productionLivenessJudge = adapters.runExecutor === undefined;
  const livenessJudgeConfigured = typeof adapters.judgeLiveness === 'function'
    || productionLivenessJudge;
  let judgeLiveness = adapters.judgeLiveness ?? null;
  const maxDebateRounds = resolveDebateRounds(runEnvironment, debateRounds);
  const originalPlan = continuation?.originalPlan ?? resolveTask(task);
  let plan = continuation?.plan ?? originalPlan;
  const commands = structuredClone(continuation?.commands ?? (Array.isArray(gate) ? gate : JSON.parse(readFileSync(gate, 'utf8'))));
  const stageTimeouts = continuation?.stageTimeouts ?? resolveStageTimeouts(opts.env ?? process.env, opts);
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
  let stallConfig = continuation?.supervision?.stallConfig ?? null;
  const executorThresholds = {
    ...resolveExecutorThresholds(opts.env ?? process.env),
    ...(continuation?.supervision?.executorThresholds ?? {}),
    ...(opts.stallThresholdMs === undefined ? {} : { thresholdMs: opts.stallThresholdMs }),
    ...(opts.progressThresholdMs === undefined
      ? {} : { progressThresholdMs: opts.progressThresholdMs }),
  };
  let activeExecutor = null;
  let stallRestartCount = continuation?.supervision?.stallRestartCount ?? 0;
  let stallRecords = continuation?.supervision?.stallRecords ?? null;
  let livenessChecks = continuation?.supervision?.livenessChecks ?? null;
  if (typeof reporter === 'function') {
    stallConfig = {
      ...resolveStallConfig(opts.env ?? process.env),
      ...(continuation?.supervision?.stallConfig ?? {}),
      ...executorThresholds,
      ...(opts.stallPolicy === undefined ? {} : { policy: opts.stallPolicy }),
      ...(opts.stallRestartLimit === undefined ? {} : { restartLimit: opts.stallRestartLimit }),
    };
    stallRecords ??= [];
    livenessChecks ??= [];
    watchdog = createGapWatchdog({
      reporter,
      runId,
      thresholdMs: stallConfig.thresholdMs,
      onStall: async (event) => {
        let action = 'report';
        const executorSlot = activeExecutor;
        if (nativeExecution && !livenessJudgeConfigured && stallConfig.policy === 'restart' && executorSlot?.stop) action = 'pause';
        if (!nativeExecution && !livenessJudgeConfigured
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
        if (action === 'pause') await executorSlot.stop(event);
      },
    });
    eventReporter = watchdog.reporter;
  }

  const runMarker = createRunMarker({ scratchRoot, runId, target });
  try {
  const iso = continuation?.workspace ?? await isolateRun({
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
  const resumedEvidence = continuation?.evidence ?? [];
  const newEvidence = createEvidenceWriter({ dir: iso.dir, round: (continuation?.debateRound ?? 0) + 1 });
  const evidence = { ...newEvidence, records: () => [...resumedEvidence, ...newEvidence.records()] };
  if (judgeLiveness === null && productionLivenessJudge) {
    judgeLiveness = createLivenessJudge({
      cwd: iso.dir,
      model: executorModel,
      effort: executorEffort,
      env: runEnvironment,
    });
  }
  const mergeConflicts = continuation?.mergeState?.mergeConflicts ?? [];
  const mergeResolutions = continuation?.mergeState?.mergeResolutions ?? [];
  let mergeProgress = continuation?.mergeState?.mergeProgress ?? null;
  let activeConflict = continuation?.mergeState?.activeConflict ?? null;
  let observedMergeWorkspace = null;
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
    if (!continuation && !nativeExecution) mergeProgress = await observedAdvanceMerge({
      cwd: iso.dir,
      parents: merge.parents,
      unitId: runId,
    });
    if (!continuation && !nativeExecution) {
      activeConflict = mergeProgress.conflict;
      if (activeConflict) mergeConflicts.push(activeConflict);
      plan = buildMergeTask(originalPlan, merge, activeConflict);
    }
  }
  const iterations = continuation?.iterations ?? [];
  let activeBranch = iso.branch;
  let freshPivotCount = continuation?.freshPivotCount ?? 0;
  // The pessimistic default is a crashed executor: nothing else has happened
  // yet. There is no gate verdict to default to any more.
  let outcome = 'executor-failed';
  let executorUsage = continuation?.tokens?.executor ?? EMPTY_USAGE;
  let verifierUsage = continuation?.tokens?.verifier ?? EMPTY_USAGE;
  let arbiterUsage = continuation?.tokens?.arbiter ?? EMPTY_USAGE;
  let planningUsage = continuation?.tokens?.planning ?? EMPTY_USAGE;
  const usageChecks = continuation?.usageChecks ?? [];
  const timeoutEvents = continuation?.timeoutEvents ?? [];
  let executorLaunchCount = continuation?.executorLaunchCount ?? 0;
  let noOpReason;
  const debateLedger = new DebateLedger();
  const debateRoundHistory = continuation?.debate?.roundHistory ?? [];
  for (const savedRound of debateRoundHistory) debateLedger.record(savedRound.round, savedRound.acceptedFindingIds ?? []);
  let debateCirclingDetected = continuation?.debate?.circlingDetected ?? false;
  let debatePivotCount = continuation?.debate?.pivotCount ?? 0;
  let finalPivotDecision = continuation?.debate?.finalPivotDecision ?? null;
  const pivotHistory = continuation?.debate?.pivotHistory ?? [];
  let debateStopReason = 'not-started';
  const accumulatedReviewTests = new Set(continuation?.reviewerTests ?? []);
  const executionMessages = continuation?.messages ?? [];
  const openFindings = new Map((continuation?.openFindings ?? []).map((finding) => [finding.id, finding]));
  const resolvedFindingIds = new Set(continuation?.resolvedFindingIds ?? []);
  let evidenceTestDigest = continuation?.evidenceTestDigest ?? reviewDigest('[]');
  let checkpointStage = 'executor-challenge';
  let currentDiff = '';
  let currentDebateRound = continuation?.debateRound ?? 0;
  let planningCheckpoint = continuation?.planningCheckpoint ?? null;
  const reviewerRestorations = continuation?.reviewProtection?.reviewerRestorations ?? [];
  const executorRestorations = continuation?.reviewProtection?.executorRestorations ?? [];
  const humanRulings = [...(continuation?.humanRulings ?? [])];
  if (continuation && !nativeExecution) {
    if (continuation.stage === 'execution-dispute') {
      for (const question of continuation.decision.questions) {
        const answer = opts.humanRuling.answers.find(item => item.id === question.id)?.answer ?? '';
        if (/^Accept Codex rebuttal(?:\s*:|\s*$)/i.test(answer.trim())
          && question.options?.includes('Accept Codex rebuttal')) {
          humanRulings.push({ id: question.id, answer, decisionId: opts.humanRuling.decisionId,
            artifactDigest: opts.humanRuling.artifactDigest, diffDigest: continuation.workspace.diffDigest,
            evidenceTestDigest: continuation.evidenceTestDigest, evidenceDigest: rulingEvidenceDigest(continuation.gateResult),
            finding: openFindings.get(question.id) });
        }
      }
    }
    recordManualRuling({ messages: executionMessages }, opts.humanRuling);
    plan = planWithDecision(plan, continuation.decision.questions, opts.humanRuling)
      + '\n\nContinue from the existing implementation and evidence. Address this human ruling and the open findings.\n'
      + JSON.stringify([...openFindings.values()]);
    const decisionPath = join(iso.dir, 'DECISION.md');
    if (existsSync(decisionPath)) unlinkSync(decisionPath);
  }

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

  let n = continuation ? continuation.iteration + 1 : 1;
  const observeUsage = (result, context) => {
    const annotated = annotateUsageConsistency(result);
    const consistency = annotated?.usageConsistency ?? checkUsageConsistency(result?.usage);
    usageChecks.push({ ...context, ...consistency });
    return annotated;
  };
  const arbitrate = async (request) => {
    request = { ...request, originalRequirements: originalPlan, interactionMode: mode,
      messages: [...executionMessages], evidence: request.evidence ?? evidence.records() };
    if (typeof runArbiterSeat !== 'function') {
      return { verdict: ARBITER_UNVERIFIED, answer: '', unavailable: true };
    }
    const injected = adapters.runArbiter !== undefined;
    if (injected) {
      reportEvent(eventReporter, runId, 'arbiter', 'start', {
        bin: arbiterBin, model: arbiterModel, judgement: request.type,
        provider: 'claude', role: 'execution-reviewer',
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
    executionMessages.push({ speaker: 'claude', role: 'execution-reviewer', phase: 'execution',
      turn: executionMessages.length + 1, judgement: request.type,
      response: result, content: result?.answer ?? JSON.stringify(result) });
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
            ownedTmpDir: true,
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
      executionMessages.push({ speaker: 'codex', role: 'implementation-author', phase: 'execution',
        turn: executionMessages.length + 1, iteration: n, attempt,
        response: result, content: result.lastMessage ?? '' });
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
  let conflictingIntent = continuation?.mergeState?.conflictingIntent ?? false;
  let mergePreparationFailure = continuation?.mergeState?.mergePreparationFailure ?? null;
  let challengeRound = continuation?.challengeRound ?? 0;
  let decision = null;
  let resolvedDecision = continuation && !nativeExecution ? { ...continuation.decision, ...opts.humanRuling, answeredBy: 'human' } : null;
  let assumedDecision = continuation?.assumedDecision ?? null;
  let gateResult = nativeSaved?.gateResult ?? null;
  let iter;
  let nativeResult = null;
  let nativeMutationPolicy = null;
  let approvedExecutionPlan = continuation?.approvedExecutionPlan ?? plan;
  const nativeEvidence = [];
  const nativePhases = [];
  const nativeLinks = [];
  let retainedArchiveFiles = [];
  let validateNativeRetention;
  if (nativeExecution) {
    let phase = nativeSaved ? { phase: nativeSaved.phase, runId: nativeSaved.runId, directory: nativeSaved.directory }
      : { phase: 'execution', runId, directory: iso.dir };
    let reopened;
    if (nativeSaved) {
      reopened = reopenPlanningContext({ continuation: nativeSaved, target: iso.dir, directory: nativeSaved.directory });
      try {
        nativePhases.push(...structuredClone(nativeSaved.phaseChain ?? []).filter(item => item.runId !== phase.runId));
        nativeLinks.push(...structuredClone(nativeSaved.phaseLinks ?? []));
      } catch (error) { reopened.journal.close(); throw error; }
    }
    let retained;
    let interruptedPlanningObservations = [];
    const totalResources = () => nativePhases.reduce((total, item) => {
      const account = item.resources;
      if (!account) return { ...total, usageUnknown: true };
      for (const key of ['providerLaunches', 'repairLaunches', 'failedLaunches']) total[key] += account[key] ?? 0;
      total.knownUsage = addUsage(total.knownUsage, account.knownUsage);
      total.usageUnknown ||= account.usageUnknown;
      return total;
    }, { providerLaunches: 0, repairLaunches: 0, failedLaunches: 0, knownUsage: { inputTokens: 0, outputTokens: 0 }, usageUnknown: false });
    const checkDirectory = directory => {
      if (directory !== iso.dir) {
        for (const path of [join(iso.dir, '.uro-tmp'), join(iso.dir, '.uro-tmp', 'retained-phases'), directory]) {
          const rel = relative(realpathSync.native(iso.dir), realpathSync.native(path));
          if (lstatSync(path).isSymbolicLink() || rel.startsWith('..') || isAbsolute(rel)) throw new Error('retained phase namespace escape');
        }
      }
    };
    const checkPhase = item => {
      checkDirectory(item.directory);
      const checkpoint = item.checkpointState;
      const manifest = checkpoint?.executionArtifacts ?? checkpoint?.planningArtifacts;
      if (!manifest || !checkpoint.journalIdentity) throw new Error('required native phase manifest or journal identity unavailable');
      const actual = contextLifecycle.manifest({ directory: item.directory, runId: item.runId, contextDigest: manifest.contextDigest,
        registeredPaths: manifest.files.map(file => join(item.directory, file.path)) });
      if (contextDigest({ manifest }) !== contextDigest({ manifest: actual })) throw new Error('required native phase manifest changed');
      const events = readFileSync(join(item.directory, '__uro_dialogue/journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      const tail = events.at(-1);
      if (tail.sequence !== checkpoint.journalIdentity.sequence || tail.hash !== checkpoint.journalIdentity.hash) throw new Error('required native journal tail changed');
      return events;
    };
    const checkChain = () => {
      for (const item of nativePhases) checkPhase(item);
      for (const link of nativeLinks) {
        checkDirectory(link.directory);
        if (lstatSync(link.path).isSymbolicLink() || reviewDigest(readFileSync(link.path)) !== link.digest) throw new Error('retained phase handoff changed');
      }
    };
    validateNativeRetention = checkChain;
    if (reopened) {
      try {
        checkChain();
        if (phase.phase === 'execution' && opts[nativeRecovery].humanRuling) applyScopedHumanRuling({ session: reopened, state: reopened.dialogue,
          humanRuling: opts[nativeRecovery].humanRuling });
        if (phase.phase === 'execution' && opts[nativeRecovery].technicalContinue) resumeTechnicalDialogue({ session: reopened, state: reopened.dialogue });
      } catch (error) { reopened.journal.close(); throw error; }
    }
    const completePhase = result => {
      const item = structuredClone({ ...phase, action: result.action, resources: result.resources,
        checkpointState: result.checkpointState, messages: result.messages ?? result.state?.messages ?? [] });
      nativePhases.push(item);
      checkPhase(item);
      return item;
    };
    const allocatePhase = (kind, parent, execution, trigger) => {
      checkChain();
      const id = `${runId}-${kind}-${randomUUID()}`;
      const namespace = join(iso.dir, '.uro-tmp', 'retained-phases');
      for (const path of [join(iso.dir, '.uro-tmp'), namespace]) {
        mkdirSync(path, { recursive: true });
        const rel = relative(realpathSync.native(iso.dir), realpathSync.native(path));
        if (lstatSync(path).isSymbolicLink() || rel.startsWith('..') || isAbsolute(rel)) throw new Error('retained phase namespace escape');
      }
      const directory = join(namespace, randomUUID()); mkdirSync(directory);
      phase = { phase: kind, runId: id, directory };
      const parentManifest = parent.checkpointState.executionArtifacts ?? parent.checkpointState.planningArtifacts;
      const context = { schemaVersion: 1, parent: { phase: parent.phase, runId: parent.runId, directory: parent.directory,
          journalIdentity: parent.checkpointState.journalIdentity, manifest: parentManifest,
          stateDigest: contextDigest({ state: parent.checkpointState.dialogue ?? parent.checkpointState.preparationState }),
          contextDigest: parentManifest.contextDigest }, child: phase, originalRequirements: originalPlan, currentPlan: plan,
        originalContext: opts.context ?? {}, sourceScope: execution.scope, approvedExecutionPlan,
        parentEntries: (parent.checkpointState.dialogue?.snapshot.entries ?? []).filter(entry => entry.kind !== 'retained-phase'),
        interactionMode: mode, limits: { challengeRounds, debateRounds: maxDebateRounds, tokenBudget, pivotCandidates },
        workspace: { target: resolve(target), directory: iso.dir, baseCommit: iso.baseCommit,
          head: execFileSync('git', ['-C', iso.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
          diff: currentDiff, diffDigest: reviewDigest(currentDiff) }, trigger,
        history: nativePhases.map(item => ({ runId: item.runId, phase: item.phase, messages: item.messages })),
        execution: { proposalCycles: execution.proposalCycles, correctionCycles: execution.correctionCycles,
          challengeCycles: execution.challengeCycles, executionCycle: execution.executionCycle, operations: execution.operations,
          mergeProgress: execution.mergeProgress,
          previous: execution.priorExecution ?? null }, resources: totalResources() };
      const path = join(directory, 'phase-link.json');
      const fd = openSync(path, 'wx');
      try { writeFileSync(fd, JSON.stringify(context)); fsyncSync(fd); } finally { closeSync(fd); }
      nativeLinks.push({ path, digest: reviewDigest(readFileSync(path)), ...phase });
      checkChain();
      return { context, validate: checkChain, evidence: parent.checkpointState.dialogue?.evidence ?? [],
        evidenceRoots: parent.checkpointState.dialogue?.scope.evidenceRoots ?? [] };
    };
    const readMergeHead = () => {
      try { return execFileSync('git', ['-C', iso.dir, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { encoding: 'utf8', windowsHide: true }).trim(); }
      catch (error) { if (error.status === 1) return null; throw error; }
    };
    const capture = async ({ readOnly = false } = {}) => {
      if (readOnly) {
        // At merge entry only parent-tracked files exist; after a merge sequence
        // all writer files were already captured. Observe without restaging an
        // uncertain Git effect or mutating before the first durable intent.
        const observed = await spawnCapture('git', ['-C', iso.dir, 'diff', merge?.mergeBase ?? iso.baseCommit,
          '--', '.', ...HARNESS_ARTIFACTS.map(path => `:(exclude)${path}`)]);
        if (observed.code !== 0) throw new Error(`cannot observe retained merge diff: ${observed.stderr.trim()}`);
        currentDiff = observed.stdout;
        const paths = await spawnCapture('git', ['-C', iso.dir, 'ls-files', '--others', '--exclude-standard', '-z',
          '--', '.', ...HARNESS_ARTIFACTS.map(path => `:(exclude)${path}`)]);
        if (paths.code !== 0) throw new Error(`cannot observe retained merge files: ${paths.stderr.trim()}`);
        const untrackedFiles = paths.stdout.split('\0').filter(Boolean).map(path => {
          const file = join(iso.dir, path), stat = lstatSync(file);
          return stat.isFile() && !stat.isSymbolicLink() ? { path, sha256: reviewDigest(readFileSync(file)) } : { path, kind: 'non-regular' };
        });
        observedMergeWorkspace = { head: execFileSync('git', ['-C', iso.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
          mergeHead: readMergeHead(), trackedDiffDigest: reviewDigest(currentDiff), untrackedFiles, diffComplete: untrackedFiles.length === 0 };
        observedMergeWorkspace.codeIdentity = contextDigest(observedMergeWorkspace);
      } else currentDiff = await createDiff(iso.dir, merge?.mergeBase ?? iso.baseCommit);
      writeFileSync(join(iso.dir, 'CHANGES.diff'), currentDiff);
      return { artifactDigest: reviewDigest(currentDiff), diff: currentDiff };
    };
    const checkSelection = () => {
      const required = [...commands, ...buildReviewerTestCommands(commands, [...accumulatedReviewTests]),
        ...(merge === undefined ? [] : [testCountFloorCommand(merge.testCounts.required)])];
      return { identity: contextDigest({ commands: required, policy: 'required-exit-zero', mutation: mutationPolicy,
        reviewerTests: [...accumulatedReviewTests].sort().map(path => ({ path, digest: reviewDigest(readFileSync(join(iso.dir, path))) })) }), commands: required };
    };
    const mutationPolicy = opts.mutation === undefined ? null : opts.mutation === true ? {} : opts.mutation;
    const mutationTestSupport = new Map();
    if (nativeSaved && mutationPolicy !== null) {
      const retainedSupport = [
        ...(nativeSaved.mutation?.analysis?.selection?.testSupportFiles ?? []),
        ...iterations.flatMap(item => (item.reviewer?.artifact?.testFiles ?? []).map(path => ({ path,
          sha256: item.reviewer.artifact.files?.[path.replace(/^__uro_review\//, '')] }))),
      ];
      for (const { path, sha256 } of retainedSupport) {
        if (typeof path !== 'string' || !path.startsWith('__uro_review/tests/')
          || path.split('/').some(part => !part || part === '.' || part === '..') || typeof sha256 !== 'string') throw new Error('invalid retained mutation test support inventory');
        const file = join(iso.dir, path), contained = relative(realpathSync.native(iso.dir), realpathSync.native(file));
        if (isAbsolute(contained) || contained.startsWith('..') || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()
          || reviewDigest(readFileSync(file)) !== sha256 || mutationTestSupport.has(path) && mutationTestSupport.get(path) !== sha256) throw new Error('retained mutation test support changed');
        mutationTestSupport.set(path, sha256);
      }
    }
    const validateMutationPolicy = () => {
      if (adapters.runMutation !== undefined) throw new Error('native mutation rejects opaque runMutation adapters');
      if (!mutationPolicy || typeof mutationPolicy !== 'object' || Array.isArray(mutationPolicy)
        || Object.keys(mutationPolicy).some(key => !['tests', 'dryRun', 'budget', 'concurrency', 'trialTimeoutMs'].includes(key)))
        throw new Error('native mutation accepts serializable tests/dryRun/budget/concurrency/trialTimeoutMs policy only');
      const check = value => {
        if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new Error('native mutation policy must be serializable');
        if (value && typeof value === 'object') for (const item of Object.values(value)) check(item);
      };
      check(mutationPolicy);
      nativeMutationPolicy = structuredClone(mutationPolicy);
    };
    const observeMutationSource = ({ cwd, beforeOverlay = false, expectedTestSupport = [] }) => {
      const root = realpathSync.native(cwd);
      const listed = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z',
        '--', '.', ...HARNESS_ARTIFACTS.filter(path => path !== '__uro_review/').map(path => `:(exclude)${path}`)], { encoding: 'utf8', windowsHide: true });
      const explicitTests = mutationPolicy?.tests?.files ?? [];
      const listedFiles = listed.split('\0').filter(Boolean);
      // A new trial may contain a tracked entry but not its ignored helper yet.
      // This before-write snapshot observes bytes, not an executable test closure;
      // selection, overlay validation, post-write and command observation stay strict.
      const support = beforeOverlay ? null : resolveMutationTestSupport({ root,
        selectedTests: [...new Set([...explicitTests, ...accumulatedReviewTests,
          ...listedFiles.filter(isTestFile)])],
        testSupportFiles: [...mutationTestSupport].map(([path, sha256]) => ({ path, sha256 })) });
      const resolvedSupportPaths = new Set(support?.files.map(file => file.path) ?? expectedTestSupport);
      const files = [...new Set([...listedFiles, ...mutationTestSupport.keys(), ...resolvedSupportPaths,
        ...explicitTests, ...accumulatedReviewTests])].filter(path => !path.startsWith('__uro_review/')
        || isTestFile(path) || explicitTests.includes(path) || accumulatedReviewTests.has(path)
        || mutationTestSupport.has(path) || resolvedSupportPaths.has(path)).sort().map(path => {
        const file = resolve(root, path), rel = relative(root, file);
        if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) throw new Error('mutation source escapes observed workspace');
        if (!existsSync(file)) return { path, missing: true };
        const canonical = realpathSync.native(file), actual = relative(root, canonical);
        if (isAbsolute(actual) || actual === '..' || actual.startsWith('..\\') || actual.startsWith('../')
          || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('mutation source requires contained regular files');
        const bytes = readFileSync(file);
        return { path, sha256: reviewDigest(bytes),
          ...(/\.(?:[cm]?js|jsx|tsx?)$/i.test(path) || explicitTests.includes(path) || mutationTestSupport.has(path)
            ? { encoding: 'base64', bytes: bytes.toString('base64'), text: bytes.toString('utf8') } : {}) };
      });
      return { cwd: root, codeIdentity: contextDigest(files.map(({ bytes, text, encoding, ...identity }) => identity)), files,
        resolvedTestSupport: support?.files ?? null,
        supportResolution: beforeOverlay ? 'deferred-before-overlay' : 'resolved' };
    };
    const selectMutation = () => {
      validateMutationPolicy();
      const source = observeMutationSource({ cwd: iso.dir });
      const selection = { cwd: source.cwd, base: merge?.mergeBase ?? iso.baseCommit,
        sourceIdentity: source.codeIdentity, policy: structuredClone(mutationPolicy), requiredChecks: checkSelection(),
        resolvedTestSupport: source.resolvedTestSupport,
        testSupportFiles: [...mutationTestSupport].sort(([a], [b]) => a.localeCompare(b)).map(([path, sha256]) => {
          if (reviewDigest(readFileSync(join(iso.dir, path))) !== sha256) throw new Error('verified reviewer test support bytes changed');
          return { path, sha256 };
        }) };
      return { ...selection, identity: contextDigest(selection) };
    };
    const mergeSelection = ({ state }) => {
      if (state.mergeHumanReview && (state.mergeHumanReview.status !== 'reviewed'
        || state.mergeHumanReview.artifactDigest === state.artifactDigest)) return null;
      if (merge === undefined || state.mergeProgress?.complete || state.executionCycle?.open
        || state.mergeProgress && !state.executionCycle) return null;
      const progress = state.mergeProgress;
      const mergeHead = readMergeHead();
      if (progress?.conflict && mergeHead && mergeHead !== progress.conflict.parentCommit) throw new Error('actual merge parent differs from saved conflict');
      const gitRead = (...args) => execFileSync('git', ['-C', iso.dir, ...args], { encoding: 'utf8', windowsHide: true }).trim();
      const ledgerPath = join(iso.dir, MERGE_LEDGER_FILENAME);
      if (existsSync(ledgerPath) && (!lstatSync(ledgerPath).isFile() || lstatSync(ledgerPath).isSymbolicLink())) throw new Error('merge ledger must be a retained regular file');
      for (const parent of merge.parents) if (gitRead('rev-parse', `${parent.commit}^{commit}`) !== parent.commit) throw new Error('merge parent requires exact commit identity');
      const selection = { cwd: realpathSync.native(iso.dir), baseCommit: iso.baseCommit, mergeBase: merge.mergeBase,
        head: gitRead('rev-parse', 'HEAD'), mergeHead, parents: structuredClone(merge.parents),
        nextParentIndex: progress?.nextParentIndex ?? 1, conflict: progress?.conflict ?? null,
        ledger: { path: MERGE_LEDGER_FILENAME, sha256: existsSync(ledgerPath) ? reviewDigest(readFileSync(ledgerPath)) : null },
        index: gitRead('ls-files', '--stage'), worktreeDiff: reviewDigest(gitRead('diff')),
        action: progress?.conflict ? 'conclude-clear-advance' : 'initial-advance' };
      return { ...selection, identity: contextDigest(selection) };
    };
    const runMergeSequence = async request => {
      // Validate the actual inputs again after durable preparation, before any Git mutation.
      if (mergeSelection(request)?.identity !== request.selection.identity) throw new Error('prepared merge inputs changed');
      const before = request.state.mergeProgress;
      let progress = before, reason = null;
      if (request.selection.conflict) {
        const ledger = readMergeLedger({ cwd: iso.dir, conflict: request.selection.conflict });
        if (!ledger.ok) reason = mergePreparationFailure = ledger.reason;
        else {
          mergeResolutions.push(...ledger.resolutions);
          if (ledger.status === 'conflicting-intent') {
            conflictingIntent = true; reason = 'conflicting-intent: merge requires human direction';
          } else {
            const concluded = await concludeConflict({ cwd: iso.dir, conflict: request.selection.conflict, unitId: runId });
            if (!concluded.ok) reason = mergePreparationFailure = concluded.reason;
            else clearMergeLedger(iso.dir);
          }
        }
      }
      if (!reason) progress = await observedAdvanceMerge({ cwd: iso.dir, parents: merge.parents, unitId: runId,
        nextParentIndex: request.selection.nextParentIndex + (request.selection.conflict ? 1 : 0) });
      mergeProgress = progress; activeConflict = progress?.conflict ?? null;
      if (activeConflict && !mergeConflicts.some(c => c.parentCommit === activeConflict.parentCommit)) mergeConflicts.push(activeConflict);
      plan = buildMergeTask(approvedExecutionPlan, merge, activeConflict);
      const observed = await capture();
      const head = execFileSync('git', ['-C', iso.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
      return { ...observed, mergeProgress: { ...progress, task: plan, head, mergeHead: readMergeHead(), reason,
        conflicts: structuredClone(mergeConflicts), resolutions: structuredClone(mergeResolutions),
        ledger: { path: MERGE_LEDGER_FILENAME, sha256: existsSync(join(iso.dir, MERGE_LEDGER_FILENAME)) ? reviewDigest(readFileSync(join(iso.dir, MERGE_LEDGER_FILENAME))) : null } } };
    };
    const providerResults = [];
    const execute = async request => {
      const attempt = ++executorLaunchCount;
      writeFileSync(join(iso.dir, 'TASK.md'), request.input);
      const controller = stallConfig?.policy === 'restart' ? new AbortController() : null;
      const slot = { stop: event => slot.stopping ??= (async () => {
        try {
          await request.onLivenessDecisionRequired({ ...event, status: 'stuck', judged: false, reasoning: 'Explicit stall policy requested termination; writer outcome remains unknown' });
          await request.beforeKillRequired(event);
        } catch (error) { slot.failure = error; }
        finally { controller?.abort(slot.failure ? { ...event, persistenceFailure: slot.failure.message } : event); }
      })() };
      if (controller) activeExecutor = slot;
      let response;
      try { response = await runExecutor({ ...request, plan: request.input, model: executorModel, effort: executorEffort,
        bin: opts.codexBin ?? 'codex', env: runEnvironment, ownedTmpDir: true,
        timeoutMs: stageTimeouts.executor, reporter: eventReporter, runId: request.state.runId, attempt,
        ...(controller ? { signal: controller.signal } : {}),
        onLivenessDecision: decision => { livenessChecks ??= []; livenessChecks.push({ attempt, iteration: request.state.proposalCycles, ...decision }); },
        onLiveness: () => watchdog?.touch('executor'),
        livenessThresholdMs: executorThresholds.thresholdMs, progressThresholdMs: executorThresholds.progressThresholdMs });
      } finally { await slot.stopping; if (activeExecutor === slot) activeExecutor = null; }
      if (response.timedOut || response.aborted) {
        try { await request.beforeKillRequired(response.timeoutReason ?? { kind: 'aborted' }); }
        catch (error) { response.error = error.message; }
      }
      if (slot.failure || response.preservationError) response.error = slot.failure?.message ?? response.preservationError;
      recordExecutorTimeout(response, request.state.proposalCycles, attempt);
      providerResults.push({ seat: 'codex', operationId: request.operationId, response });
      if (['propose', 'revise'].includes(request.action)) {
        iterations.push({ n: request.state.proposalCycles, operationId: request.operationId,
          remainingWork: request.remainingWork, changedFiles: response.changedFiles ?? [], lastMessage: response.lastMessage ?? response.content ?? '',
          executorUsage: response.usage ?? null, executor: { exitCode: response.exitCode ?? null, timedOut: Boolean(response.timedOut), timeoutMs: stageTimeouts.executor }, gate: null });
      }
      return response;
    };
    const review = typeof runReview === 'function' ? async request => {
      const response = await runReview({ ...request, prompt: request.input, deferMaterialization: true,
        originalRequirements: originalPlan, diff: currentDiff, diffDigest: reviewDigest(currentDiff),
        round: request.state.proposalCycles, messages: request.state.messages, evidence: request.state.evidence,
        model: verifierModel, bin: verifierBin, env: runEnvironment, superpowersDir: claudeSuperpowersDir,
        timeoutMs: stageTimeouts.verifier, reporter: eventReporter, runId: request.state.runId });
      providerResults.push({ seat: 'claude', operationId: request.operationId, response });
      return response;
    } : null;
    const completeReview = async ({ response: raw, ...request }) => {
      const response = raw?.materializationDeferred === true ? await completeReviewPass({ result: raw,
        cwd: iso.dir, round: request.state.proposalCycles, diffDigest: reviewDigest(currentDiff), dialogueMode: true,
        expectedIdentity: { artifactDigest: request.state.artifactDigest, contextDigest: request.state.snapshot.digest } }) : raw;
      const observed = providerResults.find(item => item.operationId === request.operationId);
      if (observed) observed.response = response;
      if (response?.artifact) {
        const artifact = detectReview({ dir: iso.dir, artifact: response.artifact, round: request.state.proposalCycles, diffDigest: reviewDigest(currentDiff) });
        if (!artifact.reviewed) return { ...response, artifactFailed: true, error: 'native review artifact is missing or stale' };
        for (const file of artifact.testFiles ?? []) accumulatedReviewTests.add(file);
        for (const path of mutationPolicy === null ? [] : response.artifact.testFiles ?? []) {
          const key = path.replace(/^__uro_review\//, ''), sha256 = response.artifact.files?.[key];
          if (!path.startsWith('__uro_review/tests/') || path.split('/').some(part => !part || part === '.' || part === '..')
            || typeof sha256 !== 'string' || reviewDigest(readFileSync(join(iso.dir, path))) !== sha256)
            return { ...response, artifactFailed: true, error: 'verified reviewer mutation support identity is invalid' };
          mutationTestSupport.set(path, sha256);
        }
        if (iterations.length) iterations.at(-1).reviewer = response;
      }
      let envelope;
      try { envelope = parseDialogueEnvelope({ response }); } catch { /* Native dispatcher owns protocol repair. */ }
      if (envelope?.action === 'approve' && (!gateResult || !request.state.executionChecks || !Array.isArray(gateResult.results)
        || gateResult.results.some(result => result.code !== 0 || result.timedOut))) {
        return { ...response, error: 'current required checks are incomplete or failed' };
      }
      if (envelope?.action === 'approve' && merge !== undefined && !request.state.mergeProgress?.complete) return { ...response, error: 'pending merge cannot be approved' };
      return response;
    };
    try {
      while (true) {
      let parent, execution, message, trigger;
      if (phase.phase === 'execution') {
      const initial = await capture({ readOnly: merge !== undefined });
      const prior = totalResources();
      nativeResult = await runExecutionDialogue({ target: iso.dir, directory: phase.directory, runId: phase.runId, retained,
        ...(reopened ? { session: reopened, state: reopened.dialogue, snapshot: reopened.snapshot, journal: reopened.journal } : {}),
        artifactRoot: resolveArtifactRoot({ scratchRoot, artifactRoot: opts.artifactRoot, env: runEnvironment }),
        requirements: originalPlan, plan: approvedExecutionPlan,
        task: merge !== undefined ? buildMergeTask(approvedExecutionPlan, merge, activeConflict) : approvedExecutionPlan,
        artifactDigest: initial.artifactDigest, interactionMode: mode,
        context: { ...(opts.context ?? {}), ...(parentContext ? { queueParent: parentContext } : {}),
          workspace: { baseCommit: iso.baseCommit, target: resolve(target) }, requiredCommands: commands },
        limits: { ...(challengeRounds === undefined ? {} : { challenges: challengeRounds }),
          ...(maxDebateRounds === undefined ? {} : { proposalCycles: maxDebateRounds }) },
        execute, discuss: request => execute({ ...request, sandbox: 'read-only' }),
        review, completeReview, capture, selectChecks: checkSelection, reviewInstructions: EXECUTION_REVIEW_PROMPT,
        ...(mutationPolicy === null ? {} : {
          selectMutation, observeMutationSource,
          runMutation: request => realMutation({ ...mutationPolicy, target: iso.dir, base: request.selection.base,
            runId: phase.runId, reporter: eventReporter, effects: { ...request.effects, testSupportFiles: request.selection.testSupportFiles },
            judge: createMutationJudge({ cwd: iso.dir, env: runEnvironment, ...(adapters.runMutationSeat ? { runSeat: adapters.runMutationSeat } : {}) }),
            arbiter: createMutationArbiter({ cwd: iso.dir, env: runEnvironment, ...(adapters.runMutationSeat ? { runSeat: adapters.runMutationSeat } : {}) }),
            adapters: { ...(adapters.runMutationCommand ? { runCommand: adapters.runMutationCommand } : {}) } }),
          captureMutationEvidence: async request => {
            if (request.effect.effect === 'mutation-write') {
              const records = [];
              for (const file of request.result.files ?? []) {
                if (file.missing) continue;
                const record = await (adapters.captureEvidence ?? captureEvidence)({ projectId: request.state.projectId,
                  root: request.result.directory, directory: request.evidenceDirectory, evidence: {
                    id: `${request.operationId}-source-${contextDigest(file.path)}`, kind: 'code', required: true,
                    projectId: request.state.projectId, claimIds: [], sourceIdentity: request.sources.after.codeIdentity,
                    locator: { path: file.path, line: 1 }, mutation: { purpose: request.effect.purpose,
                      analysisIdentity: request.effect.input.analysisIdentity, cwd: request.result.directory,
                      interpretation: 'historical disposable source captured before cleanup; not current outer code evidence' } } });
                if (record.sourceDigest !== file.sha256 || record.contextIncomplete) throw new Error('mutation source capture differs from observed write');
                records.push(record);
              }
              return records;
            }
            const entry = request.result.evidence;
            const record = await (adapters.captureEvidence ?? captureEvidence)({ projectId: request.state.projectId,
              root: entry.cwd, directory: request.evidenceDirectory, evidence: { ...entry, id: request.operationId,
                kind: 'command', required: true, projectId: request.state.projectId, claimIds: [`${request.operationId}-result`],
                sourceIdentity: entry.codeIdentity, mutation: { purpose: request.effect.purpose, key: request.effect.key,
                  analysisIdentity: request.effect.input.analysisIdentity, sourcesBefore: request.sources.before,
                  sourcesAfter: request.sources.after, interpretation: 'observed command in its actual cwd; trial source is historical, not current outer source' } } });
            if (record.contextIncomplete) throw new Error('required mutation evidence capture is incomplete');
            nativeEvidence.push(record);
            return [record];
          },
        }),
        selectMerge: mergeSelection, runMerge: runMergeSequence,
        judgeLiveness,
        selectPreservation: async () => ({ cwd: realpathSync.native(iso.dir), baseCommit: merge?.mergeBase ?? iso.baseCommit,
          head: execFileSync('git', ['-C', iso.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
          index: execFileSync('git', ['-C', iso.dir, 'ls-files', '--stage'], { encoding: 'utf8', windowsHide: true }),
          mergeHead: readMergeHead() }),
        preserveExecutorWork: ({ selection }) => preservePartialExecutorWork(iso.dir, selection.baseCommit, createDiff, true),
        runChecks: async request => {
          const captured = [];
          gateResult = await runGate({ commands: request.selection.commands, cwd: iso.dir, timeoutMs: stageTimeouts.gate,
            reporter: eventReporter, runId, attempt: request.state.proposalCycles, captureTestCount, requiredEvidence: true,
            codeIdentity: async () => (await capture()).artifactDigest,
            onEvidence: async entry => {
              const record = await (adapters.captureEvidence ?? captureEvidence)({ projectId: request.state.projectId, root: iso.dir,
                directory: request.evidenceDirectory, evidence: { ...entry, id: `${request.operationId}-command-${captured.length + 1}`,
                  kind: 'command', projectId: request.state.projectId, claimIds: [`${request.operationId}-command-result-${captured.length + 1}`], sourceIdentity: entry.codeIdentity } });
              captured.push(record); nativeEvidence.push(record);
            } });
          recordGateTimeout(gateResult, request.state.proposalCycles, 1);
          if (captured.length !== request.selection.commands.length) throw new Error('required command evidence is incomplete');
          if (iterations.length) iterations.at(-1).gate = gateResult;
          return { ...await capture(), evidence: captured,
            passed: gateResult.results.every(result => result.code === 0 && !result.timedOut) };
        },
        budget: ({ account }) => tokenBudget !== undefined && (prior.usageUnknown || account.usageUnknown) ? { allowed: false, reason: 'accounting-incomplete: unknown provider usage' }
          : tokenBudget !== undefined && prior.knownUsage.inputTokens + prior.knownUsage.outputTokens + account.knownUsage.inputTokens + account.knownUsage.outputTokens >= tokenBudget
            ? { allowed: false, reason: 'budget-exhausted: token budget reached' } : { allowed: true },
        reporter: eventReporter, env: runEnvironment });
      const finalCapture = await capture({ readOnly: merge !== undefined || nativeResult.action === 'paused' });
      if (nativeResult.approved && (observedMergeWorkspace?.diffComplete === false || finalCapture.artifactDigest !== nativeResult.state.artifactDigest
        || nativeResult.state.executionChecks?.artifactDigest !== finalCapture.artifactDigest
        || nativeResult.state.executionChecks?.checkSetIdentity !== checkSelection().identity
        || !gateResult || gateResult.results?.length !== checkSelection().commands.length
        || gateResult.results.some(result => result.code !== 0 || result.timedOut))) {
        nativeResult.approved = false; nativeResult.action = 'paused'; nativeResult.reason = 'current required checks are incomplete, stale or failed';
      }
      if (nativeResult.approved && opts.mutation !== undefined) {
        if (nativeResult.mutation?.status !== 'completed' || nativeResult.mutation.selection.identity !== selectMutation().identity) {
          nativeResult.approved = false; nativeResult.action = 'paused'; nativeResult.reason = 'current mutation analysis is incomplete or stale';
        }
      }
      reopened = null;
      parent = completePhase(nativeResult);
      checkChain();
      if (nativeResult.action !== 'replan') break;
      execution = nativeResult.state;
      message = execution.messages.at(-1); trigger = message?.replan;
      if (execution.pendingDecision || message?.sender !== 'claude' || message.action !== 'replan'
        || !trigger || !(trigger.issueId && Object.hasOwn(execution.issues, trigger.issueId)
          || trigger.claimId && Object.hasOwn(execution.claims, trigger.claimId))
        || typeof trigger.novelty !== 'string' || !trigger.novelty.trim()
        || !Array.isArray(trigger.evidenceIds) || !trigger.evidenceIds.length) throw new Error('retained replan requires an affected issue or claim, trusted evidence and concrete novelty');
      for (const id of trigger.evidenceIds) {
        const item = execution.evidence.find(e => e.id === id);
        const valid = validateEvidence({ evidence: item, projectId: execution.projectId,
          roots: [...execution.scope.sourceRoots, ...execution.scope.evidenceRoots] });
        if (!valid.valid) throw new Error(`retained replan evidence invalid: ${valid.reason}`);
      }
      retained = allocatePhase('planning', parent, execution, { ...trigger, message });
      } else {
        parent = nativePhases.at(-1);
        const link = nativeLinks.find(item => item.runId === phase.runId && item.phase === 'planning');
        if (!parent || parent.phase !== 'execution' || !link || !reopened) throw new Error('retained planning has no validated execution parent');
        const context = JSON.parse(readFileSync(link.path, 'utf8'));
        if (context.child.runId !== phase.runId || context.child.directory !== phase.directory
          || context.parent.runId !== parent.runId || context.workspace.directory !== iso.dir
          || context.workspace.baseCommit !== iso.baseCommit
          || context.parent.stateDigest !== contextDigest({ state: parent.checkpointState.dialogue })
          || context.parent.contextDigest !== parent.checkpointState.dialogue.snapshot.digest) throw new Error('retained planning parent or workspace identity changed');
        execution = parent.checkpointState.dialogue;
        message = context.trigger.message; trigger = context.trigger;
        if (message?.id !== execution.messages.at(-1)?.id || message.action !== 'replan') throw new Error('retained planning trigger identity changed');
        retained = { context, validate: checkChain, evidence: execution.evidence, evidenceRoots: execution.scope.evidenceRoots };
      }
      const held = retained;
      interruptedPlanningObservations = [];
      held.protect = async (invoke, operation) => {
        const observedBefore = interruptedPlanningObservations.length;
        let raw;
        try {
        checkChain();
        if (execFileSync('git', ['-C', iso.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim()
          !== held.context.workspace.head) throw new Error('retained project HEAD changed during planning');
        const result = await runProtectedOperation({ cwd: iso.dir, scope: 'outside', prefix: '__uro_review',
          stage: 'retained-planning', runId: phase.runId, operation: async () => (await runProtectedOperation({
            cwd: iso.dir, scope: 'inside', prefix: '__uro_review', captureSnapshot: captureReviewSnapshot,
            restoreSnapshot: restoreReviewSnapshot, operation: async () => {
              const observed = { ...operation };
              interruptedPlanningObservations.push(observed);
              try { raw = await invoke(); observed.usage = raw?.usage ?? null; return raw; }
              catch (error) { observed.error = error.message; throw error; }
            } })).result });
        checkChain();
        if ((await capture()).artifactDigest !== held.context.workspace.diffDigest) throw new Error('retained project changed during planning');
        return result.result;
        } catch (error) {
          if (interruptedPlanningObservations.length === observedBefore) error.retainedIntegrityFailure = true;
          if (raw !== undefined) return { ...(typeof raw === 'string' ? { content: raw } : raw), error: error.message };
          throw error;
        }
      };
      nativeResult = { approved: false, action: 'paused', reason: 'retained planning has not completed',
        checkpointState: { version: 2, ...phase, interactionMode: mode, requirements: originalPlan } };
      if (reopened) reopened.retained = held;
      const generated = reopened ? await continuePlanCandidateSet({ checkpointState: nativeSaved,
        target: iso.dir, session: reopened, humanRuling: opts[nativeRecovery].humanRuling, technicalContinue: opts[nativeRecovery].technicalContinue,
        claudeModel: arbiterModel, codexModel: executorModel, codexEffort: executorEffort,
        executorTimeout: stageTimeouts.executor, timeoutMs: stageTimeouts.arbiter, env: runEnvironment, reporter: eventReporter,
        draft: adapters.draftPlanCandidate, select: adapters.selectPlanCandidate, review: adapters.reviewPlanCandidate,
      }) : await generatePlanCandidates({ goal: originalPlan, target: iso.dir, directory: phase.directory, runId: phase.runId,
        mode: 'fresh', count: pivotCandidates, interactionMode: mode, failedPlan: plan, previousPlan: originalPlan,
        pivot: 'Preserve completed work; plan and authorize only remaining work using the retained evidence and decisions.',
        priorMessages: execution.messages, retained, artifactRoot: resolveArtifactRoot({ scratchRoot, artifactRoot: opts.artifactRoot, env: runEnvironment }),
        ...(tokenBudget === undefined ? {} : { resourceBudget: { tokenBudget, prior: totalResources() } }),
        claudeModel: arbiterModel, codexModel: executorModel, codexEffort: executorEffort,
        timeoutMs: stageTimeouts.arbiter, executorTimeout: stageTimeouts.executor, env: runEnvironment, reporter: eventReporter,
        ...(adapters.draftPlanCandidate ? { draft: adapters.draftPlanCandidate } : adapters.runExecutor ? { draft: async () => ({ unavailable: true, error: 'retained planner unavailable' }) } : {}),
        ...(adapters.selectPlanCandidate ? { select: adapters.selectPlanCandidate } : {}),
        ...(adapters.reviewPlanCandidate ? { review: adapters.reviewPlanCandidate } : {}),
      });
      reopened = null;
      nativeResult = { ...generated, state: generated.dialogue ?? generated.state, snapshot: generated.sharedContext,
        action: generated.action ?? 'paused' };
      const planningPhase = completePhase(nativeResult);
      planningUsage = addUsage(planningUsage, generated.resources?.knownUsage);
      if (!generated.approved) break;
      const selected = generated.selected, dialogue = generated.dialogue;
      const manualPlanApproval = mode === 'manual' && generated.approval?.decidedBy === 'human'
        && nativeSaved?.phase === 'planning' && nativeHumanQuestion(nativeSaved)?.decisionKind === 'manual-dispute'
        && dialogue?.humanRuling?.action === 'approve'
        && dialogue.humanRuling.decisionId === opts[nativeRecovery]?.humanRuling?.decisionId
        && dialogue.humanRuling.artifactDigest === dialogue.artifactDigest
        && dialogue.humanRuling.contextDigest === dialogue.snapshot.digest;
      if (!selected || generated.runId !== phase.runId || dialogue?.runId !== phase.runId || dialogue.interactionMode !== mode
        || !manualPlanApproval && (generated.approval?.decidedBy !== 'codex' || !canApproveDialogue({ state: dialogue, seat: 'codex' }).approved)
        || generated.approval.artifactDigest !== planningArtifactDigest(originalPlan, { plan: selected.plan, gate: selected.gate })
        || generated.approval.contextDigest !== dialogue.snapshot.digest) throw new Error('retained planning lacks current selected-plan Codex approval');
      assertPlanningSidecars({ directory: phase.directory, runId: phase.runId, approval: generated.approval, manifest: generated.planningArtifacts });
      const events = checkPhase(planningPhase);
      if (pivotCandidates > 1 && !events.some(event => event.type === 'selected-preparation'
        && event.operationId === selected.response?.preparationOperationId)) throw new Error('retained selected preparation identity missing');
      const savedState = events.findLast(event => event.type === 'state')?.state;
      if (!savedState || contextDigest({ state: savedState }) !== contextDigest({ state: dialogue })) throw new Error('retained planning journal state differs from approved result');
      if ((await capture()).artifactDigest !== held.context.workspace.diffDigest
        || execFileSync('git', ['-C', iso.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim()
          !== held.context.workspace.head) throw new Error('retained project changed before planning adoption');
      plan = selected.plan; approvedExecutionPlan = selected.plan;
      commands.splice(0, commands.length, ...selected.gate); gateResult = null;
      retained = allocatePhase('execution', planningPhase, execution, { ...trigger, message });
      }
    } catch (error) {
      nativeResult = { ...nativeResult, approved: false, action: 'paused', reason: error.message };
      if (phase.phase === 'planning' && !nativePhases.some(item => item.runId === phase.runId)) {
        nativePhases.push({ ...phase, action: 'paused', checkpointState: nativeResult.checkpointState,
          resources: { providerLaunches: interruptedPlanningObservations.length,
            repairLaunches: interruptedPlanningObservations.filter(item => item.effect === 'repair').length,
            failedLaunches: interruptedPlanningObservations.filter(item => item.error).length,
            knownUsage: interruptedPlanningObservations.reduce((sum, item) => addUsage(sum, item.usage), EMPTY_USAGE),
            usageUnknown: interruptedPlanningObservations.some(item => !['inputTokens', 'outputTokens'].every(key => Number.isFinite(item.usage?.[key]) && item.usage[key] >= 0)) },
          observations: interruptedPlanningObservations, integrityFailure: error.message, messages: [] });
        nativeResult.resources = nativePhases.at(-1).resources;
        planningUsage = addUsage(planningUsage, nativeResult.resources.knownUsage);
      }
      await capture({ readOnly: true }); // Observe interrupted effects without a second staging mutation.
    }
    if (!nativeResult.approved && nativeResult.state) nativeResult.state.approval = null;
    nativeResult.phaseResources = nativeResult.resources;
    nativeResult.resources = totalResources();
    retainedArchiveFiles = [
      ...nativePhases.filter(item => item.directory !== iso.dir).flatMap(item => {
        const manifest = item.checkpointState?.executionArtifacts ?? item.checkpointState?.planningArtifacts;
        return (manifest?.files ?? []).map(file => ({ path: relative(iso.dir, join(item.directory, file.path)).replaceAll('\\', '/'), sha256: file.sha256 }));
      }),
      ...nativeLinks.map(link => ({ path: relative(iso.dir, link.path).replaceAll('\\', '/'), sha256: link.digest })),
    ];
    outcome = nativeResult.approved ? 'review-ready' : conflictingIntent ? 'conflicting-intent'
      : nativeResult.action === 'needs-decision' ? 'needs-decision' : 'needs-pivot';
    debateStopReason = nativeResult.reason;
    for (const message of nativePhases.flatMap(item => item.phase === 'execution' ? item.messages : [])) {
      const observed = providerResults.find(item => item.operationId === message.operationId);
      executionMessages.push({ ...message, speaker: message.seat ?? message.sender,
        role: (message.seat ?? message.sender) === 'codex' ? 'implementation-author' : 'execution-reviewer', response: observed?.response });
    }
    // Journal resources are authoritative; these role totals are compatible projections only.
    for (const item of providerResults) {
      observeUsage(item.response, { seat: item.seat, operationId: item.operationId });
      if (item.seat === 'codex') executorUsage = addUsage(executorUsage, item.response?.usage);
      else verifierUsage = addUsage(verifierUsage, item.response?.usage);
    }
  } else {
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
  const effectiveDecisionResolver = decisionResolver
    ?? (mode === 'autonomous'
      ? createAutonomousDecisionResolver({ reviewer: arbitrate, phase: 'execution', interactionMode: mode })
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
        || challengeRound > maxChallengeRounds) {
        decision = { questions: challenge.questions, mode, challengeRound,
          ...(mode === 'autonomous' ? { unavailable: true, reason: 'challenge-limit' } : {}) };
        break;
      }

      const resolution = await effectiveDecisionResolver({
        questions: challenge.questions,
        plan,
        task: originalPlan,
      });
      const validated = validatedResolution(challenge.questions, resolution);
      if (validated === null) {
        decision = { questions: challenge.questions, mode, challengeRound, unavailable: true, reason: 'reviewer-unavailable' };
        break;
      }
      const answeredBy = 'claude';
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
  iter = makeIteration(n, exec, gateResult, executorTimedOut);

  if (executorTimedOut) {
    outcome = 'timed-out';
    debateStopReason = 'executor-timed-out';
    iterations.push(iter);
  } else if (conflictingIntent) {
    outcome = 'conflicting-intent';
    debateStopReason = 'conflicting-intent';
    iterations.push(iter);
  } else if (decision !== null) {
    outcome = decision.unavailable ? 'needs-pivot' : 'needs-decision';
    debateStopReason = decision.reason ?? 'needs-decision';
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
    currentDiff = diff;
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
      let debateRound = continuation?.debateRound ?? 0;
      while (true) {
        const consumedBeforeRound = addUsage(addUsage(addUsage(executorUsage, verifierUsage), arbiterUsage), planningUsage);
        if (tokenBudget !== undefined
          && consumedBeforeRound.inputTokens + consumedBeforeRound.outputTokens >= tokenBudget) {
          outcome = 'needs-pivot';
          debateStopReason = 'token-budget';
          break;
        }
        debateRound++;
        currentDebateRound = debateRound;
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
              operation: async () => {
                const request = { originalRequirements: originalPlan, approvedPlan: originalPlan,
                  currentPlan: plan, diff, diffDigest: reviewDigest(diff), round: debateRound,
                  interactionMode: mode, evidence: gateResult?.results ?? [],
                  evidenceReferences: evidence.records(), messages: [...executionMessages],
                  openFindings: [...openFindings.values()], decisions: resolvedDecision };
                // A successful injected legacy writer still must create a report
                // in THIS invocation. Restore the prior artifacts on failure.
                assertReviewDestination(iso.dir, 'REVIEW.md');
                const snapshot = await captureReviewSnapshot({ cwd: iso.dir });
                const reportPath = join(iso.dir, REVIEW_DIR, 'REVIEW.md');
                if (existsSync(reportPath)) unlinkSync(reportPath);
                let response;
                try {
                  response = await runReview({
                cwd: iso.dir,
                bin: verifierBin,
                model: verifierModel,
                prompt: REVIEW_PROMPT + '\n\nCURRENT REVIEW REQUEST\n' + JSON.stringify(request),
                request,
                round: debateRound,
                diffDigest: request.diffDigest,
                env: runEnvironment,
                timeoutMs: stageTimeouts.verifier,
                reporter: eventReporter,
                runId,
                pass: 'review',
                onLiveness: () => watchdog?.touch('verify'),
                livenessThresholdMs: executorThresholds.thresholdMs,
                progressThresholdMs: executorThresholds.progressThresholdMs,
                judgeLiveness: judgeLiveness ?? undefined,
                onLivenessDecision: decision => livenessChecks?.push({ pass: 'review', iteration: n, ...decision }),
                  });
                  if (adapters.runReview && !response?.artifact && !response?.launchFailed
                    && !response?.timedOut && !response?.artifactFailed && existsSync(reportPath)) {
                    const detected = detectReview({ dir: iso.dir });
                    const bundle = { version: 1, conclusion: response?.conclusion, report: readFileSync(reportPath, 'utf8'),
                      tests: (detected.testFiles ?? []).map((path) => ({
                        path: path.slice(REVIEW_DIR.length + 1), content: readFileSync(join(iso.dir, path), 'utf8') })),
                      dispositions: response?.dispositions ?? [] };
                    response = { ...response, answer: response?.answer ?? JSON.stringify(bundle),
                      artifact: await materializeReviewBundle({ cwd: iso.dir, bundle, round: debateRound, diffDigest: request.diffDigest }) };
                  }
                  if (!response?.artifact || response?.launchFailed || response?.timedOut || response?.artifactFailed) {
                    await restoreReviewSnapshot({ snapshot });
                  }
                  return response;
                } catch (error) {
                  await restoreReviewSnapshot({ snapshot });
                  throw error;
                }
              },
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
        if (!reviewer.skipped) executionMessages.push({ speaker: 'claude', role: 'execution-reviewer', phase: 'execution',
          turn: executionMessages.length + 1, round: debateRound, diffDigest: reviewDigest(diff),
          response: reviewer, content: reviewer.answer ?? reviewer.findings ?? reviewer.error ?? '' });
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
          && !reviewer.timedOut && (!reviewer.artifact || reviewer.artifactFailed
            || !detectReview({ dir: iso.dir, artifact: reviewer.artifact, round: debateRound, diffDigest: reviewDigest(diff) }).reviewed);
        if (reviewer.timedOut || reviewer.launchFailed || reviewMissing) {
          outcome = reviewer.timedOut ? 'timed-out' : 'verifier-failed';
          debateStopReason = reviewer.timedOut
            ? 'review-timed-out'
            : reviewer.launchFailed
              ? 'review-failed'
              : 'unreviewed';
          break;
        }

        for (const finding of blockingFindings) {
          const previous = openFindings.get(finding.id);
          openFindings.set(finding.id, { ...finding,
            introducedAt: previous?.introducedAt ?? executionMessages.length,
            ...(previous?.disposition ? { disposition: previous.disposition } : {}) });
          resolvedFindingIds.delete(finding.id);
        }
        const testDigest = reviewDigest(JSON.stringify([...accumulatedReviewTests].sort().map(
          (path) => [path, reviewDigest(readFileSync(join(iso.dir, path)))],
        )));
        const newTestEvidence = testDigest !== evidenceTestDigest;
        if (newTestEvidence) {
          gateResult = await runGate({
            onEvidence: (entry) => evidence.write(entry), commands: gateCommands(), cwd: iso.dir,
            timeoutMs: stageTimeouts.gate, reporter: eventReporter, runId, attempt: 1, captureTestCount,
          });
          evidenceTestDigest = testDigest;
          iter.gate = gateResult;
          recordGateTimeout(gateResult, n, 1);
          if (gateResult?.results?.some((result) => result.timedOut)) {
            outcome = 'timed-out'; debateStopReason = 'evidence-timed-out'; break;
          }
        }
        const dispositions = reviewer.artifact?.dispositions ?? [];
        const dispositionIds = dispositions.map((item) => item?.id);
        const appliedDispositions = [];
        let disputed = [];
        for (const disposition of dispositions) {
          const finding = openFindings.get(disposition?.id);
          if (!finding || dispositionIds.filter((id) => id === disposition.id).length !== 1
            || !['resolved', 'withdrawn', 'upheld'].includes(disposition.status)
            || typeof disposition.reason !== 'string' || !disposition.reason.trim()) continue;
          const reply = executionMessages.slice(finding.introducedAt).findLast(
            (message) => message.speaker === 'codex' && !message.response?.timedOut
              && (!Number.isInteger(message.response?.exitCode) || message.response.exitCode === 0),
          );
          // A fresh test changes the evidence. Neither an old response nor a
          // disposition written before this test ran can close the finding.
          if (!reply || newTestEvidence) continue;
          finding.disposition = { ...disposition, round: debateRound, diffDigest: reviewDigest(diff) };
          appliedDispositions.push(finding.disposition);
          if (disposition.status === 'upheld') {
            if (executorFindingResponses(reply.response).some(
              (item) => item.id === finding.id && item.disposition === 'dispute',
            )) disputed.push(finding);
          } else {
            openFindings.delete(finding.id);
            resolvedFindingIds.add(finding.id);
          }
        }
        // Only the recorded accepting choice settles a named dispute. A new
        // diff, new test bytes or changed finding invalidates that disposition.
        for (const ruling of humanRulings) {
          const finding = openFindings.get(ruling.id);
          if (finding && ruling.diffDigest === reviewDigest(diff)
            && ruling.evidenceTestDigest === testDigest && !newTestEvidence
            && ruling.evidenceDigest === rulingEvidenceDigest(gateResult)
            && finding.description === ruling.finding?.description
            && finding.test === ruling.finding?.test) {
            openFindings.delete(ruling.id);
            resolvedFindingIds.add(ruling.id);
            ruling.applied = true;
            disputed = disputed.filter(item => item.id !== ruling.id);
            appliedDispositions.push({ id: ruling.id, status: 'resolved', decidedBy: 'human',
              reason: ruling.answer, decisionId: ruling.decisionId, diffDigest: ruling.diffDigest });
          }
        }
        const acceptedFindings = [...openFindings.values()];
        const acceptedFindingIds = acceptedFindings.map((finding) => finding.id);
        const validation = { accepted: acceptedFindingIds, rejected: [] };
        roundRecord.acceptedFindingIds = [...acceptedFindingIds];
        roundRecord.rejectedFindingIds = [];
        roundRecord.dispositions = appliedDispositions;
        debateLedger.record(debateRound, acceptedFindingIds);
        const circling = detectDebateCircling(debateLedger);

        if (mode === 'manual' && disputed.length > 0) {
          checkpointStage = 'execution-dispute';
          decision = { mode, phase: 'execution', authority: 'human',
            questions: disputed.map((finding) => ({ id: finding.id,
              text: finding.description, reviewerPosition: finding.disposition.reason,
              options: ['Require a correction', 'Accept Codex rebuttal', 'Clarify requirements'],
              diffDigest: reviewDigest(diff) })) };
          outcome = 'needs-decision'; debateStopReason = 'needs-decision'; break;
        }
        const humanSettledReview = mode === 'manual' && blockingFindings.length > 0
          && blockingFindings.every(finding => appliedDispositions.some(disposition => disposition.id === finding.id
            && disposition.decidedBy === 'human'));
        const cleanConclusion = runReview === null || reviewer.artifact?.conclusion === 'clean' || humanSettledReview;
        if (acceptedFindings.length === 0 && !newTestEvidence && cleanConclusion) {
          outcome = 'review-ready';
          debateStopReason = 'converged';
          reportEvent(eventReporter, runId, 'debate', 'converged', {
            debateRound, provider: 'claude', role: 'execution-reviewer',
            resolvedFindingIds: [...resolvedFindingIds],
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
          if (mode === 'manual') {
            checkpointStage = 'execution-pivot';
            decision = { mode, phase: 'execution', authority: 'human',
              questions: [{ id: 'pivot', text: 'The execution debate remains unresolved. Choose a correction, fresh plan, or stop.',
                options: ['correction', 'fresh plan', 'stop'],
                freshPlanEffect: 'Review a genuinely revised plan over this saved workspace; preserve current code and evidence, without resetting to the pre-debate base.',
                openFindingIds: [...openFindings.keys()], diffDigest: reviewDigest(diff) }] };
            outcome = 'needs-decision'; debateStopReason = 'needs-decision'; break;
          }
          const stuckFindingIds = [...debateLedger.stuckFindings()];
          reportEvent(eventReporter, runId, 'debate', 'circling', {
            debateRound,
            stuckFindingIds,
          });
          const pivotJudgement = parsePivotJudgement(await arbitrate({
            type: 'pivot',
            messages: executionMessages, evidence: gateResult?.results ?? [],
            diff, originalRequirements: originalPlan, interactionMode: mode,
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
          if (unjudged || !pivotJudgement.reason?.trim()) {
            outcome = 'needs-pivot'; debateStopReason = 'reviewer-unavailable'; break;
          }
          const pivotDecision = pivotJudgement.decision;
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
            resolvedFindingIds: [...resolvedFindingIds],
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
              interactionMode: mode,
              round: debateRound,
              ledger: ledgerAtPivot,
              failedPlan: plan,
              pivot: 'Start from the pre-debate snapshot with a genuinely different implementation strategy.',
              claudeModel: arbiterModel,
              codexModel: executorModel,
              codexEffort: executorEffort,
              timeoutMs: stageTimeouts.executor,
              gateTimeout: stageTimeouts.gate,
              runId,
              env: runEnvironment,
              ...(injectedCandidateDraft === undefined ? {} : { draft: injectedCandidateDraft }),
              ...((adapters.selectPlanCandidate ?? adapters.selectCandidate) === undefined
                ? {}
                : { select: adapters.selectPlanCandidate ?? adapters.selectCandidate }),
              ...(adapters.reviewPlanCandidate === undefined ? {} : { review: adapters.reviewPlanCandidate }),
            });
            pivotRecord.planning = generated;
            planningUsage = addUsage(planningUsage, generated?.tokens?.total);
            const normalizedCandidates = (generated?.candidates ?? []).map((candidate, index) => ({
              ...candidate,
              id: candidate.id ?? `candidate-${index + 1}`,
              perspective: candidate.perspective ?? `candidate perspective ${index + 1}`,
              gateResult: candidate.gateResult ?? candidate.planGate ?? {
                passed: candidate.gatePassed === true,
                failures: candidate.failures ?? [],
              },
            }));
            planningCheckpoint = generated?.checkpointState ?? null;
            const approved = generated?.approved === true && generated?.approval?.artifactDigest
              && generated.approval.artifactDigest === generated.artifactDigest
              && generated.selected && planningArtifactDigest(originalPlan,
                { plan: generated.selected.plan, gate: generated.selected.gate }) === generated.artifactDigest;
            let selectedCandidate = approved ? generated?.selected ?? null : null;
            if (approved && selectedCandidate === null && generated?.selectedCandidateId) {
              selectedCandidate = normalizedCandidates.find(
                (candidate) => candidate.id === generated.selectedCandidateId,
              ) ?? null;
            }
            if (approved && selectedCandidate === null && typeof generated?.plan === 'string') {
              selectedCandidate = {
                id: generated.selectedCandidateId ?? 'candidate-1',
                perspective: generated.perspective ?? 'selected fresh perspective',
                plan: generated.plan,
                gate: generated.gate ?? [],
                gateResult: generated.planGate ?? { passed: true, failures: [] },
              };
              if (normalizedCandidates.length === 0) normalizedCandidates.push(selectedCandidate);
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
            const branchResult = await createFreshBranch({
              cwd: iso.dir, baseCommit: iso.baseCommit, branch: freshBranch,
              captureSnapshot: adapters.captureReviewSnapshot ?? captureReviewSnapshot,
              restoreSnapshot: adapters.restoreReviewSnapshot ?? restoreReviewSnapshot,
            });
            activeBranch = branchResult?.branch ?? freshBranch;
            pivotRecord.branch = activeBranch;
            pivotRecord.branchPoint = branchResult?.branchPoint ?? iso.baseCommit;
            pivotRecord.reviewPaths = branchResult?.reviewPaths ?? [...accumulatedReviewTests].sort();
            commands.splice(0, commands.length, ...selectedCandidate.gate);
            evidenceTestDigest = '';
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
          findings: acceptedFindings,
          accepted: validation.accepted,
          rejected: validation.rejected,
          originalTask: originalPlan,
        });
        if (!fixPlan) fixPlan = originalPlan + '\n\nRead the new reviewer test evidence and answer Claude before it judges closure.';
        fixPlan += '\n\n## Execution review conversation\n' + JSON.stringify(executionMessages)
          + '\n\n## Current command evidence\n' + JSON.stringify(gateResult?.results ?? [])
          + '\nFull command output references: ' + JSON.stringify(evidence.records())
          + '\nAnswer each open finding with reasoning. You may correct it or dispute it. '
          + 'In your final answer include JSON {"findingResponses":[{"id":"F1","disposition":"addressed|dispute","reason":"your reasoning"}]}. '
          + 'Do not modify or delete __uro_review/. Preserve the original product intent.';
        if (amendPlan) fixPlan = amendFixPlanWithLedger(fixPlan, debateLedger);
        // A non-zero exit is part of the argument now, so the fix plan carries
        // it: Codex may fix the code, or defend it and name the command as the
        // defect — the reviewers see the same evidence and judge.
        if ((gateResult.results ?? []).some((result) => result.code !== 0)) {
          fixPlan = planWithGateFailure(fixPlan, gateResult);
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
          outcome = decision.unavailable ? 'needs-pivot' : 'needs-decision';
          debateStopReason = decision.reason ?? 'needs-decision';
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
        currentDiff = diff;
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

  } // Explicit validated v1 execution reader.
  const tokens = {
    executor: executorUsage,
    verifier: verifierUsage,
    arbiter: arbiterUsage,
    ...(planningUsage.inputTokens || planningUsage.outputTokens ? { planning: planningUsage } : {}),
    total: nativeExecution ? nativeResult.resources.knownUsage : addUsage(addUsage(addUsage(executorUsage, verifierUsage), arbiterUsage), planningUsage),
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
    resolvedFindingIds: [...resolvedFindingIds],
    stuckFindingIds: [...debateLedger.stuckFindings()],
    circlingDetected: debateCirclingDetected,
    independentReviews: [],
    pivotCount: debatePivotCount,
    finalPivotDecision,
    pivotHistory: pivotHistory.map((item) => ({ ...item })),
    stopReason: debateStopReason,
    openFindings: [...openFindings.values()],
    ledger: {
      rounds: ledgerHistory,
      allFindingIds: [...debateLedger.allFindings()],
      recurredFindingIds: [...blockingOccurrences.entries()]
        .filter(([, count]) => count > 1)
        .map(([findingId]) => findingId),
      resolvedFindingIds: [...resolvedFindingIds],
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
  let mutation = nativeExecution && nativeResult.mutation?.result ? { ...nativeResult.mutation.result,
    analysisIdentity: nativeResult.mutation.selection.identity, phaseRunId: nativeResult.checkpointState.runId,
    resources: nativeResult.checkpointState.mutation.resources } : null;
  if (!nativeExecution && outcome === 'review-ready' && opts.mutation !== undefined) {
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
  const planningMessages = nativeExecution ? nativePhases.flatMap(item => item.phase === 'planning'
    ? item.messages.map(message => ({ ...message, phase: 'planning', runId: item.runId })) : [])
    : pivotHistory.flatMap(pivot => pivot.planning?.messages ?? []);
  const dissent = executionMessages.filter(message => message.speaker === 'codex'
    && executorFindingResponses(message.response).some(response => response.disposition === 'dispute'));
  const approved = nativeExecution ? nativeResult.approved === true && outcome === 'review-ready'
    && !nativeResult.state.pendingOperation && !nativeResult.state.executionCycle?.open
    && canApproveDialogue({ state: nativeResult.state, seat: 'claude' }).approved
    : outcome === 'review-ready' && executionMessages.some(message => message.speaker === 'claude');
  const currentHumanRulings = humanRulings.filter(ruling => ruling.diffDigest === reviewDigest(currentDiff)
    && ruling.evidenceTestDigest === evidenceTestDigest && ruling.evidenceDigest === rulingEvidenceDigest(gateResult)
    && ruling.applied && resolvedFindingIds.has(ruling.id));
  const humanApproval = approved && currentHumanRulings.length > 0 ? {
    artifactDigest: reviewDigest(currentDiff), decidedBy: 'human', basis: 'human',
    reason: currentHumanRulings.map(ruling => `${ruling.id}: ${ruling.answer}`).join('\n'),
    rulings: currentHumanRulings, reviewEvidence: iterations.at(-1)?.reviewer?.artifact,
  } : null;
  const facts = buildRunFacts({ runId,
    phase: 'execution', interactionMode: mode, authority: decisionAuthority({ interactionMode: mode, phase: 'execution' }),
    messages: executionMessages, planningMessages, dissent, approved, converged: null,
    approval: humanApproval ?? (approved ? { artifactDigest: reviewDigest(currentDiff), decidedBy: 'claude', basis: 'reviewer',
      ...(nativeExecution ? { nativeArtifactDigest: nativeResult.state.artifactDigest, contextDigest: nativeResult.snapshot.digest,
        messageId: nativeResult.state.approval.messageId } : {}),
      reason: 'The current implementation passed Claude review with all blocking findings explicitly closed.' } : null),
    ...(physicalRunId === runId ? {} : { physicalRunId }),
    target, targetPath: resolve(target),
    dir: iso.dir, isRepo: iso.isRepo,
    baseRef: iso.baseRef, baseCommit: iso.baseCommit, branch: activeBranch,
    iterations,
    evidence: nativeExecution ? nativeEvidence : evidence.records(),
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
    skills: claudeSuperpowersDir,
    superpowers,
  });
  if (decision !== null) facts.decision = decision;
  else if (resolvedDecision !== null) facts.decision = resolvedDecision;
  if (tokens.planning) facts.tokens.planning = tokens.planning;
  facts.interactionMode = mode;
  facts.phase = 'execution';
  facts.authority = decisionAuthority({ interactionMode: mode, phase: 'execution' });

  if (nativeExecution) {
    facts.phase = nativeResult.checkpointState?.phase ?? 'execution';
    facts.authority = decisionAuthority({ interactionMode: mode, phase: facts.phase });
    facts.dialogue = nativeResult.state ?? null;
    facts.resources = nativeResult.resources ?? null;
    facts.reason = nativeResult.reason;
    facts.nextAction = nativeResult.action;
    facts.checkpointState = { ...nativeResult.checkpointState, version: 2,
      phase: nativeResult.checkpointState?.phase ?? 'execution', runId: nativeResult.checkpointState?.runId ?? runId, rootRunId: runId,
      interactionMode: mode, action: nativeResult.action, reason: nativeResult.reason, approved,
      workspace: { ...iso, targetPath: resolve(target), diff: currentDiff, diffDigest: reviewDigest(currentDiff) },
      originalPlan, plan, approvedExecutionPlan, commands, resources: nativeResult.resources,
      gateResult, reviewerTests: [...accumulatedReviewTests], iterations, stageTimeouts,
      phaseResources: nativeResult.phaseResources, phaseChain: nativePhases, phaseLinks: nativeLinks,
      supervision: { ...nativeResult.checkpointState?.supervision, stallConfig, executorThresholds, stallRestartCount, stallRecords, livenessChecks,
        observedWorkspace: observedMergeWorkspace },
      ...(merge === undefined ? {} : { mergeState: { merge, mergeProgress: nativeResult.state?.mergeProgress ?? null,
        activeConflict, mergeConflicts, mergeResolutions, conflictingIntent, mergePreparationFailure,
        observedWorkspace: observedMergeWorkspace, pendingOperation: nativeResult.state?.pendingOperation,
        next: nativeResult.state?.next, executionChecks: nativeResult.state?.executionChecks } }),
      options: { target, scratchRoot, artifactRoot: opts.artifactRoot, baseRef, branch, branchName, gateRetries,
        correctsRunId, campaignId, campaignBase, round, unitId, campaignUnitKind, perspective, unitKind, captureTestCount,
        executorModel, executorEffort, verifierModel, verifierBin, arbiterModel, arbiterBin,
        challengeRounds, debateRounds: maxDebateRounds, tokenBudget, pivotCandidates, superpowers,
        ...(opts.mutation === undefined ? {} : { mutation: nativeMutationPolicy, mutationPolicyValid: nativeMutationPolicy !== null }) },
    };
  }
  if (!nativeExecution && outcome === 'needs-decision') {
    currentDiff = await createDiff(iso.dir, merge === undefined ? iso.baseCommit : merge.mergeBase);
    // Task 4 owns durable envelopes and identity validation. Keep the live
    // controller state here instead of reconstructing it from report summaries.
    facts.checkpointState = {
      version: 1, phase: 'execution', stage: checkpointStage, runId,
      interactionMode: mode, authority: 'human',
      workspace: { ...iso, targetPath: resolve(target), branch: activeBranch,
        diff: currentDiff, diffDigest: reviewDigest(currentDiff) },
      originalPlan, plan, originalCommands: continuation?.originalCommands ?? (Array.isArray(gate) ? gate : JSON.parse(readFileSync(gate, 'utf8'))),
      commands, contentDigests: { requirements: reviewDigest(originalPlan), plan: reviewDigest(plan),
        gate: reviewDigest(JSON.stringify(commands)), diff: reviewDigest(currentDiff) },
      iteration: n, debateRound: currentDebateRound, challengeRound, exec, iter, gateResult,
      iterations, decision, resolvedDecision, assumedDecision,
      messages: executionMessages, openFindings: [...openFindings.values()], humanRulings,
      resolvedFindingIds: [...resolvedFindingIds], evidence: evidence.records(), evidenceTestDigest,
      reviewerTests: [...accumulatedReviewTests], reviewerArtifact: iter?.reviewer?.artifact ?? null,
      tokens, usageChecks, timeoutEvents, executorLaunchCount, iterationExecutorUsage,
      debate, planningCheckpoint, freshPivotCount, stageTimeouts,
      mergeState: { merge, mergeProgress, activeConflict, mergeConflicts, mergeResolutions,
        conflictingIntent, mergePreparationFailure },
      supervision: { stallConfig, executorThresholds, stallRestartCount, stallRecords, livenessChecks },
      reviewProtection: { reviewerRestorations, executorRestorations },
      options: { target, scratchRoot, artifactRoot: resolveArtifactRoot({ scratchRoot, artifactRoot: opts.artifactRoot, env: runEnvironment }), baseRef, branch, branchName, gateRetries,
        correctsRunId, campaignId, campaignBase, round, unitId, campaignUnitKind, perspective, unitKind,
        captureTestCount, executorModel, executorEffort, verifierModel, verifierBin, arbiterModel, arbiterBin,
        challengeRounds, debateRounds: maxDebateRounds, tokenBudget, pivotCandidates, superpowers },
    };
  }
  if (assumedDecision !== null) {
    facts.assumedDecision = assumedDecision;
    facts.escalation = 'operator-absent';
  }
  facts.reviewProtection = {
    accumulatedTestFiles: [...accumulatedReviewTests].sort(),
    reviewerRestorations,
    executorRestorations,
  };
  if (!continuation && (facts.checkpointState?.version === 1 || nativeExecution && (outcome === 'needs-decision' || nativeResult.state?.technicalPause || nativeResult.checkpointState?.technicalPause))) {
    try {
      const checkpoint = await saveCheckpoint({ directory: iso.dir, checkpointState: facts.checkpointState,
        references: [typeof task === 'string' && existsSync(task) ? task : null,
          typeof gate === 'string' && existsSync(gate) ? gate : null].filter(Boolean) });
      facts.checkpoint = { directory: iso.dir, artifactDigest: checkpoint.artifactDigest,
        questions: checkpoint.pending.questions };
    } catch (error) {
      facts.checkpoint = { status: 'failed', error: error.message };
    }
  }
  writeReport({ dir: iso.dir, facts, reporter: eventReporter, runId });
  if (nativeExecution) {
    try { validateNativeRetention(); }
    catch (error) {
      facts.approved = false; facts.approval = null; facts.outcome = 'needs-pivot'; facts.nextAction = 'paused';
      facts.reason = `required retained source integrity failed: ${error.message}`;
      facts.requiredSourceFailure = { status: 'failed', error: error.message };
      Object.assign(facts.checkpointState, { approved: false, action: 'paused', reason: facts.reason, requiredSourceFailure: facts.requiredSourceFailure });
    }
  }
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
      refresh: Boolean(continuation),
      retainedFiles: retainedArchiveFiles,
      requiredRetention: nativeExecution,
    });
  } catch (error) {
    facts.artifacts = {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
    if (nativeExecution) {
      facts.approved = false; facts.approval = null; facts.outcome = 'needs-pivot'; facts.nextAction = 'paused';
      facts.reason = `required artifact retention failed: ${facts.artifacts.error}`;
    }
    try { writeFileSync(join(iso.dir, 'uro-runfacts.json'), JSON.stringify(facts, null, 2)); }
    catch { /* artifact retention is non-fatal */ }
  }
  if (nativeExecution) {
    try { refreshReportProjection({ dir: iso.dir, facts }); }
    catch (error) {
      facts.artifacts = { ...(facts.artifacts ?? {}), status: 'failed',
        refresh: { status: 'failed', error: error instanceof Error ? error.message : String(error) } };
      try { writeFileSync(join(iso.dir, 'uro-runfacts.json'), JSON.stringify(facts, null, 2)); }
      catch { /* final presentation failure is retained in memory */ }
    }
  }
  return facts;
  } finally {
    releaseRunMarker(runMarker);
    watchdog?.dispose();
  }
}
