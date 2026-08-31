import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { readEnv } from './env-compat.js';
import { spawnCapture } from './spawn.js';

const DIRECTORY_SEATS = Object.freeze({
  cursor: Object.freeze({ label: 'Cursor', manifest: '.cursor-plugin' }),
  claude: Object.freeze({ label: 'Claude', manifest: '.claude-plugin' }),
});

const SEAT_LABELS = Object.freeze({ codex: 'Codex', cursor: 'Cursor', claude: 'Claude' });
const REQUIRED_SEATS = Object.freeze(Object.keys(SEAT_LABELS));

export const SUPERPOWERS_REMEDIATION = Object.freeze({
  codex: 'Codex: run `codex plugin add superpowers@openai-curated`, then rerun `node bin/loop.js doctor`.',
  cursor: 'Cursor: run `$env:URO_SUPERPOWERS_DIR=\'<directory-with-.cursor-plugin>\'; node bin/loop.js doctor` in PowerShell, or `export URO_SUPERPOWERS_DIR=\'<directory-with-.cursor-plugin>\'; node bin/loop.js doctor` on POSIX.',
  claude: 'Claude: run `/plugin install superpowers@superpowers-marketplace` inside Claude Code, restart Claude Code, then rerun `node bin/loop.js doctor`.',
});

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
      if (isDirectory(path)) found.push({ path: resolve(path), directoryVersion: version });
    }
  }
  return found;
}

function readPluginManifest(pluginDir, seat) {
  const descriptor = DIRECTORY_SEATS[seat];
  if (!descriptor) throw new TypeError(`unsupported directory-based superpowers seat: ${seat}`);
  const manifestPath = join(pluginDir, descriptor.manifest, 'plugin.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      reason: `${descriptor.label} requires a readable valid ${descriptor.manifest}/plugin.json manifest: ${error.message}`,
      manifestPath,
    };
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.name !== 'superpowers'
    || typeof manifest.version !== 'string' || manifest.version.trim() === '') {
    return {
      ok: false,
      reason: `${descriptor.label} requires ${descriptor.manifest}/plugin.json to name superpowers and contain a version`,
      manifestPath,
    };
  }
  return { ok: true, manifest, manifestPath };
}

function readableSkillFiles(pluginDir, seat) {
  const label = DIRECTORY_SEATS[seat].label;
  const skillsDir = join(pluginDir, 'skills');
  const skillDirectories = directoryNames(skillsDir);
  if (skillDirectories.length === 0) {
    return { ok: false, reason: `${label} superpowers skills are missing or unreadable at ${skillsDir}` };
  }
  let readable = 0;
  for (const skill of skillDirectories) {
    const skillPath = join(skillsDir, skill, 'SKILL.md');
    try {
      readFileSync(skillPath, 'utf8');
      readable++;
    } catch (error) {
      return { ok: false, reason: `${label} cannot read ${skillPath}: ${error.message}` };
    }
  }
  return { ok: true, count: readable, skillsDir };
}

export function inspectSuperpowersDirectory({ path, seat }) {
  const descriptor = DIRECTORY_SEATS[seat];
  if (!descriptor) throw new TypeError(`unsupported directory-based superpowers seat: ${seat}`);
  const resolvedPath = resolve(path);
  if (!existsSync(resolvedPath) || !isDirectory(resolvedPath)) {
    return {
      ok: false,
      path: resolvedPath,
      reason: `${descriptor.label} superpowers directory does not exist: ${resolvedPath}`,
    };
  }
  const manifest = readPluginManifest(resolvedPath, seat);
  if (!manifest.ok) return { ...manifest, path: resolvedPath };
  const skills = readableSkillFiles(resolvedPath, seat);
  if (!skills.ok) return { ...skills, path: resolvedPath, manifestPath: manifest.manifestPath };
  return {
    ok: true,
    path: resolvedPath,
    manifestPath: manifest.manifestPath,
    skillsDir: skills.skillsDir,
    skillCount: skills.count,
    version: manifest.manifest.version.trim(),
  };
}

export function resolveSuperpowersDir({ seat, env, home }) {
  if (seat === 'codex') return null;
  const descriptor = DIRECTORY_SEATS[seat];
  if (!descriptor) throw new TypeError(`superpowers seat must be codex, cursor, or claude; received ${seat}`);
  const configured = readEnv(env, 'SUPERPOWERS_DIR');
  if (configured !== undefined) {
    const path = isAbsolute(configured) ? resolve(configured) : resolve(home, configured);
    const inspected = inspectSuperpowersDirectory({ path, seat });
    if (!inspected.ok) {
      throw new Error(`URO_SUPERPOWERS_DIR is not usable by ${descriptor.label}: ${inspected.reason}`);
    }
    return inspected.path;
  }

  if (typeof home !== 'string' || home === '') return null;
  const candidates = [
    join(home, '.codex', 'plugins', 'cache'),
    join(home, '.claude', 'plugins', 'cache'),
    join(home, '.cursor', 'plugins', 'cache'),
  ].flatMap(installedVersions)
    .map((candidate) => ({
      ...candidate,
      inspected: inspectSuperpowersDirectory({ path: candidate.path, seat }),
    }))
    .filter((candidate) => candidate.inspected.ok)
    .map((candidate) => ({
      path: candidate.inspected.path,
      version: candidate.inspected.version || candidate.directoryVersion,
    }));
  candidates.sort((left, right) => (
    compareVersions(left.version, right.version) || left.path.localeCompare(right.path)
  ));
  return candidates.at(-1)?.path ?? null;
}

