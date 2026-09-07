import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const SENSITIVE_KEY = /(?:password|passwd|secret|token|api[-_]?key|authorization|cookie|credential)/i;

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} is required`);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function nativePath(path) {
  return realpathSync.native(resolve(path));
}

function identityPath(path) {
  const value = nativePath(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function gitPath(target, argument) {
  const output = execFileSync('git', [
    '-C', target, 'rev-parse', '--path-format=absolute', argument,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  return identityPath(isAbsolute(output) ? output : resolve(target, output));
}

export function resolveProjectIdentity({ target }) {
  requireString(target, 'project target');
  const canonicalTarget = identityPath(target);
  try {
    const repository = gitPath(canonicalTarget, '--git-common-dir');
    const root = gitPath(canonicalTarget, '--show-toplevel');
    return {
      projectId: hash(`git-common-directory\0${repository}`),
      repository,
      root,
    };
  } catch {
    return {
      projectId: hash(`canonical-target\0${canonicalTarget}`),
      repository: null,
      root: canonicalTarget,
    };
  }
}

function assertNoCredentials(value, key = '') {
  if (SENSITIVE_KEY.test(key)) throw new TypeError(`project memory refuses credential field: ${key}`);
  if (typeof value === 'string'
    && (/(?:^|[^A-Za-z0-9_$])(?:"|')?(?:password|passwd|secret|token|api[-_]?key|authorization|cookie|credential)(?:"|')?\s*\]?\s*[=:]\s*(?:(["'])(.*?)\1|([^,;}\r\n]+))/i.test(value)
      || /(\bbearer\s+)[A-Za-z0-9._~+/-]{8,}={0,2}(?![A-Za-z0-9._~+/-])/i.test(value)
      || /\b(?:sk-|gh[opusr][_-]|github_pat[_-])[A-Za-z0-9_-]{8,}\b/.test(value))) {
    throw new TypeError('project memory refuses credential values');
  }
  if (Array.isArray(value)) value.forEach((item) => assertNoCredentials(item));
  else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([childKey, childValue]) => assertNoCredentials(childValue, childKey));
  }
}

function writeExclusive(path, value) {
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validateProject(project) {
  if (!project || typeof project !== 'object') throw new TypeError('project identity is required');
  requireString(project.projectId, 'projectId');
  requireString(project.root, 'project root');
  if (project.repository !== null) requireString(project.repository, 'project repository');
}

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('memory entry is required');
  for (const field of ['schemaVersion', 'projectId']) {
    if (Object.hasOwn(entry, field)) throw new TypeError(`memory entry ${field} is reserved`);
  }
  for (const name of ['id', 'kind', 'content', 'sourceIdentity', 'status']) {
    requireString(entry[name], `memory entry ${name}`);
  }
  if (!entry.provenance || typeof entry.provenance !== 'object') {
    throw new TypeError('memory entry provenance is required');
  }
  if (entry.tags !== undefined && (!Array.isArray(entry.tags)
    || entry.tags.some((tag) => typeof tag !== 'string' || tag === ''))) {
    throw new TypeError('memory entry tags must be strings');
  }
  assertNoCredentials(entry);
}

function parseRecord(path, projectId) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`project memory record is corrupt: ${path}`, { cause: error });
  }
  const { recordDigest, ...material } = value;
  if (typeof recordDigest !== 'string'
    || recordDigest !== hash(JSON.stringify(canonical(material)))
    || material.projectId !== projectId
    || material.schemaVersion !== 1) {
    throw new Error(`project memory record is corrupt: ${path}`);
  }
  return value;
}

function compareEntries(left, right) {
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  if (left.version !== right.version) return left.version - right.version;
  return left.versionId < right.versionId ? -1 : left.versionId === right.versionId ? 0 : 1;
}

function bindingMatches(left, right) {
  return left?.schemaVersion === 1
    && left.projectId === right.projectId
    && left.repository === right.repository
    && (right.repository !== null || left.root === right.root);
}

export function openProjectMemory({ artifactRoot, project, searchIndex = null }) {
  requireString(artifactRoot, 'artifactRoot');
  validateProject(project);
  const verifiedProject = resolveProjectIdentity({ target: project.root });
  if (verifiedProject.projectId !== project.projectId
    || verifiedProject.repository !== project.repository) {
    throw new Error('project memory identity is not verified for this target');
  }
  const root = resolve(artifactRoot, 'project-memory');
  const directory = join(root, hash(project.projectId));
  const entriesDirectory = join(directory, 'entries');
  const registryDirectory = join(root, 'registry');
  const registryPath = join(registryDirectory, `${hash(project.projectId)}.json`);
  const lockPath = join(directory, 'memory.lock');
  mkdirSync(entriesDirectory, { recursive: true });
  mkdirSync(registryDirectory, { recursive: true });

  const binding = {
    schemaVersion: 1,
    projectId: project.projectId,
    repository: project.repository,
    root: project.root,
  };
  if (existsSync(registryPath)) {
    let existing;
    try { existing = JSON.parse(readFileSync(registryPath, 'utf8')); } catch (error) {
      throw new Error('project memory registry is corrupt', { cause: error });
    }
    if (!bindingMatches(existing, binding)) {
      throw new Error('project memory identity binding mismatch; explicit validated rebinding is required');
    }
  } else {
    try { writeExclusive(registryPath, binding); } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = JSON.parse(readFileSync(registryPath, 'utf8'));
      if (!bindingMatches(existing, binding)) {
        throw new Error('project memory identity binding mismatch; explicit validated rebinding is required');
      }
    }
  }

  const list = () => readdirSync(entriesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => parseRecord(join(entriesDirectory, entry.name), project.projectId))
    .sort(compareEntries);

  const acquire = () => {
    const ownerToken = randomUUID();
    try {
      writeExclusive(lockPath, {
        schemaVersion: 1,
        ownerToken,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error('project memory lock is owned by another writer; refusing to break it');
      }
      throw error;
    }
    return ownerToken;
  };

  const release = (ownerToken) => {
    if (!existsSync(lockPath)) return;
    let lock;
    try { lock = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { return; }
    if (lock.ownerToken === ownerToken) unlinkSync(lockPath);
  };

  const append = ({ entry }) => {
    validateEntry(entry);
    const source = JSON.parse(JSON.stringify(entry));
    const ownerToken = acquire();
    try {
      const versions = list().filter((value) => value.id === source.id);
      const previous = versions.at(-1) ?? null;
      const material = {
        schemaVersion: 1,
        projectId: project.projectId,
        ...source,
        tags: source.tags ?? [],
        version: (previous?.version ?? 0) + 1,
        previousVersionId: previous?.versionId ?? null,
        createdAt: new Date().toISOString(),
      };
      const versionId = hash(JSON.stringify(canonical(material)));
      const withVersion = { ...material, versionId };
      const record = {
        ...withVersion,
        recordDigest: hash(JSON.stringify(canonical(withVersion))),
      };
      const path = join(entriesDirectory,
        `${hash(source.id)}-${String(material.version).padStart(8, '0')}-${versionId}.json`);
      try { writeExclusive(path, record); } catch (error) {
        if (error?.code === 'EEXIST') throw new Error('immutable project memory version already exists');
        throw error;
      }
      return record;
    } finally {
      release(ownerToken);
    }
  };

  const localSearch = ({ text = '', tags = [] } = {}) => {
    if (typeof text !== 'string') throw new TypeError('memory search text must be a string');
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
      throw new TypeError('memory search tags must be strings');
    }
    const wantedText = text.trim().toLowerCase();
    const wantedTags = tags.map((tag) => tag.toLowerCase()).sort();
    return list().filter((entry) => {
      const haystack = [entry.id, entry.kind, entry.content, entry.sourceIdentity,
        JSON.stringify(entry.provenance)].join('\n').toLowerCase();
      const entryTags = (entry.tags ?? []).map((tag) => tag.toLowerCase());
      return (wantedText === '' || haystack.includes(wantedText))
        && wantedTags.every((tag) => entryTags.includes(tag));
    });
  };

  const search = (query = {}) => {
    let searchStatus = 'records';
    let searchError = null;
    if (searchIndex !== null) {
      if (typeof searchIndex !== 'function') throw new TypeError('optional search index must be a function');
      try {
        searchIndex({ projectId: project.projectId, text: query.text ?? '', tags: query.tags ?? [] });
        searchStatus = 'index-available';
      } catch (error) {
        searchStatus = 'fallback';
        searchError = error instanceof Error ? error.message : String(error);
      }
    }
    const results = localSearch(query);
    Object.defineProperties(results, {
      searchStatus: { value: searchStatus, enumerable: false },
      searchError: { value: searchError, enumerable: false },
    });
    return results;
  };

  return { directory, list, search, append };
}
