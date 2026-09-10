import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  lstatSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { resolveProjectIdentity } from './project-memory.js';
import { loadWorkflowBinding, validateWorkflowBinding, workflowIdentity, workflowSnapshotEntry, readWorkflowBinding, renderWorkflowGuidance } from './workflow-profiles.js';

const reservedWorkflowEntry = entry => entry?.id === 'uroboros-workflow-binding' || entry?.kind === 'workflow-binding';
export function assertNativeContext(context = {}) {
  for (const key of ['workflow', 'workflowBinding', 'uroboros-workflow-binding', 'requirements', 'target']) {
    if (Object.hasOwn(context, key)) throw new Error(`reserved native context key: ${key}`);
  }
  if (Array.isArray(context.entries) && context.entries.some(reservedWorkflowEntry)) throw new Error('reserved workflow context entry');
}

/** Only internal options and authenticated parent snapshots may reach this seam. */
export function resolveNativeWorkflowBinding({ workflowBinding, parentSnapshots = [] } = {}) {
  const bindings = [workflowBinding, ...parentSnapshots.map(snapshot => readWorkflowBinding({ snapshot, allowLegacy: true }))].filter(value => value !== undefined);
  for (const binding of bindings) validateWorkflowBinding({ binding });
  if (bindings.some(binding => contextDigest({ workflow: workflowIdentity({ binding }) })
    !== contextDigest({ workflow: workflowIdentity({ binding: bindings[0] }) }))) {
    throw new Error('conflicting inherited workflow bindings');
  }
  return bindings[0] ?? loadWorkflowBinding();
}

/** A context reference carries grounding, never filesystem or action authority. */
export function readSharedContextReference({ reference, target }) {
  if (!reference || reference.schemaVersion !== 1 || typeof reference.path !== 'string'
    || !lstatSync(reference.path).isFile() || lstatSync(reference.path).isSymbolicLink()) throw new Error('invalid shared context reference');
  const snapshot = JSON.parse(readFileSync(reference.path, 'utf8'));
  const project = resolveProjectIdentity({ target });
  validateSharedContext({ snapshot, projectId: project.projectId });
  if (reference.projectId !== project.projectId || reference.projectId !== snapshot.projectId
    || reference.runId !== snapshot.runId || reference.unitId !== snapshot.unitId
    || reference.contextDigest !== snapshot.digest) throw new Error('shared context reference identity changed');
  return snapshot;
}

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
  redacted = redacted.replace(
    /((?:^|[^A-Za-z0-9_$])\$?(?:"|')?(?:password|passwd|secret|token|api[-_]?key|authorization|cookie|credential)(?:"|')?\s*\]?\s*[=:]\s*)(?:(["'])(.*?)\2|([^,;}\r\n]+))/gi,
    (_match, prefix, quote) => `${prefix}${quote ? `${quote}[REDACTED]${quote}` : '[REDACTED]'}`,
  );
  redacted = redacted.replace(/(\bbearer\s+)[A-Za-z0-9._~+/-]{8,}={0,2}(?![A-Za-z0-9._~+/-])/gi,
    '$1[REDACTED]');
  redacted = redacted.replace(/\b(?:sk-|gh[opusr][_-]|github_pat[_-])[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
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
    ...(input.workflow === undefined ? {} : { workflow: input.workflow }),
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
  workflowBinding,
}) {
  const parentDigest = parent === null ? null : (typeof parent === 'string' ? parent : parent.digest);
  if (parent !== null) requireString(parentDigest, 'parent digest');
  if ((entries ?? []).some(reservedWorkflowEntry)) throw new Error('reserved workflow context entry');
  return buildSnapshot({
    projectId, runId, unitId, phase, sourceRevision,
    entries: workflowBinding === undefined ? entries : [...(entries ?? []), workflowSnapshotEntry({ binding: workflowBinding })],
    ...(workflowBinding === undefined ? {} : { workflow: workflowIdentity({ binding: workflowBinding }) }),
    evidence, parentDigest, recalled,
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
  if (entries.some(reservedWorkflowEntry)) throw new Error('reserved workflow context entry cannot be replaced');
  return buildSnapshot({
    projectId: current.projectId,
    runId: current.runId,
    unitId: current.unitId,
    phase,
    workflow: current.workflow,
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
  readWorkflowBinding({ snapshot, allowLegacy: true });
  validateReferences(snapshot.evidence, 'evidence');
  validateReferences(snapshot.recalled, 'recalled entry');
  const actualDigest = contextDigest(snapshot);
  if (actualDigest !== snapshot.digest) throw new Error('shared context digest mismatch');
  return snapshot;
}

export function renderSharedContext({ snapshot }) {
  const value = validateSharedContext({ snapshot, projectId: snapshot?.projectId });
  const binding = readWorkflowBinding({ snapshot: value, allowLegacy: true });
  // Project only known harness carriers. Original snapshots and conversation remain immutable.
  const projectEntries = (entries, nested = false) => entries.map(entry => {
    if (reservedWorkflowEntry(entry)) return { ...entry,
      content: nested ? JSON.stringify(workflowIdentity({ binding: JSON.parse(entry.content) })) : renderWorkflowGuidance({ binding, phase: value.phase }),
      delivery: { projection: true, originalContentDigest: contextDigest({ content: entry.content }) } };
    const queueResults = entry.kind === 'queue-results' && entry.id === 'prior-units' && entry.provenance?.origin === 'queue';
    if (!queueResults && !['queueParent', 'retained-phase', 'planning-handoff'].includes(entry.kind)) return entry;
    let content;
    try { content = JSON.parse(entry.content); } catch { return entry; }
    if (!content || typeof content !== 'object') return entry;
    let changed = false;
    const projectCarrier = (owner, key) => {
      if (!Array.isArray(owner?.[key])) return;
      const projected = projectEntries(owner[key], true);
      if (projected.some((value, index) => value !== owner[key][index])) { owner[key] = projected; changed = true; }
    };
    if (entry.kind === 'queueParent') projectCarrier(content, 'entries');
    if (entry.kind === 'retained-phase') projectCarrier(content, 'parentEntries');
    if (entry.kind === 'planning-handoff') projectCarrier(content.snapshot, 'entries');
    // Queue results are [unit id, prior-work record] tuples. Only their captured
    // context carries a workflow; keep the surrounding evidence/history intact.
    if (queueResults && Array.isArray(content)) for (const row of content) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string') continue;
      const snapshot = row[1]?.context;
      if (snapshot?.schemaVersion === 1 && /^context-[a-f0-9]{64}$/.test(snapshot.id)) projectCarrier(snapshot, 'entries');
    }
    if (!changed) return entry;
    return { ...entry, content: JSON.stringify(content), delivery: { projection: true, originalContentDigest: contextDigest({ content: entry.content }) } };
  });
  return [
    'Shared grounding snapshot delivery projection (original snapshot digest below; projected bytes differ; evidence still requires inspection):',
    JSON.stringify(canonical({ ...value, workflow: workflowIdentity({ binding }), entries: projectEntries(value.entries) }), null, 2),
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
