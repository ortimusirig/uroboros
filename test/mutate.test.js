import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyStatementDeletion,
  filterMutableAddedLines,
  formatMutationSummary,
  groupMutationStatements,
  isTestFile,
  mutationExitCode,
  parseUnifiedDiff,
  runMutate,
  runMutationAfterGate,
  runSelectedTests,
  selectTouchingTests,
} from '../src/mutate.js';
import { createEvent, EVENT_PAIRS, EVENT_STAGES, EVENT_TYPES } from '../src/events.js';
import { run } from '../src/run.js';

function statement(id, line, {
  path = 'src/work.js',
  name = id,
  functionName = 'work',
  content = `${id}();`,
} = {}) {
  return {
    id,
    path,
    startLine: line,
    endLine: line,
    lines: [line],
    content,
    name,
    functionName,
  };
}

function planFixture(statements, tests = ['test/work.test.js']) {
  const root = mkdtempSync(join(tmpdir(), 'uro-mutate-plan-'));
  const byFile = new Map();
  for (const item of statements) {
    if (!byFile.has(item.path)) byFile.set(item.path, []);
    byFile.get(item.path).push(item);
  }
  for (const [path, items] of byFile) {
    const lines = Array.from({ length: Math.max(...items.map((item) => item.endLine)) }, () => '');
    for (const item of items) lines[item.startLine - 1] = item.content;
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${lines.join('\n')}\n`);
  }
  const changedFiles = [...byFile.keys()];
  return {
    root,
    target: root,
    base: 'HEAD',
    diff: '',
    statements,
    changedFiles,
    tests,
    testsByFile: Object.fromEntries(changedFiles.map((path) => [path, tests])),
  };
}

async function withPlan(statements, callback, tests) {
  const plan = planFixture(statements, tests);
  try { return await callback(plan); }
  finally { rmSync(plan.root, { recursive: true, force: true }); }
}

const greenBaseline = async () => ({ passed: true, code: 0 });

test('mutation discriminates a survivor and a depended-upon statement, subdividing a killed group', async () => {
  await withPlan([
    statement('unobserved', 2, { name: 'recordTelemetry()' }),
    statement('depended', 3, { name: 'returnContract()' }),
  ], async (plan) => {
    const trialIds = [];
    const result = await runMutate({
      target: plan.root,
      plan,
      adapters: {
        runTests: greenBaseline,
        runTrial: async ({ unit }) => {
          trialIds.push(unit.statements.map((item) => item.id));
          return { passed: !unit.statements.some((item) => item.id === 'depended'), code: 0 };
        },
      },
    });

    assert.equal(result.survivors.length, 1);
    assert.equal(result.survivors[0].name, 'recordTelemetry()');
    assert.deepEqual(result.survivors[0].lines.map((line) => line.line), [2]);
    assert.ok(result.kills.some((unit) => unit.statements.length === 2 && unit.provisional),
      'the first killed group must remain provisional');
    assert.ok(trialIds.some((ids) => ids.length === 1 && ids[0] === 'unobserved'));
    assert.ok(trialIds.some((ids) => ids.length === 1 && ids[0] === 'depended'));
    assert.equal(result.survivors.some((unit) => unit.statements.some((item) => item.id === 'depended')), false);
  });
});

test('the reported facts-writing case survives and is named by semantic grouping', async () => {
  await withPlan([
    statement('facts-write', 4, { name: 'decide()', content: 'decide(decision);' }),
  ], async (plan) => {
    const result = await runMutate({
      target: plan.root,
      plan,
      judge: async () => ({
        units: [{ name: 'recordLivenessDecision()', statementIds: ['facts-write'] }],
      }),
      adapters: { runTests: greenBaseline, runTrial: async () => ({ passed: true, code: 0 }) },
    });
    assert.equal(result.survivors[0].name, 'recordLivenessDecision()');
    assert.equal(result.survivors[0].statements[0].content, 'decide(decision);');
  });
});

test('a surviving semantic group reports every line and is not subdivided', async () => {
  await withPlan([statement('one', 2), statement('two', 7)], async (plan) => {
    let trials = 0;
    const result = await runMutate({
      target: plan.root,
      plan,
      adapters: {
        runTests: greenBaseline,
        runTrial: async () => { trials++; return { passed: true, code: 0 }; },
      },
    });
    assert.equal(trials, 1);
    assert.deepEqual(result.survivors[0].lines.map((line) => line.line), [2, 7]);
  });
});

test('grouping uses a semantic judge and otherwise one enclosing-function unit, never fixed chunks', async () => {
  const statements = Array.from({ length: 7 }, (_, index) => statement(`s${index}`, index + 1));
  const judged = await groupMutationStatements(statements, {
    judge: async () => ({
      units: [
        { name: 'setup branch', statementIds: ['s0', 's1'] },
        { name: 'record branch', statementIds: ['s2', 's3', 's4', 's5', 's6'] },
      ],
    }),
  });
  assert.equal(judged.judged, true);
  assert.deepEqual(judged.units.map((unit) => unit.name), ['setup branch', 'record branch']);

  const fallback = await groupMutationStatements(statements);
  assert.equal(fallback.judged, false);
  assert.equal(fallback.method, 'enclosing-function');
  assert.equal(fallback.units.length, 1);
  assert.equal(fallback.units[0].statements.length, 7,
    'seven statements in one function must not become fixed-size chunks');
});

test('a red baseline stops before grouping or mutation and explains why', async () => {
  await withPlan([statement('one', 1)], async (plan) => {
    let judgeCalls = 0;
    let trialCalls = 0;
    const result = await runMutate({
      target: plan.root,
      plan,
      judge: async () => { judgeCalls++; return { units: [] }; },
      adapters: {
        runTests: async () => ({ passed: false, code: 9 }),
        runTrial: async () => { trialCalls++; return { passed: true }; },
      },
    });
    assert.equal(result.status, 'baseline-failed');
    assert.match(result.reason, /baseline tests are red.*meaningless/i);
    assert.equal(judgeCalls, 0);
    assert.equal(trialCalls, 0);
  });
});

test('an aborted baseline reports interrupted rather than baseline-failed', async () => {
  await withPlan([statement('one', 1)], async (plan) => {
    let trialCalls = 0;
    const result = await runMutate({
      target: plan.root,
      plan,
      adapters: {
        runTests: async () => ({ aborted: true, code: 1 }),
        runTrial: async () => { trialCalls++; return { passed: true, code: 0 }; },
      },
    });

    assert.equal(result.status, 'interrupted');
    assert.notEqual(result.status, 'baseline-failed');
    assert.equal(result.baseline.aborted, true);
    assert.equal(trialCalls, 0);
  });
});

test('an aborted trial is unexamined and is neither a kill nor a survivor', async () => {
  await withPlan([
    statement('one', 1, { functionName: 'one' }),
    statement('pending', 2, { functionName: 'pending' }),
  ], async (plan) => {
    let trialCalls = 0;
    const result = await runMutate({
      target: plan.root,
      plan,
      concurrency: 1,
      adapters: {
        runTests: greenBaseline,
        runTrial: async () => { trialCalls++; return { aborted: true, code: 1 }; },
      },
    });

    assert.equal(result.status, 'interrupted');
    assert.equal(trialCalls, 1);
    assert.equal(result.examined.length, 0);
    assert.equal(result.kills.length, 0);
    assert.equal(result.survivors.length, 0);
    assert.equal(result.unexamined.length, 2);
    assert.ok(result.unexamined.every((unit) => /interrupted/i.test(unit.reason)));
  });
});

test('an interrupted concurrent batch keeps a completed peer result', async () => {
  await withPlan([
    statement('aborted', 1, { functionName: 'aborted' }),
    statement('completed', 2, { functionName: 'completed' }),
    statement('survived', 3, { functionName: 'survived' }),
  ], async (plan) => {
    let arbiterCalls = 0;
    const result = await runMutate({
      target: plan.root,
      plan,
      concurrency: 3,
      arbiter: async () => {
        arbiterCalls++;
        return { verdict: 'gap', reasoning: 'should not run after interruption' };
      },
      adapters: {
        runTests: greenBaseline,
        runTrial: async ({ unit }) => {
          const id = unit.statements[0].id;
          if (id === 'aborted') return { aborted: true, code: 1 };
          return { passed: id === 'survived', code: id === 'survived' ? 0 : 1 };
        },
      },
    });

    assert.equal(result.status, 'interrupted');
    assert.deepEqual(result.unexamined.map((unit) => unit.statements[0].id), ['aborted']);
    assert.deepEqual(result.kills.map((unit) => unit.statements[0].id), ['completed']);
    assert.deepEqual(result.survivors.map((unit) => unit.statements[0].id), ['survived']);
    assert.equal(result.examined.length, 2);
    assert.equal(arbiterCalls, 0);
    assert.deepEqual(result.survivors[0].judgement, {
      verdict: 'unjudged',
      reasoning: 'mutation interrupted before arbiter judgement',
    });
  });
});

test('an abort during trial workspace setup is unexamined and restores the working tree', async () => {
  await withPlan([statement('one', 1)], async (plan) => {
    const before = readFileSync(join(plan.root, 'src', 'work.js'));
    const commands = [];
    let workspace;
    const result = await runMutate({
      target: plan.root,
      plan,
      adapters: {
        runTests: greenBaseline,
        runCommand: async (bin, args) => {
          commands.push([bin, ...args]);
          if (args.includes('add')) {
            workspace = args.at(-2);
            return { aborted: true, code: 1, stdout: '', stderr: '' };
          }
          return { code: 0, stdout: '', stderr: '' };
        },
      },
    });

    assert.equal(result.status, 'interrupted');
    assert.equal(result.unexamined.length, 1);
    assert.equal(result.kills.length, 0);
    assert.equal(result.survivors.length, 0);
    assert.ok(commands.some((args) => args.includes('remove')));
    assert.ok(commands.some((args) => args.includes('prune')));
    assert.equal(existsSync(dirname(workspace)), false);
    assert.deepEqual(readFileSync(join(plan.root, 'src', 'work.js')), before);
  });
});

test('an abort while overlaying trial changes is unexamined and removes the workspace', async () => {
  await withPlan([statement('one', 1)], async (plan) => {
    const before = readFileSync(join(plan.root, 'src', 'work.js'));
    let workspace;
    const result = await runMutate({
      target: plan.root,
      plan,
      adapters: {
        runTests: greenBaseline,
        runCommand: async (bin, args) => {
          if (args.includes('add')) {
            workspace = args.at(-2);
            cpSync(plan.root, workspace, { recursive: true });
            return { code: 0, stdout: '', stderr: '' };
          }
          if (args.includes('diff')) {
            return { aborted: true, code: 1, stdout: '', stderr: '' };
          }
          return { code: 0, stdout: '', stderr: '' };
        },
      },
    });

    assert.equal(result.status, 'interrupted');
    assert.equal(result.unexamined.length, 1);
    assert.equal(result.kills.length, 0);
    assert.equal(result.survivors.length, 0);
    assert.equal(existsSync(dirname(workspace)), false);
    assert.deepEqual(readFileSync(join(plan.root, 'src', 'work.js')), before);
  });
});

test('an abort during semantic grouping reports interrupted without starting a trial', async () => {
  await withPlan([statement('one', 1)], async (plan) => {
    const controller = new AbortController();
    let trialCalls = 0;
    const result = await runMutate({
      target: plan.root,
      plan,
      signal: controller.signal,
      judge: async () => {
        controller.abort(new Error('operator interrupted grouping'));
        return { units: [{ name: 'work()', statementIds: ['one'] }] };
      },
      adapters: {
        runTests: greenBaseline,
        runTrial: async () => { trialCalls++; return { passed: true, code: 0 }; },
      },
    });

    assert.equal(result.status, 'interrupted');
    assert.equal(mutationExitCode(result), 130);
    assert.equal(trialCalls, 0);
    assert.equal(result.unexamined.length, 1);
    assert.equal(result.kills.length, 0);
    assert.equal(result.survivors.length, 0);
  });
});

test('an abort during empty semantic grouping cannot finish successfully', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-mutate-empty-grouping-'));
  try {
    const controller = new AbortController();
    const result = await runMutate({
      target: root,
      signal: controller.signal,
      plan: {
        root,
        target: root,
        base: 'HEAD',
        diff: '',
        statements: [],
        changedFiles: [],
        tests: [],
        testsByFile: {},
      },
      judge: async () => {
        controller.abort(new Error('operator interrupted empty grouping'));
        return { units: [] };
      },
      adapters: { runTests: greenBaseline },
    });

    assert.equal(result.status, 'interrupted');
    assert.equal(mutationExitCode(result), 130);
    assert.equal(result.examined.length, 0);
    assert.equal(result.unexamined.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an abort during survivor judgement cannot finish successfully', async () => {
  await withPlan([
    statement('one', 1, { functionName: 'one' }),
    statement('two', 2, { functionName: 'two' }),
  ], async (plan) => {
    const controller = new AbortController();
    let arbiterCalls = 0;
    const result = await runMutate({
      target: plan.root,
      plan,
      concurrency: 2,
      signal: controller.signal,
      arbiter: async () => {
        arbiterCalls++;
        controller.abort(new Error('operator interrupted arbiter'));
        return { verdict: 'acceptable', reasoning: 'measurement completed before interruption' };
      },
      adapters: {
        runTests: greenBaseline,
        runTrial: async () => ({ passed: true, code: 0 }),
      },
    });

    assert.equal(result.status, 'interrupted');
    assert.equal(mutationExitCode(result), 130);
    assert.equal(result.examined.length, 2);
    assert.equal(result.survivors.length, 2);
    assert.equal(result.kills.length, 0);
    assert.equal(arbiterCalls, 1);
    assert.deepEqual(result.survivors[1].judgement, {
      verdict: 'unjudged',
      reasoning: 'mutation interrupted before arbiter judgement',
    });
  });
});

test('an interrupted mutation run maps to the conventional non-zero interrupt exit', () => {
  assert.equal(mutationExitCode({ status: 'interrupted' }), 130);
  assert.notEqual(mutationExitCode({ status: 'interrupted' }), 0);
});

test('runSelectedTests preserves an aborted spawn as neither a pass nor a fail', async () => {
  const result = await runSelectedTests({
    cwd: process.cwd(),
    tests: ['test/work.test.js'],
    runCommand: async () => ({
      aborted: true,
      code: 1,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
    }),
  });

  assert.equal(result.aborted, true);
  assert.equal(result.code, 1);
  assert.equal(Object.hasOwn(result, 'passed'), false);
});

test('runSelectedTests keeps a non-aborted non-zero spawn as a real failure', async () => {
  const result = await runSelectedTests({
    cwd: process.cwd(),
    tests: ['test/work.test.js'],
    runCommand: async () => ({ code: 1, stdout: '', stderr: 'assertion failed' }),
  });

  assert.equal(result.passed, false);
  assert.equal(Object.hasOwn(result, 'aborted'), false);
});

test('only added executable production statements are mutable', () => {
  const sourceByFile = {
    'src/change.js': [
      "import x from './x.js'",
      '',
      '// comment',
      'const existing = 1;',
      'recordFact();',
      '/* block comment */',
    ].join('\n'),
    'test/change.test.js': 'assertFact();\n',
  };
  const additions = [
    { path: 'src/change.js', line: 1, content: "import x from './x.js'" },
    { path: 'src/change.js', line: 2, content: '' },
    { path: 'src/change.js', line: 3, content: '// comment' },
    // line 4 is deliberately pre-existing and absent from the diff additions.
    { path: 'src/change.js', line: 5, content: 'recordFact();' },
    { path: 'src/change.js', line: 6, content: '/* block comment */' },
    { path: 'test/change.test.js', line: 1, content: 'assertFact();' },
  ];
  const mutable = filterMutableAddedLines(additions, sourceByFile);
  assert.deepEqual(mutable.map((item) => item.id), ['src/change.js:5']);
  assert.equal(isTestFile('src/change.js'), false);
  assert.equal(isTestFile('test/change.test.js'), true);

  const parsed = parseUnifiedDiff([
    'diff --git a/src/change.js b/src/change.js',
    '--- a/src/change.js',
    '+++ b/src/change.js',
    '@@ -4,1 +4,2 @@',
    ' const existing = 1;',
    '+recordFact();',
  ].join('\n'));
  assert.deepEqual(parsed, [{ path: 'src/change.js', line: 5, content: 'recordFact();' }]);
});

test('mutation control: statement deletion cannot be a no-op and discriminates between statements', () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-mutate-deletion-control-'));
  const file = join(root, 'src', 'work.js');
  const original = Buffer.from(
    'export function work() {\r\n  recordFact();\r\n  preserveFact();\r\n}\r\n',
  );
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, original);

    applyStatementDeletion(root, {
      statements: [statement('record', 2, {
        path: 'src/work.js', content: '  recordFact();', name: 'recordFact()',
      })],
    });

    const mutated = readFileSync(file, 'utf8');
    assert.match(mutated, /\/\* uro mutation deleted record \*\//);
    assert.doesNotMatch(mutated, /\brecordFact\(\);/);
    assert.match(mutated, /\bpreserveFact\(\);/);

    // Byte-identity is NOT asserted here. applyStatementDeletion edits a
    // disposable workspace copy, so there is no in-place restore to round-trip;
    // the real invariant is "the original tree is never touched", and it is
    // asserted through executeMutationTrial with a sawDeletion positive control.
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dry-run executes no tests, trials, judge, or arbiter and lists units with tests', async () => {
  await withPlan([statement('one', 2)], async (plan) => {
    const calls = [];
    const result = await runMutate({
      target: plan.root,
      plan,
      dryRun: true,
      judge: async () => { calls.push('judge'); },
      arbiter: async () => { calls.push('arbiter'); },
      adapters: {
        runTests: async () => { calls.push('tests'); },
        runTrial: async () => { calls.push('trial'); },
      },
    });
    assert.deepEqual(calls, []);
    assert.equal(result.units.length, 1);
    assert.deepEqual(result.units[0].tests, ['test/work.test.js']);
    assert.equal(result.grouping.judged, false);
  });
});

test('budget exhaustion reports subdivided units as unexamined', async () => {
  await withPlan([statement('one', 1), statement('two', 2)], async (plan) => {
    const result = await runMutate({
      target: plan.root,
      plan,
      budget: 1,
      adapters: {
        runTests: greenBaseline,
        runTrial: async () => ({ passed: false, code: 1 }),
      },
    });
    assert.equal(result.kills.length, 1);
    assert.equal(result.kills[0].provisional, true);
    assert.equal(result.unexamined.length, 2);
    assert.ok(result.unexamined.every((unit) => /budget exhausted/.test(unit.reason)));
  });
});

test('independent trials run concurrently up to the configured small limit', async () => {
  await withPlan([
    statement('left', 1, { functionName: 'left' }),
    statement('right', 2, { functionName: 'right' }),
    statement('third', 3, { functionName: 'third' }),
  ], async (plan) => {
    let active = 0;
    let maximum = 0;
    const releases = [];
    const resultPromise = runMutate({
      target: plan.root,
      plan,
      concurrency: 2,
      adapters: {
        runTests: greenBaseline,
        runTrial: async () => {
          active++;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => releases.push(resolve));
          active--;
          return { passed: true, code: 0 };
        },
      },
    });
    while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
    releases.splice(0).forEach((release) => release());
    while (releases.length < 1) await new Promise((resolve) => setImmediate(resolve));
    releases.splice(0).forEach((release) => release());
    const result = await resultPromise;
    assert.equal(maximum, 2);
    assert.equal(result.survivors.length, 3);
  });
});

test('survivor evidence is presented to the arbiter and judgement is recorded', async () => {
  await withPlan([statement('log', 3, { name: 'logDecision()' })], async (plan) => {
    let presented;
    const result = await runMutate({
      target: plan.root,
      plan,
      judge: async () => ({ units: [{ name: 'logDecision()', statementIds: ['log'] }] }),
      arbiter: async (evidence) => {
        presented = evidence;
        return { verdict: 'acceptable', reasoning: 'This diagnostic log is intentionally non-blocking.' };
      },
      adapters: { runTests: greenBaseline, runTrial: async () => ({ passed: true, code: 0 }) },
    });
    assert.equal(presented.name, 'logDecision()');
    assert.deepEqual(presented.tests, ['test/work.test.js']);
    assert.ok(presented.diffContext[0].text.includes('log();'));
    assert.deepEqual(result.survivors[0].judgement, {
      verdict: 'acceptable',
      reasoning: 'This diagnostic log is intentionally non-blocking.',
    });
  });
});

test('survivors do not widen a passing gate verdict', async () => {
  const gateResult = { passed: true, results: [{ code: 0 }] };
  const wrapped = await runMutationAfterGate({
    gateResult,
    runMutation: async () => ({ status: 'finished', survivors: [{ name: 'unobserved' }] }),
  });
  assert.equal(wrapped.passed, true);
  assert.equal(wrapped.gateResult, gateResult);
  assert.equal(wrapped.mutation.survivors.length, 1);
});

test('an opted-in passing run records mutation survivors without changing its outcome', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-mutate-run-wiring-'));
  const target = join(root, 'target');
  const isolated = join(root, 'isolated');
  mkdirSync(target, { recursive: true });
  mkdirSync(isolated, { recursive: true });
  const order = [];
  const mutation = {
    status: 'finished',
    grouping: { method: 'semantic-judge', judged: true },
    summary: { unitsExamined: 1, survivors: 1, kills: 0, unexamined: 0 },
    survivors: [{ name: 'unobserved statement' }],
    kills: [],
    unexamined: [],
  };
  try {
    const facts = await run({
      task: 'exercise advisory mutation wiring',
      target,
      gate: [],
      gateRetries: 0,
      scratchRoot: join(root, 'scratch'),
      runId: 'mutation-wiring',
      mutation: true,
      adapters: {
        isolate: async () => ({
          dir: isolated,
          isRepo: true,
          baseRef: 'HEAD',
          baseCommit: 'abc123',
          branch: 'uro/mutation-wiring',
        }),
        runExecutor: async () => {
          order.push('executor');
          return { changedFiles: ['src/change.js'], lastMessage: 'implemented change' };
        },
        runGate: async () => {
          order.push('gate');
          return { passed: true, results: [] };
        },
        diffText: async () => 'diff --git a/src/change.js b/src/change.js\n+changed();\n',
        runVerifier: async () => {
          order.push('verifier');
          return { verdict: 'NO_BLOCKERS', launchFailed: false };
        },
        runMutation: async () => {
          order.push('mutation');
          return mutation;
        },
      },
    });
    assert.deepEqual(order, ['executor', 'gate', 'verifier', 'verifier', 'mutation']);
    assert.equal(facts.gateStatus, 'passed');
    assert.equal(facts.outcome, 'review-ready');
    assert.equal(facts.mutation, mutation);
    assert.match(readFileSync(join(isolated, 'uro-report.md'), 'utf8'), /Mutation survivors:\*\* 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('test selection is scoped to tests importing the changed module', () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-mutate-select-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'src', 'changed.js'), 'export const value = 1;\n');
    writeFileSync(join(root, 'src', 'other.js'), 'export const other = 2;\n');
    writeFileSync(join(root, 'test', 'changed.test.js'), "import '../src/changed.js';\n");
    writeFileSync(join(root, 'test', 'other.test.js'), "import '../src/other.js';\n");
    assert.deepEqual(selectTouchingTests({ root, changedFiles: ['src/changed.js'] }), [
      'test/changed.test.js',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the source working tree is byte-identical after a thrown trial error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-mutate-restore-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'src', 'value.js'), 'export function value() {\n  return 1;\n}\n');
    writeFileSync(join(root, 'test', 'value.test.js'), "import '../src/value.js';\n");
    writeFileSync(join(root, 'src', 'value.js'), 'export function value() {\n  recordFact();\n  return 1;\n}\n');
    const before = readFileSync(join(root, 'src', 'value.js'));
    const plan = {
      root,
      target: root,
      base: 'HEAD',
      diff: '',
      statements: [statement('record', 2, {
        path: 'src/value.js', name: 'recordFact()', content: '  recordFact();', functionName: 'value',
      })],
      changedFiles: ['src/value.js'],
      tests: ['test/value.test.js'],
      testsByFile: { 'src/value.js': ['test/value.test.js'] },
    };
    const events = [];
    let sawDeletion = false;

    await assert.rejects(runMutate({
      target: root,
      plan,
      reporter: (event) => events.push(event),
      adapters: {
        runTests: async ({ cwd }) => {
          if (cwd === root) return { passed: true, code: 0 };
          const mutated = readFileSync(join(cwd, 'src', 'value.js'), 'utf8');
          assert.match(mutated, /\/\* uro mutation deleted record \*\//);
          assert.doesNotMatch(mutated, /\brecordFact\(\);/);
          sawDeletion = true;
          throw new Error('injected mid-run failure');
        },
        createWorkspace: async () => {
          const parent = mkdtempSync(join(tmpdir(), 'uro-mutate-injected-workspace-'));
          const directory = join(parent, 'w');
          cpSync(root, directory, { recursive: true });
          return {
            directory,
            cleanup: async () => rmSync(parent, { recursive: true, force: true }),
          };
        },
      },
    }), /injected mid-run failure/);

    assert.equal(sawDeletion, true, 'positive control: the trial must delete before restoration');
    assert.deepEqual(readFileSync(join(root, 'src', 'value.js')), before);
    assert.deepEqual(events.map((event) => `${event.stage}/${event.type}`), [
      'mutate/start', 'mutate/unit', 'mutate/finish',
    ]);
    assert.equal(events.at(-1).status, 'error');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an aborted trial restores the source byte-identically after observing the deletion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-mutate-abort-restore-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'value.js'),
      'export function value() {\n  recordFact();\n  return 1;\n}\n',
    );
    const before = readFileSync(join(root, 'src', 'value.js'));
    const plan = {
      root,
      target: root,
      base: 'HEAD',
      diff: '',
      statements: [statement('record', 2, {
        path: 'src/value.js', name: 'recordFact()', content: '  recordFact();', functionName: 'value',
      })],
      changedFiles: ['src/value.js'],
      tests: ['test/value.test.js'],
      testsByFile: { 'src/value.js': ['test/value.test.js'] },
    };
    let sawDeletion = false;
    let workspaceParent;

    const result = await runMutate({
      target: root,
      plan,
      adapters: {
        runTests: async ({ cwd }) => {
          if (cwd === root) return { passed: true, code: 0 };
          const mutated = readFileSync(join(cwd, 'src', 'value.js'), 'utf8');
          assert.match(mutated, /\/\* uro mutation deleted record \*\//);
          assert.doesNotMatch(mutated, /\brecordFact\(\);/);
          sawDeletion = true;
          return { aborted: true, code: 1 };
        },
        createWorkspace: async () => {
          workspaceParent = mkdtempSync(join(tmpdir(), 'uro-mutate-abort-workspace-'));
          const directory = join(workspaceParent, 'w');
          cpSync(root, directory, { recursive: true });
          return {
            directory,
            cleanup: async () => rmSync(workspaceParent, { recursive: true, force: true }),
          };
        },
      },
    });

    assert.equal(sawDeletion, true, 'positive control: the aborted trial must delete first');
    assert.equal(result.status, 'interrupted');
    assert.equal(result.unexamined.length, 1);
    assert.equal(existsSync(workspaceParent), false);
    assert.deepEqual(readFileSync(join(root, 'src', 'value.js')), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a concurrent trial error waits for every trial workspace to restore', async () => {
  await withPlan([
    statement('left-error', 1, { functionName: 'left' }),
    statement('right-cleanup', 2, { functionName: 'right' }),
  ], async (plan) => {
    let created = 0;
    let cleaned = 0;
    await assert.rejects(runMutate({
      target: plan.root,
      plan,
      concurrency: 2,
      adapters: {
        runTests: async ({ cwd }) => {
          if (cwd === plan.root) return { passed: true, code: 0 };
          if (cwd.endsWith('workspace-1')) throw new Error('first concurrent trial failed');
          await new Promise((resolve) => setImmediate(resolve));
          return { passed: true, code: 0 };
        },
        createWorkspace: async () => {
          const number = ++created;
          const directory = join(plan.root, `workspace-${number}`);
          mkdirSync(join(directory, 'src'), { recursive: true });
          cpSync(join(plan.root, 'src', 'work.js'), join(directory, 'src', 'work.js'));
          return {
            directory,
            cleanup: async () => {
              cleaned++;
              rmSync(directory, { recursive: true, force: true });
            },
          };
        },
      },
    }), /first concurrent trial failed/);
    assert.equal(created, 2);
    assert.equal(cleaned, 2);
    assert.equal(existsSync(join(plan.root, 'workspace-1')), false);
    assert.equal(existsSync(join(plan.root, 'workspace-2')), false);
  });
});

test('all mutate event pairs round-trip through createEvent', () => {
  assert.ok(EVENT_STAGES.includes('mutate'));
  assert.ok(EVENT_TYPES.includes('unit'));
  assert.ok(EVENT_TYPES.includes('survivor'));
  const pairs = EVENT_PAIRS.filter((pair) => pair.startsWith('mutate/')).sort();
  assert.deepEqual(pairs, ['mutate/finish', 'mutate/start', 'mutate/survivor', 'mutate/unit']);
  for (const pair of pairs) {
    const [, type] = pair.split('/');
    assert.doesNotThrow(() => createEvent({ runId: `mutate-${type}`, stage: 'mutate', type }));
  }
});

test('mutate is documented as a command, skill token, and CLI usage command', () => {
  const root = new URL('../', import.meta.url);
  assert.equal(existsSync(new URL('commands/mutate.md', root)), true);
  assert.match(readFileSync(new URL('skills/uroboros/SKILL.md', root), 'utf8'), /\bmutate\b/);
  assert.match(readFileSync(new URL('src/cli-help.js', root), 'utf8'), /loop[.]js mutate\b/);
});

test('an interrupted run is never summarised as finished', () => {
  const summary = { unitsExamined: 3, survivors: 1, kills: 1, unexamined: 4 };

  const interrupted = formatMutationSummary({ status: 'interrupted', summary });
  assert.match(interrupted, /^Mutation interrupted:/);
  assert.doesNotMatch(interrupted, /finished/i);
  assert.match(interrupted, /did not complete/);
  assert.match(interrupted, /partial/);

  // Narrowness control: a run that really completed must still read as finished.
  const finished = formatMutationSummary({ status: 'finished', summary });
  assert.match(finished, /^Mutation finished:/);
  assert.doesNotMatch(finished, /interrupted/i);
});

test('loop mutate prints the human summary, not only the JSON result', () => {
  const cli = fileURLToPath(new URL('../bin/loop.js', import.meta.url));
  const root = mkdtempSync(join(tmpdir(), 'uro-mutate-cli-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'uro test');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'work.js'), 'export function work() {\n  return 1;\n}\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    writeFileSync(join(root, 'src', 'work.js'),
      'export function work() {\n  recordFact();\n  return 1;\n}\n');

    const result = spawnSync(process.execPath, [cli, 'mutate', '--target', root, '--dry-run'],
      { encoding: 'utf8' });

    // formatMutationSummary was unreachable dead code until it was wired here;
    // asserting through the CLI is what keeps it reachable.
    assert.match(result.stderr, /Mutation dry run: \d+ unit\(s\); no commands executed\./);
    assert.match(result.stdout, /"status": "dry-run"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
