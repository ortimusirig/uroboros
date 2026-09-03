import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.js';
import { CLI_COMMANDS } from '../src/cli-help.js';

test('parses mutate options and requires a target', () => {
  assert.deepEqual(parseArgs([
    'mutate', '--target', 'repo', '--base', 'main', '--tests', 'node --test {tests}', '--dry-run',
  ]), {
    command: 'mutate', target: 'repo', base: 'main', tests: 'node --test {tests}', dryRun: true,
  });
  assert.deepEqual(parseArgs(['mutate', '--target', 'repo']), {
    command: 'mutate', target: 'repo', base: 'HEAD', dryRun: false,
  });
  assert.throws(() => parseArgs(['mutate']), /missing required option: --target/);
});

test('run accepts opt-in advisory mutation evidence', () => {
  const parsed = parseArgs([
    'run', '--task', 'plan', '--target', 'repo', '--gate', 'gate.json', '--mutate',
  ]);
  assert.equal(parsed.mutate, true);
});
import { resolveStageTimeouts } from '../src/timeouts.js';

test('parses a full run invocation', () => {
  const r = parseArgs(['run', '--task', 'plan.md', '--target', 'C:/proj',
    '--gate', 'gate.json', '--gate-retries', '1', '--executor-model', 'executor-X',
    '--executor-effort', 'medium', '--verifier-model', 'verifier-Y',
    '--arbiter-model', 'claude-Z']);
  assert.equal(r.command, 'run');
  assert.equal(r.task, 'plan.md');
  assert.equal(r.target, 'C:/proj');
  assert.equal(r.gate, 'gate.json');
  assert.equal(r.gateRetries, 1);
  assert.equal(r.executorModel, 'executor-X');
  assert.equal(r.executorEffort, 'medium');
  assert.equal(r.verifierModel, 'verifier-Y');
  assert.equal(r.arbiterModel, 'claude-Z');
  assert.equal(Object.hasOwn(r, 'quiet'), false,
    'the default parse result keeps its existing shape for callers');
});

test('--corrects is a string-valued run-only option', () => {
  const run = parseArgs([
    'run', '--task', 'p', '--target', 't', '--gate', 'g', '--corrects', 'prior-run-123',
  ]);
  assert.equal(run.correctsRunId, 'prior-run-123');
  assert.throws(() => parseArgs([
    'batch', '--task', 'p', '--target', 't', '--gate', 'g', '--corrects', 'prior-run-123',
  ]), /corrects/i);
});

test('parses --quiet without changing run options', () => {
  const r = parseArgs(['run', '--task', 'p', '--target', 't', '--gate', 'g', '--quiet']);
  assert.equal(r.quiet, true);
  assert.equal(r.gateRetries, 2);
});

test('applies the retry default and leaves model defaults to run()', () => {
  const r = parseArgs(['run', '--task', 'p', '--target', 't', '--gate', 'g']);
  assert.equal(r.gateRetries, 2);
  assert.equal(r.executorModel, undefined);
  assert.equal(r.executorEffort, undefined);
  assert.equal(r.verifierModel, undefined);
  assert.equal(r.correctsRunId, undefined);
  assert.equal(Object.hasOwn(r, 'maxIterations'), false);
});

test('run and batch accept a bounded fresh-pivot candidate count', () => {
  const run = parseArgs([
    'run', '--task', 'p', '--target', 't', '--gate', 'g', '--pivot-candidates', '5',
  ]);
  const batch = parseArgs([
    'batch', '--task', 'p', '--target', 't', '--gate', 'g', '--pivot-candidates', '1',
  ]);
  assert.equal(run.pivotCandidates, 5);
  assert.equal(batch.pivotCandidates, 1);
  assert.throws(() => parseArgs([
    'run', '--task', 'p', '--target', 't', '--gate', 'g', '--pivot-candidates', '6',
  ]), /range \[1-5\]/);
});

test('run parses each stage timeout flag and the values reach timeout resolution', () => {
  const parsed = parseArgs([
    'run', '--task', 'p', '--target', 't', '--gate', 'g',
    '--executor-timeout', '101', '--verifier-timeout', '202', '--arbiter-timeout', '212',
    '--gate-timeout', '303',
  ]);
  assert.equal(parsed.executorTimeout, 101);
  assert.equal(parsed.verifierTimeout, 202);
  assert.equal(parsed.arbiterTimeout, 212);
  assert.equal(parsed.gateTimeout, 303);
  assert.deepEqual(resolveStageTimeouts({
    URO_EXECUTOR_TIMEOUT_MS: '1',
    URO_VERIFIER_TIMEOUT_MS: '2',
    URO_GATE_TIMEOUT_MS: '3',
  }, parsed), { executor: 101, verifier: 202, arbiter: 212, gate: 303 });
});

