import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyStatementDeletion,
  createMutationJudge,
  createMutationArbiter,
  discoverMutationPlan,
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
import { run as executeRun } from '../src/run.js';
import { withVerifiedSuperpowers } from '../fixtures/verified-superpowers.mjs';
import { spawnCapture } from '../src/spawn.js';
import { createHash } from 'node:crypto';
import { createInspectionReceipt } from '../src/context-evidence.js';
import { runGate } from '../src/gate.js';
const run = (options) => executeRun(withVerifiedSuperpowers(options));

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

async function withObservedMutation(callback) {
  const root = mkdtempSync(join(tmpdir(), 'uro-mutation-effects-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'pipe' });
    git('init', '-q');
    writeFileSync(join(root, 'work.js'), 'module.exports = function work() {\n  return 1;\n};\n');
    writeFileSync(join(root, 'check.cjs'), "console.log(require('node:fs').readFileSync('work.js','utf8'));\n");
    git('add', '-A');
    git('-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-qm', 'base');
    const events = [];
    const effects = { analysisIdentity: 'fixture-analysis-1',
      codeIdentity: async ({ cwd }) => createHash('sha256').update(readFileSync(join(cwd, 'work.js'))).digest('hex'),
      run: async request => {
        events.push({ stage: 'prepare', ...request, operation: undefined });
        const result = await request.operation();
        events.push({ stage: 'complete', key: request.key, result });
        return result;
      } };
    const plan = { root, target: root, base: 'HEAD', diff: '', statements: [statement('ret', 2, { path: 'work.js', content: '  return 1;' })],
      tests: ['check.cjs'], testsByFile: { 'work.js': ['check.cjs'] }, changedFiles: ['work.js'] };
    await callback({ root, plan, effects, events, git });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('mutation observable effects prepare actual disposable writes, commands and cleanup in scoped order', async () => {
  await withObservedMutation(async ({ root, plan, effects, events }) => {
    const original = readFileSync(join(root, 'work.js'), 'utf8');
    const result = await runMutate({ target: root, plan, effects, tests: { command: { bin: process.execPath, args: ['check.cjs'] } } });
    assert.equal(result.summary.survivors, 1);
    const intents = events.filter(value => value.stage === 'prepare');
    assert.ok(intents.length > 8);
    assert.ok(intents.every(value => value.key.startsWith('fixture-analysis-1:')));
    const allocation = intents.find(value => value.purpose === 'mutation-workspace-allocation');
    assert.ok(allocation.input.directory);
    assert.notEqual(allocation.input.directory, root);
    const deletion = intents.find(value => value.purpose === 'mutation-deletion');
    assert.equal(deletion.input.directory, allocation.input.directory);
    const checks = events.filter(value => value.stage === 'complete' && value.result?.evidence?.requested?.bin === process.execPath);
    assert.equal(checks.length, 2);
    assert.equal(checks[0].result.evidence.cwd, root);
    assert.equal(checks[1].result.evidence.cwd, allocation.input.directory);
    assert.notEqual(checks[0].result.evidence.codeIdentity, checks[1].result.evidence.codeIdentity);
    assert.match(checks[1].result.stdout, /uro mutation deleted ret/);
    assert.equal(readFileSync(join(root, 'work.js'), 'utf8'), original);
    assert.equal(existsSync(allocation.input.directory), false);
    assert.equal(result.examined[0].testResult.workspace.cleanup.status, 'completed');
  });
});

test('mutation observable overlay excludes live journal appends while retaining selected reviewer test bytes', async () => {
  await withObservedMutation(async ({ root, plan, effects, events }) => {
    mkdirSync(join(root, '__uro_dialogue'));
    writeFileSync(join(root, '__uro_dialogue', 'journal.jsonl'), 'initial journal');
    mkdirSync(join(root, '__uro_review'));
    writeFileSync(join(root, '__uro_review', 'selected.test.cjs'), "require('../work.js'); console.log('selected reviewer test ran');");
    plan.tests = ['__uro_review/selected.test.cjs'];
    plan.testsByFile['work.js'] = plan.tests;
    const runEffect = effects.run;
    effects.run = async request => {
      if (request.purpose === 'mutation-overlay') writeFileSync(join(root, '__uro_dialogue', 'journal.jsonl'), 'owner appended after intent');
      if (request.purpose === 'mutation-deletion') {
        assert.equal(existsSync(join(request.input.directory, '__uro_dialogue', 'journal.jsonl')), false);
        assert.equal(readFileSync(join(request.input.directory, '__uro_review', 'selected.test.cjs'), 'utf8'), "require('../work.js'); console.log('selected reviewer test ran');");
      }
      return runEffect(request);
    };
    const result = await runMutate({ plan, effects, tests: { command: { bin: process.execPath, args: ['__uro_review/selected.test.cjs'] } } });
    assert.equal(result.survivors.length, 1);
    assert.match(result.examined[0].testResult.stdout, /selected reviewer test ran/);
    assert.equal(events.find(e => e.purpose === 'mutation-overlay').input.files.some(f => f.path.startsWith('__uro_dialogue/')), false);
  });
});

test('mutation observable overlay still refuses source bytes changed after intent', async () => {
  await withObservedMutation(async ({ root, plan, effects }) => {
    const runEffect = effects.run;
    writeFileSync(join(root, 'work.js'), 'module.exports = function work() {\n  return 2;\n};\n');
    effects.run = async request => {
      if (request.purpose === 'mutation-overlay') writeFileSync(join(root, 'work.js'), 'unowned post-intent source');
      return runEffect(request);
    };
    await assert.rejects(runMutate({ plan, effects }), /mutation overlay source changed after intent/);
  });
});

test('mutation observable selected reviewer test keeps its sibling support module', async () => {
  await withObservedMutation(async ({ root, plan, effects }) => {
    mkdirSync(join(root, '__uro_review'));
    writeFileSync(join(root, '__uro_review', 'selected.test.cjs'), "require('../work.js'); require('./helper.cjs'); console.log('support loaded');");
    writeFileSync(join(root, '__uro_review', 'helper.cjs'), 'module.exports = true;');
    plan.tests = ['__uro_review/selected.test.cjs']; plan.testsByFile['work.js'] = plan.tests;
    const result = await runMutate({ plan, effects, tests: { command: { bin: process.execPath, args: ['__uro_review/selected.test.cjs'] } } });
    assert.equal(result.baseline.passed, true);
    assert.equal(result.survivors.length, 1, 'missing support cannot be misclassified as killing a mutant');
    assert.match(result.examined[0].testResult.stdout, /support loaded/);
  });
});

test('mutation observable support inventory rejects stale escaping and nonregular files', async () => {
  for (const kind of ['stale', 'escape', 'directory', 'metadata']) await withObservedMutation(async ({ root, plan, effects, events }) => {
    mkdirSync(join(root, '__uro_review', 'tests'), { recursive: true });
    const path = kind === 'escape' ? '__uro_review/tests/../../work.js' : kind === 'metadata' ? '__uro_review/REVIEW.md' : '__uro_review/tests/helper.cjs';
    if (kind === 'directory') mkdirSync(join(root, path));
    else if (kind !== 'escape') writeFileSync(join(root, path), 'module.exports = true;');
    effects.testSupportFiles = [{ path, sha256: 'not-the-source-digest' }];
    await assert.rejects(runMutate({ plan, effects, tests: { command: { bin: process.execPath, args: ['check.cjs'] } } }),
      /support|regular file|unsafe review destination/);
    assert.equal(events.some(event => event.purpose === 'mutation-deletion'), false);
  });
});

test('mutation effect rejection before allocation and baseline sink loss prevent later work', async () => {
  for (const stage of ['allocation', 'baseline-result']) await withObservedMutation(async ({ root, plan, effects, events }) => {
    const record = effects.run;
    effects.run = async request => {
      if (stage === 'allocation' && request.purpose === 'mutation-workspace-allocation') {
        assert.equal(existsSync(request.input.parent), false);
        throw new Error('allocation preparation refused');
      }
      const result = await record(request);
      if (stage === 'baseline-result' && request.purpose === 'mutation-baseline') throw new Error('baseline result sink lost');
      return result;
    };
    await assert.rejects(runMutate({ target: root, plan, effects }), stage === 'allocation' ? /allocation preparation refused/ : /baseline result sink lost/);
    assert.equal(events.some(value => value.purpose === 'mutation-deletion'), false);
    if (stage === 'baseline-result') assert.equal(events.some(value => value.purpose === 'mutation-workspace-allocation'), false);
  });
});

test('mutation required concurrent sink loss settles owned cleanup and preserves each trial observation', async () => {
  await withObservedMutation(async ({ root, plan, effects, events }) => {
    plan.statements.push(statement('second', 1, { path: 'work.js', content: 'module.exports = function work() {', functionName: 'second' }));
    let lost = false;
    const record = effects.run;
    effects.run = async request => {
      if (lost) throw new Error('required store unavailable');
      const result = await record(request);
      if (request.purpose === 'mutation-trial-test') { lost = true; throw new Error('trial result sink lost'); }
      return result;
    };
    const error = await runMutate({ target: root, plan, effects, concurrency: 2,
      tests: { command: { bin: process.execPath, args: ['check.cjs'] } } }).then(() => null, error => error);
    assert.equal(error?.mutationRequired, true);
    assert.equal(error.mutationTrials.length, 2);
    const allocated = events.filter(event => event.purpose === 'mutation-workspace-allocation');
    assert.equal(allocated.length, 2);
    assert.equal(new Set(error.mutationTrials.map(trial => trial.state?.directory)).size, 2);
    for (const entry of allocated) assert.equal(existsSync(entry.input.parent), false, 'owned cleanup finishes despite failed recording');
    assert.ok(error.mutationTrials.some(trial => trial.state.cleanup.recording === 'unrecorded'));
  });
});

test('mutation primary trial error and failed cleanup retain exact disposable directory', async () => {
  await withObservedMutation(async ({ root, plan, effects, git }) => {
    let retained;
    try {
      const error = await runMutate({ target: root, plan, effects,
        tests: { command: { bin: process.execPath, args: ['check.cjs'] } },
        adapters: { runCommand: async (bin, args, options) => {
          if (bin === process.execPath && options.cwd !== root) throw new Error('trial launch failed');
          if (bin === 'git' && args.includes('remove')) return spawnCapture(process.execPath, ['-e', "console.error('fixture removal failed');process.exitCode=9"], options);
          return spawnCapture(bin, args, options);
        } } }).then(() => null, error => error);
      assert.match(error.message, /trial launch failed/);
      retained = error.mutationState;
      assert.equal(retained.primaryError, 'trial launch failed');
      assert.equal(retained.cleanup.status, 'failed');
      assert.equal(retained.cleanup.retained, true);
      assert.equal(retained.cleanup.registered, true);
      assert.match(retained.cleanup.errors.map(error => error.message).join('\n'), /fixture removal failed/);
      assert.match(readFileSync(join(retained.directory, 'work.js'), 'utf8'), /uro mutation deleted ret/);
      assert.doesNotMatch(readFileSync(join(root, 'work.js'), 'utf8'), /uro mutation deleted/);
    } finally {
      if (retained?.directory) git('worktree', 'remove', '--force', retained.directory);
      if (retained?.parent && dirname(retained.parent) === realpathSync.native(tmpdir())) rmSync(retained.parent, { recursive: true, force: true });
    }
  });
});

test('mutation missing command identity is a required failure before launch', async () => {
  await withObservedMutation(async ({ root, plan, effects, events }) => {
    effects.codeIdentity = async () => { throw new Error('actual source identity lost'); };
    const error = await runMutate({ target: root, plan, effects }).then(() => null, error => error);
    assert.equal(error?.mutationRequired, true);
    assert.match(error.message, /actual source identity lost/);
    assert.equal(events.length, 0);
  });
});

test('mutation command refuses changed code after effect preparation before launching', async () => {
  await withObservedMutation(async ({ root, plan, effects, events }) => {
    const record = effects.run;
    effects.run = async request => {
      if (request.purpose === 'mutation-baseline') writeFileSync(join(root, 'work.js'), 'changed after intent');
      return record(request);
    };
    const error = await runMutate({ target: root, plan, effects }).then(() => null, error => error);
    assert.equal(error?.mutationRequired, true);
    assert.match(error.message, /code identity changed/);
    assert.equal(events.some(event => event.stage === 'complete'), false);
  });
});

test('mutation required effects reject opaque adapters before any operation', async () => {
  await withObservedMutation(async ({ root, plan, effects, events }) => {
    for (const key of ['runTests', 'runTrial', 'createWorkspace']) {
      const error = await runMutate({ target: root, plan, effects, adapters: { [key]: async () => { throw new Error('must not enter'); } } }).then(() => null, error => error);
      assert.equal(error?.mutationRequired, true);
      assert.match(error.message, /opaque/);
      assert.equal(events.length, 0);
    }
  });
});

test('mutation dependency linking and unlinking expose the actual owned paths', async () => {
  await withObservedMutation(async ({ root, plan, effects, events }) => {
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'fixture'), 'retained dependency');
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    const result = await runMutate({ target: root, plan, effects });
    const link = events.find(event => event.purpose === 'mutation-dependency-link');
    const unlink = events.find(event => event.purpose === 'mutation-dependency-unlink');
    assert.equal(link.input.source, join(root, 'node_modules'));
    assert.equal(unlink.input.path, link.input.destination);
    assert.equal(result.examined[0].testResult.workspace.cleanup.status, 'completed');
    assert.equal(readFileSync(join(root, 'node_modules', 'fixture'), 'utf8'), 'retained dependency');
  });
});

test('runSelectedTests never classifies a timed-out command as a survivor', async () => {
  const result = await runSelectedTests({ cwd: process.cwd(), tests: ['fixture'],
    runCommand: async () => ({ code: 0, timedOut: true, stdout: '', stderr: '' }) });
  assert.equal(result.passed, false);
  assert.equal(result.timedOut, true);
});

test('mutation overlay refuses an escaped disposable destination before changing external bytes', async () => {
  await withObservedMutation(async ({ root, plan, effects, git }) => {
    const external = mkdtempSync(join(tmpdir(), 'uro-mutation-external-'));
    try {
      writeFileSync(join(external, 'work.js'), 'external fixture must remain');
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'work.js'), 'old fixture');
      git('add', '-A'); git('-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-qm', 'nested base');
      writeFileSync(join(root, 'src', 'work.js'), 'new overlay bytes');
      const record = effects.run;
      effects.run = async request => {
        if (request.purpose === 'mutation-overlay') {
          const destination = join(request.input.directory, 'src');
          rmSync(destination, { recursive: true, force: true });
          symlinkSync(external, destination, process.platform === 'win32' ? 'junction' : 'dir');
        }
        return record(request);
      };
      const error = await runMutate({ target: root, plan, effects }).then(() => null, error => error);
      assert.ok(error);
      assert.equal(readFileSync(join(external, 'work.js'), 'utf8'), 'external fixture must remain');
    } finally { rmSync(external, { recursive: true, force: true }); }
  });
});

