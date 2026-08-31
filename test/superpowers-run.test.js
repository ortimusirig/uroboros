import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/run.js';
import { EMPTY_USAGE } from '../src/usage.js';

const VERIFIED = Object.freeze({
  ok: true,
  seats: Object.freeze({
    codex: Object.freeze({
      seat: 'codex', verified: true,
      evidence: '`codex plugin list` reports installed, enabled',
      version: '6.3.0', path: null, remediation: 'Codex fix',
    }),
    cursor: Object.freeze({
      seat: 'cursor', verified: true,
      evidence: '.cursor-plugin manifest and skills are readable',
      version: '6.0.2', path: 'C:/plugins/superpowers/6.0.2', remediation: 'Cursor fix',
    }),
    claude: Object.freeze({
      seat: 'claude', verified: true,
      evidence: '.claude-plugin manifest and skills are readable',
      version: '6.0.1', path: 'C:/plugins/superpowers/6.0.1', remediation: 'Claude fix',
    }),
  }),
});

async function runWithVerification(verification, { env = {}, expectExecution = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'uro-skills-run-'));
  const target = join(root, 'target');
  const worktree = join(root, 'worktree');
  const scratchRoot = join(root, 'scratch');
  mkdirSync(target);
  mkdirSync(worktree);
  mkdirSync(scratchRoot);
  const executorCalls = [];
  const isolateCalls = [];
  try {
    const facts = await run({
      task: 'Do nothing.', target, gate: [], gateRetries: 0,
      scratchRoot, artifactRoot: join(root, 'artifacts'), runId: 'skills-facts',
      env,
      adapters: {
        verifySuperpowers: async () => verification,
        isolate: async () => {
          isolateCalls.push(true);
          return {
            dir: worktree,
            isRepo: false,
            baseRef: 'HEAD',
            baseCommit: '0'.repeat(40),
            branch: 'uro/skills-facts',
          };
        },
        diffText: async () => '',
        runExecutor: async (options) => {
          executorCalls.push(options);
          return {
            changedFiles: [], lastMessage: '', agentMessages: [], usage: EMPTY_USAGE,
            exitCode: 0, timedOut: false,
          };
        },
        runGate: async () => ({ passed: true, results: [] }),
        runVerifier: async () => { throw new Error('no-op must not verify'); },
      },
    });
    assert.equal(executorCalls.length > 0, expectExecution);
    return {
      facts,
      executorCalls,
      isolateCalls,
      report: readFileSync(join(worktree, 'uro-report.md'), 'utf8'),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('run facts record per-seat verification evidence and distinct versions', async () => {
  const { facts, executorCalls } = await runWithVerification(VERIFIED);
  assert.equal(executorCalls.length, 1, 'positive control: a verified run starts normally');
  assert.equal(Object.hasOwn(executorCalls[0], 'superpowersDir'), false,
    'Codex must use its registry rather than receive a plugin directory');
  assert.equal(facts.superpowers.bypassed, false);
  assert.deepEqual(facts.superpowers.seats, VERIFIED.seats);
  assert.deepEqual(
    Object.fromEntries(Object.entries(facts.superpowers.seats)
      .map(([seat, value]) => [seat, value.version])),
    { codex: '6.3.0', cursor: '6.0.2', claude: '6.0.1' },
  );
});

test('run refuses an unverified seat before isolation or executor dispatch', async () => {
  let executorCalls = 0;
  let isolateCalls = 0;
  const failed = {
    ok: false,
    seats: {
      ...VERIFIED.seats,
      cursor: {
        seat: 'cursor', verified: false, evidence: 'Cursor has no .cursor-plugin manifest',
        version: null, path: null,
        remediation: 'Cursor: URO_SUPERPOWERS_DIR=<directory-with-.cursor-plugin>',
      },
    },
  };
  await assert.rejects(run({
    task: 'Must not run.', target: process.cwd(), gate: [], gateRetries: 0,
    scratchRoot: 'C:/uro/w', runId: 'unverified',
    adapters: {
      verifySuperpowers: async () => failed,
      isolate: async () => { isolateCalls++; return {}; },
      runExecutor: async () => { executorCalls++; return {}; },
      runVerifier: async () => ({}),
    },
  }), /Cursor.*[.]cursor-plugin/i);
  assert.equal(isolateCalls, 0);
  assert.equal(executorCalls, 0);
});

test('URO_REQUIRE_SUPERPOWERS=0 permits a run and discloses the bypass in facts and report', async () => {
  const failed = {
    ok: false,
    seats: {
      ...VERIFIED.seats,
      claude: {
        seat: 'claude', verified: false, evidence: 'Claude plugin missing',
        version: null, path: null, remediation: 'Claude fix',
      },
    },
  };
  const { facts, report } = await runWithVerification(failed, {
    env: { URO_REQUIRE_SUPERPOWERS: '0' },
  });
  assert.equal(facts.superpowers.bypassed, true);
  assert.equal(facts.superpowers.seats.claude.verified, false);
  assert.match(report, /Superpowers prerequisite bypassed[\s\S]*URO_REQUIRE_SUPERPOWERS=0/i);
  assert.match(report, /Claude.*not verified/i);
});
