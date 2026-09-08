import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { buildArbiterPrompt, DEFAULT_ARBITER_MODEL, runArbiter } from './arbiter.js';
import { CONVERSATION_DNA, conversationText, parseSeatReview, RepairableArtifactError,
  runConversation, seatLaunchFailure, stanceRepairLines, MAX_ARTIFACT_REPAIRS,
  planningArtifactDigest, dialoguePromptText } from './conversation.js';
import { decisionAuthority } from './decision-policy.js';
import { reportEvent } from './events.js';
import { addUsage, EMPTY_USAGE } from './usage.js';
import { runExecutor, DEFAULT_EXECUTOR_MODEL, DEFAULT_EXECUTOR_EFFORT } from './executor.js';
import { resolveStageTimeouts } from './timeouts.js';
import { applySuperpowersRequirement, verifySuperpowersSeats } from './superpowers.js';
import { saveCheckpoint } from './checkpoint.js';
import { runPlanningDialogue, openPlanningContext, callPlanningPreparation, assertPlanningSidecars, createPlanningBudgetGuard, contextLifecycle } from './planning-dialogue.js';
export { parseSeatReview };

export const DEFAULT_PLAN_CANDIDATES = 1;
export const DEFAULT_PIVOT_CANDIDATES = 3;
export const MAX_PLAN_CANDIDATES = 5;

const INITIAL_PERSPECTIVES = Object.freeze([
  'evidence-first minimal change: preserve the current design and alter only proven fault lines',
  'boundary-first redesign: move responsibility to clearer module boundaries and explicit contracts',
  'risk-first compatibility: contain the change behind compatibility seams and regression controls',
  'data-flow-first simplification: reshape the flow of state so invalid states are hard to represent',
  'operations-first resilience: design around failure recovery, observability, and safe degradation',
]);

const FRESH_PERSPECTIVES = Object.freeze([
  'problem-reframing: challenge the failed approach assumptions and solve from a different premise',
  'boundary-redesign: relocate ownership so the recurring findings cannot arise at the old seam',
  'invariant-first: derive the implementation from the required invariants instead of the discarded plan',
  'state-model redesign: replace the failed control flow with explicit state and transitions',
  'compatibility inversion: preserve external behavior while reversing the internal dependency direction',
]);

export function validatePlanCandidateCount(value, name = 'candidates') {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PLAN_CANDIDATES) {
    throw new TypeError(`${name} must be an integer from 1 to ${MAX_PLAN_CANDIDATES}`);
  }
  return value;
}

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function looksLikePath(value) {
  return /[\\/]/.test(value) || /^[.~]/.test(value) || /\.[A-Za-z0-9]+$/.test(value);
}

export function resolveGoal(goal, { baseDirectory = process.cwd() } = {}) {
  if (typeof goal !== 'string' || goal.trim() === '') {
    throw new TypeError('goal must be a non-empty string');
  }
  const candidate = isAbsolute(goal) ? resolve(goal) : resolve(baseDirectory, goal);
  if (existsSync(candidate)) {
    if (!isFile(candidate)) throw new Error(`goal path is not a file: ${candidate}`);
    try { return { source: candidate, text: readFileSync(candidate, 'utf8') }; }
    catch (error) { throw new Error(`cannot read goal file ${candidate}: ${error.message}`); }
  }
  if (looksLikePath(goal)) throw new Error(`goal file not found: ${candidate}`);
  return { source: null, text: goal };
}

/** Trust boundary for written planning artifacts consumed by queue children. */
export function assertCurrentPlanApproval({ unit, result, mode = 'manual' }) {
  const approval = result?.approval;
  if (result?.approved !== true || !approval || typeof approval.reason !== 'string' || !approval.reason.trim()
    || !['consensus', 'reviewer', 'human'].includes(approval.basis)
    || !['codex', 'human'].includes(approval.decidedBy)
    || (approval.basis === 'reviewer' && (mode !== 'autonomous' || approval.decidedBy !== 'codex'))
    || (approval.basis === 'human' && (mode !== 'manual' || approval.decidedBy !== 'human'))) {
    throw new Error('plan approval is missing a current authorized decision');
  }
  const planPath = join(unit.out, 'plan.md'), gatePath = join(unit.out, 'gate.json');
  if ((result.planPath && resolve(result.planPath) !== resolve(planPath))
    || (result.gatePath && resolve(result.gatePath) !== resolve(gatePath))) {
    throw new Error('plan approval does not identify the current output paths');
  }
  const digest = planningArtifactDigest(resolveGoal(unit.goal).text, {
    plan: readFileSync(planPath, 'utf8'), gate: JSON.parse(readFileSync(gatePath, 'utf8')),
  });
  if (approval.artifactDigest !== digest) throw new Error('plan approval digest is stale for the current goal, plan or gate');
  if (approval.contextDigest) assertPlanningSidecars({ directory: unit.out, runId: result.runId, approval, manifest: result.planningArtifacts });
  return { ...approval };
}

