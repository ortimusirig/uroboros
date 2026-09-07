import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const IDENTITY_METADATA = new Set(['digest', 'delivery', 'audit']);
const SENSITIVE_KEY = /(?:password|passwd|secret|token|api[-_]?key|authorization|cookie|credential)/i;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} is required`);
}

function redactString(value) {
  let redacted = value;
  redacted = redacted.replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]');
  redacted = redacted.replace(/((?:password|passwd|secret|token|api[-_]?key)\s*[=:]\s*)[^\s,;]+/gi,
    '$1[REDACTED]');
  redacted = redacted.replace(/\b(?:sk|gh[opusr]|github_pat)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
  return { value: redacted, redacted: redacted !== value };
}

function redact(value, key = '') {
  if (SENSITIVE_KEY.test(key) && value !== undefined && value !== null) {
    return { value: '[REDACTED]', redacted: true };
  }
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) {
    const values = value.map((item) => redact(item));
    return { value: values.map((item) => item.value), redacted: values.some((item) => item.redacted) };
  }
  if (value && typeof value === 'object') {
    let anyRedacted = false;
    const result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const child = redact(childValue, childKey);
      result[childKey] = child.value;
      anyRedacted ||= child.redacted;
    }
    return { value: result, redacted: anyRedacted };
  }
  return { value, redacted: false };
}

function validateReferences(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  const ids = new Set();
  for (const value of values) {
    if (!value || typeof value !== 'object') throw new TypeError(`${label} entries must be objects`);
    requireString(value.id, `${label} id`);
    if (ids.has(value.id)) throw new TypeError(`duplicate ${label} id: ${value.id}`);
    ids.add(value.id);
    requireString(value.sourceIdentity, `${label} source identity`);
  }
}

function validateEntries(entries) {
  validateReferences(entries, 'entry');
  for (const entry of entries) {
    requireString(entry.kind, `entry ${entry.id} kind`);
    requireString(entry.status, `entry ${entry.id} status`);
    if (typeof entry.content !== 'string' && !(entry.reference && typeof entry.reference === 'object')) {
      throw new TypeError(`entry ${entry.id} requires content or a pinned reference`);
    }
    if (!entry.provenance || typeof entry.provenance !== 'object') {
      throw new TypeError(`entry ${entry.id} provenance is required`);
    }
  }
}

function identityValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !IDENTITY_METADATA.has(key)));
}

export function contextDigest(value) {
  const serialized = JSON.stringify(canonical(identityValue(value)));
  return createHash('sha256').update(serialized).digest('hex');
}

function buildSnapshot(input, inheritedReasons = []) {
  for (const name of ['projectId', 'runId', 'unitId', 'phase', 'sourceRevision']) {
    requireString(input[name], name);
  }
  const rawEntries = input.entries ?? [];
  const rawEvidence = input.evidence ?? [];
  const rawRecalled = input.recalled ?? [];
  validateEntries(rawEntries);
  validateReferences(rawEvidence, 'evidence');
  validateReferences(rawRecalled, 'recalled entry');

  const sanitizedEntries = redact(rawEntries);
  const sanitizedEvidence = redact(rawEvidence);
  const sanitizedRecalled = redact(rawRecalled);
  const requiredRedacted = rawEntries.some((entry, index) => entry.status === 'required'
    && JSON.stringify(entry) !== JSON.stringify(sanitizedEntries.value[index]))
    || rawEvidence.some((item, index) => item.required === true
      && JSON.stringify(item) !== JSON.stringify(sanitizedEvidence.value[index]))
    || rawRecalled.some((item, index) => (item.required === true || item.status === 'required')
      && JSON.stringify(item) !== JSON.stringify(sanitizedRecalled.value[index]));
  const incompleteEvidence = rawEvidence.some((item) => item.contextIncomplete === true);
  const reasons = [...new Set([
    ...inheritedReasons,
    ...(incompleteEvidence ? ['included required evidence is incomplete'] : []),
    ...(requiredRedacted ? ['required context contained redacted sensitive material'] : []),
  ])];
  const material = {
    schemaVersion: 1,
    parentDigest: input.parentDigest ?? null,
    projectId: input.projectId,
    runId: input.runId,
    unitId: input.unitId,
    phase: input.phase,
    sourceRevision: input.sourceRevision,
    entries: sanitizedEntries.value,
    evidence: sanitizedEvidence.value,
    recalled: sanitizedRecalled.value,
    completeness: { complete: reasons.length === 0, reasons },
  };
  const idSeed = contextDigest(material);
  const withId = { ...material, id: `context-${idSeed}` };
  return { ...withId, digest: contextDigest(withId) };
}

export function createSharedContext({
  projectId,
  runId,
  unitId,
  phase,
  sourceRevision,
  entries,
  evidence = [],
  parent = null,
  recalled = [],
}) {
  const parentDigest = parent === null ? null : (typeof parent === 'string' ? parent : parent.digest);
  if (parent !== null) requireString(parentDigest, 'parent digest');
  return buildSnapshot({
    projectId, runId, unitId, phase, sourceRevision, entries, evidence, parentDigest, recalled,
  });
}

export function extendSharedContext({
  snapshot,
  entries = [],
  evidence = [],
  phase = snapshot?.phase,
  sourceRevision = snapshot?.sourceRevision,
  recalled = [],
}) {
  const current = validateSharedContext({ snapshot, projectId: snapshot?.projectId });
  return buildSnapshot({
    projectId: current.projectId,
    runId: current.runId,
    unitId: current.unitId,
    phase,
    sourceRevision,
    entries: [...current.entries, ...entries],
    evidence: [...current.evidence, ...evidence],
    recalled: [...current.recalled, ...recalled],
    parentDigest: current.digest,
  }, current.completeness?.reasons ?? []);
}

export function validateSharedContext({ snapshot, projectId }) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError('shared context snapshot is required');
  }
  if (snapshot.schemaVersion !== 1) throw new TypeError('unsupported shared context schema version');
  requireString(projectId, 'projectId');
  if (snapshot.projectId !== projectId) throw new Error('shared context project identity mismatch');
  for (const name of ['id', 'digest', 'runId', 'unitId', 'phase', 'sourceRevision']) {
    requireString(snapshot[name], `snapshot ${name}`);
  }
  if (!/^context-[a-f0-9]{64}$/.test(snapshot.id)) {
    throw new TypeError('snapshot id must be a safe digest-derived identity');
  }
  if (snapshot.parentDigest !== null) requireString(snapshot.parentDigest, 'snapshot parent digest');
  validateEntries(snapshot.entries);
  validateReferences(snapshot.evidence, 'evidence');
  validateReferences(snapshot.recalled, 'recalled entry');
  const actualDigest = contextDigest(snapshot);
  if (actualDigest !== snapshot.digest) throw new Error('shared context digest mismatch');
  return snapshot;
}

export function renderSharedContext({ snapshot }) {
  const value = validateSharedContext({ snapshot, projectId: snapshot?.projectId });
  return [
    'Shared grounding snapshot (content identity only; evidence still requires inspection):',
    JSON.stringify(canonical(value), null, 2),
  ].join('\n');
}

export function persistSharedContext({ directory, snapshot }) {
  requireString(directory, 'directory');
  const value = validateSharedContext({ snapshot, projectId: snapshot?.projectId });
  const contextDirectory = join(directory, '__uro_context');
  mkdirSync(contextDirectory, { recursive: true });
  const path = join(contextDirectory, `${value.id}.json`);
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`immutable shared context already exists: ${value.id}`);
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return path;
}
