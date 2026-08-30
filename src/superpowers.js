import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { readEnv } from './env-compat.js';

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function directoryNames(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function compareVersions(left, right) {
  return left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' });
}

function installedVersions(cacheRoot) {
  const pluginRoots = [join(cacheRoot, 'superpowers')];
  for (const marketplace of directoryNames(cacheRoot)) {
    if (marketplace === 'superpowers') continue;
    pluginRoots.push(join(cacheRoot, marketplace, 'superpowers'));
  }

  const found = [];
  for (const pluginRoot of pluginRoots) {
    for (const version of directoryNames(pluginRoot)) {
      const path = join(pluginRoot, version);
      if (isDirectory(path)) found.push({ path: resolve(path), version });
    }
  }
  return found;
}

export function resolveSuperpowersDir({ env, home }) {
  const configured = readEnv(env, 'SUPERPOWERS_DIR');
  if (configured !== undefined) {
    const path = isAbsolute(configured) ? resolve(configured) : resolve(home, configured);
    if (!existsSync(path) || !isDirectory(path)) {
      throw new Error(`URO_SUPERPOWERS_DIR does not name an existing directory: ${path}`);
    }
    return path;
  }

  if (typeof home !== 'string' || home === '') return null;
  const candidates = [
    join(home, '.codex', 'plugins', 'cache'),
    join(home, '.claude', 'plugins', 'cache'),
  ].flatMap(installedVersions);
  candidates.sort((left, right) => (
    compareVersions(left.version, right.version) || left.path.localeCompare(right.path)
  ));
  return candidates.at(-1)?.path ?? null;
}
