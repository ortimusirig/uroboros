import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const historicalArchive = 'test/fixtures/native-preintegration-3051ccb.tar.gz';

async function sourceCopy(t) {
  const root = mkdtempSync(join(tmpdir(), 'uro-workflow-no-history-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['src', 'test/fixtures', 'package.json']) {
    cpSync(join(sourceRoot, path), join(root, path), { recursive: true });
  }
  assert.equal(existsSync(join(root, '.git')), false);
  const helper = await import(pathToFileURL(join(root, 'test/fixtures/workflow-profile-fixture.js')).href);
  return { root, helper };
}

test('historical native fixture works from a disposable source copy without Git history', async t => {
  const { helper } = await sourceCopy(t);
  let historical;
  assert.doesNotThrow(() => { historical = helper.copyNativeWorkflowPackage(t, { historical: true }); },
    'historical compatibility must not require any local Git object');
  assert.equal(existsSync(join(historical.root, 'src/workflow-profiles.js')), false);
  assert.equal(typeof (await historical.module('plan.js')).runPlan, 'function');
  assert.match(readFileSync(join(historical.root, 'LICENSE'), 'utf8'), /MIT License/);
});

test('missing historical archive refuses rather than substituting current source', async t => {
  const { root, helper } = await sourceCopy(t);
  rmSync(join(root, historicalArchive));
  assert.throws(() => helper.copyNativeWorkflowPackage(t, { historical: true }), /historical fixture archive missing/i);
});

test('tampered historical archive refuses before extraction', async t => {
  const { root, helper } = await sourceCopy(t);
  const archive = join(root, historicalArchive), bytes = readFileSync(archive);
  bytes[100] ^= 1;
  writeFileSync(archive, bytes);
  assert.throws(() => helper.copyNativeWorkflowPackage(t, { historical: true }), /historical fixture archive integrity/i);
});
