import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  DebateLedger,
  detectCircling,
  PIVOT_AMEND,
  PIVOT_CONCLUDE,
  PIVOT_FRESH,
  shouldPivot,
} from './debate.js';

import {
  ARBITER_UNVERIFIED,
  buildArbiterPrompt,
  DEFAULT_ARBITER_MODEL,
  parseAgreementJudgement,
  parseCapabilityJudgement,
  parsePivotJudgement,
  runArbiter,
} from './arbiter.js';
import { reportEvent } from './events.js';
import { runExecutor } from './executor.js';

import { resolveStageTimeouts } from './timeouts.js';
import { runVerifier } from './verifier.js';
import { addUsage, EMPTY_USAGE } from './usage.js';
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

// Structured seat responses. The format is prompt discipline, not protocol: the
// parser extracts what matches and carries severities VERBATIM. Nothing anywhere
// validates a severity, filters by one, or branches on one — they are input to
// the arbiter's judgement and nothing else.
function reviewSeatPrompt({ seat, goal, plan, gate, round }) {
  return [
    `# ${seat} plan review seat`,
    'You receive the raw goal and a proposed implementation plan. Judge independently whether the plan achieves the goal; explore the target repository for real evidence.',
    `GOAL ${oneLineArtifact(goal)}`,
    `PLAN ${oneLineArtifact(plan)}`,
    `GATE ${oneLineArtifact(JSON.stringify(gate))}`,
    `ROUND ${round}`,
    'Respond in exactly this structure and nothing else:',
    'AGREE: yes or AGREE: no.',
    'Then zero or more suggestion lines, one per line, formatted: S<id> P0: description (or P1, P2 — your judgement of priority; nothing mechanical acts on it).',
    'Reuse the same S<id> for a suggestion you have raised in an earlier round so recurrence is visible.',
    'Then zero or more question lines formatted: Q<id>: question.',
    'AGREE: yes means you are satisfied the plan achieves the goal and you could work from it as written.',
  ].join(' ');
}

function parseSeatReview(text) {
  const source = String(text ?? '');
  const agreeMatches = [...source.matchAll(/(?:^|\n|\s)AGREE:\s*(yes|no)\b/gi)];
  const agree = agreeMatches.length > 0
    ? agreeMatches.at(-1)[1].toLowerCase() === 'yes'
    : null;
  const suggestions = [...source.matchAll(/(?:^|\n)\s*(S[\w-]+)\s+([^\s:]{1,12}):\s*(.+?)(?=\n|$)/g)]
    .map((match) => ({ id: match[1], severity: match[2], text: match[3].trim() }));
  const questions = [...source.matchAll(/(?:^|\n)\s*(Q[\w-]+):\s*(.+?)(?=\n|$)/g)]
    .map((match) => ({ id: match[1], text: match[2].trim() }));
  return {
    agree: agree === true,
    readable: agree !== null,
    suggestions,
    questions,
    content: source,
  };
}

// Cursor's CLI takes its prompt on argv and cannot read stdin, so a prompt
// embedding a whole proposal dies on the Windows 8191-character command line —
// the same wall that silenced the arbiter until its prompt moved to stdin.
// Measured live: the seat went mute in every call of the first three-way run.
// The hand-off is therefore the repo's established file pattern: artifacts on
// disk in a scratch directory, a short prompt naming their absolute paths —
// exactly how run-mode reviews already read TASK.md and CHANGES.diff.
function withSeatWorkspace(files, work) {
  const directory = mkdtempSync(join(tmpdir(), 'uro-plan-seat-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(directory, name), content, 'utf8');
    }
    return work(directory);
  } finally {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* scratch */ }
  }
}

