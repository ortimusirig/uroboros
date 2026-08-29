import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/args.js';
import { CLI_COMMANDS, CLI_USAGE } from '../src/cli-help.js';

const commandPath = fileURLToPath(new URL('../commands/prune.md', import.meta.url));
const skillPath = fileURLToPath(new URL('../skills/uroboros/SKILL.md', import.meta.url));

test('run and batch accept an artifact-root override', () => {
  const run = parseArgs([
    'run', '--task', 'plan.md', '--target', 'target', '--gate', 'gate.json',
    '--artifact-root', 'D:/records',
  ]);
  assert.equal(run.artifactRoot, 'D:/records');

  const batch = parseArgs([
    'batch', '--task', 'one', '--target', 'target', '--gate', 'gate.json',
    '--artifact-root', 'D:/batch-records',
  ]);
  assert.equal(batch.artifactRoot, 'D:/batch-records');
});

test('prune parses conservative defaults and combined retention flags', () => {
  assert.deepEqual(parseArgs(['prune']), {
    command: 'prune', keep: 20, dryRun: false,
  });
  assert.deepEqual(parseArgs([
    'prune', '--keep', '2', '--older-than', '30', '--dry-run',
    '--scratch-root', 'D:/scratch', '--artifact-root', 'D:/records',
  ]), {
    command: 'prune',
    keep: 2,
    olderThan: 30,
    dryRun: true,
    scratchRoot: 'D:/scratch',
    artifactRoot: 'D:/records',
  });
  assert.throws(() => parseArgs(['prune', '--keep', '-1']), /keep|range/i);
  assert.throws(() => parseArgs(['prune', '--older-than', '-1']), /older-than|range/i);
});

test('prune is covered by CLI usage, plugin skill, and a command file', () => {
  assert.equal(CLI_COMMANDS.includes('prune'), true);
  assert.match(CLI_USAGE, /\bprune\b/);
  assert.equal(existsSync(commandPath), true);
  const skill = readFileSync(skillPath, 'utf8');
  assert.match(skill, /\bprune\b/);
});
