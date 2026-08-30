import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/run.js';
import { EMPTY_USAGE } from '../src/usage.js';

async function runWithSkills(superpowersDir) {
  const root = mkdtempSync(join(tmpdir(), 'uro-skills-run-'));
  const target = join(root, 'target');
  const worktree = join(root, 'worktree');
  const scratchRoot = join(root, 'scratch');
  mkdirSync(target);
  mkdirSync(worktree);
  mkdirSync(scratchRoot);
  const executorCalls = [];
  try {
    const facts = await run({
      task: 'Do nothing.', target, gate: [], gateRetries: 0,
      scratchRoot, artifactRoot: join(root, 'artifacts'), runId: 'skills-facts',
      superpowersDir,
      adapters: {
        isolate: async () => ({
          dir: worktree,
          isRepo: false,
          baseRef: 'HEAD',
          baseCommit: '0'.repeat(40),
          branch: 'uro/skills-facts',
        }),
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
    return { facts, executorCalls };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('run facts and the executor receive the resolved skills path', async () => {
  const path = 'C:/plugins/superpowers/6.3.0';
  const { facts, executorCalls } = await runWithSkills(path);
  assert.equal(executorCalls[0].superpowersDir, path);
  assert.equal(facts.skills, path);
});

test('run facts record null when superpowers is absent', async () => {
  const { facts, executorCalls } = await runWithSkills(null);
  assert.equal(executorCalls[0].superpowersDir, null);
  assert.equal(facts.skills, null);
});
