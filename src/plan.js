import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  DebateLedger,
  detectCircling,
  PIVOT_AMEND,
  PIVOT_CONCLUDE,
  PIVOT_FRESH,
  shouldPivot,
} from './debate.js';
import { buildFixPlan, validateFindings } from './fix-plan.js';
import {
  ARBITER_UNVERIFIED,
  buildArbiterPrompt,
  DEFAULT_ARBITER_MODEL,
  parseCapabilityJudgement,
  parsePivotJudgement,
  runArbiter,
} from './arbiter.js';
import { reportEvent } from './events.js';
import { runExecutor } from './executor.js';
import { runPlanGate } from './plan-gate.js';
import { parseReview } from './review.js';
import { resolveStageTimeouts } from './timeouts.js';
import { runVerifier } from './verifier.js';
import {
  applySuperpowersRequirement,
  verifySuperpowersSeats,
} from './superpowers.js';

export const DEFAULT_PLAN_CANDIDATES = 3;
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
  for (const name of ['plan.md', 'gate.json']) {
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
    '# Plan drafting seat',
    '',
    'Work only as a planner. Explore the target for real evidence, but do not modify any file.',
    'Draft an implementation plan and its executable gate.json for this goal:',
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

async function productionDraft(request) {
  const result = await runExecutor({
    plan: request.input,
    cwd: request.target,
    model: request.plannerModel,
    sandbox: request.sandbox,
    timeoutMs: request.timeoutMs,
    runId: request.runId,
    attempt: request.round,
    env: request.env,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`planner seat exited ${result.exitCode}${result.timedOut ? ' after timing out' : ''}`);
  }
  return { ...parseDraftArtifact(result.lastMessage), usage: result.usage };
}

function selectionPrompt({ candidates, ledger, failedPlan }) {
  return [
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
    'Return exactly <SELECTED_CANDIDATE>candidate-N</SELECTED_CANDIDATE>.',
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

async function productionSelect(request) {
  const result = await runExecutor({
    plan: request.input,
    cwd: request.target,
    model: request.plannerModel,
    sandbox: 'read-only',
    timeoutMs: request.timeoutMs,
    runId: request.runId,
    env: request.env,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`plan selector exited ${result.exitCode}${result.timedOut ? ' after timing out' : ''}`);
  }
  return {
    selectedCandidateId: selectedCandidateId(result.lastMessage),
    usage: result.usage,
  };
}

function oneLineArtifact(text) {
  return String(text).replaceAll('"', "'")
    .replace(/[\r\n]+/g, ' [newline] ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function productionReview({
  plan,
  gate,
  target,
  verifierModel,
  timeoutMs,
  env,
  home,
  superpowersDir,
}) {
  const prompt = [
    'Review the proposed implementation plan against the real repository.',
    'Emit REVIEW.md blocks using headings F1 and fields Severity, Category, Description, Test.',
    'Every blocking finding must name a test. Suggestions are nonblocking.',
    'End with exactly ISSUES when any blocking finding exists, otherwise exactly NO_BLOCKERS.',
    `PLAN ${oneLineArtifact(plan)}`,
    `GATE ${oneLineArtifact(JSON.stringify(gate))}`,
  ].join(' ');
  const result = await runVerifier({
    cwd: target,
    prompt,
    model: verifierModel,
    timeoutMs,
    pass: 'plan',
    env,
    home,
    superpowersDir,
  });
  return { content: result.findings ?? '', verdict: result.verdict, usage: result.usage };
}

function capabilityPrompt({ seat, plan, remedyOnly = false, previousAnswer }) {
  return buildArbiterPrompt({
    type: 'capability', seat, plan, remedyOnly, previousAnswer,
  }).replace('# Claude arbiter seat', `# ${seat} capability seat`);
}

async function productionCapability({
  seat,
  prompt,
  target,
  plannerModel,
  verifierModel,
  arbiterModel,
  executorTimeout,
  verifierTimeout,
  arbiterTimeout,
  runId,
  env,
  home,
  superpowersDir,
}) {
  if (seat === 'executor') {
    const result = await runExecutor({
      plan: prompt, cwd: target, model: plannerModel, sandbox: 'read-only',
      timeoutMs: executorTimeout, runId, env,
    });
    return result.exitCode === 0 && !result.timedOut
      ? result.lastMessage
      : { verdict: ARBITER_UNVERIFIED };
  }
  if (seat === 'reviewer') {
    const verifierPrompt = prompt
      .replace(
        'Return exactly one JSON object and no prose.',
        'Return one JSON object followed only by the required final verdict marker.',
      )
      .replaceAll('"', "'")
      .replace(/[\r\n]+/g, ' ');
    const result = await runVerifier({
      cwd: target,
      prompt: `${verifierPrompt} End with exactly NO_BLOCKERS.`,
      model: verifierModel,
      timeoutMs: verifierTimeout,
      pass: 'capability',
      env,
      home,
      superpowersDir,
    });
    return result.launchFailed || result.timedOut
      ? { verdict: ARBITER_UNVERIFIED }
      : result.findings;
  }
  return runArbiter({
    cwd: target,
    request: { type: 'capability', seat, plan: prompt },
    prompt,
    model: arbiterModel,
    timeoutMs: arbiterTimeout,
    runId,
    env,
  });
}

async function capabilityVetoes({
  plan,
  checkCapability,
  context,
  reporter,
  runId,
  planRound,
}) {
  if (typeof checkCapability !== 'function') return [];
  const vetoes = [];
  for (const seat of ['executor', 'reviewer', 'arbiter']) {
    const firstPrompt = capabilityPrompt({ seat, plan });
    const first = await checkCapability({ ...context, seat, plan, prompt: firstPrompt });
    let judgement = parseCapabilityJudgement(first);
    if (judgement.verdict !== 'answered' || judgement.capable !== false) continue;
    const answers = [first];
    if (!judgement.complete) {
      const prompt = capabilityPrompt({
        seat, plan, remedyOnly: true, previousAnswer: first,
      });
      const second = await checkCapability({
        ...context,
        seat,
        plan,
        prompt,
        remedyOnly: true,
        previousAnswer: first,
      });
      answers.push(second);
      const supplement = parseCapabilityJudgement(second);
      if (supplement.verdict === 'answered' && supplement.capable === false) {
        judgement = {
          ...judgement,
          what: supplement.what || judgement.what,
          why: supplement.why || judgement.why,
          alternative: supplement.alternative || judgement.alternative,
        };
        judgement.complete = Boolean(judgement.what && judgement.why && judgement.alternative);
      } else {
        const alternative = typeof second === 'string'
          ? second.trim()
          : typeof second?.alternative === 'string' ? second.alternative.trim()
            : typeof second?.answer === 'string' ? second.answer.trim() : '';
        if (alternative) {
          judgement = { ...judgement, alternative, complete: Boolean(judgement.what && judgement.why) };
        }
      }
    }
    const veto = { seat, ...judgement, answers };
    vetoes.push(veto);
    reportEvent(reporter, runId, 'capability', 'vetoed', {
      planRound,
      seat,
      what: veto.what,
      why: veto.why,
      alternative: veto.alternative,
      complete: veto.complete,
      answers,
    });
  }
  return vetoes;
}

function vetoFeedback(vetoes) {
  return [
    '# Capability veto remedies',
    '',
    'The previous draft cannot proceed. Redraft it around each seat-authoritative remedy.',
    '',
    ...vetoes.flatMap((veto) => [
      `## ${veto.seat}`,
      `Cannot do: ${veto.what}`,
      `Limitation: ${veto.why}`,
      `Use instead: ${veto.alternative || 'No complete alternative was supplied; find a compatible mechanism.'}`,
      '',
    ]),
  ].join('\n');
}

function normalizeDraft(value) {
  if (value && typeof value === 'object' && typeof value.plan === 'string') {
    let gate = value.gate;
    if (typeof gate === 'string') gate = JSON.parse(gate);
    return { ...value, plan: value.plan.endsWith('\n') ? value.plan : `${value.plan}\n`, gate };
  }
  return parseDraftArtifact(value);
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

function declarePerspective(plan, perspective) {
  const source = String(plan ?? '');
  if (source.includes(perspective)) return source;
  return `## Perspective\n\n${perspective}\n\n${source}`;
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

/**
 * Generate and mechanically check a bounded STORM candidate set. The helper is
 * deliberately side-effect free with respect to plan artifacts; callers decide
 * whether the selected plan is written or executed.
 */
export async function runPlanCandidateSet({
  goal,
  target,
  count = DEFAULT_PLAN_CANDIDATES,
  mode = 'initial',
  round = 1,
  ledger = null,
  failedPlan = '',
  previousPlan = '',
  feedback = '',
  pivot = '',
  plannerModel,
  timeoutMs = resolveStageTimeouts().executor,
  gateTimeout = resolveStageTimeouts().gate,
  runId = `plan-candidates-${randomUUID()}`,
  env = process.env,
  draft,
  checkGate = runPlanGate,
  select,
} = {}) {
  validatePlanCandidateCount(count, mode === 'fresh' ? 'pivotCandidates' : 'candidates');
  if (mode !== 'initial' && mode !== 'fresh') {
    throw new TypeError(`unknown candidate mode: ${mode}`);
  }
  if (typeof goal !== 'string' || goal.trim() === '') {
    throw new TypeError('candidate goal must be a non-empty string');
  }
  if (typeof target !== 'string' || target === '') {
    throw new TypeError('candidate target must be a non-empty string');
  }
  const draftCandidate = draft ?? productionDraft;
  const perspectives = mode === 'fresh' ? FRESH_PERSPECTIVES : INITIAL_PERSPECTIVES;
  const definitions = Array.from({ length: count }, (_, index) => ({
    id: `candidate-${index + 1}`,
    perspective: perspectives[index],
  }));

  const candidates = await Promise.all(definitions.map(async (definition) => {
    const input = draftingPrompt({
      goal,
      round,
      previousPlan,
      feedback,
      pivot,
      perspective: definition.perspective,
      candidateId: definition.id,
      candidateCount: count,
      ledger,
      failedPlan,
    });
    let artifact;
    let gateResult;
    try {
      artifact = normalizeDraft(await draftCandidate({
        input,
        goal,
        target,
        round,
        candidateId: definition.id,
        candidateIndex: Number(definition.id.slice('candidate-'.length)),
        candidateCount: count,
        perspective: definition.perspective,
        mode,
        ledger,
        failedPlan,
        plannerModel,
        sandbox: 'read-only',
        timeoutMs,
        runId,
        env,
      }));
      artifact.plan = declarePerspective(artifact.plan, definition.perspective);
    } catch (error) {
      gateResult = candidateFailure(error);
    }
    if (artifact) {
      try {
        gateResult = await checkGate({
          plan: artifact.plan,
          gate: artifact.gate,
          target,
          timeoutMs: gateTimeout,
          round,
          runId,
          candidateId: definition.id,
          perspective: definition.perspective,
        });
      } catch (error) {
        gateResult = {
          passed: false,
          failures: [{
            id: 'PG_GATE',
            check: 'gate-runs',
            message: `plan gate failed to run: ${error?.message ?? String(error)}`,
          }],
        };
      }
    }
    return { ...definition, input, ...(artifact ?? {}), gateResult };
  }));
  const surviving = candidates.filter((candidate) => candidate.gateResult?.passed === true);
  if (surviving.length === 0) {
    return { mode, candidates, surviving: [], selected: null, exhausted: true };
  }

  let selected = surviving[0];
  let selectionUsage;
  const selectCandidate = select ?? (draft === undefined ? productionSelect : null);
  if (surviving.length > 1 && typeof selectCandidate === 'function') {
    let answer;
    try {
      answer = await selectCandidate({
        input: selectionPrompt({ candidates: surviving, ledger, failedPlan }),
        goal,
        target,
        candidates: surviving.map((candidate) => ({
          id: candidate.id,
          perspective: candidate.perspective,
          plan: candidate.plan,
          gate: candidate.gate,
        })),
        ledger,
        failedPlan,
        mode,
        plannerModel,
        timeoutMs,
        runId,
        env,
      });
      selectionUsage = answer?.usage;
    } catch {
      answer = null;
    }
    const chosenId = selectedCandidateId(answer);
    selected = surviving.find((candidate) => candidate.id === chosenId) ?? selected;
  }
  return {
    mode,
    candidates,
    surviving,
    selected,
    exhausted: false,
    ...(selectionUsage === undefined ? {} : { selectionUsage }),
  };
}

function normalizeReview(value) {
  if (typeof value === 'string') {
    const parsed = parseReview(value);
    const verdict = parsed !== null
      ? undefined
      : /(?:^|\n)\s*NO_BLOCKERS\s*$/i.test(value) ? 'NO_BLOCKERS' : 'UNVERIFIED';
    return { content: value, verdict };
  }
  if (Array.isArray(value)) return { findings: value, verdict: undefined };
  if (value && typeof value === 'object') return value;
  return { content: '', verdict: 'UNVERIFIED' };
}

function reviewFindings(review) {
  const findings = Array.isArray(review.findings)
    ? review.findings
    : parseReview(review.content ?? '') ?? [];
  if (findings.some((finding) => finding.severity === 'blocking')) return findings;
  if (findings.length > 0) return findings;
  if (review.verdict !== undefined && review.verdict !== 'NO_BLOCKERS') {
    return [...findings, {
      id: 'F_UNVERIFIED',
      severity: 'blocking',
      category: 'review',
      description: `plan reviewer did not approve the draft (${review.verdict})`,
      test: 'plan review retry',
    }];
  }
  return findings;
}

function gateFindings(failures) {
  return failures.map((item, index) => ({
    id: item.id || `PG${index + 1}`,
    severity: 'blocking',
    category: item.check,
    description: item.message,
    test: 'mechanical plan gate',
  }));
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
  goal,
  target,
  out,
  rounds,
  candidates = DEFAULT_PLAN_CANDIDATES,
  pivotCandidates = DEFAULT_PLAN_CANDIDATES,
  plannerModel,
  verifierModel,
  arbiterModel = DEFAULT_ARBITER_MODEL,
  gateTimeout = resolveStageTimeouts().gate,
  executorTimeout = resolveStageTimeouts().executor,
  verifierTimeout = resolveStageTimeouts().verifier,
  arbiterTimeout = resolveStageTimeouts().arbiter,
  dryRun = false,
  runId = `plan-${randomUUID()}`,
  reporter,
  baseDirectory = process.cwd(),
  env = process.env,
  home = homedir(),
  superpowers,
  adapters = {},
} = {}) {
  if (rounds !== undefined && (!Number.isSafeInteger(rounds) || rounds < 1)) {
    throw new TypeError('rounds must be a positive integer');
  }
  validatePlanCandidateCount(candidates, 'candidates');
  validatePlanCandidateCount(pivotCandidates, 'pivotCandidates');
  const verifySuperpowers = adapters.verifySuperpowers ?? verifySuperpowersSeats;
  const verification = superpowers?.seats
    ? { ok: Object.values(superpowers.seats).every((seat) => seat.verified === true), seats: superpowers.seats }
    : await verifySuperpowers({ env, home });
  const requirement = applySuperpowersRequirement(verification, env);
  if (!requirement.ok) throw new Error(`superpowers preflight failed: ${requirement.reason}`);
  const verifiedSeats = requirement.verification.seats;
  const cursorSuperpowersDir = verifiedSeats.cursor.verified
    ? verifiedSeats.cursor.path
    : null;
  const request = validatePlanRequest({ goal, target, out, baseDirectory });
  reportEvent(reporter, runId, 'plan', 'start', {
    target: request.target, out: request.out, rounds, candidates, pivotCandidates,
    goalSource: request.goalSource,
  });
  if (dryRun) {
    const result = { runId, dryRun: true, converged: false, rounds: 0, target: request.target, out: request.out };
    reportEvent(reporter, runId, 'plan', 'finish', { dryRun: true, converged: false, rounds: 0 });
    return result;
  }

  const draft = adapters.draft ?? productionDraft;
  const reviewPlan = adapters.review ?? productionReview;
  const runArbiterSeat = adapters.runArbiter
    ?? (adapters.draft === undefined ? runArbiter : null);
  const checkCapability = adapters.checkCapability
    ?? adapters.capabilityCheck
    ?? (adapters.draft === undefined && adapters.review === undefined
      ? productionCapability
      : null);
  const checkGate = adapters.runPlanGate ?? runPlanGate;
  const selectPlanCandidate = adapters.selectPlanCandidate ?? adapters.selectCandidate;
  const ledger = new DebateLedger();
  let previousPlan = '';
  let feedback = '';
  let pivotInstruction = '';
  let pivotCount = 0;
  const pivotHistory = [];
  const capabilityHistory = [];
  const candidateHistory = [];
  let pendingFreshCandidates = null;
  let lastGate = null;

  const arbitrate = async (arbiterRequest) => {
    if (typeof runArbiterSeat !== 'function') {
      return { verdict: ARBITER_UNVERIFIED, unavailable: true };
    }
    const injected = adapters.runArbiter !== undefined;
    if (injected) reportEvent(reporter, runId, 'arbiter', 'start', {
      model: arbiterModel, judgement: arbiterRequest.type,
    });
    let result;
    try {
      result = await runArbiterSeat({
        cwd: request.target,
        request: arbiterRequest,
        prompt: buildArbiterPrompt(arbiterRequest),
        model: arbiterModel,
        timeoutMs: arbiterTimeout,
        runId,
        env,
        reporter: injected ? undefined : reporter,
      });
    } catch {
      result = { verdict: ARBITER_UNVERIFIED };
    }
    if (injected) reportEvent(reporter, runId, 'arbiter', 'finish', {
      verdict: result?.verdict ?? (result ? 'ANSWERED' : ARBITER_UNVERIFIED),
      judgement: arbiterRequest.type,
    });
    return result;
  };

  for (let round = 1; rounds === undefined || round <= rounds; round++) {
    let artifact;
    let gateResult;
    const storm = round === 1 && candidates > 1
      ? { mode: 'initial', count: candidates, ledger: null, failedPlan: '' }
      : pendingFreshCandidates;
    if (storm) {
      pendingFreshCandidates = null;
      const generated = await runPlanCandidateSet({
        goal: request.goal,
        target: request.target,
        count: storm.count,
        mode: storm.mode,
        round,
        ledger: storm.ledger,
        failedPlan: storm.failedPlan,
        previousPlan: storm.mode === 'fresh' ? '' : previousPlan,
        feedback,
        pivot: pivotInstruction,
        plannerModel,
        timeoutMs: executorTimeout,
        gateTimeout,
        runId,
        env,
        draft,
        checkGate,
        select: selectPlanCandidate
          ?? (adapters.draft === undefined ? productionSelect : undefined),
      });
      const selectedId = generated.selected?.id ?? null;
      const history = {
        round,
        mode: storm.mode,
        candidates: generated.candidates.map((candidate) => (
          planCandidateFacts(candidate, selectedId)
        )),
        selectedCandidateId: selectedId,
        exhausted: generated.exhausted,
      };
      candidateHistory.push(history);
      if (generated.exhausted) {
        const failures = history.candidates.flatMap((candidate) => (
          candidate.failures.map((failure) => ({ ...failure, candidateId: candidate.id }))
        ));
        lastGate = { passed: false, failures };
        if (storm.mode === 'fresh' && pivotHistory.length > 0) {
          Object.assign(pivotHistory.at(-1), {
            candidates: history.candidates,
            selectedCandidateId: null,
            exhausted: true,
            escalatedTo: PIVOT_CONCLUDE,
          });
        }
        const reason = storm.mode === 'fresh' ? 'pivot-conclude' : 'candidates-exhausted';
        const result = {
          runId, dryRun: false, converged: false, reason, rounds: round,
          target: request.target, out: request.out, gate: lastGate,
          capabilityVetoes: capabilityHistory,
          pivotHistory,
          candidateHistory,
        };
        reportEvent(reporter, runId, 'plan', 'finish', {
          converged: false, reason, rounds: round,
          ...(storm.mode === 'fresh' ? { pivot: PIVOT_CONCLUDE } : {}),
        });
        return result;
      }
      artifact = { plan: generated.selected.plan, gate: generated.selected.gate };
      gateResult = generated.selected.gateResult;
    } else {
      const input = draftingPrompt({
        goal: request.goal,
        round,
        previousPlan,
        feedback,
        pivot: pivotInstruction,
      });
      try {
        artifact = normalizeDraft(await draft({
          input,
          goal: request.goal,
          target: request.target,
          out: request.out,
          round,
          plannerModel,
          sandbox: 'read-only',
          timeoutMs: executorTimeout,
          runId,
          env,
        }));
      } catch (error) {
        artifact = {
          plan: previousPlan,
          gate: null,
          draftFailure: `planner artifacts are invalid: ${error?.message ?? String(error)}`,
        };
      }
      gateResult = artifact.draftFailure
        ? {
          passed: false,
          failures: [{ id: 'PG_DRAFT', check: 'gate-runs', message: artifact.draftFailure }],
        }
        : await checkGate({
          plan: artifact.plan,
          gate: artifact.gate,
          target: request.target,
          timeoutMs: gateTimeout,
          round,
          runId,
        });
    }
    lastGate = gateResult;
    reportEvent(reporter, runId, 'plan', 'gate', {
      planRound: round,
      passed: gateResult.passed === true,
      failures: gateResult.failures ?? [],
    });

    let findings;
    let reviewed = false;
    if (gateResult.passed === true) {
      reviewed = true;
      let review;
      try {
        review = normalizeReview(await reviewPlan({
          plan: artifact.plan,
          gate: artifact.gate,
          target: request.target,
          round,
          verifierModel,
          timeoutMs: verifierTimeout,
          runId,
          env,
          home,
          superpowersDir: cursorSuperpowersDir,
        }));
      } catch (error) {
        review = {
          content: '',
          verdict: `failed: ${error?.message ?? String(error)}`,
        };
      }
      findings = reviewFindings(review);
    } else {
      findings = gateFindings(gateResult.failures ?? []);
    }
    const blocking = findings.filter((finding) => finding.severity === 'blocking');
    const validation = blocking.length === 0
      ? { accepted: [], rejected: [], judgements: [] }
      : await validateFindings(blocking, {
          arbiter: arbitrate,
          diff: `PLAN\n${artifact.plan}\nGATE\n${JSON.stringify(artifact.gate)}`,
          plan: request.goal,
          reporter,
          runId,
          debateRound: round,
        });
    const survivingIds = new Set(validation.accepted);
    const surviving = blocking.filter((finding) => survivingIds.has(finding.id));
    ledger.record(round, surviving.map((finding) => finding.id));
    reportEvent(reporter, runId, 'plan', 'round', {
      planRound: round,
      gatePassed: gateResult.passed === true,
      reviewed,
      findingIds: findings.map((finding) => finding.id),
      blockingFindingIds: blocking.map((finding) => finding.id),
      acceptedFindingIds: validation.accepted,
      rejectedFindingIds: validation.rejected,
    });

    if (gateResult.passed === true && surviving.length === 0) {
      const vetoes = await capabilityVetoes({
        plan: artifact.plan,
        checkCapability,
        context: {
          target: request.target,
          plannerModel,
          verifierModel,
          arbiterModel,
          executorTimeout,
          verifierTimeout,
          arbiterTimeout,
          runId,
          env,
          home,
          superpowersDir: cursorSuperpowersDir,
        },
        reporter,
        runId,
        planRound: round,
      });
      if (vetoes.length > 0) {
        capabilityHistory.push({ round, vetoes });
        previousPlan = artifact.plan;
        feedback = vetoFeedback(vetoes);
        pivotInstruction = '';
        continue;
      }
      const paths = writeArtifacts(request.out, artifact.plan, artifact.gate);
      reportEvent(reporter, runId, 'plan', 'converged', {
        planRound: round, suggestions: findings.length,
      });
      const result = {
        runId,
        dryRun: false,
        converged: true,
        reason: 'converged',
        rounds: round,
        target: request.target,
        out: request.out,
        capabilityVetoes: capabilityHistory,
        pivotHistory,
        candidateHistory,
        ...paths,
      };
      reportEvent(reporter, runId, 'plan', 'finish', {
        converged: true, reason: result.reason, rounds: round,
      });
      return result;
    }

    feedback = buildFixPlan({
      findings: blocking,
      accepted: validation.accepted,
      rejected: validation.rejected,
      originalTask: request.goal,
    });
    previousPlan = artifact.plan;
    pivotInstruction = '';
    if (detectCircling(ledger)) {
      const pivotJudgement = parsePivotJudgement(await arbitrate({
        type: 'pivot',
        ledger: Array.from({ length: ledger.currentRound }, (_, index) => ({
          round: index + 1, findingIds: ledger.round(index + 1),
        })),
        recurringFindings: surviving.filter((finding) => ledger.stuckFindings().has(finding.id)),
        attempted: pivotHistory,
        plan: artifact.plan,
      }));
      const unjudged = pivotJudgement.verdict !== 'answered';
      const decision = unjudged ? shouldPivot(pivotCount) : pivotJudgement.decision;
      pivotCount++;
      pivotHistory.push({
        decision,
        unjudged,
        ...(pivotJudgement.reason ? { reason: pivotJudgement.reason } : {}),
      });
      if (decision === PIVOT_CONCLUDE) {
        const result = {
          runId, dryRun: false, converged: false, reason: 'pivot-conclude', rounds: round,
          target: request.target, out: request.out, gate: lastGate,
          capabilityVetoes: capabilityHistory,
          pivotHistory,
        };
        reportEvent(reporter, runId, 'plan', 'finish', {
          converged: false, reason: result.reason, rounds: round, pivot: decision,
        });
        return result;
      }
      if (decision === PIVOT_FRESH) {
        const ledgerAtPivot = {
          rounds: Array.from({ length: ledger.currentRound }, (_, index) => ({
            round: index + 1, findingIds: ledger.round(index + 1),
          })),
          recurredFindingIds: [...ledger.stuckFindings()],
          resolvedFindingIds: [...ledger.resolvedFindings()],
        };
        pendingFreshCandidates = {
          mode: 'fresh',
          count: pivotCandidates,
          ledger: ledgerAtPivot,
          failedPlan: artifact.plan,
        };
        previousPlan = '';
      }
      pivotInstruction = decision === PIVOT_AMEND
        ? 'Amend the approach specifically to break the recurring findings.'
        : 'Start from a genuinely fresh approach while preserving the goal and invariants.';
    }
  }

  const result = {
    runId,
    dryRun: false,
    converged: false,
    reason: 'rounds-exhausted',
    rounds,
    target: request.target,
    out: request.out,
    gate: lastGate,
    capabilityVetoes: capabilityHistory,
    pivotHistory,
    candidateHistory,
  };
  reportEvent(reporter, runId, 'plan', 'finish', {
    converged: false, reason: result.reason, rounds,
  });
  return result;
}
