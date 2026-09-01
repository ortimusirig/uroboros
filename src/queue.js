import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { assertPlanOutputAvailable, resolveGoal } from './plan.js';

const QUEUE_UNIT_KEYS = new Set(['name', 'task', 'gate', 'goal', 'out']);
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

function addTokens(total, next) {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    total: total.total + next.total,
  };
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

function evaluateFacts(facts) {
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

  // review-ready IS the seats' agreement: the debate converged with no
  // accepted blocking finding under the arbiter's judgement, and the
  // reviewer's report plus the evidence trail travel in the facts for any
  // reader who wants them. Nothing here re-decides.
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

export async function runQueue({
  file,
  target,
  mode = 'manual',
  maxRuns,
  tokenBudget,
  dryRun = false,
  dependencies = {},
}) {
  if (!QUEUE_MODES.has(mode)) {
    throw new TypeError(`invalid queue mode: ${mode}; expected manual or autonomous`);
  }
  const queue = loadQueueFile(file);
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
  const appendLog = dependencies.appendLog ?? appendQueueLog;
  const now = dependencies.now ?? (() => Date.now());

  await assertCleanTarget(target, { allowedPaths: [queue.logPath] });

  let attemptedCount = 0;
  let landedCount = 0;
  let totalTokens = zeroTokens;
  let stop = null;
  const assumedDecisions = [];
  const allowedQueuePaths = [queue.logPath];

  for (const unit of queue.units) {
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
        planResult = await launchPlan({ unit, target: resolve(target) });
        // The taxi meter runs whether or not you arrive: planning spend counts
        // on every path, not only when a unit lands.
        const planTokenReading = factTokens(planResult);
        if (planTokenReading.valid) totalTokens = addTokens(totalTokens, planTokenReading.tokens);
        planTokens = planTokenReading.valid ? planTokenReading.tokens : zeroTokens;
        if (planResult?.converged !== true) {
          const durationMs = Math.max(0, now() - startedAt);
          const reason = `plan did not converge: ${planResult?.reason ?? 'unknown reason'}`;
          stop = {
            kind: 'plan-not-converged',
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
            planConverged: false,
            planOutcome: planResult?.reason ?? 'unknown',
            implementationOutcome: null,
            tokens: planTokens,
            durationMs,
            landed: false,
            stoppedOn: true,
            stopReason: reason,
          });
          break;
        }
        implementationUnit = {
          ...unit,
          task: planResult.planPath ?? join(unit.out, 'plan.md'),
          gate: planResult.gatePath ?? join(unit.out, 'gate.json'),
        };
        allowedQueuePaths.push(implementationUnit.task, implementationUnit.gate);
      }
      launch = await launchRun({ unit: implementationUnit, target: resolve(target), mode });
      facts = await readRunFacts(launch);
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
    const evaluation = tokenReading.valid
      ? evaluateFacts(facts)
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
    if (evaluation.action === 'land') {
      try {
        await landDiff({
          target: resolve(target),
          diffPath: join(launch.runDirectory, 'CHANGES.diff'),
          unit,
          runId: facts?.runId ?? launch?.runId ?? 'unknown',
          allowedDirtyPaths: allowedQueuePaths,
        });
        landed = true;
        landedCount++;
      } catch (error) {
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

    appendLog(queue.logPath, {
      name: unit.name,
      runId: facts?.runId ?? launch?.runId ?? null,
      outcome: facts?.outcome ?? null,
      findingsLastRound: (facts?.debate?.roundHistory?.at(-1)?.findings ?? []).length,
      tokens,
      durationMs,
      landed,
      stoppedOn: stop !== null,
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
        planOutcome: planResult?.reason ?? null,
        implementationOutcome: facts?.outcome ?? null,
      } : {}),
    });

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

  const remaining = queue.units.length - attemptedCount;
  return {
    dryRun: false,
    attemptedCount,
    landedCount,
    remaining,
    totalTokens,
    stop,
    assumedDecisions,
    summary: formatQueueSummary({
      units: queue.units,
      landedCount,
      stop,
      remaining,
      totalTokens,
      assumedDecisions,
    }),
  };
}
