import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';
import { runQueue } from '../src/queue.js';

function makeFixture(count = 3) {
  const directory = mkdtempSync(join(process.cwd(), '.ccc-test-queue-'));
  const target = join(directory, 'target');
  mkdirSync(target);
  const units = [];
  for (let index = 0; index < count; index++) {
    const number = index + 1;
    const task = `plan-${number}.md`;
    const gate = `gate-${number}.json`;
    writeFileSync(join(directory, task), `# Plan ${number}\n`);
    writeFileSync(join(directory, gate), '{}\n');
    units.push({ name: `unit-${number}`, task, gate });
  }
  const file = join(directory, 'queue.json');
  writeFileSync(file, JSON.stringify(units));
  return {
    directory,
    file,
    target,
    units,
    logPath: join(directory, 'queue-log.jsonl'),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function reviewReady(runId, overrides = {}) {
  return {
    runId,
    outcome: 'review-ready',
    gateStatus: 'passed',
    correctnessVerdict: 'NO_BLOCKERS',
    intentVerdict: 'NO_BLOCKERS',
    tokens: { total: { inputTokens: 3, outputTokens: 2 } },
    ...overrides,
  };
}

function fakeRuntime(facts, overrides = {}) {
  const launches = [];
  const landings = [];
  const judgements = [];
  const directories = new Map();
  return {
    launches,
    landings,
    judgements,
    dependencies: {
      assertCleanTarget: async () => {},
      // Tests declare their world: the default final review approves so
      // landing-mechanics tests stay focused; refusal and unavailability
      // are exercised explicitly below.
      judgeLanding: async (request) => {
        judgements.push(request);
        return { approved: true, reasoning: 'reviewed first-hand in fixture' };
      },
      launchRun: async (request) => {
        const index = launches.length;
        launches.push(request);
        const runDirectory = `run-directory-${index + 1}`;
        directories.set(runDirectory, facts[index]);
        return { runDirectory };
      },
      readRunFacts: async ({ runDirectory }) => directories.get(runDirectory),
      landDiff: async (request) => {
        landings.push(request);
        return { commit: `commit-${landings.length}`, paths: [`file-${landings.length}.js`] };
      },
      ...overrides,
    },
  };
}

function readLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function makeGoalFixture(unit = {
  name: 'goal-unit', goal: 'Implement the planned behavior', out: 'generated/goal-unit',
}) {
  const directory = mkdtempSync(join(process.cwd(), '.ccc-test-goal-queue-'));
  const target = join(directory, 'target');
  mkdirSync(target);
  const file = join(directory, 'queue.json');
  writeFileSync(file, JSON.stringify([unit]));
  return {
    directory, target, file, logPath: join(directory, 'queue-log.jsonl'),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('a goal unit converges its plan before launching and landing implementation', async () => {
  const fixture = makeGoalFixture();
  const planLaunches = [];
  const runtime = fakeRuntime([reviewReady('run-goal')], {
    launchPlan: async (request) => {
      planLaunches.push(request);
      return {
        converged: true, rounds: 2, reason: 'converged',
        planPath: join(request.unit.out, 'plan.md'),
        gatePath: join(request.unit.out, 'gate.json'),
      };
    },
  });
  try {
    const result = await runQueue({
      file: fixture.file, target: fixture.target, dependencies: runtime.dependencies,
    });
    assert.equal(planLaunches.length, 1);
    assert.equal(runtime.launches.length, 1);
    assert.match(runtime.launches[0].unit.task, /generated[\\/]goal-unit[\\/]plan[.]md$/);
    assert.match(runtime.launches[0].unit.gate, /generated[\\/]goal-unit[\\/]gate[.]json$/);
    assert.equal(runtime.landings.length, 1);
    assert.ok(runtime.landings[0].allowedDirtyPaths.includes(runtime.launches[0].unit.task));
    assert.ok(runtime.landings[0].allowedDirtyPaths.includes(runtime.launches[0].unit.gate));
    assert.equal(result.landedCount, 1);
    const log = readLog(fixture.logPath)[0];
    assert.deepEqual({
      planRounds: log.planRounds,
      planConverged: log.planConverged,
      implementationOutcome: log.implementationOutcome,
    }, { planRounds: 2, planConverged: true, implementationOutcome: 'review-ready' });
  } finally { fixture.cleanup(); }
});

test('a non-converged goal plan stops before implementation starts', async () => {
  const fixture = makeGoalFixture();
  let runLaunches = 0;
  try {
    const result = await runQueue({
      file: fixture.file,
      target: fixture.target,
      dependencies: {
        assertCleanTarget: async () => {},
        launchPlan: async () => ({
          converged: false, rounds: 3, reason: 'rounds-exhausted',
          tokens: { total: { inputTokens: 120_000, outputTokens: 8_000 } },
        }),
        launchRun: async () => { runLaunches++; },
      },
    });
    assert.equal(runLaunches, 0);
    assert.equal(result.stop.kind, 'plan-not-converged');
    const log = readLog(fixture.logPath)[0];
    assert.equal(log.planRounds, 3);
    assert.equal(log.planConverged, false);
    assert.equal(log.implementationOutcome, null);
    // The taxi meter runs whether or not you arrive: a failed plan's spend is
    // real spend. Reported as zero, an operator cannot see what planning cost.
    assert.deepEqual(log.tokens,
      { inputTokens: 120_000, outputTokens: 8_000, total: 128_000 });
    assert.equal(result.totalTokens.total, 128_000,
      'the queue summary must include planning spend from unconverged units');
  } finally { fixture.cleanup(); }
});

test('queue rejects units carrying both shapes or neither before anything starts', async () => {
  for (const unit of [
    { name: 'both', task: 'plan.md', gate: 'gate.json', goal: 'Do work', out: 'generated' },
    { name: 'neither' },
  ]) {
    const fixture = makeGoalFixture(unit);
    let starts = 0;
    try {
      await assert.rejects(runQueue({
        file: fixture.file,
        target: fixture.target,
        dependencies: {
          assertCleanTarget: async () => { starts++; },
          launchPlan: async () => { starts++; },
          launchRun: async () => { starts++; },
        },
      }), /either task\+gate or goal\+out/);
      assert.equal(starts, 0);
    } finally { fixture.cleanup(); }
  }
});

test('goal-unit dry-run validates output and starts no plan or implementation', async () => {
  const fixture = makeGoalFixture();
  let starts = 0;
  try {
    const result = await runQueue({
      file: fixture.file,
      target: fixture.target,
      dryRun: true,
      dependencies: {
        assertCleanTarget: async () => { starts++; },
        launchPlan: async () => { starts++; },
        launchRun: async () => { starts++; },
      },
    });
    assert.equal(starts, 0);
    assert.match(result.summary, /goal: Implement the planned behavior/);
    assert.match(result.summary, /out: .*generated[\\/]goal-unit/);
    assert.equal(existsSync(join(fixture.directory, 'generated', 'goal-unit')), false);
  } finally { fixture.cleanup(); }
});

test('goal-unit dry-run refuses an output that would overwrite plan.md', async () => {
  const fixture = makeGoalFixture();
  try {
    const out = join(fixture.directory, 'generated', 'goal-unit');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'plan.md'), 'existing plan\n');
    let starts = 0;
    await assert.rejects(runQueue({
      file: fixture.file,
      target: fixture.target,
      dryRun: true,
      dependencies: {
        launchPlan: async () => { starts++; },
        launchRun: async () => { starts++; },
      },
    }), /refusing to overwrite.*plan[.]md/i);
    assert.equal(starts, 0);
  } finally { fixture.cleanup(); }
});

test('three approved units land in order and the summary reports all three', async () => {
  const fixture = makeFixture();
  try {
    const runtime = fakeRuntime([
      reviewReady('run-1'),
      reviewReady('run-2'),
      reviewReady('run-3'),
    ]);

    const result = await runQueue({
      file: fixture.file,
      target: fixture.target,
      dependencies: runtime.dependencies,
    });

    assert.deepEqual(runtime.launches.map(({ unit }) => unit.name), ['unit-1', 'unit-2', 'unit-3']);
    assert.deepEqual(runtime.landings.map(({ unit }) => unit.name), ['unit-1', 'unit-2', 'unit-3']);
    assert.equal(result.landedCount, 3);
    assert.equal(result.stop, null);
    assert.match(result.summary, /Units landed: 3/);
    assert.equal(readLog(fixture.logPath).length, 3);
  } finally {
    fixture.cleanup();
  }
});

test('stray verdict-era fields are inert at landing', async () => {
  // The verdict fields died in the review collapse: a run that converged IS
  // the seats' agreement, and no leftover field re-decides it at landing.
  const fixture = makeFixture();
  try {
    const runtime = fakeRuntime([
      reviewReady('run-1'),
      reviewReady('run-2', { correctnessVerdict: 'ISSUES', intentVerdict: 'UNVERIFIED' }),
      reviewReady('run-3'),
    ]);

    const result = await runQueue({
      file: fixture.file,
      target: fixture.target,
      dependencies: runtime.dependencies,
    });

    assert.equal(runtime.launches.length, 3);
    assert.deepEqual(runtime.landings.map(({ unit }) => unit.name),
      ['unit-1', 'unit-2', 'unit-3']);
    assert.equal(result.stop, null);
  } finally {
    fixture.cleanup();
  }
});

test('needs-decision stops the queue and records its questions', async () => {
  const fixture = makeFixture();
  const questions = [{ id: 'Q1', kind: 'product', question: 'Which copy?' }];
  try {
    const runtime = fakeRuntime([
      reviewReady('run-1'),
      reviewReady('run-2', {
        outcome: 'needs-decision',
        gateStatus: 'not-run',
        correctnessVerdict: null,
        intentVerdict: null,
        decision: { questions },
      }),
      reviewReady('run-3'),
    ]);

    const result = await runQueue({
      file: fixture.file,
      target: fixture.target,
      dependencies: runtime.dependencies,
    });

    assert.equal(runtime.launches.length, 2);
    assert.equal(runtime.landings.length, 1);
    assert.equal(result.stop.outcome, 'needs-decision');
    assert.deepEqual(result.stop.questions, questions);
    assert.deepEqual(readLog(fixture.logPath)[1].questions, questions);
  } finally {
    fixture.cleanup();
  }
});

test('gate-failed stops without attempting to apply the failed unit', async () => {
  const fixture = makeFixture();
  try {
    const runtime = fakeRuntime([
      reviewReady('run-1'),
      reviewReady('run-2', {
        outcome: 'gate-failed',
        gateStatus: 'failed',
        correctnessVerdict: null,
        intentVerdict: null,
      }),
      reviewReady('run-3'),
    ]);

    const result = await runQueue({
      file: fixture.file,
      target: fixture.target,
      dependencies: runtime.dependencies,
    });

    assert.equal(runtime.launches.length, 2);
    assert.equal(runtime.landings.length, 1);
    assert.match(result.stop.reason, /outcome gate-failed/);
  } finally {
    fixture.cleanup();
  }
});

test('landing consults the seats only; no gate field exists to re-check', async () => {
  // The gate verdict is gone. A stale gateStatus key in the facts is inert —
  // landing is the seats' recorded agreement and nothing else.
  const fixture = makeFixture();
  try {
    const runtime = fakeRuntime([
      reviewReady('run-1', { gateStatus: 'failed' }),
      reviewReady('run-2'),
      reviewReady('run-3'),
    ]);

    const result = await runQueue({
      file: fixture.file,
      target: fixture.target,
      dependencies: runtime.dependencies,
    });

    assert.equal(runtime.landings.length, 3, 'clean verdicts land; a stray field cannot veto');
    assert.equal(result.stop, null);
  } finally {
    fixture.cleanup();
  }
});

test('max-runs stops after one landed unit with two remaining', async () => {
  const fixture = makeFixture();
  try {
    const runtime = fakeRuntime([
      reviewReady('run-1'),
      reviewReady('run-2'),
      reviewReady('run-3'),
    ]);

    const result = await runQueue({
      file: fixture.file,
      target: fixture.target,
      maxRuns: 1,
      dependencies: runtime.dependencies,
    });

    assert.equal(runtime.launches.length, 1);
    assert.equal(runtime.landings.length, 1);
    assert.equal(result.stop.kind, 'max-runs');
    assert.equal(result.remaining, 2);
    assert.match(result.summary, /Stopped before unit-2: max-runs limit 1 reached/);
    assert.match(result.summary, /2 remaining/);
  } finally {
    fixture.cleanup();
  }
});

test('token budget forecasts the next unit and never interrupts an in-flight unit', async () => {
  const fixture = makeFixture();
  try {
    const runtime = fakeRuntime([
      reviewReady('run-1', { tokens: { total: { inputTokens: 4, outputTokens: 3 } } }),
      reviewReady('run-2', { tokens: { total: { inputTokens: 4, outputTokens: 3 } } }),
      reviewReady('run-3'),
    ]);

    const result = await runQueue({
      file: fixture.file,
      target: fixture.target,
      tokenBudget: 10,
      dependencies: runtime.dependencies,
    });

    assert.equal(runtime.launches.length, 1);
    assert.equal(runtime.landings.length, 1, 'the completed in-flight unit must still be landed');
    assert.equal(result.totalTokens.total, 7);
    assert.equal(result.stop.kind, 'token-budget');
    assert.match(result.stop.reason, /7 \+ estimated 7.*10/);
  } finally {
    fixture.cleanup();
  }
});

test('a run that itself exceeds the token budget completes and lands before the queue stops', async () => {
  const fixture = makeFixture();
  try {
    const runtime = fakeRuntime([
      reviewReady('run-1', { tokens: { total: { inputTokens: 8, outputTokens: 5 } } }),
      reviewReady('run-2'),
      reviewReady('run-3'),
    ]);

    const result = await runQueue({
      file: fixture.file,
      target: fixture.target,
      tokenBudget: 10,
      dependencies: runtime.dependencies,
    });

    assert.equal(runtime.launches.length, 1);
    assert.equal(runtime.landings.length, 1);
    assert.equal(result.totalTokens.total, 13);
    assert.match(result.stop.reason, /exceeded.*13.*10/);
  } finally {
    fixture.cleanup();
  }
});

test('malformed token facts stop safely instead of weakening budget accounting', async () => {
  const fixture = makeFixture();
  try {
    const runtime = fakeRuntime([
      reviewReady('run-1', {
        tokens: { total: { inputTokens: 'unknown', outputTokens: 2 } },
      }),
      reviewReady('run-2'),
      reviewReady('run-3'),
    ]);

    const result = await runQueue({
      file: fixture.file,
      target: fixture.target,
      tokenBudget: 100,
      dependencies: runtime.dependencies,
    });

    assert.equal(runtime.launches.length, 1);
    assert.equal(runtime.landings.length, 0);
    assert.equal(result.stop.kind, 'token-accounting');
    assert.match(result.stop.reason, /invalid token accounting/);
    assert.equal(result.totalTokens.total, 0);
    assert.equal(readLog(fixture.logPath)[0].tokenAccounting, 'invalid');
  } finally {
    fixture.cleanup();
  }
});

test('non-object run facts stop safely, log the attempt, and launch no later unit', async () => {
  const fixture = makeFixture();
  try {
    const runtime = fakeRuntime([
      null,
      reviewReady('run-2'),
      reviewReady('run-3'),
    ]);

    const result = await runQueue({
      file: fixture.file,
      target: fixture.target,
      dependencies: runtime.dependencies,
    });

    assert.equal(runtime.launches.length, 1);
    assert.equal(runtime.landings.length, 0);
    assert.equal(result.stop.kind, 'token-accounting');
    assert.match(result.stop.reason, /invalid token accounting/);
    const log = readLog(fixture.logPath);
    assert.equal(log.length, 1);
    assert.equal(log[0].landed, false);
    assert.equal(log[0].stoppedOn, true);
  } finally {
    fixture.cleanup();
  }
});

test('dry-run resolves every path, starts nothing, writes no log, and spends no tokens', async () => {
  const fixture = makeFixture();
  try {
    let cleanChecks = 0;
    const runtime = fakeRuntime([], {
      assertCleanTarget: async () => { cleanChecks++; },
      launchRun: async () => { throw new Error('must not launch'); },
      landDiff: async () => { throw new Error('must not land'); },
    });

    const result = await runQueue({
      file: fixture.file,
      target: fixture.target,
      dryRun: true,
      dependencies: runtime.dependencies,
    });

    assert.equal(cleanChecks, 0);
    assert.equal(runtime.launches.length, 0);
    assert.equal(result.totalTokens.total, 0);
    assert.equal(existsSync(fixture.logPath), false);
    for (const unit of fixture.units) {
      assert.match(result.summary, new RegExp(resolve(fixture.directory, unit.task).replace(/[\\]/g, '\\\\')));
      assert.match(result.summary, new RegExp(resolve(fixture.directory, unit.gate).replace(/[\\]/g, '\\\\')));
    }
  } finally {
    fixture.cleanup();
  }
});

test('dry-run reports a missing task or gate as an error without launching', async () => {
  for (const missing of ['task', 'gate']) {
    const fixture = makeFixture(1);
    try {
      const path = missing === 'task'
        ? join(fixture.directory, fixture.units[0].task)
        : join(fixture.directory, fixture.units[0].gate);
      unlinkSync(path);
      let launches = 0;
      await assert.rejects(
        runQueue({
          file: fixture.file,
          target: fixture.target,
          dryRun: true,
          dependencies: {
            launchRun: async () => { launches++; },
          },
        }),
        new RegExp(`${missing} file does not exist`),
      );
      assert.equal(launches, 0);
    } finally {
      fixture.cleanup();
    }
  }
});

test('a diff check failure stops and leaves the target unchanged', async () => {
  const fixture = makeFixture();
  const sentinel = join(fixture.target, 'sentinel.txt');
  writeFileSync(sentinel, 'unchanged\n');
  try {
    const runtime = fakeRuntime([
      reviewReady('run-1'),
      reviewReady('run-2'),
      reviewReady('run-3'),
    ], {
      landDiff: async () => { throw new Error('diff does not apply cleanly'); },
    });

    const result = await runQueue({
      file: fixture.file,
      target: fixture.target,
      dependencies: runtime.dependencies,
    });

    assert.equal(runtime.launches.length, 1);
    assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged\n');
    assert.match(result.stop.reason, /diff does not apply cleanly/);
  } finally {
    fixture.cleanup();
  }
});

test('a dirty target is refused before any unit starts', async () => {
  const fixture = makeFixture();
  try {
    let launches = 0;
    await assert.rejects(runQueue({
      file: fixture.file,
      target: fixture.target,
      dependencies: {
        assertCleanTarget: async () => { throw new Error('target working tree is dirty'); },
        launchRun: async () => { launches++; },
      },
    }), /target working tree is dirty/);
    assert.equal(launches, 0);
    assert.equal(existsSync(fixture.logPath), false);
  } finally {
    fixture.cleanup();
  }
});

test('queue-log gains exactly one JSON line for every attempted unit', async () => {
  const fixture = makeFixture();
  writeFileSync(fixture.logPath, '{"previous":true}\n');
  try {
    const runtime = fakeRuntime([
      reviewReady('run-1'),
      reviewReady('run-2', { outcome: 'verifier-failed' }),
      reviewReady('run-3'),
    ]);

    await runQueue({
      file: fixture.file,
      target: fixture.target,
      dependencies: runtime.dependencies,
    });

    const lines = readLog(fixture.logPath);
    assert.equal(lines.length, 3);
    assert.equal(lines[0].previous, true);
    assert.deepEqual(lines.slice(1).map(({ runId }) => runId), ['run-1', 'run-2']);
  } finally {
    fixture.cleanup();
  }
});

test('the beside-queue log is the only dirty-path exception passed to landing', async () => {
  const fixture = makeFixture(1);
  try {
    const cleanChecks = [];
    const runtime = fakeRuntime([reviewReady('run-1')], {
      assertCleanTarget: async (target, request) => { cleanChecks.push({ target, request }); },
    });

    await runQueue({
      file: fixture.file,
      target: fixture.target,
      dependencies: runtime.dependencies,
    });

    assert.deepEqual(cleanChecks[0].request.allowedPaths, [fixture.logPath]);
    assert.deepEqual(runtime.landings[0].allowedDirtyPaths, [fixture.logPath]);
  } finally {
    fixture.cleanup();
  }
});

test('queue passes autonomous mode to every unit and defaults every unit to manual', async () => {
  for (const [requestedMode, expectedMode] of [[undefined, 'manual'], ['autonomous', 'autonomous']]) {
    const fixture = makeFixture();
    try {
      const runtime = fakeRuntime([
        reviewReady('run-1'),
        reviewReady('run-2'),
        reviewReady('run-3'),
      ]);
      await runQueue({
        file: fixture.file,
        target: fixture.target,
        ...(requestedMode === undefined ? {} : { mode: requestedMode }),
        dependencies: runtime.dependencies,
      });
      assert.deepEqual(runtime.launches.map(({ mode }) => mode), [expectedMode, expectedMode, expectedMode]);
    } finally {
      fixture.cleanup();
    }
  }
});

test('operator-absent assumed decisions land, remain visible in the log, and lead the summary', async () => {
  const fixture = makeFixture(1);
  const questions = [{ id: 'Q1', kind: 'authority', question: 'May the daemon proceed?' }];
  try {
    const runtime = fakeRuntime([
      reviewReady('run-1', {
        escalation: 'operator-absent',
        assumedDecision: { questions, answers: [{ id: 'Q1', answer: 'Proceed.' }] },
      }),
    ]);

    const result = await runQueue({
      file: fixture.file,
      target: fixture.target,
      mode: 'autonomous',
      dependencies: runtime.dependencies,
    });

    assert.equal(runtime.landings.length, 1);
    const line = readLog(fixture.logPath)[0];
    assert.equal(line.escalation, 'operator-absent');
    assert.deepEqual(line.questions, questions);
    assert.deepEqual(line.answers, [{ id: 'Q1', answer: 'Proceed.' }]);
    assert.ok(result.summary.indexOf('Decisions assumed while operator absent')
      < result.summary.indexOf('Units landed: 1'));
    assert.match(result.summary, /unit-1.*run-1/);
    assert.match(result.summary, /Q1: May the daemon proceed\?/);
    assert.match(result.summary, /Answer: Proceed[.]/);
  } finally {
    fixture.cleanup();
  }
});

test('positive control: when the first unit stops, the launcher is called exactly once', async () => {
  const fixture = makeFixture();
  try {
    const runtime = fakeRuntime([
      reviewReady('run-1', {
        outcome: 'gate-failed',
        gateStatus: 'failed',
        correctnessVerdict: null,
        intentVerdict: null,
      }),
      reviewReady('run-2'),
      reviewReady('run-3'),
    ]);

    await runQueue({
      file: fixture.file,
      target: fixture.target,
      dependencies: runtime.dependencies,
    });

    assert.equal(runtime.launches.length, 1);
    assert.equal(runtime.landings.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('an unnamed unit uses its task basename in commits and logs', async () => {
  const fixture = makeFixture(1);
  try {
    const declaration = JSON.parse(readFileSync(fixture.file, 'utf8'));
    delete declaration[0].name;
    writeFileSync(fixture.file, JSON.stringify(declaration));
    const runtime = fakeRuntime([reviewReady('run-1')]);

    await runQueue({
      file: fixture.file,
      target: fixture.target,
      dependencies: runtime.dependencies,
    });

    assert.equal(runtime.landings[0].unit.name, basename(declaration[0].task));
    assert.equal(readLog(fixture.logPath)[0].name, basename(declaration[0].task));
  } finally {
    fixture.cleanup();
  }
});

test('Claude final review runs before every landing and its judgement is recorded', async () => {
  const fixture = makeFixture();
  try {
    const runtime = fakeRuntime([reviewReady('run-1')]);
    await runQueue({
      file: fixture.file,
      target: fixture.target,
      dependencies: runtime.dependencies,
    });
    assert.equal(runtime.judgements.length, 1, 'no landing without the final review');
    assert.equal(runtime.judgements[0].runDirectory, 'run-directory-1');
    assert.equal(runtime.landings.length, 1);
    const log = readLog(fixture.logPath);
    assert.equal(log[0].finalReview.approved, true);
    assert.equal(log[0].finalReview.reasoning, 'reviewed first-hand in fixture');
    assert.equal(log[0].landed, true);
  } finally {
    fixture.cleanup();
  }
});

test('a refused final review stops the queue with Claude reasoning and lands nothing', async () => {
  const fixture = makeFixture();
  try {
    const runtime = fakeRuntime([
      reviewReady('run-1'),
      reviewReady('run-2'),
      reviewReady('run-3'),
    ], {
      judgeLanding: async ({ runDirectory }) => runDirectory === 'run-directory-2'
        ? {
            approved: false,
            reasoning: 'the diff narrows shared scope the task requires',
            findings: [{ id: 'L1', severity: 'P0', text: 'shared scope narrowed' }],
          }
        : { approved: true, reasoning: 'sound' },
    });
    const result = await runQueue({
      file: fixture.file,
      target: fixture.target,
      dependencies: runtime.dependencies,
    });
    assert.equal(runtime.landings.length, 1, 'only the approved unit lands');
    assert.equal(result.stop.kind, 'final-review');
    assert.match(result.stop.reason, /Claude refused the landing/);
    assert.match(result.stop.reason, /narrows shared scope/);
    const log = readLog(fixture.logPath);
    assert.equal(log[1].landed, false);
    assert.equal(log[1].finalReview.approved, false);
    assert.deepEqual(log[1].finalReview.findings,
      [{ id: 'L1', severity: 'P0', text: 'shared scope narrowed' }]);
  } finally {
    fixture.cleanup();
  }
});

test('an unavailable final review never lands — silence is not consent at landing', async () => {
  const fixture = makeFixture(1);
  try {
    const runtime = fakeRuntime([reviewReady('run-1')], {
      judgeLanding: async () => { throw new Error('claude CLI unreachable'); },
    });
    const result = await runQueue({
      file: fixture.file,
      target: fixture.target,
      dependencies: runtime.dependencies,
    });
    assert.equal(runtime.landings.length, 0);
    assert.equal(result.stop.kind, 'final-review');
    assert.match(result.stop.reason, /unavailable — nothing lands unseen/);
    assert.match(result.stop.reason, /claude CLI unreachable/);
    const log = readLog(fixture.logPath);
    assert.equal(log[0].finalReview.approved, null);
  } finally {
    fixture.cleanup();
  }
});