test('mutation provider hooks preserve both real Codex role results and reject before paid launch', async () => {
  await withObservedMutation(async ({ root, plan, effects, events }) => {
    const provider = join(root, 'seat.cjs'), counter = join(root, 'launches');
    writeFileSync(provider, `let input='';process.stdin.on('data',v=>input+=v);process.stdin.on('end',()=>{
      require('node:fs').appendFileSync(${JSON.stringify(counter)},'1');
      const value=input.includes('# Mutation grouping')?{units:[{name:'return',statementIds:['ret']}]}:{verdict:'acceptable',reasoning:'Fixture evidence'};
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}}));
      console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:5,output_tokens:2}}));
    });`);
    const config = { cwd: root, runSeat: (_bin, _args, options) => spawnCapture(process.execPath, [provider], options) };
    const options = { target: root, plan, effects, tests: { command: { bin: process.execPath, args: ['check.cjs'] } },
      judge: createMutationJudge(config), arbiter: createMutationArbiter(config) };
    const result = await runMutate(options);
    assert.equal(result.grouping.judged, true);
    assert.equal(result.survivors[0].judgement.verdict, 'acceptable');
    assert.equal(readFileSync(counter, 'utf8'), '11');
    const providers = events.filter(event => event.effect === 'provider');
    assert.deepEqual(providers.map(event => event.purpose), ['mutation-grouping', 'mutation-survivor']);
    for (const provider of providers) {
      const done = events.find(event => event.stage === 'complete' && event.key === provider.key);
      assert.equal(done.result.usage.inputTokens, 5);
      assert.equal(done.result.usage.outputTokens, 2);
      assert.equal(done.result.requestedLaunch.bin, 'codex');
      assert.equal(done.result.delivery.sha256, createHash('sha256').update(provider.input.input).digest('hex'));
    }
    effects.run = async request => { if (request.effect === 'provider') throw new Error('provider intent refused'); return request.operation(); };
    const error = await runMutate(options).then(() => null, error => error);
    assert.equal(error.mutationRequired, true);
    assert.equal(readFileSync(counter, 'utf8'), '11');
  });
});