function writableAncestor(path) {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export function assertPlanOutputAvailable(out) {
  if (typeof out !== 'string' || out.trim() === '') {
    throw new TypeError('out must be a non-empty directory path');
  }
  const directory = resolve(out);
  if (existsSync(directory) && !isDirectory(directory)) {
    throw new Error(`plan output path is not a directory: ${directory}`);
  }
  for (const name of ['plan.md', 'gate.json', 'uro-checkpoint.json']) {
    const path = join(directory, name);
    if (existsSync(path)) throw new Error(`refusing to overwrite existing ${path}`);
  }
  const ancestor = writableAncestor(directory);
  try { accessSync(ancestor, constants.W_OK); }
  catch (error) { throw new Error(`plan output is not writable: ${directory}: ${error.message}`); }
  return directory;
}

export function validatePlanRequest({ goal, target, out, baseDirectory = process.cwd() }) {
  const resolvedTarget = resolve(target);
  if (!isDirectory(resolvedTarget)) throw new Error(`target directory does not exist: ${resolvedTarget}`);
  const resolvedGoal = resolveGoal(goal, { baseDirectory });
  const resolvedOut = assertPlanOutputAvailable(out);
  return { goal: resolvedGoal.text, goalSource: resolvedGoal.source, target: resolvedTarget, out: resolvedOut };
}

function parseDraftArtifact(text) {
  const source = String(text ?? '');
  const plan = /<PLAN_MD>\s*([\s\S]*?)\s*<\/PLAN_MD>/i.exec(source)?.[1]?.trim();
  const gateText = /<GATE_JSON>\s*([\s\S]*?)\s*<\/GATE_JSON>/i.exec(source)?.[1]?.trim()
    ?.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!plan || !gateText) throw new Error('planner did not return PLAN_MD and GATE_JSON artifacts');
  let gate;
  try { gate = JSON.parse(gateText); }
  catch (error) { throw new Error(`planner returned invalid gate.json: ${error.message}`); }
  return { plan: `${plan}\n`, gate };
}

function ledgerPrompt(ledger) {
  if (!ledger) return '';
  const rounds = Array.isArray(ledger) ? ledger : ledger.rounds ?? [];
  const recurring = Array.isArray(ledger.recurredFindingIds)
    ? ledger.recurredFindingIds
    : [];
  const resolved = Array.isArray(ledger.resolvedFindingIds)
    ? ledger.resolvedFindingIds
    : [];
  return [
    'Debate ledger (evidence from the discarded approach):',
    JSON.stringify({ rounds, recurringFindingIds: recurring, resolvedFindingIds: resolved }),
  ].join('\n');
}

function draftingPrompt({
  goal,
  round,
  previousPlan,
  feedback,
  pivot,
  perspective,
  candidateId,
  candidateCount,
  ledger,
  failedPlan,
}) {
  return [
    CONVERSATION_DNA,
    '',
    '# Plan drafting seat',
    '',
    'Work only as a planner. Explore the target for real evidence, but do not modify any file.',
    'Draft an implementation plan and its evidence commands (gate.json) for this goal. The harness runs those commands once per round and records their full output as evidence for the seats; no exit code passes or fails the change.',
    '',
    goal,
    '',
    `This is plan round ${round}.`,
    'The plan must contain headings named Title, Required behavior, Invariants, Test requirements, and Out of scope.',
    'Every cited path and line must already exist in the target. Describe proposed new paths without formatting them as citations.',
    'Every absence assertion in Test requirements must include a positive control in the same numbered or bulleted item.',
    'Return exactly two tagged artifacts and no prose outside them:',
    '<PLAN_MD>\n...complete Markdown...\n</PLAN_MD>',
    '<GATE_JSON>\n[{"bin":"...","args":["..."]}]\n</GATE_JSON>',
    ...(perspective ? [
      '',
      '# STORM candidate',
      `Candidate: ${candidateId}`,
      `Candidate count: ${candidateCount}`,
      `Declared perspective: ${perspective}`,
      'This perspective must materially determine the implementation strategy. Do not merely reword another likely approach.',
      'State the declared perspective explicitly in the plan so a reviewer can distinguish the approach.',
    ] : []),
    ...(ledger ? ['', ledgerPrompt(ledger)] : []),
    ...(failedPlan ? [
      '',
      'Discarded implementation framing:',
      failedPlan,
      'Do not amend or reproduce that framing. Choose a genuinely different implementation strategy.',
    ] : []),
    ...(pivot ? ['', `Pivot instruction: ${pivot}`] : []),
    ...(previousPlan ? ['', 'Previous draft:', previousPlan] : []),
    ...(feedback ? ['', 'Required corrections:', feedback] : []),
  ].join('\n');
}


function normalizeDraft(value) {
  if (value && typeof value === 'object' && typeof value.plan === 'string') {
    let gate = value.gate;
    if (typeof gate === 'string') gate = JSON.parse(gate);
    return { plan: value.plan.endsWith('\n') ? value.plan : `${value.plan}\n`, gate };
  }
  return parseDraftArtifact(value);
}

// A proposal that ARRIVED but does not parse — missing tags, unreadable
// gate.json — is a repairable artifact: the parse error goes back to the
// proposing seat verbatim and it answers next round. An answer with NO artifact
// in it at all is not a malformed artifact but a seat that never really spoke,
// and that stays terminal.
//
// The engine hands this the seat's RAW response precisely so the plan tier owns
// that distinction. It is the plan tier — not the engine — that knows a plan
// proposal is a tagged string, an `answer` carrying one, or the {plan, gate}
// object an injected seat returns; anything else is silence. Reading silence as
// a malformed artifact ('[object Object]' has no PLAN_MD either) fed it back
// round after round, unbounded.
export function parsePlanProposal(response) {
  const artifact = typeof response === 'string' ? response
    : typeof response?.answer === 'string' ? response.answer
      : typeof response?.plan === 'string' ? response
        : null;
  if (artifact === null || (typeof artifact === 'string' && artifact.trim() === '')) {
    throw new Error('the proposing seat returned no artifact');
  }
  try {
    return normalizeDraft(artifact);
  } catch (error) {
    throw new RepairableArtifactError(error.message, { cause: error });
  }
}

