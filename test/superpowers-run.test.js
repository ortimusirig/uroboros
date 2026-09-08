import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/run.js';
import { EMPTY_USAGE } from '../src/usage.js';
import { verifyCodexSuperpowers } from '../src/superpowers.js';
import { isolate } from '../src/isolation.js';
import { planningEnvelope as envelope } from './fixtures/planning-responses.js';

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
  const base = process.platform === 'win32' ? 'C:/ccc-test' : tmpdir();
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'uro-skills-run-'));
  const target = join(root, 'target');
  const scratchRoot = join(root, 'scratch');
  mkdirSync(target);
  writeFileSync(join(target, 'seed.txt'), 'unchanged prerequisite fixture\n');
  mkdirSync(scratchRoot);
  const executorCalls = [];
  const isolateCalls = [];
  try {
    const facts = await run({
      task: 'Do nothing.', target, gate: [], gateRetries: 0,
      scratchRoot, artifactRoot: join(root, 'artifacts'), runId: 'skills-facts',
      env: { ...process.env, ...env },
      adapters: {
        verifySuperpowers: async () => verification,
        isolate: async options => {
          isolateCalls.push(true);
          return isolate(options);
        },
        runExecutor: async (options) => {
          executorCalls.push(options);
          return {
            changedFiles: [], lastMessage: '', agentMessages: [], usage: EMPTY_USAGE,
            exitCode: 0, timedOut: false, dialogue: envelope(options, options.action),
          };
        },
        runReview: null,
      },
    });
    assert.equal(executorCalls.length > 0, expectExecution);
    return {
      facts,
      executorCalls,
      isolateCalls,
      report: readFileSync(join(facts.dir, 'uro-report.md'), 'utf8'),
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
  assert.deepEqual(facts.superpowers.seats, { codex: VERIFIED.seats.codex, claude: VERIFIED.seats.claude });
  assert.equal(Object.hasOwn(facts.participation, 'claude'), false, 'configuration is not observed review participation');
  assert.equal(facts.approved, false, 'configuration and a proposal do not imply reviewer approval');
  assert.equal(facts.resources.providerLaunches, 1);
  assert.equal(facts.dialogue.messages.some(message => message.sender === 'claude'), false);
  assert.deepEqual(
    Object.fromEntries(Object.entries(facts.superpowers.seats)
      .map(([seat, value]) => [seat, value.version])),
    { codex: '6.3.0', claude: '6.0.1' },
  );
});

test('run refuses an unverified seat before isolation or executor dispatch', async () => {
  let executorCalls = 0;
  let isolateCalls = 0;
  const failed = {
    ok: false,
    seats: {
      ...VERIFIED.seats,
      claude: {
        seat: 'claude', verified: false, evidence: 'Claude has no .claude-plugin manifest',
        version: null, path: null,
        remediation: 'Claude: URO_SUPERPOWERS_DIR=<directory-with-.claude-plugin>',
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
  }), /Claude.*[.]claude-plugin/i);
  assert.equal(isolateCalls, 0);
  assert.equal(executorCalls, 0);
});

test('run accepts the verified remote registry without bypassing the Superpowers requirement', async () => {
  const codex = await verifyCodexSuperpowers({
    spawn: async () => ({
      code: 0, timedOut: false,
      stdout: 'superpowers@openai-curated-remote  installed, enabled  6.3.0  C:/plugins/superpowers\n',
      stderr: '',
    }),
  });
  const { facts, executorCalls } = await runWithVerification({
    ok: codex.verified,
    seats: { codex, claude: VERIFIED.seats.claude },
  }, { env: { URO_REQUIRE_SUPERPOWERS: '1' } });

  assert.equal(executorCalls.length, 1);
  assert.equal(facts.superpowers.bypassed, false);
  assert.equal(facts.superpowers.seats.codex.verified, true);
  assert.match(facts.superpowers.seats.codex.evidence, /superpowers@openai-curated-remote/);
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