async function productionCursorDraft({
  goal, target, verifierModel, timeoutMs, runId, env, home, superpowersDir, feedback, failedPlan,
}) {
  return withSeatWorkspace({
    'GOAL.md': `${goal}\n`,
    ...(feedback ? { 'FEEDBACK.md': `${feedback}\n` } : {}),
    ...(failedPlan ? { 'FAILED_PLAN.md': `${failedPlan}\n` } : {}),
  }, async (workspace) => {
    const prompt = [
      '# Cursor plan drafting seat',
      'You are one of three seats drafting independently from the same raw goal. Draft from your own reading of the repository.',
      `Read the goal from ${oneLineArtifact(join(workspace, 'GOAL.md'))} and draft an implementation plan and its executable gate.json for it.`,
      ...(feedback ? [`Apply the required corrections in ${oneLineArtifact(join(workspace, 'FEEDBACK.md'))}.`] : []),
      ...(failedPlan ? [`${oneLineArtifact(join(workspace, 'FAILED_PLAN.md'))} holds a discarded framing; choose a genuinely different strategy.`] : []),
      'Every cited path and line must already exist in the target; verify each citation by reading before citing.',
      'Reply in plain chat text, not a plan tool artifact.',
      'Return exactly <PLAN_MD>...markdown...</PLAN_MD> then <GATE_JSON>[...]</GATE_JSON> and no prose outside them.',
    ].join(' ');
    const result = await runVerifier({
      cwd: target, prompt, model: verifierModel, timeoutMs, pass: 'plan', env, home, superpowersDir,
    });
    const artifact = parseDraftArtifact(`${result.findings ?? ''}\n${result.plan ?? ''}`);
    return { ...artifact, usage: result.usage };
  });
}

async function productionCursorReview({
  goal, plan, gate, round, target, verifierModel, timeoutMs, env, home, superpowersDir,
}) {
  return withSeatWorkspace({
    'GOAL.md': `${goal}\n`,
    'PROPOSAL.md': `${plan}\n`,
    'PROPOSED_GATE.json': `${JSON.stringify(gate, null, 2)}\n`,
  }, async (workspace) => {
    const prompt = [
      '# Cursor plan review seat',
      `Read the raw goal from ${oneLineArtifact(join(workspace, 'GOAL.md'))} and the proposed plan from ${oneLineArtifact(join(workspace, 'PROPOSAL.md'))} with its gate ${oneLineArtifact(join(workspace, 'PROPOSED_GATE.json'))}.`,
      'Judge independently whether the plan achieves the goal; explore the target repository for real evidence.',
      `ROUND ${round}.`,
      'Respond in plain chat text, in exactly this structure and nothing else:',
      'AGREE: yes or AGREE: no.',
      'Then zero or more suggestion lines, one per line, formatted: S<id> P0: description (or P1, P2 — your judgement of priority; nothing mechanical acts on it).',
      'Reuse the same S<id> for a suggestion you have raised in an earlier round so recurrence is visible.',
      'Then zero or more question lines formatted: Q<id>: question.',
      'AGREE: yes means you are satisfied the plan achieves the goal and you could work from it as written.',
    ].join(' ');
    const result = await runVerifier({
      cwd: target, prompt, model: verifierModel, timeoutMs, pass: 'plan', env, home, superpowersDir,
    });
    if (result.launchFailed || result.timedOut) {
      return { agree: false, readable: false, suggestions: [], questions: [], content: '', unavailable: true, usage: result.usage };
    }
    return { ...parseSeatReview(`${result.findings ?? ''}\n${result.plan ?? ''}`), usage: result.usage };
  });
}