function candidateFailure(error) {
  return {
    passed: false,
    failures: [{
      id: 'PG_DRAFT',
      check: 'gate-runs',
      message: `planner artifacts are invalid: ${error?.message ?? String(error)}`,
    }],
  };
}

export function planCandidateFacts(candidate, selectedId = null) {
  const planGate = {
    passed: candidate.gateResult?.passed === true,
    failures: candidate.gateResult?.failures ?? [],
  };
  return {
    id: candidate.id,
    perspective: candidate.perspective,
    planGate,
    gatePassed: planGate.passed,
    failures: planGate.failures,
    selected: candidate.id === selectedId,
  };
}


export async function planningPreflight({ adapters = {}, superpowers, env, home }) {
  const requiredSeats = ['codex', 'claude'];
  const verification = superpowers?.seats ? superpowers
    : await (adapters.verifySuperpowers ?? verifySuperpowersSeats)({ env, home, requiredSeats });
  const requirement = applySuperpowersRequirement(verification, env, { requiredSeats });
  if (!requirement.ok) throw new Error(`superpowers preflight failed: ${requirement.reason}`);
  return requirement;
}

export function planningAuthorPrompt(prompt, request) {
  if (request.dialogueMode) return [dialoguePromptText(prompt), dialoguePromptText(request.input),
    'You are Claude, the planning author. Follow the requested dialogue action. Only propose/revise includes complete required artifact tags alongside the dialogue envelope.',
    'Independently inspect relevant repository sources. Conversation-only turns are read-only.'].join('\n\n');
  return [
    prompt,
    ...(request.candidateCount ? [`Author candidate ${request.candidateId} of ${request.candidateCount}. Its perspective is: ${request.perspective}. Make this approach materially distinct and describe that perspective in the plan.`] : []),
    'You are Claude, the author. Codex reviews this artifact. State AGREE: yes if you endorse the delivered artifact, or AGREE: no and explain retained dissent. Include the complete required tagged artifacts.',
    'Answer every outstanding objection with evidence. Preserve dissent explicitly. During reconciliation state the disputed point, evidence, and what would change your position.',
    `Interaction mode: ${request.interactionMode}. Autonomous final planning authority: Codex. Manual unresolved disputes: human.`,
    request.previousProposal ? 'Previous proposal:\n' + request.previousProposal : '',
    request.feedback ? 'Feedback (verbatim):\n' + request.feedback : '',
    conversationText(request.messages),
  ].filter(Boolean).join('\n\n');
}

export function planningReviewPrompt(prompt, request) {
  if (request.dialogueMode) return [dialoguePromptText(prompt), dialoguePromptText(request.input),
    'You are Codex, the independent planning reviewer. Inspect evidence and explicitly assess it. A clean approve may finish this call; decide alone is not approval. Manual unresolved disputes go to the human.'].join('\n\n');
  return [
    prompt,
    `ARTIFACT_DIGEST: ${request.artifactDigest}`,
    'Engage with the author reasoning and previous messages. Retain open issue IDs; identify addressed IDs with ADDRESSED: id,id. State unresolved questions as Q<id>: question.',
    request.finalDecision
      ? 'You are Codex, the final planning reviewer in autonomous mode. Resolve this specific dispute. Return DECISION: approve, DECISION: revise, or DECISION: stop; REASON: your substantive reasoning; and ARTIFACT_DIGEST: the exact digest above. A revision does not approve current bytes. Retain author dissent; your ruling is not consensus.'
      : 'Return AGREE: yes or AGREE: no and ARTIFACT_DIGEST: the exact digest above. Explain objections in substantive prose and S<id> P1: description lines. During reconciliation state evidence and what would change your position.',
    conversationText(request.messages),
    ...(request.repairContent ? stanceRepairLines(request.repairContent) : []),
  ].join('\n\n');
}

function parsePlanningReview(result) {
  const source = String(result.lastMessage ?? '');
  const decisions = [...source.matchAll(/^[ \t]*DECISION[ \t]*:[ \t]*([^\r\n]*)/gim)]
    .map(match => match[1].trim().toLowerCase());
  const decision = decisions.length === 1 && ['approve', 'revise', 'stop'].includes(decisions[0])
    ? decisions[0] : undefined;
  return { ...parseSeatReview(source), ...planningReviewEvidence(result), usage: result.usage,
    artifactDigest: /(?:^|\n)\s*ARTIFACT_DIGEST:\s*([a-f0-9]{64})\b/i.exec(source)?.[1]?.toLowerCase(),
    decision,
    reason: /(?:^|\n)\s*REASON:\s*([^\n]+)/i.exec(source)?.[1] ?? '',
    addressedIssueIds: /(?:^|\n)\s*ADDRESSED:\s*([^\n]+)/i.exec(source)?.[1]?.split(',').map(id => id.trim()) ?? [],
  };
}

// Retention and authority are separate: only lastMessage above determines the
// ruling, while all delivered messages remain ordered and verbatim in the record.
function planningReviewEvidence(result) {
  const agentMessages = Array.isArray(result.agentMessages)
    ? result.agentMessages.filter(message => typeof message === 'string') : [];
  return { content: agentMessages.length ? agentMessages.join('\n\n') : result.lastMessage ?? '',
    agentMessages, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode,
    timedOut: result.timedOut, launchFailed: result.launchFailed };
}

