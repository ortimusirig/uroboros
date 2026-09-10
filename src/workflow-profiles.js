import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = dirname(fileURLToPath(import.meta.url));
const ASSET_ROOT = join(MODULE_ROOT, 'workflow-profiles');
const PROFILE_IDS = ['bmad', 'spec-kit'];
const PHASES = ['planning', 'execution', 'acceptance'];
const BINDING_ENTRY_ID = 'uroboros-workflow-binding';
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sorted(value[key])]),
  );
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function bindingDigest(binding) {
  const { digest, ...material } = binding;
  return sha256(JSON.stringify(sorted(material)));
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function exactKeys(value, keys, label) {
  plainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has unsupported fields`);
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required`);
  return value;
}

function sha(value, label) {
  if (!SHA256.test(requiredString(value, label))) throw new TypeError(`${label} must be a SHA-256`);
}

function safeProvenancePath(value, label) {
  requiredString(value, label);
  if (value.includes('\\') || value.startsWith('/') || isAbsolute(value)
    || value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new TypeError(`${label} must be a relative path`);
  }
}

function unique(values, label) {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError(`${label} must be a non-empty array`);
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new TypeError(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateReference(reference, label) {
  exactKeys(reference, ['path', 'sha256'], label);
  safeProvenancePath(reference.path, `${label} path`);
  sha(reference.sha256, `${label} hash`);
}

function validateSection(section, profileId) {
  exactKeys(section, ['id', 'phases', 'content', 'sha256'], `${profileId} section`);
  if (!PHASES.includes(section.id)) throw new TypeError(`unsupported ${profileId} section`);
  if (!Array.isArray(section.phases) || section.phases.length !== 1 || section.phases[0] !== section.id) {
    throw new TypeError(`invalid ${profileId} section phase`);
  }
  requiredString(section.content, `${profileId} section content`);
  sha(section.sha256, `${profileId} section hash`);
  if (sha256(section.content) !== section.sha256) throw new Error(`${profileId} section hash mismatch`);
}

function validateProfile(profile, expectedId) {
  exactKeys(profile, ['id', 'adapterRevision', 'upstream', 'sources', 'notices', 'sections'], 'workflow profile');
  if (profile.id !== expectedId) throw new TypeError(`unsupported workflow profile: ${profile.id}`);
  if (!Number.isSafeInteger(profile.adapterRevision) || profile.adapterRevision < 1) {
    throw new TypeError(`${profile.id} adapter revision is invalid`);
  }
  exactKeys(profile.upstream, ['repository', 'commit'], `${profile.id} upstream`);
  requiredString(profile.upstream.repository, `${profile.id} upstream repository`);
  if (!COMMIT.test(requiredString(profile.upstream.commit, `${profile.id} upstream commit`))) {
    throw new TypeError(`${profile.id} upstream commit is invalid`);
  }
  if (!Array.isArray(profile.sources) || !Array.isArray(profile.notices) || !Array.isArray(profile.sections)) {
    throw new TypeError(`${profile.id} workflow material is invalid`);
  }
  for (const reference of profile.sources) validateReference(reference, `${profile.id} source`);
  for (const reference of profile.notices) validateReference(reference, `${profile.id} notice`);
  unique(profile.sources.map((reference) => reference.path), `${profile.id} source path`);
  unique(profile.notices.map((reference) => reference.path), `${profile.id} notice path`);
  for (const section of profile.sections) validateSection(section, profile.id);
  if (profile.sections.length !== PHASES.length || profile.sections.some((section, index) => section.id !== PHASES[index])) {
    throw new TypeError(`${profile.id} sections must match the supported phase order`);
  }
}

export function validateWorkflowBinding({ binding }) {
  plainObject(binding, 'workflow binding');
  if (binding.schemaVersion !== 1) throw new TypeError('unsupported workflow binding schema version');
  if (binding.mode === 'legacy-unbound') {
    exactKeys(binding, ['schemaVersion', 'mode'], 'legacy workflow binding');
    return binding;
  }
  if (binding.mode !== 'bound') throw new TypeError('unsupported workflow binding mode');
  exactKeys(binding, ['schemaVersion', 'mode', 'digest', 'profiles'], 'workflow binding');
  sha(binding.digest, 'workflow binding digest');
  if (!Array.isArray(binding.profiles) || binding.profiles.length !== PROFILE_IDS.length) {
    throw new TypeError('workflow binding profiles are invalid');
  }
  for (const [index, profile] of binding.profiles.entries()) validateProfile(profile, PROFILE_IDS[index]);
  if (bindingDigest(binding) !== binding.digest) throw new Error('workflow binding digest mismatch');
  return binding;
}

function installedPath(localPath, label) {
  safeProvenancePath(localPath, `${label} local path`);
  const candidate = resolve(ASSET_ROOT, ...localPath.split('/'));
  if (relative(ASSET_ROOT, candidate).startsWith('..')) throw new TypeError(`${label} local path escapes bundle`);
  return candidate;
}

function readInstalledAsset({ profileId, group, asset }) {
  const label = `${profileId} ${group}`;
  const path = installedPath(asset.localPath, label);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`missing workflow ${label} asset`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`workflow ${label} asset must be a regular file`);
  const bytes = readFileSync(path);
  if (sha256(bytes) !== asset.sha256) throw new Error(`workflow ${label} asset hash mismatch`);
  return bytes;
}

function validateManifestAsset(asset, profileId, group) {
  const fields = group === 'section'
    ? ['id', 'phases', 'path', 'localPath', 'sha256']
    : ['path', 'localPath', 'sha256'];
  exactKeys(asset, fields, `${profileId} ${group}`);
  safeProvenancePath(asset.path, `${profileId} ${group} path`);
  safeProvenancePath(asset.localPath, `${profileId} ${group} local path`);
  sha(asset.sha256, `${profileId} ${group} hash`);
  if (group === 'section' && (!PHASES.includes(asset.id) || !Array.isArray(asset.phases)
    || asset.phases.length !== 1 || asset.phases[0] !== asset.id)) {
    throw new TypeError(`invalid ${profileId} section metadata`);
  }
}

function loadManifest() {
  const path = join(ASSET_ROOT, 'manifest.json');
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error('missing workflow manifest asset');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('workflow manifest asset must be a regular file');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('malformed workflow manifest');
  }
  exactKeys(manifest, ['schemaVersion', 'digest', 'profiles'], 'workflow manifest');
  if (manifest.schemaVersion !== 1) throw new TypeError('unsupported workflow manifest schema version');
  sha(manifest.digest, 'workflow manifest digest');
  if (!Array.isArray(manifest.profiles) || manifest.profiles.length !== PROFILE_IDS.length) {
    throw new TypeError('workflow manifest profiles are invalid');
  }
  for (const [index, profile] of manifest.profiles.entries()) {
    exactKeys(profile, ['id', 'adapterRevision', 'upstream', 'sources', 'notices', 'sections'], 'workflow manifest profile');
    if (profile.id !== PROFILE_IDS[index]) throw new TypeError('workflow manifest profile set is invalid');
    if (!Array.isArray(profile.sources) || !Array.isArray(profile.notices) || !Array.isArray(profile.sections)) {
      throw new TypeError(`workflow manifest ${profile.id} material is invalid`);
    }
    for (const asset of profile.sources) validateManifestAsset(asset, profile.id, 'source');
    for (const asset of profile.notices) validateManifestAsset(asset, profile.id, 'notice');
    for (const asset of profile.sections) validateManifestAsset(asset, profile.id, 'section');
    unique(profile.sources.map((asset) => asset.path), `${profile.id} manifest source path`);
    unique(profile.notices.map((asset) => asset.path), `${profile.id} manifest notice path`);
    if (profile.sections.length !== PHASES.length || profile.sections.some((asset, sectionIndex) => asset.id !== PHASES[sectionIndex])) {
      throw new TypeError(`workflow manifest ${profile.id} sections are invalid`);
    }
  }
  return manifest;
}