test('batch parses each stage timeout flag', () => {
  const parsed = parseArgs([
    'batch', '--task', 'p', '--target', 't', '--gate', 'g',
    '--executor-timeout', '404', '--verifier-timeout', '505', '--gate-timeout', '606',
  ]);
  assert.equal(parsed.executorTimeout, 404);
  assert.equal(parsed.verifierTimeout, 505);
  assert.equal(parsed.gateTimeout, 606);
});

test('stage timeout flags reject values outside the environment-variable rules', () => {
  const base = ['run', '--task', 'p', '--target', 't', '--gate', 'g'];
  const invalid = [
    ['executor-timeout', '0',
      '--executor-timeout must be between 1 and 2147483647 milliseconds'],
    ['verifier-timeout', '-1',
      '--verifier-timeout must be a positive integer number of milliseconds'],
    ['gate-timeout', 'tomorrow',
      '--gate-timeout must be a positive integer number of milliseconds'],
    ['executor-timeout', '2147483648',
      '--executor-timeout must be between 1 and 2147483647 milliseconds'],
  ];
  for (const [flag, value, message] of invalid) {
    assert.throws(() => parseArgs([...base, `--${flag}`, value]), new Error(message));
  }
});

test('rejects the removed --max-iterations option', () => {
  assert.throws(() => parseArgs(['run', '--task', 'p', '--target', 't', '--gate', 'g',
    '--max-iterations', '5']), /max-iterations/i);
});

test('rejects an invalid executor effort while accepting Codex effort values', () => {
  assert.throws(() => parseArgs(['run', '--task', 'p', '--target', 't', '--gate', 'g',
    '--executor-effort', 'extreme']), /executor-effort.*extreme/i);
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    assert.equal(parseArgs(['run', '--task', 'p', '--target', 't', '--gate', 'g',
      '--executor-effort', effort]).executorEffort, effort);
  }
});

test('rejects an unknown command', () => {
  assert.throws(() => parseArgs(['frobnicate']), /unknown command/i);
});

test('parses status with exactly one run directory', () => {
  assert.deepEqual(parseArgs(['status', 'C:/ccc/w/run/w']), {
    command: 'status', runDirectory: 'C:/ccc/w/run/w',
  });
  assert.throws(() => parseArgs(['status']), /status <run-directory>/);
  assert.throws(() => parseArgs(['status', 'one', 'two']), /status <run-directory>/);
});

test('doctor parses --fix without deep probes and rejects the token-spending combination', () => {
  assert.deepEqual(parseArgs(['doctor', '--fix', '--scratch-root', 'scratch']), {
    command: 'doctor', deep: false, fix: true, scratchRoot: 'scratch',
  });
  assert.throws(
    () => parseArgs(['doctor', '--fix', '--deep']),
    /cannot be combined/,
  );
  assert.deepEqual(parseArgs(['doctor', '--fix', '--yes']), {
    command: 'doctor', deep: false, fix: true, yes: true,
  });
  assert.throws(() => parseArgs(['doctor', '--yes']), /--yes requires --fix/);
  assert.throws(() => parseArgs(['doctor', '--deep', '--yes']), /--yes requires --fix/);
});

test('setup accepts its optional scratch root and headless consent flag', () => {
  assert.deepEqual(parseArgs(['setup']), { command: 'setup' });
  assert.deepEqual(parseArgs(['setup', '--scratch-root', 'scratch']), {
    command: 'setup', scratchRoot: 'scratch',
  });
  assert.deepEqual(parseArgs(['setup', '--yes']), { command: 'setup', yes: true });
  assert.throws(() => parseArgs(['setup', 'somewhere']), /Unexpected argument/);
});

test('run and batch parse dashboard controls with the dashboard port rules', () => {
  const run = parseArgs([
    'run', '--task', 'p', '--target', 't', '--gate', 'g',
    '--port', '8123', '--open', '--no-dashboard',
  ]);
  assert.equal(run.port, 8123);
  assert.equal(run.open, true);
  assert.equal(run.noDashboard, true);

  const batch = parseArgs([
    'batch', '--task', 'p', '--target', 't', '--gate', 'g', '--port', '0', '--open',
  ]);
  assert.equal(batch.port, 0);
  assert.equal(batch.open, true);
  assert.equal(Object.hasOwn(batch, 'noDashboard'), false);

  assert.throws(() => parseArgs([
    'run', '--task', 'p', '--target', 't', '--gate', 'g', '--port', '65536',
  ]), /dashboard port/i);
  assert.throws(() => parseArgs([
    'batch', '--task', 'p', '--target', 't', '--gate', 'g', '--port', '12.5',
  ]), /dashboard port/i);
});