/** Inject model process boundaries while keeping prompt construction and parsing real. */
export function createPlanningSeats({
  target, claudeModel = DEFAULT_ARBITER_MODEL, codexModel = DEFAULT_EXECUTOR_MODEL,
  codexEffort = DEFAULT_EXECUTOR_EFFORT, executorTimeout, arbiterTimeout,
  runId, env, reporter, adapters = {}, authorPrompt, reviewPrompt,
}) {
  const hermetic = ['runArbiter', 'runExecutor', 'author', 'reviewer', 'draft', 'codexReview']
    .some(key => Object.hasOwn(adapters, key));
  const authorTransport = adapters.runArbiter ?? (hermetic ? null : runArbiter);
  const reviewTransport = adapters.runExecutor ?? (hermetic ? null : runExecutor);
  return {
    author: adapters.author ?? (async request => {
      if (typeof authorTransport !== 'function') return { unavailable: true, error: 'Claude author transport unavailable' };
      return authorTransport({
        cwd: target, request, prompt: planningAuthorPrompt(request.dialogueMode
          ? (['propose', 'revise', 'repair'].includes(request.action)
            ? authorPrompt({ ...request, type: request.type === 'draft' ? 'draft' : 'propose' })
            : '# Read-only planning discussion') : authorPrompt(request), request),
        model: claudeModel, timeoutMs: arbiterTimeout, runId, env, reporter,
      });
    }),
    reviewCodex: adapters.reviewer ?? adapters.codexReview ?? (async request => {
      if (typeof reviewTransport !== 'function') return { unavailable: true, error: 'Codex reviewer transport unavailable' };
      const result = await reviewTransport({
        cwd: target, plan: planningReviewPrompt(reviewPrompt(request), request),
        model: codexModel, effort: codexEffort, sandbox: 'read-only',
        timeoutMs: executorTimeout, runId, env,
        ...(request.dialogueMode ? { dialogueState: request.state, operationId: request.operationId } : {}),
      });
      if (result.exitCode !== 0 || result.timedOut || result.launchFailed) {
        return { ...result, unavailable: true, error: seatLaunchFailure('codex review', result), usage: result.usage,
          ...planningReviewEvidence(result) };
      }
      return request.dialogueMode ? { ...result, content: result.lastMessage ?? result.content ?? '' } : parsePlanningReview(result);
    }),
  };
}

export function reviewSeatPrompt({ goal, plan, gate, round }) {
  return [CONVERSATION_DNA, '# Codex plan reviewer',
    'Independently inspect repository evidence and review this exact plan against the original requirements.',
    'GOAL', goal, 'PLAN', plan, 'GATE', JSON.stringify(gate, null, 2), `ROUND ${round}`,
  ].join('\n\n');
}

async function productionDraft(request) {
  const result = await runArbiter({
    request: { type: 'draft', goal: request.goal },
    prompt: planningAuthorPrompt(request.input, request),
    cwd: request.target, model: request.claudeModel, timeoutMs: request.timeoutMs,
    runId: request.runId, env: request.env,
    ...(request.dialogueMode ? { dialogueState: request.state, operationId: request.operationId } : {}),
  });
  if (result?.verdict === 'UNVERIFIED' || result?.launchFailed || result?.timedOut) {
    return { ...result, unavailable: true, error: seatLaunchFailure('claude author', result) };
  }
  return result;
}

function selectionPrompt({ candidates, ledger, failedPlan }) {
  return [
    CONVERSATION_DNA,
    '',
    '# STORM plan selection seat',
    '',
    'Select one viable plan using judgement. Do not score or rank the candidates.',
    'Prefer the approach that best satisfies the goal and gate while learning from the supplied evidence.',
    ...(ledger ? ['', ledgerPrompt(ledger)] : []),
    ...(failedPlan ? ['', 'Discarded framing (do not select a disguised copy):', failedPlan] : []),
    '',
    ...candidates.flatMap((candidate) => [
      `## ${candidate.id}`,
      `Declared perspective: ${candidate.perspective}`,
      candidate.plan,
      `Gate: ${JSON.stringify(candidate.gate)}`,
      '',
    ]),
    'Return <SELECTED_CANDIDATE>candidate-N</SELECTED_CANDIDATE> alongside the required dialogue envelope.',
  ].join('\n');
}

function selectedCandidateId(value) {
  if (typeof value === 'string') {
    return /<SELECTED_CANDIDATE>\s*([^<\s]+)\s*<\/SELECTED_CANDIDATE>/i.exec(value)?.[1]
      ?? value.trim();
  }
  if (value && typeof value === 'object') {
    return value.selectedCandidateId ?? value.candidateId ?? value.id ?? null;
  }
  return null;
}


async function productionSelect(request, execute = runExecutor) {
  const result = await execute({
    plan: request.input, cwd: request.target, model: request.codexModel,
    effort: request.codexEffort, sandbox: 'read-only', timeoutMs: request.executorTimeout,
    runId: request.runId, env: request.env,
    ...(request.dialogueMode ? { dialogueState: request.state, operationId: request.operationId } : {}),
  });
  if (result.exitCode !== 0 || result.timedOut || result.launchFailed) {
    return { ...result, unavailable: true, error: seatLaunchFailure('codex selector', result) };
  }
  return { ...result, selectedCandidateId: selectedCandidateId(result.lastMessage) };
}