test('mutation auxiliary transports retain actual launch, submitted input and usage for both Codex roles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-mutation-transport-'));
  try {
    const child = join(root, 'seat.cjs');
    writeFileSync(child, `let input=''; process.stdin.on('data', value => input += value); process.stdin.on('end', () => {
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({units:[],verdict:'acceptable',reasoning:'Observed fixture'})}}));
      console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:7,output_tokens:3}}));
    });`);
    for (const factory of [createMutationJudge, createMutationArbiter]) {
      const seat = factory({ cwd: root, runSeat: (_bin, _args, options) => spawnCapture(process.execPath, [child], options) });
      const result = await seat({ statements: [] });
      assert.equal(result.usage?.inputTokens, 7);
      assert.equal(result.usage?.outputTokens, 3);
      assert.equal(result.requestedLaunch?.bin, 'codex');
      assert.ok(result.requestedLaunch.args.includes('read-only'));
      assert.deepEqual(result.launch?.argv, [process.execPath, child]);
      assert.equal(result.launch.cwd, root);
      assert.equal(result.delivery?.kind, 'stdin-submitted');
      assert.ok(result.delivery.bytes > 100);
      assert.equal(result.delivery.consumption, 'unknown');
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /turn.completed/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mutation failed launch preserves requested transport and unknown usage', async () => {
  const seat = createMutationJudge({ cwd: process.cwd(), bin: join(tmpdir(), 'missing-uro-mutation-provider'), runSeat: spawnCapture });
  const result = await seat({ statements: [] });
  assert.equal(result.available, false);
  assert.equal(result.usage, null);
  assert.equal(result.launch, null);
  assert.equal(result.requestedLaunch.cwd, process.cwd());
  assert.match(result.reason, /could not start/);
});