export function loadWorkflowBinding() {
  const manifest = loadManifest();
  const binding = {
    schemaVersion: 1,
    mode: 'bound',
    digest: manifest.digest,
    profiles: manifest.profiles.map((profile) => ({
      id: profile.id,
      adapterRevision: profile.adapterRevision,
      upstream: profile.upstream,
      sources: profile.sources.map((asset) => {
        readInstalledAsset({ profileId: profile.id, group: 'source', asset });
        return { path: asset.path, sha256: asset.sha256 };
      }),
      notices: profile.notices.map((asset) => {
        readInstalledAsset({ profileId: profile.id, group: 'notice', asset });
        return { path: asset.path, sha256: asset.sha256 };
      }),
      sections: profile.sections.map((asset) => ({
        id: asset.id,
        phases: asset.phases,
        content: readInstalledAsset({ profileId: profile.id, group: 'section', asset }).toString('utf8'),
        sha256: asset.sha256,
      })),
    })),
  };
  validateWorkflowBinding({ binding });
  return deepFreeze(binding);
}

export function workflowIdentity({ binding }) {
  const value = validateWorkflowBinding({ binding });
  return value.mode === 'legacy-unbound'
    ? { schemaVersion: 1, mode: 'legacy-unbound' }
    : { schemaVersion: 1, mode: 'bound', digest: value.digest };
}