export async function runPlanCandidateSet({
  goal, target, count, mode = 'initial',
  interactionMode = 'manual', round = 1, rounds, ledger = null,
  failedPlan = '', previousPlan = '', feedback = '', pivot = '',
  claudeModel, codexModel, codexEffort, plannerModel,
  timeoutMs = resolveStageTimeouts().arbiter, executorTimeout = resolveStageTimeouts().executor,
  runId = `plan-candidates-${randomUUID()}`, env = process.env, reporter,
  draft, select, review, priorMessages = [],
  directory, out, artifactRoot, searchIndex, budget, resourceBudget,
} = {}) {
  decisionAuthority({ interactionMode, phase: 'planning' });
  if (count === undefined) count = mode === 'fresh' ? DEFAULT_PIVOT_CANDIDATES : DEFAULT_PLAN_CANDIDATES;
  validatePlanCandidateCount(count, mode === 'fresh' ? 'pivotCandidates' : 'candidates');
  if (!['initial', 'fresh'].includes(mode)) throw new TypeError(`unknown candidate mode: ${mode}`);
  if (typeof goal !== 'string' || !goal.trim()) throw new TypeError('candidate goal must be a non-empty string');
  if (typeof target !== 'string' || !target) throw new TypeError('candidate target must be a non-empty string');
  if (plannerModel !== undefined) throw new TypeError('plannerModel is ambiguous; use claudeModel or codexModel');
  if (count === 1) {
    const candidate = { id: 'candidate-1', index: 0, perspective: (mode === 'fresh' ? FRESH_PERSPECTIVES : INITIAL_PERSPECTIVES)[0], author: 'claude', attempts: [] };
    const common = { goal, target, mode, interactionMode, claudeModel, codexModel, codexEffort, timeoutMs, executorTimeout, runId, env };
    const production = createPlanningSeats({ ...common, arbiterTimeout: timeoutMs,
      adapters: draft ? { author: draft, ...(review ? { reviewer: review } : {}) } : {},
      authorPrompt: request => draftingPrompt({ ...common, ...request, round: request.round }), reviewPrompt: reviewSeatPrompt });
    const result = await runPlanningDialogue({ requirements: goal, target,
      directory: directory ?? join(target, '.uro-tmp', runId), runId, interactionMode, rounds, budget, resourceBudget,
      context: { failedPlan, previousPlan, ledger, pivot, feedback, priorMessages }, artifactRoot, env, searchIndex, reporter,
      seats: { author: async r => {
        const response = await (draft ?? production.author)({ ...common, ...r, candidateId: candidate.id,
          candidateIndex: r.type === 'draft' ? 1 : undefined, candidateCount: 1, perspective: candidate.perspective,
          messages: [...priorMessages, ...r.messages] });
        candidate.attempts.push({ response }); candidate.response = response;
        return response;
      }, reviewCodex: r => (review ?? production.reviewCodex)({ ...r, messages: [...priorMessages, ...r.messages] }) },
      strategy: { parseProposal: response => {
        const proposal = parsePlanProposal(response);
        Object.assign(candidate, proposal, { gateResult: { passed: true, failures: [] } }); return proposal;
      }, reviewRequests: ({ proposal, round }) => ({ codex: { goal, ...proposal, round } }),
      renderInput: r => draftingPrompt({ ...common, ...r, failedPlan, previousPlan, ledger, pivot, feedback }),
      writeConverged: proposal => ({ selected: { ...candidate, ...proposal } }) },
    });
    result.checkpointState.candidateState = { mode, selectedCandidateId: candidate.id, candidates: [candidate] };
    return { mode, interactionMode, candidates: [candidate], surviving: candidate.plan ? [candidate] : [],
      selected: null, exhausted: !candidate.plan, ...result };
  }
  const draftCandidate = draft ?? productionDraft;
  const session = openPlanningContext({ requirements: goal, target, directory: directory ?? join(target, '.uro-tmp', runId),
    runId, context: { failedPlan, previousPlan, ledger, pivot, feedback, priorMessages }, artifactRoot, env, searchIndex });
  try {
  const budgetGuard = createPlanningBudgetGuard({ session, resourceBudget, budget });
  let budgetPause = null;
  const perspectives = mode === 'fresh' ? FRESH_PERSPECTIVES : INITIAL_PERSPECTIVES;
  const common = { goal, target, round, mode, interactionMode, ledger, failedPlan,
    claudeModel, codexModel, codexEffort, timeoutMs, executorTimeout, runId, env };
  const messages = [...priorMessages], roundHistory = [];
  let draftingUsage = EMPTY_USAGE, artifactRepairs = 0;
  const messageFor = (response, speaker, role, extra = {}) => {
    const content = typeof response === 'string' ? response
      : response?.content ?? response?.answer ?? response?.lastMessage ?? '';
    const parsed = { ...parseSeatReview(content), ...(typeof response === 'object' ? response : {}) };
    const message = {
      speaker, role, phase: 'planning', round, turn: messages.length + 1,
      artifactDigest: null,
      stance: response?.unavailable || response?.launchFailed || response?.timedOut
        ? 'unavailable' : parsed.readable ? (parsed.agree ? 'agree' : 'disagree') : 'stance-unreadable',
      content,
      transport: Object.fromEntries(['stderr', 'stdout', 'exitCode', 'launchFailed', 'timedOut', 'usage']
        .filter(key => response?.[key] !== undefined).map(key => [key, response[key]])),
      ...(response?.error ? { error: response.error } : {}),
      ...extra,
    };
    messages.push(message);
    return message;
  };
  const attemptDraft = async (candidate, repairFeedback = '') => {
    const input = draftingPrompt({ goal, round, previousPlan, feedback: repairFeedback || feedback, pivot,
      candidateId: candidate.id, candidateCount: count, perspective: candidate.perspective, ledger, failedPlan });
    let response;
    try {
      response = await callPlanningPreparation({ session, requirements: goal, input, call: draftCandidate, seat: 'claude', action: 'propose', budget: budgetGuard,
        previousPreparationOperationId: repairFeedback ? candidate.response.preparationOperationId : undefined,
        request: { ...common, candidateId: candidate.id,
        candidateIndex: candidate.index + 1, candidateCount: count, perspective: candidate.perspective,
        feedback: repairFeedback || feedback, messages: [...messages] } });
    } catch (error) {
      response = { unavailable: true, error: error instanceof Error ? error.message : String(error) };
    }
    if (response?.budgetPaused) { budgetPause = response; candidate.preparationPause = response; return; }
    draftingUsage = addUsage(draftingUsage, response?.usage);
    const message = messageFor(response, 'claude', 'author', { candidateId: candidate.id });
    const attempt = { response, message };
    candidate.attempts.push(attempt);
    Object.assign(candidate, { input, response, message });
    try {
      if (response?.unavailable || response?.launchFailed || response?.timedOut || response?.verdict === 'UNVERIFIED') {
        throw new Error(response.error || seatLaunchFailure('claude author', response));
      }
      const artifact = parsePlanProposal(response);
      message.artifactDigest = planningArtifactDigest(goal, artifact);
      session.journal.append({ type: 'candidate-artifact', operationId: response.preparationOperationId, artifactDigest: message.artifactDigest });
      Object.assign(candidate, artifact, { gateResult: { passed: true, failures: [] }, repairable: false });
    } catch (error) {
      attempt.parseError = error.message;
      candidate.repairable = error instanceof RepairableArtifactError;
      candidate.gateResult = candidateFailure(error);
      message.parseError = error.message;
      if (!candidate.repairable) message.stance = 'unavailable';
    }
    reportEvent(reporter, runId, 'plan', 'proposal', { tier: 'plan', ...message });
  };
  // Every requested alternative receives its initial author call. Repairs then
  // share the same budget as later proposal/writer repairs, rather than resetting
  // an allowance per candidate or skipping malformed delivered artifacts.
  const candidates = Array.from({ length: count }, (_, index) => ({
    id: `candidate-${index + 1}`, index, perspective: perspectives[index], author: 'claude', attempts: [],
  }));
  for (const candidate of candidates) { await attemptDraft(candidate); if (budgetPause) break; }
  let irreparable = false;
  for (const candidate of candidates) {
    if (budgetPause) break;
    while (candidate.repairable) {
      const parseError = candidate.attempts.at(-1).parseError;
      roundHistory.push({ round, candidateId: candidate.id, repair: parseError });
      if (++artifactRepairs > MAX_ARTIFACT_REPAIRS) { irreparable = true; break; }
      await attemptDraft(candidate, [parseError, 'Previous delivered response:', candidate.message.content].join('\n'));
      if (budgetPause) { artifactRepairs--; break; }
    }
    if (irreparable) break;
  }
  const surviving = candidates.filter(candidate => candidate.gateResult?.passed);
  let selected = surviving[0], selectionUsage, selection;
  const failure = reason => {
    const resources = session.journal.account(), usage = resources.knownUsage;
    const result = { mode, interactionMode, candidates, surviving, selected: null, messages, roundHistory,
      exhausted: surviving.length === 0, approved: false, converged: false, approval: null, reason,
      sharedContext: session.snapshot, directory: session.directory, resources,
      tokens: { total: usage, usageUnknown: resources.usageUnknown }, checkpointState: {
        version: 2, phase: 'planning', tier: 'plan', runId, interactionMode,
        authority: decisionAuthority({ interactionMode, phase: 'planning' }), requirements: goal,
        proposal: null, artifactDigest: null, approval: null, messages, roundHistory, openIssues: [], usage,
        artifactRepairs, roundsLimit: rounds ?? null,
        candidateState: { mode, selectedCandidateId: null, candidates, selection },
      } };
    if (budgetPause) {
      result.action = 'paused';
      result.exhausted = true;
      const tail = session.journal.read().at(-1);
      Object.assign(result.checkpointState, { directory: session.directory, artifactRoot: session.artifactRoot,
        resourceBudget: session.resourceBudget, technicalPause: { reason },
        preparationState: session.journal.read().findLast(event => event.type === 'preparation-paused')?.state ?? null,
        journalIdentity: tail ? { sequence: tail.sequence, hash: tail.hash } : null });
      contextLifecycle.checkContext(session);
      session.journal.close();
      result.planningArtifacts = contextLifecycle.manifest({ directory: session.directory, runId,
        contextDigest: session.snapshot.digest, registeredPaths: session.ownedFiles.keys() });
      result.checkpointState.planningArtifacts = result.planningArtifacts;
    }
    return result;
  };
  if (budgetPause) return failure(budgetPause.reason);
  if (irreparable) return failure('proposal-irreparable');
  if (!surviving.length) return failure('author-unavailable');
  if (surviving.length > 1) {
    const choose = select ?? (draft ? null : productionSelect);
    if (!choose) return failure('reviewer-unavailable');
    let answer;
    try {
      answer = await callPlanningPreparation({ session, requirements: goal, call: choose, seat: 'codex', action: 'verify', budget: budgetGuard,
        request: { ...common, candidates: surviving }, input: selectionPrompt({ candidates: surviving, ledger, failedPlan }) });
    } catch (error) {
      answer = { unavailable: true, error: error instanceof Error ? error.message : String(error) };
    }
    if (answer?.budgetPaused) { budgetPause = answer; return failure(answer.reason); }
    selectionUsage = answer?.usage;
    selection = answer;
    const selectionMessage = messageFor(answer, 'codex', 'reviewer', { kind: 'candidate-selection' });
    reportEvent(reporter, runId, 'plan', 'review', { tier: 'plan', ...selectionMessage });
    if (answer?.unavailable || answer?.launchFailed || answer?.timedOut) return failure('reviewer-unavailable');
    selected = surviving.find(candidate => candidate.id === selectedCandidateId(answer));
    if (!selected) return failure('selection-unreadable');
  }
  const productionSeats = createPlanningSeats({
    target, claudeModel, codexModel, codexEffort, executorTimeout, arbiterTimeout: timeoutMs,
    runId, env,
    adapters: draft ? { author: async () => null } : {},
    authorPrompt: request => draftingPrompt({ goal, round: request.round, feedback: request.feedback }),
    reviewPrompt: request => reviewSeatPrompt(request),
  });
  const result = await runPlanningDialogue({
    runId, reporter, tier: 'plan', interactionMode, requirements: goal, rounds,
    session, target, directory: session.directory, budget, resourceBudget,
    prelude: { proposal: { plan: selected.plan, gate: selected.gate }, artifactRepairs,
      preparationOperationId: selected.response.preparationOperationId, selectionOperationId: selection?.preparationOperationId },
    seats: {
      author: async request => {
        if (draft) return draft({ ...common, ...request, candidateId: selected.id });
        return productionSeats.author(request);
      },
      reviewCodex: review ?? productionSeats.reviewCodex,
    },
    strategy: {
      parseProposal: parsePlanProposal,
      reviewRequests: ({ proposal, round: turn }) => ({ codex: { goal, ...proposal, round: turn } }),
      writeConverged: proposal => ({ selected: { ...selected, ...proposal } }),
    },
  });
  result.checkpointState.candidateState = { mode, selectedCandidateId: selected.id, candidates, selection };
  return { mode, interactionMode, candidates, surviving, selected: null, exhausted: false,
    ...result, ...(selectionUsage === undefined ? {} : { selectionUsage }) };
  } finally { session.journal.close(); }
}