test('mutation required command evidence records actual command bytes and stops on sink loss', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-mutation-evidence-'));
  try {
    const counter = join(root, 'counter');
    const child = join(root, 'check.cjs');
    writeFileSync(child, `require('node:fs').appendFileSync(${JSON.stringify(counter)}, '1'); console.log('full stdout'); console.error('full stderr'); process.exitCode=4;`);
    const captured = [];
    const result = await runSelectedTests({ cwd: root, tests: ['check.cjs'], command: { bin: process.execPath, args: [child] },
      requiredEvidence: true, codeIdentity: async () => 'actual-fixture-code', onEvidence: async value => { captured.push(value); } });
    assert.equal(result.passed, false);
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0].argv, [process.execPath, child]);
    assert.equal(captured[0].cwd, root);
    assert.equal(captured[0].codeIdentity, 'actual-fixture-code');
    assert.equal(captured[0].exitCode, 4);
    assert.equal(captured[0].status, 'completed');
    assert.equal(captured[0].stdout.trim(), 'full stdout');
    assert.equal(captured[0].stderr.trim(), 'full stderr');
    await assert.rejects(runSelectedTests({ cwd: root, tests: ['check.cjs'], command: { bin: process.execPath, args: [child] },
      requiredEvidence: true, codeIdentity: async () => 'actual-fixture-code', onEvidence: async () => { throw new Error('required sink lost'); } }), /required sink lost/);
    assert.equal(readFileSync(counter, 'utf8'), '11');
    await assert.rejects(runSelectedTests({ cwd: root, tests: ['check.cjs'], command: { bin: process.execPath, args: [child] },
      requiredEvidence: true, onEvidence: async () => {} }), /code identity/);
    assert.equal(readFileSync(counter, 'utf8'), '11', 'missing provenance prevents another command');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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