export function verifyDirectorySuperpowers({ seat, env, home }) {
  const descriptor = DIRECTORY_SEATS[seat];
  if (!descriptor) throw new TypeError(`directory verification is unavailable for seat ${seat}`);
  let path;
  try {
    path = resolveSuperpowersDir({ seat, env, home });
  } catch (error) {
    return {
      seat,
      verified: false,
      evidence: `${descriptor.label}: ${error instanceof Error ? error.message : String(error)}`,
      version: null,
      path: null,
      remediation: SUPERPOWERS_REMEDIATION[seat],
    };
  }
  if (path === null) {
    return {
      seat,
      verified: false,
      evidence: `${descriptor.label}: no superpowers directory with a valid ${descriptor.manifest} manifest and readable skills was found`,
      version: null,
      path: null,
      remediation: SUPERPOWERS_REMEDIATION[seat],
    };
  }
  const inspected = inspectSuperpowersDirectory({ path, seat });
  return {
    seat,
    verified: inspected.ok,
    evidence: inspected.ok
      ? `${descriptor.label}: ${descriptor.manifest}/plugin.json verified ${inspected.skillCount} readable skill files at ${path}`
      : `${descriptor.label}: ${inspected.reason}`,
    version: inspected.ok ? inspected.version : null,
    path: inspected.ok ? inspected.path : null,
    remediation: SUPERPOWERS_REMEDIATION[seat],
  };
}

export function parseCodexSuperpowersList(output) {
  const line = String(output).split(/\r?\n/)
    .find((candidate) => /^\s*superpowers@openai-curated(?:\s{2,}|\s*$)/i.test(candidate));
  if (!line) return { found: false, status: null, version: null, line: null };
  const columns = line.trim().split(/\s{2,}/);
  const status = columns[1] ?? '';
  const verified = /^installed,\s*enabled$/i.test(status);
  return {
    found: true,
    verified,
    status,
    version: verified && columns[2] ? columns[2] : null,
    line: line.trim(),
  };
}

export async function verifyCodexSuperpowers({
  bin = 'codex',
  spawn = spawnCapture,
  env = process.env,
} = {}) {
  let result;
  try {
    result = await spawn(bin, ['plugin', 'list'], {
      timeoutMs: 30_000,
      env: { ...process.env, ...env },
    });
  } catch (error) {
    return {
      seat: 'codex',
      verified: false,
      evidence: `Codex: \`codex plugin list\` could not run: ${error?.message ?? String(error)}`,
      version: null,
      path: null,
      remediation: SUPERPOWERS_REMEDIATION.codex,
    };
  }
  if (result.timedOut || result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 500);
    return {
      seat: 'codex',
      verified: false,
      evidence: `Codex: \`codex plugin list\` ${result.timedOut ? 'timed out' : `exited ${result.code}`}${detail ? `: ${detail}` : ''}`,
      version: null,
      path: null,
      remediation: SUPERPOWERS_REMEDIATION.codex,
    };
  }
  const parsed = parseCodexSuperpowersList(result.stdout);
  return {
    seat: 'codex',
    verified: parsed.verified === true,
    evidence: parsed.found
      ? `Codex: \`codex plugin list\` reports ${parsed.line}`
      : 'Codex: `codex plugin list` did not report superpowers@openai-curated',
    version: parsed.version,
    path: null,
    remediation: SUPERPOWERS_REMEDIATION.codex,
  };
}

export async function verifySuperpowersSeats({
  env = process.env,
  home = homedir(),
  codexBin = 'codex',
  spawn = spawnCapture,
} = {}) {
  const [codex, cursor, claude] = await Promise.all([
    verifyCodexSuperpowers({ bin: codexBin, spawn, env }),
    Promise.resolve(verifyDirectorySuperpowers({ seat: 'cursor', env, home })),
    Promise.resolve(verifyDirectorySuperpowers({ seat: 'claude', env, home })),
  ]);
  return {
    ok: codex.verified && cursor.verified && claude.verified,
    seats: { codex, cursor, claude },
  };
}

export function applySuperpowersRequirement(verification, env = process.env) {
  const bypassed = readEnv(env, 'REQUIRE_SUPERPOWERS') === '0';
  const suppliedSeats = verification?.seats ?? {};
  const seats = Object.fromEntries(REQUIRED_SEATS.map((seat) => [
    seat,
    suppliedSeats[seat] ?? {
      seat,
      verified: false,
      evidence: `${SEAT_LABELS[seat]}: missing verification evidence`,
      version: null,
      path: null,
      remediation: SUPERPOWERS_REMEDIATION[seat],
    },
  ]));
  const normalizedVerification = {
    ...verification,
    ok: REQUIRED_SEATS.every((seat) => seats[seat].verified === true),
    seats,
  };
  const failed = REQUIRED_SEATS.map((seat) => seats[seat])
    .filter((seat) => seat.verified !== true);
  if (failed.length === 0) {
    return { ok: true, bypassed, reason: null, verification: normalizedVerification };
  }
  const reason = failed.map((seat) => `${seat.evidence}. Fix: ${seat.remediation}`).join(' ');
  return { ok: bypassed, bypassed, reason, verification: normalizedVerification };
}
