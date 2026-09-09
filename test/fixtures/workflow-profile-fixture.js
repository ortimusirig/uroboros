import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
