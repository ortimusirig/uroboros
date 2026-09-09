import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

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
    const archive = join(root, 'historical.tar');
    execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, '3051ccbe52d84dd7a93d80604e4230d089421038', 'src', 'package.json'],
      { cwd: join(sourceDirectory, '..'), windowsHide: true });
    execFileSync('tar', ['-xf', archive, '-C', root], { windowsHide: true });
  } else {
    cpSync(sourceDirectory, join(root, 'src'), { recursive: true });
    cpSync(join(sourceDirectory, '..', 'package.json'), join(root, 'package.json'));
  }
  return { root, assetsPath: join(root, 'src', 'workflow-profiles'),
    module: name => importWorkflowPackage(join(root, 'src', name)) };
}