/** Resume the selected in-memory candidate debate; no new candidates or disk writer. */
export async function continuePlanCandidateSet({ checkpointState: state, humanRuling, target,
  claudeModel, codexModel, codexEffort, executorTimeout, timeoutMs, env, reporter, draft, review }) {
  const selected = state.candidateState.candidates.find(candidate => candidate.id === state.candidateState.selectedCandidateId);
  if (!selected) throw new Error('saved fresh planning candidate is missing');
  const seats = createPlanningSeats({ target, claudeModel, codexModel, codexEffort, executorTimeout,
    arbiterTimeout: timeoutMs, runId: state.runId, env, reporter,
    adapters: { ...(draft ? { author: request => draft({ ...request, target, candidateId: selected.id,
      input: state.version === 2 ? request.input : draftingPrompt({ goal: state.requirements, round: request.round,
        previousPlan: request.previousProposal, feedback: request.feedback }) }) } : {}),
      ...(review ? { reviewer: review } : {}) },
    authorPrompt: request => draftingPrompt({ goal: state.requirements, round: request.round,
      previousPlan: request.previousProposal, feedback: request.feedback }), reviewPrompt: reviewSeatPrompt });
  const result = await (state.version === 2 ? runPlanningDialogue : runConversation)({ runId: state.runId, tier: 'plan', interactionMode: state.interactionMode,
    ...(state.version === 2 ? { target, directory: state.directory } : {}),
    requirements: state.requirements, rounds: state.roundsLimit ?? undefined, continuation: state, humanRuling, seats, reporter,
    strategy: { parseProposal: parsePlanProposal,
      reviewRequests: ({ proposal, round }) => ({ codex: { goal: state.requirements, ...proposal, round } }),
      writeConverged: proposal => ({ selected: { ...selected, ...proposal } }) } });
  return { mode: state.candidateState.mode, candidates: state.candidateState.candidates, selected: null, ...result };
}