test('parses publish with exactly one completed run directory', () => {
  assert.deepEqual(parseArgs(['publish', 'C:/ccc/w/run/w']), {
    command: 'publish', runDirectory: 'C:/ccc/w/run/w',
  });
  assert.throws(() => parseArgs(['publish']), /publish <run-directory>/);
  assert.throws(() => parseArgs(['publish', 'one', 'two']), /publish <run-directory>/);
});

test('parses dashboard run, scratch-root, and port forms without ambiguity', () => {
  assert.deepEqual(parseArgs(['dashboard', 'C:/ccc/w/a', '--port', '8123']), {
    command: 'dashboard', runDirectory: 'C:/ccc/w/a', port: 8123,
  });
  assert.deepEqual(parseArgs(['dashboard', '--scratch-root', 'C:/ccc/w']), {
    command: 'dashboard', scratchRoot: 'C:/ccc/w',
  });
  assert.deepEqual(parseArgs(['dashboard', '--run', 'C:/ccc/w/a']), {
    command: 'dashboard', runDirectory: 'C:/ccc/w/a',
  });
  assert.deepEqual(parseArgs(['dashboard']), { command: 'dashboard' },
    'no source means the CLI-configured default scratch root');
  assert.throws(() => parseArgs(['dashboard', 'a', '--scratch-root', 'b']), /either.*run.*scratch/i);
  assert.throws(() => parseArgs(['dashboard', '--port', '65536']), /port/i);
  assert.throws(() => parseArgs(['dashboard', '--port', '12.5']), /port/i);
});

test('rejects a missing required option', () => {
  assert.throws(() => parseArgs(['run', '--task', 'p']), /--target/);
});

test('parses repeated batch plans with bounded concurrency, budget, and unit identity', () => {
  const parsed = parseArgs([
    'batch',
    '--task', 'candidate-a.md',
    '--task', 'candidate-b.md',
    '--target', 'C:/proj',
    '--gate', 'gate.json',
    '--concurrency', '2',
    '--token-budget', '9000',
    '--unit-kind', 'candidate',
    '--unit-kind', 'merge',
    '--perspective', 'minimal-change',
    '--perspective', 'refactor-first',
    '--quiet',
  ]);
  assert.equal(parsed.command, 'batch');
  assert.deepEqual(parsed.tasks, [
    { task: 'candidate-a.md', unitKind: 'candidate', perspective: 'minimal-change' },
    { task: 'candidate-b.md', unitKind: 'merge', perspective: 'refactor-first' },
  ]);
  assert.equal(parsed.concurrency, 2);
  assert.equal(parsed.tokenBudget, 9000);
  assert.equal(parsed.gateRetries, 2);
  assert.equal(parsed.quiet, true);
});

test('batch defaults concurrency to two and broadcasts the candidate unit kind', () => {
  const parsed = parseArgs([
    'batch', '--task', 'a', '--task', 'b', '--target', 't', '--gate', 'g',
  ]);
  assert.equal(parsed.concurrency, 2);
  assert.ok(parsed.tokenBudget > 0);
  assert.deepEqual(parsed.tasks.map((unit) => unit.unitKind), ['candidate', 'candidate']);
});

test('batch parses explicit unit ids and tree dependency edges', () => {
  const parsed = parseArgs([
    'batch',
    '--task', 'parent plan', '--unit-id', 'parent',
    '--task', 'child plan', '--unit-id', 'child',
    '--task', 'sibling plan', '--unit-id', 'sibling',
    '--depends-on', 'child=parent',
    '--depends-on', 'sibling=parent',
    '--target', 't', '--gate', 'g', '--unit-kind', 'node',
  ]);
  assert.deepEqual(parsed.tasks, [
    { task: 'parent plan', unitKind: 'node', unitId: 'parent' },
    { task: 'child plan', unitKind: 'node', unitId: 'child', dependsOn: 'parent' },
    { task: 'sibling plan', unitKind: 'node', unitId: 'sibling', dependsOn: 'parent' },
  ]);
});