test('the mutation judge keeps the verified Codex registry and inherited launch environment', async () => {
  const env = { CODEX_HOME: 'C:/registered-mutation-home' };
  let launchOptions;
  const judge = createMutationJudge({
    cwd: process.cwd(),
    env,
    runSeat: async (_bin, _args, options) => {
      launchOptions = options;
      return {
        code: 0,
        stdout: `${JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: JSON.stringify({ units: [] }) },
        })}\n`,
      };
    },
  });

  await judge({ statements: [] });
  assert.equal(launchOptions.env.CODEX_HOME, env.CODEX_HOME);
  assert.equal(launchOptions.env[Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH'], process.env[Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH']);
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
  const scratchBase = process.env.URO_TEST_SCRATCH_ROOT ?? (process.platform === 'win32' ? 'C:/ccc-test' : tmpdir());
  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(join(scratchBase, 'uro-mutate-run-wiring-'));
  const target = join(root, 'target');
  mkdirSync(target, { recursive: true });
  const order = [];
  const envelope = (r, action, extra = {}) => ({ schemaVersion: 1, action, artifactDigest: r.state.artifactDigest,
    contextDigest: r.state.snapshot.digest, replyTo: null, content: 'Review the actual optional measurement',
    claims: [], issues: [], evidence: [], verifications: [], next: null, ...extra });
  execFileSync('git', ['init', '-q', target]);
  execFileSync('git', ['-C', target, 'config', 'core.autocrlf', 'false']);
  writeFileSync(join(target, 'work.js'), 'module.exports = function work() {\n  return 1;\n};\n');
  writeFileSync(join(target, 'work.test.cjs'), "require('./work.js'); console.log('real advisory command');");
  execFileSync('git', ['-C', target, 'add', '.']);
  execFileSync('git', ['-C', target, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'base']);
  try {
    const facts = await run({
      task: 'exercise advisory mutation wiring',
      target,
      gate: [],
      gateRetries: 0,
      scratchRoot: join(root, 'scratch'),
      artifactRoot: join(root, 'artifacts'),
      runId: 'mutation-wiring',
      mode: 'autonomous',
      mutation: { budget: 1, concurrency: 1, tests: { command: { bin: process.execPath, args: ['work.test.cjs'] } } },
      adapters: {
        runExecutor: async r => {
          order.push('executor');
          writeFileSync(join(r.cwd, 'work.js'), 'module.exports = function work() {\n  return 2;\n};\n');
          return { exitCode: 0, usage: { inputTokens: 1, outputTokens: 1 }, dialogue: envelope(r, r.action) };
        },
        runGate: async request => {
          order.push('gate');
          return runGate(request);
        },
        runReview: async r => {
          order.push('reviewer');
          const item = r.state.evidence.find(e => e.id === 'requirement-briefing');
          const receipt = createInspectionReceipt({ operationId: r.operationId, seat: 'claude', evidence: [item], inspected: true, result: 'read' });
          assert.ok(r.state.evidence.some(e => e.mutation?.purpose === 'mutation-trial-test'));
          return { usage: { inputTokens: 1, outputTokens: 1 }, observations: { evidence: [], receipts: [receipt] }, dialogue: envelope(r, 'approve', {
            claims: [{ id: 'briefing-requirement', kind: 'fact', text: 'Saved briefing is present.', evidenceIds: [item.id] }],
            verifications: [{ claimId: 'briefing-requirement', evidenceIds: [item.id], inspectionReceiptIds: [receipt.id], result: 'supports', reason: 'Read saved briefing' }] }) };
        },
        runMutationSeat: (bin, args, opts) => {
          if (!order.includes('mutation')) order.push('mutation');
          return spawnCapture(process.execPath, ['-e', `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
            const value=JSON.parse(input.trim().split('\\n').at(-1));
            const answer=input.includes('# Mutation grouping judge') ? {units:[{name:'changed return',statementIds:value.statements.map(s=>s.id)}]} : {verdict:'gap',reasoning:'A surviving advisory measurement'};
            console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(answer)}}));
            console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));});`], opts);
        },
      },
    });
    assert.deepEqual(order, ['executor', 'gate', 'mutation', 'reviewer']);
    assert.equal(facts.outcome, 'review-ready');
    assert.equal(facts.mutation.survivors.length, 1);
    assert.equal(facts.mutation.grouping.judged, true);
    assert.match(readFileSync(join(facts.dir, 'uro-report.md'), 'utf8'), /Mutation survivors:\*\* 1/);
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
  assert.deepEqual(pairs,
    ['mutate/finish', 'mutate/stalled', 'mutate/start', 'mutate/survivor', 'mutate/unit']);
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
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Mutation dry run: \d+ unit\(s\); no commands executed\./);
    assert.match(result.stdout, /"status": "dry-run"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function withMutationRepository(callback) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'uro-mutate-path-')));
  const root = join(directory, 'canonical-repository');
  const alias = join(directory, 'alias-repository');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  try {
    mkdirSync(root);
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');
    for (const folder of ['src', 'other', '..data']) {
      mkdirSync(join(root, folder));
      writeFileSync(join(root, folder, 'work.js'), 'export function work() {\n  return 1;\n}\n');
    }
    git('add', '-A');
    git('-c', 'user.email=test@example.com', '-c', 'user.name=uro test', 'commit', '-qm', 'base');
    for (const folder of ['src', 'other', '..data']) {
      writeFileSync(join(root, folder, 'work.js'),
        'export function work() {\n  recordFact();\n  return 1;\n}\n');
      writeFileSync(join(root, folder, 'new.js'), 'export function added() {\n  return 2;\n}\n');
    }
    await callback({ root, alias, directory });
  } finally {
    // Remove the known link itself before deleting this owned fixture directory.
    if (existsSync(alias)) unlinkSync(alias);
    rmSync(directory, { recursive: true, force: true });
  }
}