export function workflowSnapshotEntry({ binding }) {
  const value = validateWorkflowBinding({ binding });
  return {
    id: BINDING_ENTRY_ID,
    kind: 'workflow-binding',
    content: JSON.stringify(value),
    sourceIdentity: value.mode === 'bound' ? value.digest : 'legacy-unbound',
    provenance: { source: 'workflow-binding', id: value.mode === 'bound' ? value.digest : 'legacy-unbound' },
    status: 'required',
  };
}

function sameIdentity(actual, expected) {
  return JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
}

function validIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return false;
  if (identity.schemaVersion !== 1) return false;
  if (identity.mode === 'legacy-unbound') return Object.keys(identity).length === 2;
  return identity.mode === 'bound' && Object.keys(identity).length === 3 && SHA256.test(identity.digest);
}

export function readWorkflowBinding({ snapshot, expected, allowLegacy = false }) {
  plainObject(snapshot, 'workflow snapshot');
  const candidates = Array.isArray(snapshot.entries) ? snapshot.entries.filter((entry) => entry
    && typeof entry === 'object' && (entry.id === BINDING_ENTRY_ID || entry.kind === 'workflow-binding')) : [];
  if (!Object.hasOwn(snapshot, 'workflow') && candidates.length === 0 && allowLegacy) {
    const legacy = { schemaVersion: 1, mode: 'legacy-unbound' };
    if (expected !== undefined && (!validIdentity(expected) || !sameIdentity(expected, legacy))) {
      throw new Error('workflow snapshot expected identity conflicts with binding');
    }
    return legacy;
  }
  if (!validIdentity(snapshot.workflow)) throw new Error('workflow snapshot marker is invalid');
  if (candidates.length !== 1) throw new Error('workflow snapshot requires one workflow binding entry');
  const entry = candidates[0];
  if (entry.id !== BINDING_ENTRY_ID || entry.kind !== 'workflow-binding' || entry.status !== 'required'
    || typeof entry.content !== 'string') throw new Error('workflow snapshot binding entry is invalid');
  let binding;
  try {
    binding = JSON.parse(entry.content);
  } catch {
    throw new Error('workflow snapshot binding content is malformed');
  }
  validateWorkflowBinding({ binding });
  const identity = workflowIdentity({ binding });
  if (!sameIdentity(snapshot.workflow, identity)) throw new Error('workflow snapshot identity conflicts with binding');
  if (entry.sourceIdentity !== (binding.mode === 'bound' ? binding.digest : 'legacy-unbound')) {
    throw new Error('workflow snapshot entry source identity conflicts with binding');
  }
  if (expected !== undefined && (!validIdentity(expected) || !sameIdentity(expected, identity))) {
    throw new Error('workflow snapshot expected identity conflicts with binding');
  }
  return binding;
}

function requiredPhase(phase) {
  if (!PHASES.includes(phase)) throw new TypeError('unsupported workflow phase');
}

export function renderWorkflowGuidance({ binding, phase }) {
  const value = validateWorkflowBinding({ binding });
  requiredPhase(phase);
  if (value.mode === 'legacy-unbound') return `Workflow guidance is unbound for historical ${phase} work.`;
  return [
    `Workflow guidance delivery projection (captured binding digest: ${value.digest}).`,
    ...value.profiles.map((profile) => {
      const section = profile.sections.find((candidate) => candidate.id === phase);
      return `## ${profile.id} adapter revision ${profile.adapterRevision} (${profile.upstream.repository}@${profile.upstream.commit})\n\n${section.content}`;
    }),
  ].join('\n\n');
}

export function summarizeWorkflowBinding({ binding, phase } = {}) {
  const value = validateWorkflowBinding({ binding });
  if (phase !== undefined) requiredPhase(phase);
  if (value.mode === 'legacy-unbound') return { mode: 'legacy-unbound', profiles: [] };
  return {
    mode: 'bound',
    digest: value.digest,
    profiles: value.profiles.map((profile) => ({
      id: profile.id,
      adapterRevision: profile.adapterRevision,
      upstreamCommit: profile.upstream.commit,
      sections: phase === undefined ? profile.sections.map((section) => section.id) : [phase],
    })),
  };
}