test('repeated dependency edges make the child a merge unit', () => {
  const parsed = parseArgs([
    'batch',
    '--task', 'left plan', '--unit-id', 'left',
    '--task', 'right plan', '--unit-id', 'right',
    '--task', 'join plan', '--unit-id', 'join',
    '--depends-on', 'join=right',
    '--depends-on', 'join=left',
    '--target', 't', '--gate', 'g', '--unit-kind', 'node',
  ]);
  assert.deepEqual(parsed.tasks[2], {
    task: 'join plan', unitKind: 'merge', unitId: 'join', dependsOn: ['right', 'left'],
  });
});

test('batch dependency flags reject ambiguous or malformed edge declarations', () => {
  assert.throws(() => parseArgs([
    'batch', '--task', 'a', '--task', 'b', '--unit-id', 'a',
    '--target', 't', '--gate', 'g',
  ]), /unit-id.*once per/i);
  assert.throws(() => parseArgs([
    'batch', '--task', 'a', '--depends-on', 'a=b', '--target', 't', '--gate', 'g',
  ]), /depends-on requires.*unit-id/i);
  assert.throws(() => parseArgs([
    'batch', '--task', 'a', '--unit-id', 'a', '--depends-on', 'not-an-edge',
    '--target', 't', '--gate', 'g',
  ]), /expected CHILD=PARENT/i);
});

test('batch rejects unsafe fan-out, bad kinds, and mismatched per-task kinds', () => {
  assert.throws(() => parseArgs([
    'batch', '--task', 'a', '--target', 't', '--gate', 'g', '--concurrency', '17',
  ]), /range/i);
  assert.throws(() => parseArgs([
    'batch', '--task', 'a', '--target', 't', '--gate', 'g', '--concurrency', '2.5',
  ]), /range/i);
  assert.throws(() => parseArgs([
    'batch', '--task', 'a', '--target', 't', '--gate', 'g', '--unit-kind', 'planner',
  ]), /unit-kind.*planner/i);
  assert.throws(() => parseArgs([
    'batch', '--task', 'a', '--task', 'b', '--task', 'c', '--target', 't', '--gate', 'g',
    '--unit-kind', 'candidate', '--unit-kind', 'node',
  ]), /once.*all.*once per/i);
  assert.throws(() => parseArgs([
    'batch', '--task', 'a', '--task', 'b', '--target', 't', '--gate', 'g',
    '--perspective', 'only-one',
  ]), /perspective.*once per/i);
});

test('naming the default unit kind does not turn a batch into a candidate set', () => {
  // `candidate` is the documented default kind, so passing it explicitly must be a no-op.
  // Keying Mode A off --unit-kind made this batch a candidate set, which validateCandidateSet
  // then rejected for missing perspectives — breaking a previously valid invocation.
  const base = ['batch', '--task', 'a.md', '--task', 'b.md', '--target', '.', '--gate', 'g.json'];
  assert.equal(parseArgs(base).candidateSet, false, 'positive control: a plain batch is not a candidate set');
  assert.equal(parseArgs([...base, '--unit-kind', 'candidate']).candidateSet, false,
    'explicitly naming the default kind must not change behaviour');
  assert.equal(
    parseArgs([...base, '--perspective', 'minimal-change', '--perspective', 'refactor-first']).candidateSet,
    true,
    'positive control: perspectives DO make a candidate set, so this is not passing by always returning false');
});

test('batch parses bounded iterative round plans and groups each task with its round', () => {
  const parsed = parseArgs([
    'batch',
    '--task', 'round one a', '--round', '1', '--unit-id', 'r1-a',
    '--task', 'round one b', '--round', '1', '--unit-id', 'r1-b',
    '--task', 'round two a', '--round', '2', '--unit-id', 'r2-a',
    '--target', 't', '--gate', 'g', '--rounds', '2',
    '--perspective', 'minimal-change',
    '--perspective', 'test-first',
    '--perspective', 'minimal-change',
  ]);

  assert.equal(parsed.maxRounds, 2);
  assert.equal(parsed.candidateSet, true);
  assert.deepEqual(parsed.roundPlans.map((round) => round.map((unit) => unit.unitId)), [
    ['r1-a', 'r1-b'], ['r2-a'],
  ]);
  assert.equal(parsed.roundPlans[0][0].perspective, 'minimal-change');
  assert.equal(parsed.roundPlans[1][0].perspective, 'minimal-change',
    'a perspective may recur in a later, better-informed round');
});

