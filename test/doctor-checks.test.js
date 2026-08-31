import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCTOR_CHECKS } from '../src/doctor-checks.js';
import { runDoctor } from '../src/doctor.js';

const fakeGit = fileURLToPath(new URL('../fixtures/fake-doctor-git.mjs', import.meta.url));
const fakeCodex = fileURLToPath(new URL('../fixtures/fake-doctor-codex.mjs', import.meta.url));
const fakeAgent = fileURLToPath(new URL('../fixtures/fake-doctor-agent.mjs', import.meta.url));
const fakeClaude = fileURLToPath(new URL('../fixtures/fake-doctor-claude.mjs', import.meta.url));
const fakeGh = fileURLToPath(new URL('../fixtures/fake-doctor-gh.mjs', import.meta.url));
const SAFE_TEST_BASE = process.env.URO_TEST_SCRATCH_ROOT ?? (process.platform === 'win32'
  ? 'C:/tmp'
  : tmpdir());
const SAFE_TEST_ROOT = join(SAFE_TEST_BASE, '.ccc-doctor-registry-tests');

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function writeFakeBin(directory, name, script) {
  if (process.platform === 'win32') {
    const path = join(directory, `${name}.cmd`);
    writeFileSync(path, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return path;
  }
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

function createPassingFixture() {
  mkdirSync(SAFE_TEST_ROOT, { recursive: true });
  const root = mkdtempSync(join(SAFE_TEST_ROOT, 'ccc-doctor-golden-pass-'));
  const binRoot = join(root, 'bin');
  const repository = join(root, 'repository');
  mkdirSync(binRoot);
  mkdirSync(repository);
  const blocklist = join(root, 'publish-blocklist.txt');
  writeFileSync(blocklist, 'confidential-customer\n# Comments are ignored.\ninternal-project\n');
  const superpowers = join(root, 'superpowers');
  mkdirSync(join(superpowers, '.cursor-plugin'), { recursive: true });
  mkdirSync(join(superpowers, '.claude-plugin'), { recursive: true });
  mkdirSync(join(superpowers, 'skills', 'using-superpowers'), { recursive: true });
  const manifest = JSON.stringify({ name: 'superpowers', version: '6.0.2' });
  writeFileSync(join(superpowers, '.cursor-plugin', 'plugin.json'), manifest);
  writeFileSync(join(superpowers, '.claude-plugin', 'plugin.json'), manifest);
  writeFileSync(join(superpowers, 'skills', 'using-superpowers', 'SKILL.md'), '# skill\n');
  return {
    root,
    superpowers,
    scratchRoot: join(root, 'scratch'),
    repository,
    bins: {
      git: writeFakeBin(binRoot, 'golden-git', fakeGit),
      codex: writeFakeBin(binRoot, 'golden-codex', fakeCodex),
      agent: writeFakeBin(binRoot, 'golden-agent', fakeAgent),
      claude: writeFakeBin(binRoot, 'golden-claude', fakeClaude),
      gh: writeFakeBin(binRoot, 'golden-gh', fakeGh),
      gitleaks: writeFakeBin(binRoot, 'golden-gitleaks', fakeGh),
      trufflehog: writeFakeBin(binRoot, 'golden-trufflehog', fakeGh),
      logdy: writeFakeBin(binRoot, 'golden-logdy', fakeGh),
      environment: {
        URO_PUBLISH_BLOCKLIST: blocklist,
        URO_SUPERPOWERS_DIR: superpowers,
      },
    },
  };
}

function createFailingFixture() {
  mkdirSync(SAFE_TEST_ROOT, { recursive: true });
  const root = mkdtempSync(join(SAFE_TEST_ROOT, 'ccc-doctor-golden-fail-'));
  const repository = join(root, 'repository');
  mkdirSync(repository);
  return {
    root,
    scratchRoot: join(root, 'AppData', 'scratch'),
    repository,
    bins: {
      git: 'ccc-doctor-golden-missing-git-7e57',
      codex: 'ccc-doctor-golden-missing-codex-7e57',
      agent: 'ccc-doctor-golden-missing-agent-7e57',
      claude: 'ccc-doctor-golden-missing-claude-7e57',
      gh: 'ccc-doctor-golden-missing-gh-7e57',
      gitleaks: 'ccc-doctor-golden-missing-gitleaks-7e57',
      trufflehog: 'ccc-doctor-golden-missing-trufflehog-7e57',
      logdy: 'ccc-doctor-golden-missing-logdy-7e57',
      environment: {},
    },
  };
}

function golden(name, replacements) {
  const path = fileURLToPath(new URL(`./golden/${name}`, import.meta.url));
  let expected = readFileSync(path, 'utf8');
  for (const [key, value] of Object.entries(replacements)) {
    expected = expected.replaceAll(`{{${key}}}`, value);
  }
  assert.doesNotMatch(expected, /{{[^}]+}}/, 'every golden placeholder must be replaced');
  return expected;
}

function assertGoldenEquality(actual, expected) {
  assert.equal(actual, expected);
}

function assertMatchingLeadingAndTrailingVerdicts(output, expectedVerdict) {
  const lines = output.trimEnd().split('\n');
  const verdicts = lines.filter((line) => /^Loop (?:core )?health:/.test(line));
  assert.equal(lines[0], 'uroboros doctor');
  assert.equal(lines[1], expectedVerdict,
    'the health verdict must appear immediately after the doctor header');
  assert.ok(lines.slice(0, 3).includes(expectedVerdict),
    'the health verdict must appear within the first three output lines');
  assert.deepEqual(verdicts, [expectedVerdict, expectedVerdict],
    'the leading and trailing health verdicts must agree');
}

function removeFixture(root) {
  rmSync(root, { recursive: true, force: true });
  try { rmdirSync(SAFE_TEST_ROOT); } catch { /* Another fixture may still own the parent. */ }
}

function doctorCheck(id) {
  const check = DOCTOR_CHECKS.find((candidate) => candidate.id === id);
  assert.ok(check, `doctor registry must contain ${id}`);
  return check;
}

test('doctor registry has every prerequisite id and exactly four auto-fixable checks', () => {
  const requiredPrerequisiteIds = [
    'node-version',
    'git-usable',
    'codex-cli-installed',
    'codex-signed-in',
    'cursor-agent-installed',
    'cursor-signed-in',
    'claude-cli-installed',
    'claude-signed-in',
    'scratch-root-location',
    'scratch-root-writable',
    'superpowers-codex',
    'superpowers-cursor',
    'superpowers-claude',
  ];
  assert.ok(DOCTOR_CHECKS.length > 0, 'the registry must not be empty');
  const ids = DOCTOR_CHECKS.map((check) => check.id);
  for (const id of requiredPrerequisiteIds) {
    assert.ok(ids.includes(id), `the registry must include ${id}`);
  }
  assert.equal(new Set(ids).size, ids.length, 'registry ids must be unique');
  for (const check of DOCTOR_CHECKS) {
    assert.match(check.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(check.kind === 'required' || check.kind === 'optional');
    assert.equal(typeof check.name, 'string');
    assert.equal(typeof check.probe, 'function');
    assert.equal(typeof check.remediation.prose, 'string');
    assert.ok(Object.hasOwn(check.remediation, 'command'));
    assert.equal(typeof check.remediation.autoFixable, 'boolean');
    const { command } = check.remediation;
    if (command?.type === 'spawn') {
      assert.equal(typeof command.binary, 'string');
      assert.ok(Array.isArray(command.args));
    } else if (command?.type === 'shell') {
      assert.equal(typeof command.command, 'string');
      assert.equal(typeof command.platform, 'string');
    } else if (command?.type === 'mkdir') {
      assert.deepEqual(command.path, { from: 'input', name: 'scratchRoot' });
      assert.equal(command.recursive, true);
    } else {
      assert.equal(command, null);
    }
  }
  assert.deepEqual(
    DOCTOR_CHECKS.filter((check) => check.remediation.autoFixable).map((check) => check.id).sort(),
    ['codex-cli-installed', 'cursor-agent-installed', 'scratch-root-writable', 'superpowers-codex'],
  );
  assert.ok(
    DOCTOR_CHECKS.filter((check) => check.kind === 'optional')
      .every((check) => check.remediation.autoFixable === false),
    'every optional check must explicitly remain non-auto-fixable',
  );
  assert.deepEqual(
    DOCTOR_CHECKS.filter((check) => check.id.startsWith('publish-guard-'))
      .map(({ id, phase, kind, remediation }) => ({
        id,
        phase,
        kind,
        autoFixable: remediation.autoFixable,
      })),
    [
      { id: 'publish-guard-gitleaks', phase: 'optional', kind: 'optional', autoFixable: false },
      { id: 'publish-guard-blocklist', phase: 'optional', kind: 'optional', autoFixable: false },
      { id: 'publish-guard-trufflehog', phase: 'optional', kind: 'optional', autoFixable: false },
    ],
  );
});

test('publish guard gitleaks passes when present and fails with actionable remediation when absent', async () => {
  const check = doctorCheck('publish-guard-gitleaks');
  const present = await check.probe({ bins: { gitleaks: process.execPath } });
  const absent = await check.probe({
    bins: { gitleaks: 'ccc-doctor-definitely-missing-gitleaks-58d9' },
  });

  assert.equal(present.status, 'PASS');
  assert.match(present.detail, /blocking publish prerequisite is satisfied/);
  assert.equal(absent.status, 'FAIL');
  assert.match(absent.detail, /publish refuses without it/);
  assert.match(check.remediation.prose, /publish refuses without `gitleaks`/);
  assert.match(check.remediation.prose, /https:\/\/github[.]com\/gitleaks\/gitleaks#installing/);
});

test('publish guard blocklist fails when URO_PUBLISH_BLOCKLIST is unset', async () => {
  const outcome = await doctorCheck('publish-guard-blocklist').probe({ bins: {}, env: {} });
  assert.equal(outcome.status, 'FAIL');
  assert.match(outcome.detail, /is not set/);
  assert.match(outcome.detail, /publish refuses/);
});

test('superpowers doctor checks verify all three seats and make each one required', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-superpowers-doctor-'));
  const codexCheck = doctorCheck('superpowers-codex');
  const cursorCheck = doctorCheck('superpowers-cursor');
  const claudeCheck = doctorCheck('superpowers-claude');
  const emptyHome = join(root, 'empty-home');
  const configured = join(root, 'configured-superpowers');
  mkdirSync(emptyHome);
  mkdirSync(join(configured, '.cursor-plugin'), { recursive: true });
  mkdirSync(join(configured, '.claude-plugin'), { recursive: true });
  mkdirSync(join(configured, 'skills', 'using-superpowers'), { recursive: true });
  const manifest = JSON.stringify({ name: 'superpowers', version: '6.0.2' });
  writeFileSync(join(configured, '.cursor-plugin', 'plugin.json'), manifest);
  writeFileSync(join(configured, '.claude-plugin', 'plugin.json'), manifest);
  writeFileSync(join(configured, 'skills', 'using-superpowers', 'SKILL.md'), '# skill\n');
  try {
    const codex = await codexCheck.probe({
      bins: { codex: 'codex' },
      spawn: async () => ({
        code: 0, timedOut: false, stderr: '',
        stdout: 'superpowers@openai-curated  installed, enabled  3fdeeb49  C:/plugin\n',
      }),
    });
    const cursor = await cursorCheck.probe({
      env: { URO_SUPERPOWERS_DIR: configured }, home: emptyHome, bins: {},
    });
    const claude = await claudeCheck.probe({
      env: { URO_SUPERPOWERS_DIR: configured }, home: emptyHome, bins: {},
    });

    assert.equal(codex.status, 'PASS');
    assert.equal(cursor.status, 'PASS');
    assert.equal(claude.status, 'PASS');
    assert.deepEqual(
      [codexCheck, cursorCheck, claudeCheck].map((check) => check.kind),
      ['required', 'required', 'required'],
    );
    assert.match(codex.detail, /installed, enabled.*3fdeeb49/i);
    assert.match(cursor.detail, /Cursor.*6[.]0[.]2/i);
    assert.match(claude.detail, /Claude.*6[.]0[.]2/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('each failing superpowers doctor check names its seat and exact remediation command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-superpowers-doctor-fail-'));
  const codexOnly = join(root, 'codex-only-superpowers');
  mkdirSync(join(codexOnly, '.codex-plugin'), { recursive: true });
  mkdirSync(join(codexOnly, 'skills', 'using-superpowers'), { recursive: true });
  writeFileSync(join(codexOnly, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'superpowers', version: '6.3.0',
  }));
  writeFileSync(join(codexOnly, 'skills', 'using-superpowers', 'SKILL.md'), '# skill\n');
  try {
    const outcomes = await Promise.all([
      doctorCheck('superpowers-codex').probe({
        bins: { codex: 'codex' },
        spawn: async () => ({
          code: 0, timedOut: false, stderr: '',
          stdout: 'superpowers@openai-curated  not installed  C:/plugin\n',
        }),
      }),
      doctorCheck('superpowers-cursor').probe({
        env: { URO_SUPERPOWERS_DIR: codexOnly }, home: root, bins: {},
      }),
      doctorCheck('superpowers-claude').probe({ env: {}, home: root, bins: {} }),
    ]);

    for (const [index, seat] of ['Codex', 'Cursor', 'Claude'].entries()) {
      const check = doctorCheck(`superpowers-${seat.toLowerCase()}`);
      assert.equal(outcomes[index].status, 'FAIL');
      assert.match(outcomes[index].detail, new RegExp(seat, 'i'));
      assert.match(check.remediation.prose, new RegExp(seat, 'i'));
    }
    assert.match(doctorCheck('superpowers-codex').remediation.prose,
      /codex plugin add superpowers@openai-curated/);
    assert.match(doctorCheck('superpowers-cursor').remediation.prose,
      /URO_SUPERPOWERS_DIR=.*[.]cursor-plugin/);
    assert.match(outcomes[1].detail, /[.]cursor-plugin/,
      'a Codex-only directory must fail Cursor verification at the manifest boundary');
    assert.match(doctorCheck('superpowers-claude').remediation.prose,
      /plugin install superpowers@superpowers-marketplace/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed required superpowers seat makes doctor unhealthy', async () => {
  const checks = ['superpowers-codex', 'superpowers-cursor', 'superpowers-claude'];
  for (const failedId of checks) {
    const seatChecks = checks.map((id) => ({
      id,
      phase: 'prerequisite',
      kind: 'required',
      name: id,
      remediation: { prose: 'fix it', command: null, autoFixable: false },
      probe: async () => ({ status: id === failedId ? 'FAIL' : 'PASS', detail: id }),
    }));
    const result = await runDoctor({
      scratchRoot: join(tmpdir(), 'uro-doctor-required-seat'),
      checks: seatChecks,
    });
    assert.equal(result.ok, false, `${failedId} must affect doctor health`);
  }
  const passing = await runDoctor({
    scratchRoot: join(tmpdir(), 'uro-doctor-required-seats-pass'),
    checks: checks.map((id) => ({
      id,
      phase: 'prerequisite',
      kind: 'required',
      name: id,
      remediation: { prose: 'fix it', command: null, autoFixable: false },
      probe: async () => ({ status: 'PASS', detail: id }),
    })),
  });
  assert.equal(passing.ok, true, 'positive control: all three verified seats permit health');
});

test('doctor remediation uses the same Codex registry environment it probed', async () => {
  const root = mkdtempSync(join(process.cwd(), '.ccc-doctor-remediation-env-'));
  const env = { CODEX_HOME: join(root, 'codex-home') };
  let remediationOptions;
  const check = {
    id: 'codex-registry-remediation-env',
    phase: 'prerequisite',
    kind: 'required',
    name: 'Codex registry remediation environment',
    remediation: {
      prose: 'Codex: codex plugin add superpowers@openai-curated',
      autoFixable: true,
      command: {
        type: 'spawn', binary: 'codex', args: ['plugin', 'add', 'superpowers@openai-curated'],
      },
    },
    probe: async () => ({ status: 'FAIL', detail: 'not installed', remediationKey: 'default' }),
  };
  try {
    await runDoctor({
      scratchRoot: root,
      checks: [check],
      fix: true,
      env,
      consent: async () => true,
      remediationExecutor: async (_command, _inputs, options) => {
        remediationOptions = options;
        return { code: 0 };
      },
    });

    assert.equal(remediationOptions.env.CODEX_HOME, env.CODEX_HOME);
    assert.equal(remediationOptions.env.PATH, process.env.PATH);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor deep seat probes keep registry overrides and the inherited launch environment', async () => {
  const root = mkdtempSync(join(process.cwd(), '.ccc-doctor-deep-env-'));
  const plugin = join(root, 'superpowers');
  for (const manifest of ['.cursor-plugin', '.claude-plugin']) {
    mkdirSync(join(plugin, manifest), { recursive: true });
    writeFileSync(join(plugin, manifest, 'plugin.json'), JSON.stringify({
      name: 'superpowers', version: '6.0.2',
    }));
  }
  mkdirSync(join(plugin, 'skills', 'using-superpowers'), { recursive: true });
  writeFileSync(join(plugin, 'skills', 'using-superpowers', 'SKILL.md'), '# skill\n');
  const env = { CODEX_HOME: join(root, 'codex-home'), URO_SUPERPOWERS_DIR: plugin };
  const calls = [];
  const spawn = async (bin, args, options) => {
    calls.push({ bin, args, options });
    if (bin === 'codex') {
      writeFileSync(join(options.cwd, 'ccc-doctor-write.txt'), 'URO_DOCTOR_WRITE_OK\n');
    }
    const stdout = bin === 'agent'
      ? readFileSync(join(options.cwd, 'ccc-doctor-read.txt'), 'utf8')
      : '';
    return { code: 0, timedOut: false, stdout, stderr: '' };
  };
  try {
    const codex = await doctorCheck('codex-write-probe').probe({
      bins: { codex: 'codex', git: 'git' },
      deep: true,
      state: { codexPresent: true, git: { usable: true }, workspace: root },
      env,
      spawn,
    });
    const cursor = await doctorCheck('cursor-read-probe').probe({
      bins: { agent: 'agent' },
      deep: true,
      state: { agentPresent: true, workspace: root },
      env,
      home: root,
      spawn,
    });

    assert.equal(codex.status, 'PASS');
    assert.equal(cursor.status, 'PASS');

    // loop mutate found this: deleting initializeProbeRepository from
    // probeCodex left the whole suite green. The write probe runs Codex inside
    // a throwaway repository, and without git init it is not a repository at
    // all, so the probe would no longer be probing what it claims to.
    // Assert on the argv arrays: the commit is invoked as
    // `git -c user.email=... -c user.name=... commit -m ...`, so a prefix match
    // on the joined string would look for "commit" and find "-c".
    const gitCalls = calls.filter(({ bin }) => bin === 'git').map(({ args }) => args ?? []);
    assert.ok(gitCalls.some((args) => args[0] === 'init'),
      'the probe repository must be initialised before Codex writes into it');
    assert.ok(gitCalls.some((args) => args[0] === 'add'),
      'the probe repository must stage its seed file');
    assert.ok(gitCalls.some((args) => args.includes('commit')),
      'the probe repository must have a commit, not an unborn branch');
    for (const call of calls.filter(({ bin }) => bin === 'codex' || bin === 'agent')) {
      assert.equal(call.options.env.CODEX_HOME, env.CODEX_HOME);
      assert.equal(call.options.env.PATH, process.env.PATH);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('publish guard blocklist fails when its injected path does not exist', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-doctor-missing-blocklist-'));
  try {
    const outcome = await doctorCheck('publish-guard-blocklist').probe({
      bins: {},
      env: { URO_PUBLISH_BLOCKLIST: join(root, 'missing.txt') },
    });
    assert.equal(outcome.status, 'FAIL');
    assert.match(outcome.detail, /could not be read/);
    assert.match(outcome.detail, /publish refuses/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('publish guard blocklist fails when it contains only blank lines and comments', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-doctor-empty-blocklist-'));
  const path = join(root, 'blocklist.txt');
  writeFileSync(path, '\n  \n# first comment\n   # indented comment\n');
  try {
    const outcome = await doctorCheck('publish-guard-blocklist').probe({
      bins: {},
      env: { URO_PUBLISH_BLOCKLIST: path },
    });
    assert.equal(outcome.status, 'FAIL');
    assert.match(outcome.detail, /contains no usable terms/);
    assert.match(outcome.detail, /publish refuses/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('publish guard blocklist passes and reports only the count for two usable terms', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-doctor-valid-blocklist-'));
  const path = join(root, 'blocklist.txt');
  writeFileSync(path, '# ignored\nfirst-confidential-value\n\n second-confidential-value \n');
  try {
    const outcome = await doctorCheck('publish-guard-blocklist').probe({
      bins: {},
      env: { URO_PUBLISH_BLOCKLIST: path },
    });
    assert.equal(outcome.status, 'PASS');
    assert.match(outcome.detail, /2 usable blocklist terms found/);
    assert.doesNotMatch(outcome.detail, /first-confidential-value|second-confidential-value/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rendered doctor output reports a blocklist count without leaking its contents', async () => {
  const fixture = createPassingFixture();
  const distinctiveTerm = 'never-render-this-confidential-identifier-9137';
  writeFileSync(
    fixture.bins.environment.URO_PUBLISH_BLOCKLIST,
    `${distinctiveTerm}\nanother-confidential-identifier\n`,
  );
  try {
    const result = await runDoctor({
      scratchRoot: fixture.scratchRoot,
      repository: fixture.repository,
      nodeVersion: '24.9.0',
      bins: fixture.bins,
    });
    assert.match(result.output, /2 usable blocklist terms found/);
    assert.doesNotMatch(result.output, new RegExp(distinctiveTerm));
  } finally {
    removeFixture(fixture.root);
  }
});

test('publish guard trufflehog is advisory when absent and passes when present', async () => {
  const check = doctorCheck('publish-guard-trufflehog');
  const absent = await check.probe({
    bins: { trufflehog: 'ccc-doctor-definitely-missing-trufflehog-58d9' },
  });
  const present = await check.probe({ bins: { trufflehog: process.execPath } });

  assert.equal(absent.status, 'FAIL');
  assert.match(absent.detail, /advisory only/);
  assert.match(absent.detail, /publish warns and proceeds/);
  assert.equal(present.status, 'PASS');
  assert.match(present.detail, /advisory publish scanning is available/);
});

test('doctor leads with the same unhealthy verdict it repeats at the tail', async () => {
  const fixture = createFailingFixture();
  try {
    const result = await runDoctor({
      deep: true,
      scratchRoot: fixture.scratchRoot,
      repository: fixture.repository,
      nodeVersion: '23.1.2',
      bins: fixture.bins,
      home: fixture.root,
    });
    assert.equal(result.ok, false, 'a failing required check must make doctor unhealthy');
    assertMatchingLeadingAndTrailingVerdicts(
      result.output,
      'Loop health: UNHEALTHY (one or more required checks failed).',
    );
  } finally {
    removeFixture(fixture.root);
  }
});

test('optional publish guard failures do not affect core health, while required failures do', async () => {
  const fixture = createPassingFixture();
  const bins = {
    ...fixture.bins,
    gitleaks: 'ccc-doctor-definitely-missing-gitleaks-core-health-58d9',
    trufflehog: 'ccc-doctor-definitely-missing-trufflehog-core-health-58d9',
    environment: { URO_SUPERPOWERS_DIR: fixture.superpowers },
  };
  try {
    const healthy = await runDoctor({
      scratchRoot: fixture.scratchRoot,
      repository: fixture.repository,
      nodeVersion: '24.9.0',
      bins,
    });
    assert.equal(healthy.ok, true, healthy.output);
    assert.match(healthy.output, /Loop core health: HEALTHY/);
    assert.match(healthy.output, /FAIL \[optional\] Publish guard gitleaks/);
    assert.match(healthy.output, /FAIL \[optional\] Publish guard blocklist/);
    assert.match(healthy.output, /FAIL \[optional\] Publish guard trufflehog/);
    assertMatchingLeadingAndTrailingVerdicts(
      healthy.output,
      'Loop core health: HEALTHY (all performed required checks passed; Codex, Cursor, and Claude sign-ins were verified).',
    );

    const unhealthy = await runDoctor({
      scratchRoot: fixture.scratchRoot,
      repository: fixture.repository,
      nodeVersion: '23.9.0',
      bins,
    });
    assert.equal(unhealthy.ok, false);
    assert.match(unhealthy.output, /Loop health: UNHEALTHY/);
    assertMatchingLeadingAndTrailingVerdicts(
      unhealthy.output,
      'Loop health: UNHEALTHY (one or more required checks failed).',
    );
  } finally {
    removeFixture(fixture.root);
  }
});

test('doctor all-pass output is byte-identical to its committed golden', async () => {
  const fixture = createPassingFixture();
  const previousRemote = process.env.URO_FAKE_GITHUB_REMOTE;
  const previousAuth = process.env.URO_FAKE_GH_AUTH;
  process.env.URO_FAKE_GITHUB_REMOTE = 'yes';
  process.env.URO_FAKE_GH_AUTH = 'yes';
  try {
    const result = await runDoctor({
      deep: true,
      scratchRoot: fixture.scratchRoot,
      repository: fixture.repository,
      nodeVersion: '24.9.0',
      bins: fixture.bins,
      home: fixture.root,
    });
    const expected = golden('doctor-all-pass.txt', {
      SCRATCH_ROOT: resolve(fixture.scratchRoot),
      REPOSITORY: resolve(fixture.repository),
      SUPERPOWERS_DIR: resolve(fixture.superpowers),
      CODEX_BIN: fixture.bins.codex,
      AGENT_BIN: fixture.bins.agent,
      CLAUDE_BIN: fixture.bins.claude,
      GH_BIN: fixture.bins.gh,
      GITLEAKS_BIN: fixture.bins.gitleaks,
      TRUFFLEHOG_BIN: fixture.bins.trufflehog,
      LOGDY_BIN: fixture.bins.logdy,
    });
    assert.equal(result.ok, true, result.output);
    assertGoldenEquality(result.output, expected);

    const oneCharacterWrong = `${expected.slice(0, -2)}X${expected.slice(-1)}`;
    assert.throws(
      () => assertGoldenEquality(result.output, oneCharacterWrong),
      assert.AssertionError,
      'positive control: the golden comparison must reject a one-character difference',
    );
  } finally {
    if (previousRemote === undefined) delete process.env.URO_FAKE_GITHUB_REMOTE;
    else process.env.URO_FAKE_GITHUB_REMOTE = previousRemote;
    if (previousAuth === undefined) delete process.env.URO_FAKE_GH_AUTH;
    else process.env.URO_FAKE_GH_AUTH = previousAuth;
    removeFixture(fixture.root);
  }
});

test('doctor all-fail output is byte-identical to its committed golden', async () => {
  const fixture = createFailingFixture();
  try {
    const result = await runDoctor({
      deep: true,
      scratchRoot: fixture.scratchRoot,
      repository: fixture.repository,
      nodeVersion: '23.1.2',
      bins: fixture.bins,
      home: fixture.root,
    });
    const cursorInstallProse = process.platform === 'win32'
      ? "run `irm 'https://cursor.com/install?win32=true' | iex` in Windows PowerShell, reopen the terminal, confirm the binary is `agent`, and run `agent login`."
      : 'run `curl https://cursor.com/install -fsS | bash`, reopen the terminal, confirm the binary is `agent`, and run `agent login`.';
    const expected = golden('doctor-all-fail.txt', {
      SCRATCH_ROOT: resolve(fixture.scratchRoot),
      REPOSITORY: resolve(fixture.repository),
      CURSOR_INSTALL_PROSE: cursorInstallProse,
    });
    assert.equal(result.ok, false);
    assertGoldenEquality(result.output, expected);
  } finally {
    removeFixture(fixture.root);
  }
});