test('mutation discovery accepts an aliased repository root', async () => {
  await withMutationRepository(async ({ root, alias }) => {
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const plan = await discoverMutationPlan({ target: alias });
    assert.equal(plan.scopedPath, '.');
    assert.equal(plan.target, alias, 'reported target retains the caller\'s spelling');
    assert.deepEqual(plan.changedFiles.toSorted(), [
      '..data/new.js', '..data/work.js', 'other/new.js', 'other/work.js', 'src/new.js', 'src/work.js',
    ]);
  });
});

test('mutation discovery confines aliased subdirectories to their tracked and untracked changes', async () => {
  await withMutationRepository(async ({ root, alias }) => {
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const plan = await discoverMutationPlan({ target: join(alias, 'src') });
    assert.equal(plan.scopedPath, 'src');
    assert.deepEqual(plan.changedFiles.toSorted(), ['src/new.js', 'src/work.js']);
    assert.doesNotMatch(plan.diff, /(?:other|\.\.data)\//);
  });
});

test('mutation discovery accepts real Windows short paths without widening a subtree', {
  skip: process.platform !== 'win32',
}, async (t) => {
  await withMutationRepository(async ({ root }) => {
    const short = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '$taskFso = New-Object -ComObject Scripting.FileSystemObject; $taskFso.GetFolder($env:URO_TEST_ALIAS_TARGET).ShortPath',
    ], { encoding: 'utf8', env: { ...process.env, URO_TEST_ALIAS_TARGET: root } }).trim();
    if (resolve(short).toLowerCase() === root.toLowerCase()) {
      t.skip('this volume does not expose a distinct Windows 8.3 path');
      return;
    }
    assert.equal(realpathSync.native(short).toLowerCase(), root.toLowerCase());
    const whole = await discoverMutationPlan({ target: short });
    assert.equal(whole.scopedPath, '.');
    assert.equal(whole.changedFiles.length, 6);
    assert.equal(whole.target, resolve(short));
    const subtree = await discoverMutationPlan({ target: join(short, 'src') });
    assert.deepEqual(subtree.changedFiles.toSorted(), ['src/new.js', 'src/work.js']);
    assert.doesNotMatch(subtree.diff, /(?:other|\.\.data)\//);
  });
});