function writeArtifacts(out, plan, gate) {
  mkdirSync(out, { recursive: true });
  const planPath = join(out, 'plan.md');
  const gatePath = join(out, 'gate.json');
  writeFileSync(planPath, plan, { encoding: 'utf8', flag: 'wx' });
  try {
    writeFileSync(gatePath, `${JSON.stringify(gate, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    unlinkSync(planPath);
    throw error;
  }
  return { planPath, gatePath };
}

export async function runPlan({
  goal, target, out, rounds, interactionMode = 'manual',
  candidates = DEFAULT_PLAN_CANDIDATES, pivotCandidates = DEFAULT_PIVOT_CANDIDATES,
  claudeModel, codexModel, codexEffort, plannerModel, verifierModel, arbiterModel,
  executorTimeout = resolveStageTimeouts().executor,
  arbiterTimeout = resolveStageTimeouts().arbiter,
  dryRun = false, runId = `plan-${randomUUID()}`, reporter,
  baseDirectory = process.cwd(), env = process.env, home = homedir(), superpowers, adapters = {},
  artifactRoot, searchIndex,
} = {}) {
  decisionAuthority({ interactionMode, phase: 'planning' });
  if (plannerModel !== undefined || verifierModel !== undefined) {
    throw new TypeError('plannerModel/verifierModel are ambiguous; use claudeModel or codexModel');
  }
  if (rounds !== undefined && (!Number.isSafeInteger(rounds) || rounds < 1)) throw new TypeError('rounds must be a positive integer');
  validatePlanCandidateCount(candidates, 'candidates');
  validatePlanCandidateCount(pivotCandidates, 'pivotCandidates');
  await planningPreflight({ adapters, superpowers, env, home });
  const request = validatePlanRequest({ goal, target, out, baseDirectory });
  reportEvent(reporter, runId, 'plan', 'start', { tier: 'plan', target: request.target,
    out: request.out, rounds, candidates, pivotCandidates, interactionMode, goalSource: request.goalSource });
  if (dryRun) return { runId, dryRun: true, approved: false, converged: false, rounds: 0,
    target: request.target, out: request.out };
  const seats = createPlanningSeats({
    target: request.target, claudeModel: claudeModel ?? arbiterModel, codexModel, codexEffort,
    executorTimeout, arbiterTimeout, runId, env, reporter, adapters,
    authorPrompt: authorRequest => `${CONVERSATION_DNA}\n\n${buildArbiterPrompt({ ...authorRequest, goal: request.goal })}`,
    reviewPrompt: reviewSeatPrompt,
  });
  let result;
  if (candidates > 1) {
    const execute = adapters.runExecutor ?? (Object.keys(adapters).some(key =>
      ['runArbiter', 'author', 'reviewer', 'draft', 'codexReview'].includes(key)) ? null : runExecutor);
    result = await runPlanCandidateSet({
      goal: request.goal, target: request.target, count: candidates, interactionMode, rounds,
      claudeModel: claudeModel ?? arbiterModel, codexModel, codexEffort,
      timeoutMs: arbiterTimeout, executorTimeout, runId, env, reporter,
      directory: request.out, artifactRoot, searchIndex,
      draft: r => seats.author({ ...r, type: r.previousProposal ? 'propose' : 'draft' }),
      review: seats.reviewCodex,
      select: execute ? r => productionSelect(r, execute)
        : async () => { throw new Error('Codex selector unavailable'); },
    });
    if (result.approved) Object.assign(result, writeArtifacts(request.out, result.selected.plan, result.selected.gate));
  } else {
    result = await runPlanningDialogue({
      runId, reporter, rounds, tier: 'plan', interactionMode, requirements: request.goal, seats,
      target: request.target, directory: request.out, artifactRoot, env, searchIndex,
      strategy: {
        draftRequest: () => ({ claudeRequest: { type: 'draft', goal: request.goal } }),
        proposeRequest: context => ({ type: 'propose', goal: request.goal, ...context }),
        parseProposal: parsePlanProposal,
        reviewRequests: ({ round, proposal }) => ({ codex: { goal: request.goal, ...proposal, round } }),
        writeConverged: proposal => writeArtifacts(request.out, proposal.plan, proposal.gate),
      },
    });
  }
  result.checkpointState.planningContext = { kind: 'plan', request,
    options: { claudeModel: claudeModel ?? arbiterModel, codexModel, codexEffort, executorTimeout, arbiterTimeout } };
  if (result.reason === 'needs-decision') {
    const checkpoint = await saveCheckpoint({ directory: request.out, checkpointState: result.checkpointState,
      references: request.goalSource && existsSync(request.goalSource) ? [request.goalSource] : [] });
    result.checkpoint = { directory: request.out, artifactDigest: checkpoint.artifactDigest, questions: checkpoint.pending.questions };
  }
  return { ...result, dryRun: false, target: request.target, out: request.out };
}

/** Trusted phase continuation; the public resume layer validates identity first. */
export async function continuePlanning({ checkpointState, humanRuling, adapters = {}, reporter, env }) {
  const state = structuredClone(checkpointState);
  const { request, options } = state.planningContext;
  const result = await (state.version === 2 ? runPlanningDialogue : runConversation)({ runId: state.runId, reporter, rounds: state.roundsLimit ?? undefined,
    tier: 'plan', interactionMode: state.interactionMode, requirements: state.requirements,
    ...(state.version === 2 ? { target: request.target, directory: state.directory } : {}),
    continuation: state, humanRuling,
    seats: createPlanningSeats({ target: request.target, ...options, runId: state.runId, env, reporter, adapters,
      authorPrompt: r => `${CONVERSATION_DNA}\n\n${buildArbiterPrompt({ ...r, goal: request.goal })}`,
      reviewPrompt: reviewSeatPrompt }),
    strategy: { parseProposal: parsePlanProposal,
      proposeRequest: context => ({ type: 'propose', goal: request.goal, ...context }),
      reviewRequests: ({ round, proposal }) => ({ codex: { goal: request.goal, ...proposal, round } }),
      writeConverged: proposal => writeArtifacts(request.out, proposal.plan, proposal.gate) },
  });
  result.checkpointState.planningContext = state.planningContext;
  return { ...result, target: request.target, out: request.out };
}
