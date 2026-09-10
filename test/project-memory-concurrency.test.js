import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openProjectMemory, resolveProjectIdentity } from '../src/project-memory.js';

const TEST_ROOT = process.platform === 'win32' ? 'C:\\ccc-test' : tmpdir();
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function entry({ content, source, message }) {
  return {
    id: 'shared-finding',
    kind: 'finding',
    content,
    provenance: { source, id: message },
    sourceIdentity: message,
    status: 'verified',
    tags: ['concurrency'],
  };
}

async function waitForBarrier({ ready, child, childResult }) {
  const deadline = Date.now() + 15_000;
  while (!existsSync(ready)) {
    if (child.exitCode !== null) {
      const result = await childResult;
      throw new Error(`writer exited before acquiring its append lock: ${result.code}\n${result.stderr}`);
    }
    if (Date.now() >= deadline) throw new Error('timed out waiting for deterministic writer barrier');
    await delay(10);
  }
}

test('overlapping notebook writers refuse live contention and explicit retry preserves both immutable versions', async t => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const root = mkdtempSync(join(TEST_ROOT, 'uro-memory-concurrency-'));
  const target = join(root, 'project'), artifactRoot = join(root, 'artifacts');
  const ready = join(root, 'writer-ready'), release = join(root, 'writer-release');
  const preload = join(root, 'barrier-preload.mjs'), childScript = join(root, 'writer.mjs');
  mkdirSync(target);
  const project = resolveProjectIdentity({ target });
  const memory = openProjectMemory({ artifactRoot, project });
  const entriesDirectory = join(memory.directory, 'entries');
  const lockPath = join(memory.directory, 'memory.lock');
  const first = entry({ content: 'First process finding', source: 'claude', message: 'message-1' });
  const second = entry({ content: 'Second process finding', source: 'codex', message: 'message-2' });

  writeFileSync(preload, `
import fs from 'node:fs';
import { resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.readdirSync;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
fs.readdirSync = function(path, ...args) {
  if (resolve(path) === resolve(process.env.URO_BARRIER_ENTRIES)
      && fs.existsSync(process.env.URO_BARRIER_LOCK)
      && !fs.existsSync(process.env.URO_BARRIER_READY)) {
    fs.writeFileSync(process.env.URO_BARRIER_READY, 'locked');
    while (!fs.existsSync(process.env.URO_BARRIER_RELEASE)) Atomics.wait(sleeper, 0, 0, 20);
  }
  return original.call(this, path, ...args);
};
syncBuiltinESMExports();
`, 'utf8');
  writeFileSync(childScript, `
const module = await import(process.env.URO_MEMORY_MODULE);
const project = module.resolveProjectIdentity({ target: process.env.URO_MEMORY_TARGET });
const memory = module.openProjectMemory({ artifactRoot: process.env.URO_MEMORY_ARTIFACT_ROOT, project });
memory.append({ entry: JSON.parse(process.env.URO_MEMORY_ENTRY) });
`, 'utf8');

  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, childScript], {
    cwd: root,
    env: {
      ...process.env,
      URO_BARRIER_ENTRIES: entriesDirectory,
      URO_BARRIER_LOCK: lockPath,
      URO_BARRIER_READY: ready,
      URO_BARRIER_RELEASE: release,
      URO_MEMORY_MODULE: pathToFileURL(fileURLToPath(new URL('../src/project-memory.js', import.meta.url))).href,
      URO_MEMORY_TARGET: target,
      URO_MEMORY_ARTIFACT_ROOT: artifactRoot,
      URO_MEMORY_ENTRY: JSON.stringify(first),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childResult = new Promise(resolve => {
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => resolve({ code: null, stdout, stderr: `${stderr}${error.stack ?? error}` }));
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  t.after(async () => {
    if (!existsSync(release)) writeFileSync(release, 'release');
    if (child.exitCode === null) {
      await Promise.race([childResult, delay(3_000)]);
      if (child.exitCode === null) child.kill();
    }
    rmSync(root, { recursive: true, force: true });
  });

  await waitForBarrier({ ready, child, childResult });
  const ownerLock = readFileSync(lockPath, 'utf8');
  assert.throws(() => memory.append({ entry: second }), /lock is owned by another writer/);
  assert.equal(readFileSync(lockPath, 'utf8'), ownerLock, 'contender must not replace or remove the live owner lock');
  assert.deepEqual(memory.list(), [], 'refused contender must not overwrite or fabricate a record');

  writeFileSync(release, 'release');
  const completed = await childResult;
  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(existsSync(lockPath), false, 'successful writer releases only its own lock');

  memory.append({ entry: second });
  const versions = memory.list();
  assert.deepEqual(versions.map(record => record.version), [1, 2]);
  assert.deepEqual(versions.map(record => record.provenance.source), ['claude', 'codex']);
  assert.deepEqual(versions.map(record => record.sourceIdentity), ['message-1', 'message-2']);
  assert.equal(versions[1].previousVersionId, versions[0].versionId);
  assert.notEqual(versions[0].versionId, versions[1].versionId);
});
