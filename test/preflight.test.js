import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflight as runPreflight, probeVerifierLiveness } from '../src/preflight.js';

const VERIFIED_SUPERPOWERS = Object.freeze({
  ok: true,
  seats: Object.freeze({
    codex: Object.freeze({ seat: 'codex', verified: true, evidence: 'registry', version: '6.3.0', path: null, remediation: 'Codex fix' }),
    cursor: Object.freeze({ seat: 'cursor', verified: true, evidence: 'manifest', version: '6.0.2', path: 'C:/cursor', remediation: 'Cursor fix' }),
    claude: Object.freeze({ seat: 'claude', verified: true, evidence: 'manifest', version: '6.0.2', path: 'C:/claude', remediation: 'Claude fix' }),
  }),
});

const preflight = (options) => runPreflight({
  verifySuperpowers: async () => VERIFIED_SUPERPOWERS,
  probeVerifier: async () => ({ ok: true, reason: null }),
  checkCommand: async () => true,
  ...options,
});

const SAFE_SCRATCH_BASE = process.env.URO_TEST_SCRATCH_ROOT ?? (process.platform === 'win32'
  ? 'C:/ccc-test'
  : join(homedir(), '.ccc-test'));

function makeScratch() {
  mkdirSync(SAFE_SCRATCH_BASE, { recursive: true });
  return mkdtempSync(join(SAFE_SCRATCH_BASE, '.preflight-corrects-'));
}

