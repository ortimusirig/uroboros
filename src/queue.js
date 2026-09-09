import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertCurrentPlanApproval, assertPlanOutputAvailable, resolveGoal } from './plan.js';
import { detectReview, reviewDigest } from './review.js';
import { attachQueueCheckpoint, checkpointDigest, readCheckpoint, writeCheckpointAtomic } from './checkpoint.js';
import { recoverQueueLanding } from './queue-runtime.js';
import { assertPlanningSidecars, createPlanningHandoff, readPlanningHandoffReference, planningHistory } from './planning-dialogue.js';
import { createSharedContext, extendSharedContext, persistSharedContext, readSharedContextReference, resolveNativeWorkflowBinding } from './shared-context.js';
import { workflowIdentity, validateWorkflowBinding, readWorkflowBinding } from './workflow-profiles.js';
import { resolveProjectIdentity } from './project-memory.js';

const QUEUE_UNIT_KEYS = new Set(['name', 'task', 'gate', 'goal', 'out', 'tokenBudget', 'rounds']);
const QUEUE_MODES = new Set(['manual', 'autonomous']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function declaredPath(value, field, directory, index) {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`queue unit ${index + 1} ${field} must be a non-empty path string`);
  }
  return isAbsolute(value) ? resolve(value) : resolve(directory, value);
}

function validateFile(path, field, index) {
  if (!existsSync(path)) {
    throw new Error(`queue unit ${index + 1} ${field} file does not exist: ${path}`);
  }
  let file;
  try {
    file = statSync(path).isFile();
  } catch (error) {
    throw new Error(`queue unit ${index + 1} ${field} file cannot be inspected: ${error.message}`);
  }
  if (!file) throw new Error(`queue unit ${index + 1} ${field} path is not a file: ${path}`);
}

