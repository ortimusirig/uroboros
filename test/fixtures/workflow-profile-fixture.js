import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const sourceDirectory = join(fixtureDirectory, '..', '..', 'src');

export function copyWorkflowPackage(t) {
  const root = mkdtempSync(join(tmpdir(), 'uro-workflow-profile-'));
  const modulePath = join(root, 'workflow-profiles.js');
  const assetsPath = join(root, 'workflow-profiles');
  if (existsSync(join(sourceDirectory, 'workflow-profiles.js'))) {
    cpSync(join(sourceDirectory, 'workflow-profiles.js'), modulePath);
  }
  if (existsSync(join(sourceDirectory, 'workflow-profiles'))) {
    cpSync(join(sourceDirectory, 'workflow-profiles'), assetsPath, { recursive: true });
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, modulePath, assetsPath };
}

export function importWorkflowPackage(modulePath) {
  return import(`${pathToFileURL(modulePath).href}?fixture=${crypto.randomUUID()}`);
}

// Historical native records are produced by real pre-integration code, never metadata deletion.
export function copyNativeWorkflowPackage(t, { historical = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'uro-workflow-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (historical) {
    // Immutable authentic source; see native-preintegration-3051ccb.md for provenance.
    const archive = join(fixtureDirectory, 'native-preintegration-3051ccb.tar.gz');
    if (!existsSync(archive)) throw new Error('Historical fixture archive missing');
    const bytes = readFileSync(archive);
    if (createHash('sha256').update(bytes).digest('hex') !== '513463b5c25b1ac0f2d65de11c8b5a6e86167f83dd1ce6c9d0bdfafbb0db85cc') {
      throw new Error('Historical fixture archive integrity mismatch');
    }
    execFileSync('tar', ['-xzf', '-', '-C', root], { input: bytes, windowsHide: true });
  } else {
    cpSync(sourceDirectory, join(root, 'src'), { recursive: true });
    cpSync(join(sourceDirectory, '..', 'package.json'), join(root, 'package.json'));
  }
  return { root, assetsPath: join(root, 'src', 'workflow-profiles'),
    module: name => importWorkflowPackage(join(root, 'src', name)) };
}