test('fails when target does not exist', async () => {
  const gate = mkdtempSync(join(tmpdir(), 'g-'));
  writeFileSync(join(gate, 'gate.json'), '[]');
  const r = await preflight({ target: 'C:/does/not/exist/xyz', gate: join(gate, 'gate.json'),
    scratchRoot: 'C:/ccc/w', bins: { git: process.execPath, codex: process.execPath, agent: process.execPath } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /target/i);
});

test('fails when scratch root is under AppData', async () => {
  const d = mkdtempSync(join(tmpdir(), 'p-'));
  writeFileSync(join(d, 'gate.json'), '[]');
  const r = await preflight({ target: d, gate: join(d, 'gate.json'),
    scratchRoot: 'C:/Users/x/AppData/Local/ccc',
    bins: { git: process.execPath, codex: process.execPath, agent: process.execPath } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /AppData/i);
});

test('passes when everything resolves', async () => {
  const d = mkdtempSync(join(tmpdir(), 'p-'));
  writeFileSync(join(d, 'gate.json'), '[]');
  const r = await preflight({ target: d, gate: join(d, 'gate.json'), scratchRoot: 'C:/ccc/w',
    bins: { git: process.execPath, codex: process.execPath, agent: process.execPath } });
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
});

test('fails before binary probes when a path-like task file is missing', async () => {
  const d = mkdtempSync(join(tmpdir(), 'p-'));
  const missing = join(d, 'missing-plan.txt');
  writeFileSync(join(d, 'gate.json'), '[]');
  const r = await preflight({ task: missing, target: d, gate: join(d, 'gate.json'),
    scratchRoot: 'C:/ccc/w',
    bins: { git: 'not-needed', codex: 'not-needed', agent: 'not-needed' } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /task file not found/i);
  assert.ok(r.reason.includes(missing), 'the diagnostic must name the missing task path');
});

test('batch preflight validates every task before probing binaries', async () => {
  const d = mkdtempSync(join(tmpdir(), 'p-'));
  const missing = join(d, 'second-plan.txt');
  writeFileSync(join(d, 'gate.json'), '[]');
  const r = await preflight({
    tasks: ['Valid inline plan prose.', missing],
    target: d,
    gate: join(d, 'gate.json'),
    scratchRoot: 'C:/ccc/w',
    bins: { git: 'not-needed', codex: 'not-needed', agent: 'not-needed' },
  });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes(missing));
});

test('preflight rejects a missing corrected run and accepts an existing run directory', async () => {
  const d = mkdtempSync(join(tmpdir(), 'p-corrects-'));
  const scratchRoot = makeScratch();
  const gate = join(d, 'gate.json');
  writeFileSync(gate, '[]');
  const bins = { git: process.execPath, codex: process.execPath, agent: process.execPath };
  try {
    const missing = await preflight({
      task: 'A valid inline task.', target: d, gate, scratchRoot,
      correctsRunId: 'mistyped-prior-run', bins,
    });
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /corrected run not found/i);
    assert.ok(missing.reason.includes('mistyped-prior-run'),
      'the preflight diagnostic must name the missing run id');

    mkdirSync(join(scratchRoot, 'existing-prior-run', 'w'), { recursive: true });
    const existing = await preflight({
      task: 'A valid inline task.', target: d, gate, scratchRoot,
      correctsRunId: 'existing-prior-run', bins,
    });
    assert.deepEqual(existing, {
      ok: true,
      reason: null,
      superpowers: { required: true, bypassed: false, seats: VERIFIED_SUPERPOWERS.seats },
    },
      'positive control: an existing prior run must pass the same preflight');
  } finally {
    rmSync(d, { recursive: true, force: true });
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('verifier liveness probe names the binary and version invocation on failure', async () => {
  const calls = [];
  const result = await probeVerifierLiveness({
    bin: 'seat-agent',
    spawn: async (bin, args) => {
      calls.push({ bin, args });
      return { code: 7, stdout: '', stderr: 'cannot start verifier', timedOut: false };
    },
  });

  assert.deepEqual(calls, [{ bin: 'seat-agent', args: ['--version'] }]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /seat-agent/);
  assert.match(result.reason, /seat-agent --version/);
  assert.match(result.reason, /exited 7/);
  assert.match(result.reason, /cannot start verifier/);
});

test('preflight accepts an injected passing verifier probe', async () => {
  const d = mkdtempSync(join(tmpdir(), 'p-probe-'));
  writeFileSync(join(d, 'gate.json'), '[]');
  let probed = null;
  const r = await preflight({
    target: d, gate: join(d, 'gate.json'), scratchRoot: 'C:/ccc/w',
    bins: { git: process.execPath, codex: process.execPath, agent: process.execPath },
    probeVerifier: async ({ bin }) => {
      probed = bin;
      return { ok: true, reason: null };
    },
    checkCommand: async () => true,
  });

  assert.equal(r.ok, true);
  assert.equal(probed, process.execPath);
});

test('run and batch preflight reject an unverified seat before work can start', async () => {
  const d = mkdtempSync(join(tmpdir(), 'p-superpowers-fail-'));
  const gate = join(d, 'gate.json');
  writeFileSync(gate, '[]');
  const calls = [];
  const failed = {
    ok: false,
    seats: {
      ...VERIFIED_SUPERPOWERS.seats,
      cursor: {
        seat: 'cursor', verified: false, evidence: 'Cursor missing .cursor-plugin',
        version: null, path: null,
        remediation: 'Cursor: URO_SUPERPOWERS_DIR=<directory-with-.cursor-plugin>',
      },
    },
  };
  try {
    for (const taskInputs of [{ task: 'Run task.' }, { tasks: ['Batch one.', 'Batch two.'] }]) {
      const result = await preflight({
        ...taskInputs,
        target: d,
        gate,
        scratchRoot: 'C:/ccc/w',
        bins: { git: 'git', codex: 'codex', agent: 'agent' },
        checkCommand: async () => true,
        probeVerifier: async () => ({ ok: true, reason: null }),
        verifySuperpowers: async () => failed,
      });
      if (result.ok) calls.push('executor');
      assert.equal(result.ok, false);
      assert.match(result.reason, /Cursor.*[.]cursor-plugin/i);
    }
    assert.deepEqual(calls, [], 'neither run nor batch can dispatch an executor after failure');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('URO_REQUIRE_SUPERPOWERS=0 explicitly bypasses a failed preflight and records it', async () => {
  const d = mkdtempSync(join(tmpdir(), 'p-superpowers-bypass-'));
  const gate = join(d, 'gate.json');
  writeFileSync(gate, '[]');
  const failed = {
    ok: false,
    seats: {
      ...VERIFIED_SUPERPOWERS.seats,
      claude: {
        seat: 'claude', verified: false, evidence: 'Claude missing', version: null,
        path: null, remediation: 'Claude fix',
      },
    },
  };
  try {
    const result = await preflight({
      task: 'Run deliberately.', target: d, gate, scratchRoot: 'C:/ccc/w',
      bins: { git: 'git', codex: 'codex', agent: 'agent' },
      checkCommand: async () => true,
      probeVerifier: async () => ({ ok: true, reason: null }),
      verifySuperpowers: async () => failed,
      env: { URO_REQUIRE_SUPERPOWERS: '0' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.superpowers.bypassed, true);
    assert.equal(result.superpowers.seats.claude.verified, false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