test('mutation discovery rejects a target outside the discovered root before reading changes', async () => {
  await withMutationRepository(async ({ root, directory }) => {
    const unrelatedRoot = join(directory, 'unrelated-repository');
    mkdirSync(unrelatedRoot);
    const commands = [];
    await assert.rejects(discoverMutationPlan({
      target: join(root, 'src'),
      runCommand: async (bin, args) => {
        assert.equal(bin, 'git');
        commands.push(args[2]);
        if (args[2] !== 'rev-parse') throw new Error('Git change discovery reached an unrelated root');
        return { code: 0, stdout: `${unrelatedRoot}\n`, stderr: '' };
      },
    }), /target is outside repository/);
    assert.deepEqual(commands, ['rev-parse']);
  });
});

test('mutation discovery permits a legitimate directory beginning with two dots', async () => {
  await withMutationRepository(async ({ root }) => {
    const plan = await discoverMutationPlan({ target: join(root, '..data') });
    assert.equal(plan.scopedPath, '..data');
    assert.deepEqual(plan.changedFiles.toSorted(), ['..data/new.js', '..data/work.js']);
  });
});

test('a golden fixture under test/ is not selected as a runnable test', () => {
  // `loop mutate` selected test/golden/dashboard-board.html because the path
  // has a "test" segment and its stem matched the changed src/dashboard-board.js.
  // node --test then tried to execute the HTML, the baseline went red, and the
  // whole mutation run refused to start.
  assert.equal(isTestFile('test/golden/dashboard-board.html'), false);
  assert.equal(isTestFile('test/golden/doctor-all-pass.txt'), false);
  assert.equal(isTestFile('test/fixtures/sample.json'), false);

  // Narrowness control: real tests must still be found, by segment and by name.
  assert.equal(isTestFile('test/dashboard-board.test.js'), true);
  assert.equal(isTestFile('test/plan.test.js'), true);
  assert.equal(isTestFile('src/thing.spec.ts'), true);
  assert.equal(isTestFile('__tests__/helper.mjs'), true);
});

