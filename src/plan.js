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
import { reportEvent } from './events.js';
import { runExecutor } from './executor.js';
import { runPlanGate } from './plan-gate.js';
import { parseReview } from './review.js';
import { resolveStageTimeouts } from './timeouts.js';
import { runVerifier } from './verifier.js';

export const DEFAULT_PLAN_ROUNDS = 3;

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

function draftingPrompt({ goal, round, previousPlan, feedback, pivot }) {
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
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`planner seat exited ${result.exitCode}${result.timedOut ? ' after timing out' : ''}`);
  }
  return { ...parseDraftArtifact(result.lastMessage), usage: result.usage };
}

function oneLineArtifact(text) {
  return String(text).replaceAll('"', "'")
    .replace(/[\r\n]+/g, ' [newline] ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function productionReview({ plan, gate, target, verifierModel, timeoutMs }) {
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
  });
  return { content: result.findings ?? '', verdict: result.verdict, usage: result.usage };
}

function normalizeDraft(value) {
  if (value && typeof value === 'object' && typeof value.plan === 'string') {
    let gate = value.gate;
    if (typeof gate === 'string') gate = JSON.parse(gate);
    return { ...value, plan: value.plan.endsWith('\n') ? value.plan : `${value.plan}\n`, gate };
  }
  return parseDraftArtifact(value);
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
  rounds = DEFAULT_PLAN_ROUNDS,
  plannerModel,
  verifierModel,
  gateTimeout = resolveStageTimeouts().gate,
  executorTimeout = resolveStageTimeouts().executor,
  verifierTimeout = resolveStageTimeouts().verifier,
  dryRun = false,
  runId = `plan-${randomUUID()}`,
  reporter,
  baseDirectory = process.cwd(),
  adapters = {},
} = {}) {
  if (!Number.isSafeInteger(rounds) || rounds < 1) throw new TypeError('rounds must be a positive integer');
  const request = validatePlanRequest({ goal, target, out, baseDirectory });
  reportEvent(reporter, runId, 'plan', 'start', {
    target: request.target, out: request.out, rounds, goalSource: request.goalSource,
  });
  if (dryRun) {
    const result = { runId, dryRun: true, converged: false, rounds: 0, target: request.target, out: request.out };
    reportEvent(reporter, runId, 'plan', 'finish', { dryRun: true, converged: false, rounds: 0 });
    return result;
  }

  const draft = adapters.draft ?? productionDraft;
  const reviewPlan = adapters.review ?? productionReview;
  const checkGate = adapters.runPlanGate ?? runPlanGate;
  const ledger = new DebateLedger();
  let previousPlan = '';
  let feedback = '';
  let pivotInstruction = '';
  let pivotCount = 0;
  let lastGate = null;

  for (let round = 1; round <= rounds; round++) {
    const input = draftingPrompt({
      goal: request.goal,
      round,
      previousPlan,
      feedback,
      pivot: pivotInstruction,
    });
    let artifact;
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
      }));
    } catch (error) {
      artifact = {
        plan: previousPlan,
        gate: null,
        draftFailure: `planner artifacts are invalid: ${error?.message ?? String(error)}`,
      };
    }
    const gateResult = artifact.draftFailure
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
    ledger.record(round, findings.map((finding) => finding.id));
    reportEvent(reporter, runId, 'plan', 'round', {
      planRound: round,
      gatePassed: gateResult.passed === true,
      reviewed,
      findingIds: findings.map((finding) => finding.id),
      blockingFindingIds: blocking.map((finding) => finding.id),
    });

    if (gateResult.passed === true && blocking.length === 0) {
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
        ...paths,
      };
      reportEvent(reporter, runId, 'plan', 'finish', {
        converged: true, reason: result.reason, rounds: round,
      });
      return result;
    }

    const validation = validateFindings(blocking);
    feedback = buildFixPlan({
      findings: blocking,
      accepted: validation.accepted,
      rejected: validation.rejected,
      originalTask: request.goal,
    });
    previousPlan = artifact.plan;
    pivotInstruction = '';
    if (detectCircling(ledger)) {
      const decision = shouldPivot(pivotCount++);
      if (decision === PIVOT_CONCLUDE) {
        const result = {
          runId, dryRun: false, converged: false, reason: 'pivot-conclude', rounds: round,
          target: request.target, out: request.out, gate: lastGate,
        };
        reportEvent(reporter, runId, 'plan', 'finish', {
          converged: false, reason: result.reason, rounds: round, pivot: decision,
        });
        return result;
      }
      if (decision === PIVOT_FRESH) previousPlan = '';
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
  };
  reportEvent(reporter, runId, 'plan', 'finish', {
    converged: false, reason: result.reason, rounds,
  });
  return result;
}