test('round counts above three are rejected during argument parsing', () => {
  assert.throws(() => parseArgs([
    'batch', '--task', 'a', '--target', 't', '--gate', 'g',
    '--perspective', 'minimal-change', '--rounds', '4',
  ]), /range \[1-3\].*4/i);
});

test('iterative rounds reject non-candidate batch shapes during argument parsing', () => {
  assert.throws(() => parseArgs([
    'batch', '--task', 'a', '--target', 't', '--gate', 'g',
    '--perspective', 'minimal-change', '--unit-kind', 'node', '--rounds', '2',
  ]), /iterative.*only candidate/i);
});

test('queue defaults to manual mode with unbounded limits', () => {
  assert.deepEqual(parseArgs(['queue', '--file', 'queue.json']), {
    command: 'queue',
    file: 'queue.json',
    mode: 'manual',
    dryRun: false,
  });
});

test('plan parses its goal, target, output, rounds, model, and dry-run', () => {
  assert.deepEqual(parseArgs([
    'plan', '--goal', 'Improve the parser', '--target', 'repo', '--out', 'generated',
    '--rounds', '5', '--planner-model', 'gpt-plan', '--dry-run',
  ]), {
    command: 'plan',
    goal: 'Improve the parser',
    target: 'repo',
    out: 'generated',
    rounds: 5,
    candidates: 3,
    pivotCandidates: 3,
    plannerModel: 'gpt-plan',
    dryRun: true,
  });
  assert.throws(() => parseArgs(['plan', '--goal', 'x', '--target', 'repo']), /--out/);
  assert.throws(() => parseArgs([
    'plan', '--goal', 'x', '--target', 'repo', '--out', 'generated', '--rounds', '0',
  ]), /value out of range/);
  const unbounded = parseArgs([
    'plan', '--goal', 'x', '--target', 'repo', '--out', 'generated',
  ]);
  assert.equal(Object.hasOwn(unbounded, 'rounds'), false,
    'omitting --rounds must not invent a planning bound');
  assert.equal(unbounded.candidates, 3);
  assert.equal(unbounded.pivotCandidates, 3);
  const configured = parseArgs([
    'plan', '--goal', 'x', '--target', 'repo', '--out', 'generated',
    '--candidates', '1', '--pivot-candidates', '5',
  ]);
  assert.equal(configured.candidates, 1);
  assert.equal(configured.pivotCandidates, 5);
  assert.throws(() => parseArgs([
    'plan', '--goal', 'x', '--target', 'repo', '--out', 'generated',
    '--candidates', '6',
  ]), /range \[1-5\]/);
});

test('queue parses autonomous mode, limits, dry-run, and the goal to accept', () => {
  assert.deepEqual(parseArgs([
    'queue',
    '--file', 'queue.json',
    '--mode', 'autonomous',
    '--max-runs', '3',
    '--token-budget', '25000',
    '--accept-goal', 'uro-project/goals/G1-first/spec.md',
    '--dry-run',
  ]), {
    command: 'queue',
    file: 'queue.json',
    mode: 'autonomous',
    maxRuns: 3,
    tokenBudget: 25000,
    acceptGoalSpec: 'uro-project/goals/G1-first/spec.md',
    dryRun: true,
  });

  // Acceptance is explicit: without the flag the queue carries no goal to close.
  assert.equal(
    Object.hasOwn(parseArgs(['queue', '--file', 'queue.json']), 'acceptGoalSpec'),
    false,
  );
});

test('queue rejects missing files, invalid modes, and non-positive or fractional limits', () => {
  assert.throws(() => parseArgs(['queue']), /missing required option: --file/);
  assert.throws(
    () => parseArgs(['queue', '--file', 'q.json', '--mode', 'automatic']),
    /invalid --mode.*manual, autonomous/,
  );
  for (const [flag, value] of [
    ['--max-runs', '0'],
    ['--max-runs', '1.5'],
    ['--token-budget', '0'],
    ['--token-budget', '1.5'],
  ]) {
    assert.throws(
      () => parseArgs(['queue', '--file', 'q.json', flag, value]),
      /value out of range/,
    );
  }
});

test('every command answers --help with usage instead of an error', () => {
  for (const command of CLI_COMMANDS) {
    if (command === 'help') continue;
    assert.deepEqual(parseArgs([command, '--help']), { command: 'help' });
  }
  assert.deepEqual(parseArgs(['run', '-h']), { command: 'help' });
  assert.deepEqual(
    parseArgs(['run', '--task', 'p', '--help']),
    { command: 'help' },
    '--help wins even mixed among other flags',
  );
});