test('selectTouchingTests never hands a non-runnable fixture to the test command', () => {
  const files = [
    'src/dashboard-board.js',
    'test/dashboard-board.test.js',
    'test/golden/dashboard-board.html',
  ];
  const selected = selectTouchingTests({
    root: process.cwd(), changedFiles: ['src/dashboard-board.js'], files,
  });
  assert.ok(selected.includes('test/dashboard-board.test.js'));
  assert.equal(selected.includes('test/golden/dashboard-board.html'), false,
    'a golden fixture must never reach `node --test`');
});

test('a unit with no selected tests is unexamined, never a survivor', async () => {
  // Measured: `loop mutate` reported four fixtures/*.mjs units as survivors
  // after running ZERO tests for each. A trial with no tests cannot fail, so
  // "survived" asserted every line was untested on no evidence — and the
  // arbiter then judged all four a gap.
  await withPlan([statement('untouched', 2, { path: 'src/work.js' })], async (plan) => {
    let trials = 0;
    const result = await runMutate({
      target: plan.root,
      plan: { ...plan, tests: [], testsByFile: { 'src/work.js': [] } },
      adapters: {
        runTests: greenBaseline,
        runTrial: async () => { trials++; return { passed: true, code: 0 }; },
      },
    });

    assert.equal(result.survivors.length, 0, 'a zero-test unit must not be a survivor');
    assert.equal(result.unexamined.length, 1);
    assert.match(result.unexamined[0].reason, /no selected test/i);
    assert.equal(trials, 0, 'a trial with no tests must not be run at all');
  });
});