export function loadQueueFile(file) {
  if (typeof file !== 'string' || file === '') {
    throw new TypeError('queue file must be a non-empty path string');
  }
  const path = resolve(file);
  let document;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot load queue file ${path}: ${error.message}`);
  }
  if (!Array.isArray(document)) throw new TypeError('queue file must contain a JSON list');

  const directory = dirname(path);
  const units = document.map((raw, index) => {
    if (!isRecord(raw)) throw new TypeError(`queue unit ${index + 1} must be an object`);
    const unknown = Object.keys(raw).find((key) => !QUEUE_UNIT_KEYS.has(key));
    if (unknown !== undefined) {
      throw new Error(`queue unit ${index + 1} has unknown key "${unknown}"`);
    }
    if (raw.name !== undefined && (typeof raw.name !== 'string' || raw.name.trim() === '')) {
      throw new TypeError(`queue unit ${index + 1} name must be a non-empty string`);
    }
    for (const key of ['tokenBudget', 'rounds']) if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || raw[key] < 1)) {
      throw new TypeError(`queue unit ${index + 1} ${key} must be a positive safe integer`);
    }
    const controls = Object.fromEntries(['tokenBudget', 'rounds'].filter(key => raw[key] !== undefined).map(key => [key, raw[key]]));
    const hasTaskShape = Object.hasOwn(raw, 'task') || Object.hasOwn(raw, 'gate');
    const hasGoalShape = Object.hasOwn(raw, 'goal') || Object.hasOwn(raw, 'out');
    if (hasTaskShape === hasGoalShape) {
      throw new Error(
        `queue unit ${index + 1} must carry either task+gate or goal+out, never both or neither`,
      );
    }
    if (hasGoalShape) {
      if (!Object.hasOwn(raw, 'goal') || !Object.hasOwn(raw, 'out')) {
        throw new Error(`queue unit ${index + 1} goal units require both goal and out`);
      }
      const goal = resolveGoal(raw.goal, { baseDirectory: directory });
      const out = declaredPath(raw.out, 'out', directory, index);
      assertPlanOutputAvailable(out);
      return {
        index: index + 1,
        ...controls,
        kind: 'goal',
        name: raw.name?.trim() ?? (goal.source ? basename(goal.source) : `goal-${index + 1}`),
        goal: goal.source ?? goal.text,
        out,
      };
    }
    if (!Object.hasOwn(raw, 'task') || !Object.hasOwn(raw, 'gate')) {
      throw new Error(`queue unit ${index + 1} task units require both task and gate`);
    }
    const task = declaredPath(raw.task, 'task', directory, index);
    const gate = declaredPath(raw.gate, 'gate', directory, index);
    validateFile(task, 'task', index);
    validateFile(gate, 'gate', index);
    return {
      index: index + 1,
      ...controls,
      name: raw.name?.trim() ?? basename(task),
      task,
      gate,
    };
  });

  return {
    path,
    directory,
    logPath: join(directory, 'queue-log.jsonl'),
    units,
  };
}

function factTokens(facts) {
  const inputTokens = facts?.tokens?.total?.inputTokens;
  const outputTokens = facts?.tokens?.total?.outputTokens;
  const valid = [inputTokens, outputTokens].every((value) => (
    typeof value === 'number' && Number.isFinite(value) && value >= 0
  ));
  return {
    valid,
    tokens: valid
      ? { inputTokens, outputTokens, total: inputTokens + outputTokens }
      : { inputTokens: 0, outputTokens: 0, total: 0 },
  };
}

// The arbiter reports the canonical five-field usage shape; the queue meters
// the two fields it reports, in the same reading it keeps for run facts.
function usageTokens(usage) {
  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;
  const valid = [inputTokens, outputTokens].every((value) => (
    typeof value === 'number' && Number.isFinite(value) && value >= 0
  ));
  return valid
    ? { inputTokens, outputTokens, total: inputTokens + outputTokens }
    : { inputTokens: 0, outputTokens: 0, total: 0 };
}

function addTokens(total, next) {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    total: total.total + next.total,
  };
}

// Acceptance asks the log, not this invocation's counters: a goal split across
// several queue runs (stop, resume, finish) is complete when every unit of the
// queue file carries a landed row, whichever invocation landed it.
//
// A read failure is not the same fact as an incomplete trail: incomplete
// means a mid-goal stop, which is normal and silently skips acceptance; an
// unreadable log means completeness can never be confirmed, which the caller
// must treat as a stop, since the operator explicitly asked for acceptance.
function everyUnitLanded(units, logPath, readQueueLog = readFileSync) {
  let text;
  try {
    text = readQueueLog(logPath, 'utf8');
  } catch (error) {
    return { complete: false, unreadable: error?.message ?? String(error) };
  }
  const landed = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (isRecord(row) && row.landed === true && typeof row.name === 'string') landed.add(row.name);
  }
  return { complete: units.every((unit) => landed.has(unit.name)) };
}

function questionsFrom(facts, assumed = false) {
  const candidate = assumed
    ? facts?.assumedDecision?.questions ?? facts?.decision?.questions
    : facts?.decision?.questions;
  return Array.isArray(candidate) ? candidate.map((question) => ({ ...question })) : [];
}

function answersFrom(facts) {
  const candidate = facts?.assumedDecision?.answers ?? facts?.decision?.answers;
  return Array.isArray(candidate) ? candidate.map((answer) => ({ ...answer })) : [];
}

function assertCurrentExecutionApproval(facts, runDirectory) {
  const receipt = facts?.approval;
  const human = receipt?.decidedBy === 'human' && receipt?.basis === 'human' && facts?.interactionMode === 'manual';
  if (facts?.phase !== 'execution' || facts.approved !== true
    || !isRecord(receipt) || (!human && (receipt.decidedBy !== 'claude' || receipt.basis !== 'reviewer'))
    || typeof receipt.reason !== 'string' || receipt.reason.trim() === ''
    || typeof receipt.artifactDigest !== 'string') {
    throw new Error('current execution approval is missing or invalid; review-ready alone does not authorize landing');
  }
  let diff;
  try { diff = readFileSync(join(runDirectory, 'CHANGES.diff')); } catch {
    throw new Error('current execution approval cannot be verified: CHANGES.diff is missing or unreadable');
  }
  if (reviewDigest(diff) !== receipt.artifactDigest) {
    throw new Error('current execution approval is stale for CHANGES.diff');
  }
  if (human) {
    const evidence = receipt.reviewEvidence;
    if (!evidence || !detectReview({ dir: runDirectory, artifact: evidence, round: evidence.round,
      diffDigest: receipt.artifactDigest }).reviewed) throw new Error('human ruling has no current Claude review evidence');
    const checkpoint = readCheckpoint(runDirectory);
    if (!Array.isArray(receipt.rulings) || !receipt.rulings.length) throw new Error('human approval has no durable rulings');
    for (const ruling of receipt.rulings) {
      const accepted = checkpoint.receipts.find(item => item.decisionId === ruling.decisionId);
      if (!accepted || accepted.phase !== 'execution' || accepted.stage !== 'execution-dispute'
        || accepted.artifactDigest !== ruling.artifactDigest || ruling.diffDigest !== receipt.artifactDigest
        || !accepted.answers.some(item => item.id === ruling.id && item.answer === ruling.answer)
        || !accepted.questions.some(item => item.id === ruling.id && item.options?.includes('Accept Codex rebuttal'))
        || !/^Accept Codex rebuttal(?:\s*:|\s*$)/i.test(ruling.answer.trim())) {
        throw new Error('human approval does not match an accepted durable dispute ruling');
      }
    }
  }
}

function evaluateFacts(facts, runDirectory) {
  if (!isRecord(facts)) {
    return { action: 'stop', reason: 'completed run facts are missing or invalid', questions: [] };
  }
  if (facts.outcome !== 'review-ready') {
    const questions = facts.outcome === 'needs-decision' ? questionsFrom(facts) : [];
    return {
      action: 'stop',
      reason: `run outcome ${facts.outcome ?? 'unknown'}`,
      outcome: facts.outcome ?? null,
      questions,
    };
  }

  // Historical outcome labels remain readable but cannot substitute for the
  // explicit execution review receipt bound to the artifact we will land.
  try { assertCurrentExecutionApproval(facts, runDirectory); } catch (error) {
    return { action: 'stop', kind: 'execution-approval', reason: error.message, questions: [] };
  }
  return { action: 'land' };
}

function stopBefore(units, attempted, kind, reason) {
  const next = units[attempted] ?? null;
  return {
    kind,
    reason,
    before: true,
    ...(next === null ? {} : { unit: next.name, unitIndex: next.index }),
  };
}

function formatQuestions(questions, answers = []) {
  const answersById = new Map(answers.map((answer) => [answer.id, answer]));
  return questions.flatMap((question, index) => {
    const lines = [`    ${question.id ?? '?'}: ${question.question ?? '(question unavailable)'}`];
    const answer = answersById.get(question.id) ?? answers[index];
    if (answer !== undefined) {
      lines.push(`      Answer: ${answer.answer ?? '(answer unavailable)'}`);
    }
    return lines;
  });
}

export function formatQueueSummary({
  dryRun = false,
  units,
  landedCount,
  stop,
  remaining,
  totalTokens,
  assumedDecisions,
  goalAcceptance = null,
}) {
  if (dryRun) {
    return [
      'Dry run — resolved queue:',
      ...units.flatMap((unit) => [
        `${unit.index}. ${unit.name}`,
        ...(unit.kind === 'goal'
          ? [`   goal: ${unit.goal}`, `   out: ${unit.out}`]
          : [`   task: ${unit.task}`, `   gate: ${unit.gate}`]),
      ]),
      `Units: ${units.length}`,
      'Runs started: 0',
      'Total tokens: 0',
      '',
    ].join('\n');
  }

  const lines = [];
  if (assumedDecisions.length > 0) {
    lines.push('Decisions assumed while operator absent:');
    for (const decision of assumedDecisions) {
      lines.push(`  - ${decision.name} (run ${decision.runId ?? 'unknown'})`);
      lines.push(...formatQuestions(decision.questions, decision.answers));
    }
    lines.push('');
  }
  lines.push(`Units landed: ${landedCount}`);
  if (goalAcceptance?.approved === true) {
    lines.push(`Goal accepted: ${goalAcceptance.reasoning || '(no reasoning recorded)'}`);
  }
  if (stop === null) lines.push('Stopped: no');
  else {
    const where = stop.unit === undefined
      ? ''
      : ` ${stop.before === true ? 'before' : 'on'} ${stop.unit}`;
    lines.push(`Stopped${where}: ${stop.reason} (${remaining} remaining)`);
  }
  lines.push(
    `Total tokens: ${totalTokens.total} `
      + `(input ${totalTokens.inputTokens}, output ${totalTokens.outputTokens})`,
    '',
  );
  return lines.join('\n');
}

function appendQueueLog(path, record) {
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

function missingDependency(name) {
  return async () => { throw new Error(`queue dependency is not configured: ${name}`); };
}

export async function runQueue(options) {
  return executeQueue({ ...options, queue: loadQueueFile(options.file) });
}

export async function continueQueue({ context, phaseResult, runDirectory, dependencies = {}, journal = {}, persistJournal = () => {} }) {
  if (checkpointDigest(readFileSync(context.queue.path, 'utf8')) !== context.fileDigest) throw new Error('queue file changed; saved cursor is invalid');
  validateQueueWorkflow({ context, journal, continuation: phaseResult?.checkpointState });
  return executeQueue({ ...context.options, queue: context.queue,
    continuation: { ...context, phaseResult, runDirectory, journal, persistJournal }, dependencies });
}

// The parent capture and independent checkpoint identity must agree before
// native continuation, landing recovery, or another child may cause effects.
export function validateQueueWorkflow({ context, journal = context.journal ?? {}, continuation }) {
  const schema = journal.schemaVersion ?? 1;
  if (![1, 2, 3].includes(schema)) throw new Error('unsupported queue workflow journal schema');
  const legacy = { schemaVersion: 1, mode: 'legacy-unbound' };
  const binding = validateWorkflowBinding({ binding: schema === 3 ? journal.workflowBinding : journal.workflowBinding ?? legacy });
  if (schema === 3 && (binding.mode !== 'bound' || !context.workflow)) throw new Error('required queue workflow identity missing');
  if (schema !== 3 && binding.mode !== 'legacy-unbound') throw new Error('historical queue workflow cannot become bound');
  const expected = workflowIdentity({ binding });
  const agree = identity => {
    if (checkpointDigest({ workflow: identity }) !== checkpointDigest({ workflow: expected })) throw new Error('queue workflow identity conflict');
  };
  if (context.workflow !== undefined) agree(context.workflow);
  if (context.options?.workflowBinding !== undefined) agree(workflowIdentity({ binding: context.options.workflowBinding }));
  const check = snapshot => readWorkflowBinding({ snapshot, expected, allowLegacy: schema !== 3 });
  for (const entry of Object.values(journal.units ?? {})) {
    if (entry.contextRef) check(readSharedContextReference({ reference: entry.contextRef, target: context.options.target }));
    if (entry.executionContextRef) check(readPlanningHandoffReference({ reference: entry.executionContextRef,
      target: context.options.target, completedExecution: completedExecutionHandoff(entry) }));
  }
  if (continuation) {
    const phases = [...(continuation.phaseChain ?? []).map(phase => phase.checkpointState), continuation];
    for (const phase of phases) {
      const snapshot = phase?.dialogue?.snapshot ?? phase?.preparationSnapshot;
      if (snapshot) check(snapshot);
      if (phase?.workflow !== undefined) agree(phase.workflow);
      else if (schema === 3) throw new Error('required child workflow identity missing');
    }
  }
  return binding;
}

function completedExecutionHandoff(entry) {
  return entry.operationId && entry.launch?.runDirectory && entry.result?.approval?.artifactDigest ? {
    operationId: entry.operationId, commit: entry.landing?.commit,
    diffPath: join(entry.launch.runDirectory, 'CHANGES.diff'), artifactDigest: entry.result.approval.artifactDigest,
  } : undefined;
}

// Delivery is distinct from the raw recovery journal: retain ordinary protocol
// records and validated context, not transport/checkpoint/private option bags.
function priorUnitContext({ entry, unit, target }) {
  const fields = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined
    && (value[key] === null || typeof value[key] !== 'object')).map(key => [key, value[key]]));
  const approval = value => fields(value, ['approved', 'decidedBy', 'basis', 'artifactDigest', 'contextDigest', 'sidecarDigest', 'messageId', 'reason']);
  const reference = entry.executionContextRef ?? entry.contextRef;
  const snapshot = reference ? readPlanningHandoffReference({ reference, target,
    completedExecution: completedExecutionHandoff(entry) }) : null;
  return {
    unit: fields(unit, ['index', 'name', 'kind', 'goal', 'task', 'gate', 'out']),
    ...fields(entry, ['operationId', 'logged']),
    plan: { ...fields(entry.planResult, ['runId', 'approved', 'reason', 'planPath', 'gatePath']), approval: approval(entry.planResult?.approval) },
    execution: { ...fields(entry.result, ['runId', 'outcome', 'approved', 'reason', 'phase', 'nextAction']),
      approval: approval(entry.result?.approval),
      ...(entry.result?.dialogue ? { history: planningHistory(entry.result.dialogue) } : {}) },
    landing: fields(entry.landing, ['commit', 'landed', 'reason']),
    judgement: fields(entry.judgement, ['approved', 'reasoning']),
    ...(snapshot ? { context: snapshot } : {}),
  };
}

// Exact generated files only. Never exempt the output directory or unrelated
// untracked source; revalidate the saved plan receipt before each use.
export function queueContinuationPaths(context) {
  validateQueueWorkflow({ context });
  const paths = [context.queue.logPath, ...(context.journal?.path ? [context.journal.path] : [])];
  for (const entry of Object.values(context.journal?.units ?? {})) if (entry.contextRef) {
    readSharedContextReference({ reference: entry.contextRef, target: context.options.target });
    paths.push(entry.contextRef.path);
    if (entry.executionContextRef) {
      readPlanningHandoffReference({ reference: entry.executionContextRef, target: context.options.target, completedExecution: completedExecutionHandoff(entry) });
      paths.push(entry.executionContextRef.path);
    }
  }
  for (const unit of context.queue.units.filter(unit => unit.kind === 'goal')) {
    const result = (unit.index === context.unitIndex ? (context.phase === 'planning' ? context.phaseResult : context.planResult) : null)
      ?? context.journal?.units?.[unit.index]?.planResult
      ?? context.approvedPlans?.[unit.index];
    if (!result?.approved) continue;
    assertCurrentPlanApproval({ unit, result, mode: context.options?.mode ?? 'manual' });
    if (result.approval.contextDigest) paths.push(...assertPlanningSidecars({ directory: unit.out,
      runId: result.runId, approval: result.approval, manifest: result.planningArtifacts }));
    paths.push(join(unit.out, 'plan.md'), join(unit.out, 'gate.json'));
    if (existsSync(join(unit.out, 'uro-checkpoint.json')) && readCheckpoint(unit.out).runId === result.runId) {
      paths.push(join(unit.out, 'uro-checkpoint.json'), join(unit.out, 'uro-resume.lock'));
    }
  }
  return paths;
}

async function executeQueue({
  file,
  target,
  mode = 'manual',
  claudeModel, codexModel, codexEffort,
  maxRuns,
  tokenBudget,
  rounds,
  acceptGoalSpec,
  dryRun = false,
  dependencies = {},
  queue, continuation,
  workflowBinding,
}) {
  if (!QUEUE_MODES.has(mode)) {
    throw new TypeError(`invalid queue mode: ${mode}; expected manual or autonomous`);
  }
  const zeroTokens = { inputTokens: 0, outputTokens: 0, total: 0 };
  if (dryRun) {
    return {
      dryRun: true,
      attemptedCount: 0,
      landedCount: 0,
      remaining: queue.units.length,
      totalTokens: zeroTokens,
      stop: null,
      assumedDecisions: [],
      goalAcceptance: null,
      summary: formatQueueSummary({
        dryRun: true,
        units: queue.units,
        landedCount: 0,
        stop: null,
        remaining: queue.units.length,
        totalTokens: zeroTokens,
        assumedDecisions: [],
      }),
    };
  }

  const assertCleanTarget = dependencies.assertCleanTarget ?? missingDependency('assertCleanTarget');
  const launchRun = dependencies.launchRun ?? missingDependency('launchRun');
  const launchPlan = dependencies.launchPlan ?? missingDependency('launchPlan');
  const readRunFacts = dependencies.readRunFacts ?? missingDependency('readRunFacts');
  const landDiff = dependencies.landDiff ?? missingDependency('landDiff');
  const judgeLanding = dependencies.judgeLanding ?? missingDependency('judgeLanding');
  const acceptGoal = dependencies.acceptGoal ?? missingDependency('acceptGoal');
  const readQueueLog = dependencies.readQueueLog ?? readFileSync;
  const appendLog = dependencies.appendLog ?? appendQueueLog;
  const now = dependencies.now ?? (() => Date.now());

  workflowBinding = structuredClone(continuation ? validateQueueWorkflow({ context: continuation })
    : resolveNativeWorkflowBinding({ workflowBinding }));
  let allowedQueuePaths = continuation ? queueContinuationPaths(continuation) : [queue.logPath];
  await assertCleanTarget(target, { allowedPaths: [...allowedQueuePaths] });
  const queueFileDigest = continuation?.fileDigest ?? checkpointDigest(readFileSync(queue.path, 'utf8'));
  const queueJournal = continuation?.journal ?? { schemaVersion: workflowBinding.mode === 'bound' ? 3 : 2,
    workflowBinding, runId: `queue-${randomUUID()}`, units: {}, debits: {} };
  queueJournal.workflowBinding ??= workflowBinding;
  const parentContext = { queue, workflow: workflowIdentity({ binding: workflowBinding }), options: { mode, target }, journal: queueJournal };
  if (!continuation) queueJournal.path = join(queue.directory, '__uro_context', `${queueJournal.runId}-queue.json`);
  const persistQueue = () => {
    if (queueJournal.path) writeCheckpointAtomic(queueJournal.path, { ...queueJournal, checksum: checkpointDigest(queueJournal) });
    continuation?.persistJournal(queueJournal);
  };
  const debit = (id, tokens, value, provider = false) => {
    const resource = value?.resources;
    (queueJournal.debits ??= {})[id] = { tokens, providerLaunches: resource?.providerLaunches ?? (provider ? 1 : 0),
      launchesUnknown: !provider && !resource, usageUnknown: resource?.usageUnknown === true || value?.tokens?.usageUnknown === true
        || (provider ? !value?.usage || ![value.usage.inputTokens, value.usage.outputTokens].every(Number.isFinite) : !factTokens(value).valid) };
    persistQueue();
  };
  const resources = () => Object.values(queueJournal.debits ?? {}).reduce((sum, item) => ({
    providerLaunches: sum.providerLaunches + item.providerLaunches,
    launchesUnknown: sum.launchesUnknown || item.launchesUnknown, usageUnknown: sum.usageUnknown || item.usageUnknown,
    knownUsage: { inputTokens: sum.knownUsage.inputTokens + item.tokens.inputTokens,
      outputTokens: sum.knownUsage.outputTokens + item.tokens.outputTokens },
  }), { providerLaunches: 0, launchesUnknown: false, usageUnknown: false, knownUsage: { inputTokens: 0, outputTokens: 0 } });
  // Preserve only validated output provenance, not arbitrary existing files or
  // whole output directories. Earlier goals must survive a later suspension.
  const approvedPlans = { ...continuation?.approvedPlans };

  let attemptedCount = continuation?.attemptedCount ?? 0;
  let landedCount = continuation?.landedCount ?? 0;
  let totalTokens = continuation?.totalTokens ?? zeroTokens;
  let stop = null;
  const assumedDecisions = [];

  for (const unit of queue.units) {
    if (continuation && unit.index < continuation.unitIndex) continue;
    const resuming = continuation && unit.index === continuation.unitIndex;
    const beforeUnit = { attemptedCount, landedCount, totalTokens: { ...totalTokens } };
    const journal = queueJournal;
    if (journal) journal.units ??= {};
    const unitJournal = journal ? (journal.units[unit.index] ??= {}) : {};
    const persist = persistQueue;
    const childControls = (execution = false) => {
      const parentRemaining = tokenBudget === undefined ? Infinity : tokenBudget - totalTokens.total;
      const itemRemaining = unit.tokenBudget === undefined ? Infinity : unit.tokenBudget - (totalTokens.total - beforeUnit.totalTokens.total);
      const remaining = Math.min(parentRemaining, itemRemaining);
      if (Number.isFinite(remaining) && resources().usageUnknown) throw new Error('accounting-incomplete: unknown queue usage');
      if (remaining <= 0) throw new Error('budget-exhausted: saved queue or item allowance exhausted');
      if (!unitJournal.contextRef) {
        const project = resolveProjectIdentity({ target });
        journal.runId ??= `queue-${randomUUID()}`;
        const snapshot = createSharedContext({ projectId: project.projectId, runId: journal.runId, workflowBinding,
          unitId: `${journal.runId}:${unit.index}`, phase: 'queue', sourceRevision: queueFileDigest,
          entries: [{ id: 'requirements', kind: 'requirement', content: unit.goal ?? readFileSync(unit.task, 'utf8'),
            sourceIdentity: queueFileDigest, status: 'required', provenance: { origin: 'queue', unitIndex: unit.index } },
          { id: 'prior-units', kind: 'queue-results', content: JSON.stringify(Object.entries(journal.units).filter(([id]) => Number(id) < unit.index)
            .map(([id, entry]) => [id, priorUnitContext({ entry, unit: queue.units.find(previous => previous.index === Number(id)), target })])),
            sourceIdentity: queueFileDigest, status: 'historical', provenance: { origin: 'queue', runId: journal.runId } }] });
        const path = persistSharedContext({ directory: queue.directory, snapshot });
        unitJournal.contextRef = { schemaVersion: 1, path, projectId: project.projectId, runId: snapshot.runId,
          unitId: snapshot.unitId, contextDigest: snapshot.digest };
        persist();
      }
      readSharedContextReference({ reference: unitJournal.contextRef, target });
      allowedQueuePaths = [...new Set([...allowedQueuePaths, unitJournal.contextRef.path, ...(journal.path ? [journal.path] : [])])];
      const reference = execution && unitJournal.executionContextRef ? unitJournal.executionContextRef : unitJournal.contextRef;
      if (execution) readPlanningHandoffReference({ reference, target });
      validateQueueWorkflow({ context: parentContext });
      return { contextRef: reference, workflowBinding: structuredClone(workflowBinding), ...(Number.isFinite(remaining) ? { tokenBudget: remaining } : {}),
        ...((unit.rounds ?? rounds) === undefined ? {} : { rounds: unit.rounds ?? rounds }) };
    };
    if (unitJournal.logged) {
      if (unitJournal.planResult?.approved) {
        const { runId, planPath, gatePath, approval, planningArtifacts } = unitJournal.planResult;
        approvedPlans[unit.index] = { approved: true, runId, planPath, gatePath, approval, ...(planningArtifacts ? { planningArtifacts } : {}) };
      }
      ({ attemptedCount, landedCount, totalTokens } = unitJournal.afterUnit);
      continue;
    }
    const savePending = async (directory, phase, planResult) => {
      if (!directory || !existsSync(join(directory, 'uro-checkpoint.json'))) return;
      const checkpoint = await attachQueueCheckpoint(directory, { version: 1, queue, workflow: workflowIdentity({ binding: workflowBinding }),
        fileDigest: checkpointDigest(readFileSync(queue.path, 'utf8')), unitIndex: unit.index, phase,
        ...beforeUnit, planResult, approvedPlans, options: { file, target: resolve(target), mode,
          claudeModel, codexModel, codexEffort, maxRuns, tokenBudget, rounds, acceptGoalSpec } }, journal);
      if (stop) stop.checkpoint = { directory, artifactDigest: checkpoint.artifactDigest, questions: checkpoint.pending.questions };
    };
    if (maxRuns !== undefined && attemptedCount >= maxRuns) {
      stop = stopBefore(
        queue.units,
        attemptedCount,
        'max-runs',
        `max-runs limit ${maxRuns} reached`,
      );
      break;
    }
    if (tokenBudget !== undefined && attemptedCount > 0) {
      const estimate = Math.ceil(totalTokens.total / attemptedCount);
      if (totalTokens.total + estimate > tokenBudget) {
        stop = stopBefore(
          queue.units,
          attemptedCount,
          'token-budget',
          `token budget forecast: ${totalTokens.total} + estimated ${estimate} exceeds ${tokenBudget}`,
        );
        break;
      }
    }

    attemptedCount++;
    const startedAt = now();
    let facts;
    let launch;
    let planResult = null;
    let planTokens = zeroTokens;
    let implementationUnit = unit;
    try {
      if (unit.kind === 'goal') {
        planResult = resuming && continuation.phase === 'planning' ? continuation.phaseResult
          : unitJournal.planResult ?? (resuming ? continuation.planResult : null);
        if (!planResult) {
          if (unitJournal.planningStarted) throw new Error('queue planning was already started without a recorded result; automatic replay refused');
          if (journal) { unitJournal.planningStarted = true; persist(); }
          planResult = await launchPlan({ unit, target: resolve(target), mode, claudeModel, codexModel, codexEffort, ...childControls() });
        }
        if (journal) { unitJournal.planResult = planResult; delete unitJournal.planningStarted; persist(); }
        // The taxi meter runs whether or not you arrive: planning spend counts
        // on every path, not only when a unit lands.
        const planTokenReading = factTokens(planResult);
        if (planTokenReading.valid) totalTokens = addTokens(totalTokens, planTokenReading.tokens);
        planTokens = planTokenReading.valid ? planTokenReading.tokens : zeroTokens;
        debit(`${unit.index}:planning`, planTokens, planResult);
        if ((tokenBudget !== undefined || unit.tokenBudget !== undefined) && resources().usageUnknown) throw new Error('accounting-incomplete: unknown planning usage');
        if (planResult?.approved !== true) {
          const durationMs = Math.max(0, now() - startedAt);
          const reason = `plan was not approved: ${planResult?.reason ?? 'unknown reason'}`;
          stop = {
            kind: 'plan-not-approved',
            unit: unit.name,
            unitIndex: unit.index,
            reason,
            outcome: null,
            questions: [],
          };
          appendLog(queue.logPath, {
            name: unit.name,
            runId: null,
            planRounds: planResult?.rounds ?? null,
            planConverged: planResult?.converged === true,
            planApproval: planResult?.approval ?? null,
            planApproved: false,
            interactionMode: mode,
            pendingDecision: planResult?.pendingDecision ?? null,
            checkpointState: planResult?.checkpointState ?? null,
            queueContext: { file: queue.path, unitIndex: unit.index, goal: unit.goal, out: unit.out, target: resolve(target), mode },
            planOutcome: planResult?.reason ?? 'unknown',
            implementationOutcome: null,
            tokens: planTokens,
            durationMs,
            landed: false,
            stoppedOn: true,
            stopReason: reason,
          });
          await savePending(planResult?.checkpoint?.directory ?? unit.out, 'planning', planResult);
          break;
        }
        assertCurrentPlanApproval({ unit, result: planResult, mode });
        if (planResult.approval.contextDigest || planResult.approval.sidecarDigest || planResult.planningArtifacts
          || planResult.checkpointState?.version === 2 || planResult.sharedContext || planResult.dialogue) {
          if (!unitJournal.executionContextRef) {
            if (unitJournal.launch || unitJournal.launching || unitJournal.result || resuming && continuation.phase === 'execution') throw new Error('required saved planning execution handoff missing; replay refused');
            const handoff = createPlanningHandoff({ target, directory: unit.out, result: planResult });
            const parent = readSharedContextReference({ reference: unitJournal.contextRef, target });
            const snapshot = extendSharedContext({ snapshot: parent, entries: [{ id: 'current-planning-handoff', kind: 'planning-handoff',
              content: JSON.stringify(handoff), sourceIdentity: planResult.approval.contextDigest,
              provenance: { origin: 'validated-planning-approval', runId: planResult.runId }, status: 'required' }] });
            const path = persistSharedContext({ directory: queue.directory, snapshot });
            unitJournal.executionContextRef = { ...unitJournal.contextRef, path, contextDigest: snapshot.digest,
              planningHandoff: { directory: unit.out, runId: planResult.runId, contextDigest: planResult.approval.contextDigest,
                artifactDigest: planResult.approval.artifactDigest, sidecarDigest: planResult.approval.sidecarDigest } };
            persist();
          }
          readPlanningHandoffReference({ reference: unitJournal.executionContextRef, target, completedExecution: completedExecutionHandoff(unitJournal) });
          if (unitJournal.executionContextRef.planningHandoff.contextDigest !== planResult.approval.contextDigest
            || unitJournal.executionContextRef.planningHandoff.runId !== planResult.runId) throw new Error('saved planning handoff is stale');
          allowedQueuePaths.push(unitJournal.executionContextRef.path);
        }
        approvedPlans[unit.index] = { approved: true, runId: planResult.runId,
          planPath: planResult.planPath, gatePath: planResult.gatePath, approval: planResult.approval,
          ...(planResult.planningArtifacts ? { planningArtifacts: planResult.planningArtifacts } : {}) };
        implementationUnit = {
          ...unit,
          approval: planResult.approval,
          task: planResult.planPath ?? join(unit.out, 'plan.md'),
          gate: planResult.gatePath ?? join(unit.out, 'gate.json'),
        };
        allowedQueuePaths.push(implementationUnit.task, implementationUnit.gate);
        if (planResult.approval.contextDigest) allowedQueuePaths.push(...assertPlanningSidecars({ directory: unit.out,
          runId: planResult.runId, approval: planResult.approval, manifest: planResult.planningArtifacts }));
      }
      if (resuming && continuation.phase === 'execution') {
        launch = { runDirectory: continuation.runDirectory, runId: continuation.phaseResult.runId };
        facts = continuation.phaseResult;
      } else if (unitJournal.result) {
        launch = unitJournal.launch;
        facts = unitJournal.result;
      } else {
        if (unitJournal.launching) throw new Error('queue child was already launched without a recorded result; automatic replay refused');
        if (journal) { unitJournal.launching = true; persist(); }
        launch = await launchRun({ unit: implementationUnit, target: resolve(target), mode, claudeModel, codexModel, codexEffort, ...childControls(true) });
        facts = await readRunFacts(launch);
      }
      if (journal) { unitJournal.result = facts; unitJournal.launch = launch; delete unitJournal.launching; persist(); }
    } catch (error) {
      const durationMs = Math.max(0, now() - startedAt);
      const failedDuringPlanning = unit.kind === 'goal' && planResult === null;
      const failureStage = failedDuringPlanning
        ? 'plan launch failed'
        : 'implementation launch or facts read failed';
      const reason = `${failureStage}: ${error?.message ?? String(error)}`;
      stop = {
        kind: failedDuringPlanning ? 'plan-failed' : 'run-failed',
        unit: unit.name,
        unitIndex: unit.index,
        reason,
        outcome: null,
        questions: [],
      };
      appendLog(queue.logPath, {
        name: unit.name,
        runId: launch?.runId ?? null,
        outcome: null,
        tokens: planTokens,
        durationMs,
        landed: false,
        stoppedOn: true,
        stopReason: reason,
        ...(unit.kind === 'goal' ? {
          planRounds: planResult?.rounds ?? null,
          planConverged: planResult?.converged === true,
        planApproved: planResult?.approved === true,
        planApproval: planResult?.approval ?? null,
        interactionMode: mode,
          planOutcome: planResult?.reason ?? null,
          implementationOutcome: null,
        } : {}),
      });
      break;
    }

    const durationMs = Math.max(0, now() - startedAt);
    const tokenReading = factTokens(facts);
    const { tokens } = tokenReading;
    if (tokenReading.valid) totalTokens = addTokens(totalTokens, tokens);
    debit(`${unit.index}:execution`, tokens, facts);
    const evaluation = (tokenBudget !== undefined || unit.tokenBudget !== undefined) && resources().usageUnknown
      ? { action: 'stop', kind: 'accounting-incomplete', reason: 'accounting-incomplete: unknown completed child usage', outcome: facts?.outcome, questions: [] }
      : tokenReading.valid
      ? evaluateFacts(facts, launch.runDirectory)
      : {
        action: 'stop',
        kind: 'token-accounting',
        reason: 'completed run facts contain invalid token accounting',
        outcome: facts?.outcome ?? null,
        questions: [],
      };
    const assumed = isRecord(facts) && facts.escalation === 'operator-absent';
    const assumedQuestions = assumed ? questionsFrom(facts, true) : [];
    const assumedAnswers = assumed ? answersFrom(facts) : [];
    if (assumed) {
      assumedDecisions.push({
        name: unit.name,
        runId: facts.runId ?? launch?.runId ?? null,
        questions: assumedQuestions,
        answers: assumedAnswers,
      });
    }

    let landed = false;
    let landing = null;
    let landingJudgement = null;
    if (evaluation.action === 'land' && !unitJournal.judgement
      && (tokenBudget !== undefined && totalTokens.total >= tokenBudget
        || unit.tokenBudget !== undefined && totalTokens.total - beforeUnit.totalTokens.total >= unit.tokenBudget)) {
      Object.assign(evaluation, { action: 'stop', kind: 'token-budget', reason: 'budget-exhausted: no allowance remains for landing review' });
    }
    if (evaluation.action === 'land') {
      // The hierarchy's last step: with the reviewer's findings closed,
      // Claude reads the change first-hand and judges the landing. Nothing
      // lands unseen — an unavailable or unreadable judgement is a stop,
      // never consent.
      try {
        if (!unitJournal.judgement && unitJournal.judgementStarted) throw new Error('landing judgement was already started without a recorded result; automatic replay refused');
        if (!unitJournal.judgement && journal) { unitJournal.judgementStarted = true; persist(); }
        landingJudgement = unitJournal.judgement ?? await judgeLanding({
          unit,
          facts,
          claudeModel,
          runDirectory: launch.runDirectory,
          ...childControls(),
        }) ?? { approved: null, reasoning: 'landing judge returned nothing' };
      } catch (error) {
        landingJudgement = {
          approved: null,
          reasoning: error?.message ?? String(error),
        };
      }
      if (journal) { unitJournal.judgement = landingJudgement; persist(); }
      const landingTokens = usageTokens(landingJudgement.usage);
      totalTokens = addTokens(totalTokens, landingTokens);
      debit(`${unit.index}:landing`, landingTokens, landingJudgement, true);
      if ((tokenBudget !== undefined || unit.tokenBudget !== undefined) && resources().usageUnknown) {
        landingJudgement = { ...landingJudgement, approved: null, reasoning: 'accounting-incomplete: unknown landing usage' };
      }
      if (landingJudgement.approved === true) {
        try {
          if (unit.kind === 'goal') assertCurrentPlanApproval({ unit, result: planResult, mode });
          assertCurrentExecutionApproval(facts, launch.runDirectory);
          allowedQueuePaths = queueContinuationPaths({ ...parentContext, approvedPlans });
          if (journal) {
            unitJournal.operationId ??= checkpointDigest({ queue: queueFileDigest, unit: unit.index,
              runId: facts.runId, diff: facts.approval.artifactDigest });
            persist();
          }
          landing = unitJournal.landing ?? await landDiff({
            target: resolve(target),
            diffPath: join(launch.runDirectory, 'CHANGES.diff'),
            unit,
            runId: facts?.runId ?? launch?.runId ?? 'unknown',
            allowedDirtyPaths: allowedQueuePaths,
            ...(unitJournal.operationId ? { operationId: unitJournal.operationId } : {}),
          });
          if (journal) { unitJournal.landing = landing; persist(); }
          landed = true;
          landedCount++;
        } catch (error) {
          if (unitJournal.operationId) {
            // Once an operation was dispatched, failure to return its SHA is
            // not proof it did not commit. Reconcile or leave phase-complete.
            const recovered = await recoverQueueLanding({ target, operationId: unitJournal.operationId,
              diffPath: join(launch.runDirectory, 'CHANGES.diff'), allowedDirtyPaths: allowedQueuePaths });
            if (!recovered) {
              if (continuation) throw error;
              unitJournal.landingFailure = { reason: error?.message ?? String(error), status: 'reconciliation-required' };
              persist();
              stop = { kind: 'apply-failed', unit: unit.name, unitIndex: unit.index,
                reason: error?.message ?? String(error), outcome: facts?.outcome ?? null, questions: [] };
            } else {
              landing = recovered;
              unitJournal.landing = recovered;
              persist();
              landed = true;
              landedCount++;
            }
          } else {
            const reason = error?.message ?? String(error);
            stop = {
              kind: 'apply-failed',
              unit: unit.name,
              unitIndex: unit.index,
              reason,
              outcome: facts?.outcome ?? null,
              questions: [],
            };
          }
        }
      } else {
        stop = {
          kind: 'final-review',
          unit: unit.name,
          unitIndex: unit.index,
          reason: landingJudgement.approved === false
            ? `Claude refused the landing: ${landingJudgement.reasoning || '(no reasoning recorded)'}`
            : `Claude's final review was unavailable — nothing lands unseen: ${landingJudgement.reasoning || '(no detail)'}`,
          outcome: facts?.outcome ?? null,
          questions: [],
        };
      }
    } else {
      stop = {
        kind: evaluation.kind ?? 'run-outcome',
        unit: unit.name,
        unitIndex: unit.index,
        reason: evaluation.reason,
        outcome: evaluation.outcome ?? facts?.outcome ?? null,
        questions: evaluation.questions ?? [],
      };
    }

    const record = {
      name: unit.name,
      runId: facts?.runId ?? launch?.runId ?? null,
      ...(unitJournal.operationId ? { operationId: unitJournal.operationId, unitIndex: unit.index } : {}),
      outcome: facts?.outcome ?? null,
      findingsLastRound: (facts?.debate?.roundHistory?.at(-1)?.findings ?? []).length,
      tokens,
      durationMs,
      landed,
      // The landed commit is the audit trail, and the base the goal-acceptance
      // review diffs from when a goal spans several queue invocations.
      ...(typeof landing?.commit === 'string' && landing.commit !== ''
        ? { commit: landing.commit }
        : {}),
      stoppedOn: stop !== null,
      ...(landingJudgement === null ? {} : {
        finalReview: {
          approved: landingJudgement.approved,
          reasoning: landingJudgement.reasoning ?? '',
          ...(Array.isArray(landingJudgement.findings) && landingJudgement.findings.length > 0
            ? { findings: landingJudgement.findings }
            : {}),
        },
      }),
      ...(tokenReading.valid ? {} : { tokenAccounting: 'invalid' }),
      ...(stop === null ? {} : { stopReason: stop.reason }),
      ...(evaluation.questions?.length > 0 ? { questions: evaluation.questions } : {}),
      ...(assumed ? {
        escalation: 'operator-absent',
        questions: assumedQuestions,
        answers: assumedAnswers,
      } : {}),
      ...(unit.kind === 'goal' ? {
        planRounds: planResult?.rounds ?? null,
        planConverged: planResult?.converged === true,
        planApproved: planResult?.approved === true,
        planApproval: planResult?.approval ?? null,
        interactionMode: mode,
        planOutcome: planResult?.reason ?? null,
        implementationOutcome: facts?.outcome ?? null,
      } : {}),
    };
    const logged = unitJournal.operationId && existsSync(queue.logPath)
      ? readFileSync(queue.logPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
        .filter(row => row.operationId === unitJournal.operationId) : [];
    const confirmed = logged.filter(row => row.landed);
    if (confirmed.length > 1 || logged.some(row => row.name !== record.name)
      || confirmed.some(row => row.commit !== record.commit)
      || logged.some(row => !row.landed && row.commit)) {
      throw new Error('queue operation log conflicts with saved landing');
    }
    if (!confirmed.length) appendLog(queue.logPath, { ...record, ...(logged.length ? { reconcilesOperation: unitJournal.operationId } : {}) });
    if (journal && landed) {
      unitJournal.logged = true;
      unitJournal.afterUnit = { attemptedCount, landedCount, totalTokens };
      persist();
    }

    if (facts?.outcome === 'needs-decision' || facts?.checkpointState?.dialogue?.technicalPause
      || facts?.checkpointState?.technicalPause) await savePending(launch.runDirectory, 'execution', planResult);
    if (stop !== null) break;
    if (tokenBudget !== undefined && totalTokens.total > tokenBudget
      && attemptedCount < queue.units.length) {
      stop = stopBefore(
        queue.units,
        attemptedCount,
        'token-budget',
        `token budget exceeded: total ${totalTokens.total} exceeds ${tokenBudget}`,
      );
      break;
    }
  }

  // Claude closes the goal, not the queue. Acceptance runs only when the
  // operator asked for it and nothing already stopped. An empty queue file
  // names nothing landed to review, so a REQUESTED acceptance over it stops
  // loudly instead of being silently skipped — a goal is never achieved
  // unseen, and that includes "unseen because nothing ran". Otherwise,
  // acceptance runs once the log shows every named unit landed; a queue file
  // with units that stopped short of landing them all never reaches this
  // point at all (stop is already non-null). Landed commits are never rolled
  // back: a refusal is information for the operator, exactly like a landing
  // refusal.
  let goalAcceptance = null;
  if (acceptGoalSpec !== undefined && stop === null && queue.units.length === 0) {
    stop = {
      kind: 'goal-acceptance',
      reason: 'nothing queued — nothing to accept; a goal is never achieved unseen',
      outcome: null,
      questions: [],
    };
  } else if (acceptGoalSpec !== undefined && stop === null && queue.units.length > 0) {
    const landedState = everyUnitLanded(queue.units, queue.logPath, readQueueLog);
    if (landedState.unreadable !== undefined) {
      // Unreadable is not the same as incomplete: an incomplete trail is a
      // normal mid-goal stop that silently skips acceptance, but the operator
      // asked for the goal to be closed, and completeness can never be
      // confirmed from a log that cannot be read — that is a stop, not silence.
      stop = {
        kind: 'goal-acceptance',
        reason: 'cannot read queue-log.jsonl to verify the goal is complete — a goal is '
          + `never achieved unseen: ${landedState.unreadable}`,
        outcome: null,
        questions: [],
      };
    } else if (landedState.complete && !queueJournal.acceptance?.result && tokenBudget !== undefined
      && (resources().usageUnknown || totalTokens.total >= tokenBudget)) {
      stop = { kind: resources().usageUnknown ? 'accounting-incomplete' : 'token-budget',
        reason: 'No known remaining allowance for goal acceptance', outcome: null, questions: [] };
    } else if (landedState.complete) {
      const acceptanceJournal = (queueJournal.acceptance ??= {});
      const persistAcceptance = persistQueue;
      let acceptance;
      try {
        if (!acceptanceJournal.result && acceptanceJournal.started) throw new Error('goal acceptance was already started without a recorded result; automatic replay refused');
        if (!acceptanceJournal.result) { acceptanceJournal.started = true; persistAcceptance(); }
        acceptance = acceptanceJournal.result ?? await acceptGoal({
          claudeModel,
          workflowBinding: structuredClone(workflowBinding),
          goalSpecPath: resolve(acceptGoalSpec),
          target: resolve(target),
          logPath: queue.logPath,
          ...(tokenBudget === undefined ? {} : { tokenBudget: tokenBudget - totalTokens.total }),
        }) ?? { approved: null, reasoning: 'goal acceptance returned nothing' };
      } catch (error) {
        acceptance = { approved: null, reasoning: error?.message ?? String(error) };
      }
      acceptanceJournal.result = acceptance; persistAcceptance();
      // The taxi meter runs whether or not you arrive: the acceptance judgement
      // spends real tokens on every path, approved or refused or unavailable.
      const acceptanceTokens = usageTokens(acceptance.usage);
      totalTokens = addTokens(totalTokens, acceptanceTokens);
      debit('goal-acceptance', acceptanceTokens, acceptance, true);
      const accountingIncomplete = tokenBudget !== undefined && resources().usageUnknown;
      goalAcceptance = {
        approved: accountingIncomplete ? null : typeof acceptance.approved === 'boolean' ? acceptance.approved : null,
        reasoning: acceptance.reasoning ?? '',
        ...(Array.isArray(acceptance.findings) && acceptance.findings.length > 0
          ? { findings: acceptance.findings }
          : {}),
      };
      if (goalAcceptance.approved !== true) {
        stop = {
          kind: accountingIncomplete ? 'accounting-incomplete' : 'goal-acceptance',
          reason: accountingIncomplete ? 'accounting-incomplete: unknown goal acceptance usage' : goalAcceptance.approved === false
            ? `Claude refused the goal: ${goalAcceptance.reasoning || '(no reasoning recorded)'}`
            : "Claude's goal acceptance was unavailable — a goal is never achieved "
              + `unseen: ${goalAcceptance.reasoning || '(no detail)'}`,
          outcome: null,
          questions: [],
        };
      }
      const operationId = checkpointDigest({ queue: queueFileDigest, kind: 'goal-acceptance', runId: queueJournal.runId ?? null });
      const alreadyLogged = operationId && existsSync(queue.logPath) && readFileSync(queue.logPath, 'utf8')
        .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).some(row => row.operationId === operationId);
      if (!alreadyLogged) appendLog(queue.logPath, {
        goalAcceptance,
        tokens: acceptanceTokens,
        ...(operationId ? { operationId } : {}),
        ...(stop === null ? {} : { stopReason: stop.reason }),
      });
    }
  }

  const remaining = queue.units.length - attemptedCount;
  return {
    dryRun: false,
    attemptedCount,
    landedCount,
    remaining,
    totalTokens,
    resources: resources(),
    stop,
    assumedDecisions,
    goalAcceptance,
    summary: formatQueueSummary({
      units: queue.units,
      landedCount,
      stop,
      remaining,
      totalTokens,
      assumedDecisions,
      goalAcceptance,
    }),
  };
}
