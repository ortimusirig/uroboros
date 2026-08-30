import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveSuperpowersDir } from '../src/superpowers.js';

function temporaryHome() {
  return mkdtempSync(join(tmpdir(), 'uro-superpowers-home-'));
}

test('resolveSuperpowersDir honours an existing URO_SUPERPOWERS_DIR', () => {
  const home = temporaryHome();
  const configured = join(home, 'configured-superpowers');
  mkdirSync(configured);
  try {
    assert.equal(
      resolveSuperpowersDir({ env: { URO_SUPERPOWERS_DIR: configured }, home }),
      resolve(configured),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('resolveSuperpowersDir rejects a configured path that does not exist', () => {
  const home = temporaryHome();
  const missing = join(home, 'missing-superpowers');
  try {
    assert.throws(
      () => resolveSuperpowersDir({ env: { URO_SUPERPOWERS_DIR: missing }, home }),
      (error) => error instanceof Error
        && error.message.includes('URO_SUPERPOWERS_DIR')
        && error.message.includes(resolve(missing)),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('resolveSuperpowersDir returns null when no configured or cached install exists', () => {
  const home = temporaryHome();
  try {
    assert.equal(resolveSuperpowersDir({ env: {}, home }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('resolveSuperpowersDir selects the highest version across Claude and Codex caches', () => {
  const home = temporaryHome();
  const versions = [
    join(home, '.claude', 'plugins', 'cache', 'superpowers-marketplace', 'superpowers', '6.9.0'),
    join(home, '.codex', 'plugins', 'cache', 'openai-curated-remote', 'superpowers', '6.10.0'),
    join(home, '.codex', 'plugins', 'cache', 'superpowers', '5.0.0'),
  ];
  for (const path of versions) mkdirSync(path, { recursive: true });
  try {
    assert.equal(resolveSuperpowersDir({ env: {}, home }), resolve(versions[1]));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