async function productionCodexReview({
  goal, plan, gate, round, target, plannerModel, timeoutMs, runId, env,
}) {
  const result = await runExecutor({
    plan: reviewSeatPrompt({ seat: 'Codex', goal, plan, gate, round }),
    cwd: target,
    model: plannerModel,
    sandbox: 'read-only',
    timeoutMs,
    runId,
    env,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    return { agree: false, readable: false, suggestions: [], questions: [], content: '', unavailable: true, usage: result.usage };
  }
  return { ...parseSeatReview(result.lastMessage), usage: result.usage };
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
    // No mechanical gate judges a candidate. Drafting is the only thing that can
    // fail here; every drafted plan reaches the selection seat, which judges.
    // gateResult keeps its shape because run.js facts and the dashboard read it.
    if (artifact) gateResult = { passed: true, failures: [] };
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

  // Seat wiring. Injecting `draft` marks a hermetic test: production seats then
  // stay out unless explicitly supplied, so a unit test can never launch a CLI.
  const draftCodex = adapters.draft ?? productionDraft;
  const hermetic = adapters.draft !== undefined;
  const draftCursor = adapters.cursorDraft ?? (hermetic ? null : productionCursorDraft);
  const reviewCursor = adapters.review ?? (hermetic ? null : productionCursorReview);
  const reviewCodex = adapters.codexReview ?? (hermetic ? null : productionCodexReview);
  const runArbiterSeat = adapters.runArbiter ?? (hermetic ? null : runArbiter);
  const checkCapability = adapters.checkCapability
    ?? adapters.capabilityCheck
    ?? (hermetic || adapters.review !== undefined ? null : productionCapability);
  const ledger = new DebateLedger();
  // Every seat call adds its usage here, so a plan that never converges still
  // reports what it spent. The taxi meter runs whether or not you arrive.
  let usageTotal = EMPTY_USAGE;
  const tallyUsage = (value) => { if (value?.usage) usageTotal = addUsage(usageTotal, value.usage); return value; };
  let pivotCount = 0;
  const pivotHistory = [];
  const capabilityHistory = [];
  const stormHistory = [];
  const roundHistory = [];

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
    return tallyUsage(result);
  };

  const finish = (reason, round, extra = {}) => {
    const converged = reason === 'converged';
    const result = {
      runId,
      dryRun: false,
      converged,
      reason,
      rounds: round,
      target: request.target,
      out: request.out,
      storm: stormHistory,
      roundHistory,
      capabilityVetoes: capabilityHistory,
      pivotHistory,
      tokens: { total: { ...usageTotal } },
      ...extra,
    };
    reportEvent(reporter, runId, 'plan', 'finish', {
      converged, reason, rounds: round,
      ...(extra.pivot === undefined ? {} : { pivot: extra.pivot }),
    });
    return result;
  };

  const failureMessage = (error) => (error instanceof Error ? error.message : String(error));

  // All three seats draft independently from the SAME raw goal - never from a
  // paraphrase, so their takes stay uncorrelated.
  const stormOnce = async ({ round, feedback, failedPlan }) => {
    const attempts = await Promise.all([
      (async () => {
        try {
          const input = draftingPrompt({
            goal: request.goal, round, previousPlan: '', feedback, pivot: '', failedPlan,
          });
          const artifact = normalizeDraft(await draftCodex({
            input, goal: request.goal, target: request.target, out: request.out, round,
            plannerModel, sandbox: 'read-only', timeoutMs: executorTimeout, runId, env,
          }));
          tallyUsage(artifact);
          return { seat: 'codex', ...artifact };
        } catch (error) { return { seat: 'codex', error: failureMessage(error) }; }
      })(),
      (async () => {
        if (typeof draftCursor !== 'function') return { seat: 'cursor', error: 'cursor drafting seat unavailable' };
        try {
          const artifact = normalizeDraft(await draftCursor({
            goal: request.goal, target: request.target, round, verifierModel,
            timeoutMs: verifierTimeout, runId, env, home,
            superpowersDir: cursorSuperpowersDir, feedback, failedPlan,
          }));
          tallyUsage(artifact);
          return { seat: 'cursor', ...artifact };
        } catch (error) { return { seat: 'cursor', error: failureMessage(error) }; }
      })(),
      (async () => {
        const response = await arbitrate({
          type: 'draft', goal: request.goal, feedback, failedPlan,
        });
        if (!response || response.verdict === ARBITER_UNVERIFIED
          || response.launchFailed || response.timedOut) {
          return { seat: 'claude', error: 'claude drafting seat unavailable' };
        }
        try {
          const text = typeof response === 'string' ? response : response.answer ?? response;
          return { seat: 'claude', ...normalizeDraft(text) };
        } catch (error) { return { seat: 'claude', error: failureMessage(error) }; }
      })(),
    ]);
    reportEvent(reporter, runId, 'plan', 'storm', {
      planRound: round,
      drafts: attempts.map(({ seat, error }) => ({ seat, ok: !error, ...(error ? { error } : {}) })),
    });
    stormHistory.push({
      round,
      drafts: attempts.map(({ seat, error }) => ({ seat, ok: !error, ...(error ? { error } : {}) })),
    });
    return attempts;
  };

  const normalizeSeatReview = (value) => {
    if (typeof value === 'string') return parseSeatReview(value);
    if (value && typeof value === 'object' && typeof value.agree === 'boolean') {
      return {
        readable: true,
        suggestions: [],
        questions: [],
        content: '',
        ...value,
      };
    }
    return parseSeatReview(String(value?.content ?? ''));
  };

  const unavailableReview = () => ({
    agree: false, readable: false, suggestions: [], questions: [], content: '', unavailable: true,
  });

  const reviewBoth = async ({ round, proposal, gate }) => {
    const [codex, cursor] = await Promise.all([
      (async () => {
        if (typeof reviewCodex !== 'function') return unavailableReview();
        try {
          return normalizeSeatReview(tallyUsage(await reviewCodex({
            goal: request.goal, plan: proposal, gate, round,
            target: request.target, plannerModel, timeoutMs: executorTimeout, runId, env,
          })));
        } catch { return unavailableReview(); }
      })(),
      (async () => {
        if (typeof reviewCursor !== 'function') return unavailableReview();
        try {
          return normalizeSeatReview(tallyUsage(await reviewCursor({
            goal: request.goal, plan: proposal, gate, round,
            target: request.target, verifierModel, timeoutMs: verifierTimeout,
            env, home, superpowersDir: cursorSuperpowersDir,
          })));
        } catch { return unavailableReview(); }
      })(),
    ]);
    for (const [seat, review] of [['codex', codex], ['cursor', cursor]]) {
      reportEvent(reporter, runId, 'plan', 'review', {
        planRound: round,
        seat,
        agree: review.agree === true,
        readable: review.readable !== false,
        suggestionIds: review.suggestions.map((item) => item.id),
        questionCount: review.questions.length,
        ...(review.unavailable ? { unavailable: true } : {}),
      });
    }
    return { codex, cursor };
  };

  let stormDrafts = null;
  let reStorm = true;
  let feedback = '';
  let failedPlan = '';
  let previousProposal = '';
  let openQuestions = [];
  let round = 0;

  for (round = 1; rounds === undefined || round <= rounds; round++) {
    if (reStorm) {
      stormDrafts = await stormOnce({ round, feedback, failedPlan });
      reStorm = false;
      if (stormDrafts.every((attempt) => attempt.error)) {
        // Nothing was drafted, so there is nothing to talk about. This is
        // inability, not a mechanical verdict on any plan.
        return finish('storm-exhausted', round);
      }
    }

    const proposeResponse = await arbitrate({
      type: 'propose',
      goal: request.goal,
      drafts: stormDrafts.filter((attempt) => !attempt.error)
        .map(({ seat, plan, gate }) => ({ seat, plan, gate })),
      feedback,
      questions: openQuestions,
      previousProposal,
    });
    let proposal = null;
    if (proposeResponse && proposeResponse.verdict !== ARBITER_UNVERIFIED
      && !proposeResponse.launchFailed && !proposeResponse.timedOut) {
      try {
        const text = typeof proposeResponse === 'string'
          ? proposeResponse
          : proposeResponse.answer ?? proposeResponse;
        proposal = normalizeDraft(text);
      } catch { proposal = null; }
    }
    reportEvent(reporter, runId, 'plan', 'proposal', {
      planRound: round, ok: proposal !== null,
    });
    if (proposal === null) {
      // The collating seat did not produce a proposal. A seat that did not run
      // cannot be substituted by a rule, so the round cannot proceed.
      return finish('arbiter-unavailable', round);
    }
    previousProposal = proposal.plan;

    const reviews = await reviewBoth({ round, proposal: proposal.plan, gate: proposal.gate });
    openQuestions = [
      ...reviews.codex.questions.map((question) => ({ seat: 'codex', ...question })),
      ...reviews.cursor.questions.map((question) => ({ seat: 'cursor', ...question })),
    ];

    const agreementResponse = await arbitrate({
      type: 'agreement',
      goal: request.goal,
      proposal: proposal.plan,
      gate: proposal.gate,
      reviews: {
        codex: {
          agree: reviews.codex.agree,
          suggestions: reviews.codex.suggestions,
          questions: reviews.codex.questions,
          content: reviews.codex.content,
        },
        cursor: {
          agree: reviews.cursor.agree,
          suggestions: reviews.cursor.suggestions,
          questions: reviews.cursor.questions,
          content: reviews.cursor.content,
        },
      },
    });
    const agreement = parseAgreementJudgement(agreementResponse);
    reportEvent(reporter, runId, 'plan', 'agreement', {
      planRound: round,
      converged: agreement.verdict === 'answered' && agreement.converged === true,
      unjudged: agreement.verdict !== 'answered',
      ...(agreement.reason ? { reason: agreement.reason } : {}),
    });

    // Convergence is three seats actually agreeing. Silence, an unreadable
    // response, or an absent seat is not agreement; an overruled objection does
    // not exist here at all - Claude persuades through feedback, never outvotes.
    const seatsAgree = reviews.codex.agree === true && reviews.cursor.agree === true;
    const converged = seatsAgree
      && agreement.verdict === 'answered'
      && agreement.converged === true;

    const suggestionIds = [
      ...reviews.codex.suggestions.map((item) => `codex-${item.id}`),
      ...reviews.cursor.suggestions.map((item) => `cursor-${item.id}`),
    ];
    ledger.record(round, suggestionIds);
    roundHistory.push({
      round,
      reviews: {
        codex: {
          agree: reviews.codex.agree,
          readable: reviews.codex.readable !== false,
          suggestions: reviews.codex.suggestions,
          questions: reviews.codex.questions,
          ...(reviews.codex.unavailable ? { unavailable: true } : {}),
        },
        cursor: {
          agree: reviews.cursor.agree,
          readable: reviews.cursor.readable !== false,
          suggestions: reviews.cursor.suggestions,
          questions: reviews.cursor.questions,
          ...(reviews.cursor.unavailable ? { unavailable: true } : {}),
        },
      },
      agreement,
      converged,
    });
    reportEvent(reporter, runId, 'plan', 'round', {
      planRound: round,
      suggestionIds,
      codexAgrees: reviews.codex.agree === true,
      cursorAgrees: reviews.cursor.agree === true,
      converged,
    });

    if (converged) {
      const vetoes = await capabilityVetoes({
        plan: proposal.plan,
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
        feedback = vetoFeedback(vetoes);
        continue;
      }
      const paths = writeArtifacts(request.out, proposal.plan, proposal.gate);
      reportEvent(reporter, runId, 'plan', 'converged', {
        planRound: round,
        suggestions: suggestionIds.length,
      });
      return finish('converged', round, paths);
    }

    // Claude's feedback leads; the seats' own words follow verbatim so the next
    // proposal answers them rather than a summary of them.
    feedback = [
      agreement.feedback || '',
      ...['codex', 'cursor'].flatMap((seat) => reviews[seat].suggestions.map(
        (item) => `${seat} ${item.id} ${item.severity}: ${item.text}`,
      )),
    ].filter(Boolean).join('\n');

    if (detectCircling(ledger)) {
      const pivotJudgement = parsePivotJudgement(await arbitrate({
        type: 'pivot',
        ledger: Array.from({ length: ledger.currentRound }, (_, index) => ({
          round: index + 1, findingIds: ledger.round(index + 1),
        })),
        recurringFindings: suggestionIds.filter((id) => ledger.stuckFindings().has(id)),
        attempted: pivotHistory,
        plan: proposal.plan,
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
        return finish('pivot-conclude', round, { pivot: PIVOT_CONCLUDE });
      }
      if (decision === PIVOT_FRESH) {
        reStorm = true;
        failedPlan = proposal.plan;
        previousProposal = '';
        openQuestions = [];
        feedback = '';
      } else {
        feedback = `${feedback}\nAmend the approach specifically to break the recurring suggestions.`;
      }
    }
  }

  return finish('rounds-exhausted', round - 1);
}
