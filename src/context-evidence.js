import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

const KINDS = new Set(['code', 'command', 'requirement', 'external', 'memory', 'inference']);
const UNPROVEN_KINDS = new Set(['question', 'hypothesis', 'preference']);
const SENSITIVE_KEY = /(?:password|passwd|secret|token|api[-_]?key|authorization|cookie|credential)/i;

function digest(value) {
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

function redactString(value) {
  let result = value;
  result = result.replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]');
  result = result.replace(/((?:password|passwd|secret|token|api[-_]?key)\s*[=:]\s*)[^\s,;]+/gi,
    '$1[REDACTED]');
  result = result.replace(/\b(?:sk|gh[opusr]|github_pat)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
  return { value: result, redacted: result !== value };
}

function redact(value, key = '') {
  if (SENSITIVE_KEY.test(key) && value !== undefined && value !== null) {
    return { value: '[REDACTED]', redacted: true };
  }
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) {
    const children = value.map((entry) => redact(entry));
    return { value: children.map((entry) => entry.value), redacted: children.some((entry) => entry.redacted) };
  }
  if (value && typeof value === 'object') {
    const copy = {};
    let changed = false;
    for (const [childKey, childValue] of Object.entries(value)) {
      const child = redact(childValue, childKey);
      copy[childKey] = child.value;
      changed ||= child.redacted;
    }
    return { value: copy, redacted: changed };
  }
  return { value, redacted: false };
}

function nativePath(path) {
  return realpathSync.native(resolve(path));
}

function normalized(path) {
  const value = resolve(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function segmentInside(root, file) {
  const rel = relative(normalized(root), normalized(file));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function scopedExistingFile(root, locator) {
  const canonicalRoot = nativePath(root);
  const candidate = resolve(canonicalRoot, locator);
  if (!segmentInside(canonicalRoot, candidate)) throw new Error('evidence source is outside the project scope');
  if (!existsSync(candidate)) throw new Error('evidence source is missing');
  const canonicalFile = nativePath(candidate);
  if (!segmentInside(canonicalRoot, canonicalFile)) throw new Error('evidence source resolves outside the project scope');
  if (!lstatSync(canonicalFile).isFile()) throw new Error('evidence source must be a regular file');
  return canonicalFile;
}

function validateShape(value, projectId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('evidence is required');
  requireString(projectId, 'projectId');
  requireString(value.id, 'evidence id');
  requireString(value.kind, 'evidence kind');
  if (!KINDS.has(value.kind)) throw new TypeError(`unsupported evidence kind: ${value.kind}`);
  if (value.projectId !== projectId) throw new Error('evidence project identity mismatch');
  requireString(value.sourceIdentity, 'evidence source identity');
  if (!Array.isArray(value.claimIds) || value.claimIds.some((id) => typeof id !== 'string' || id === '')) {
    throw new TypeError('evidence claimIds must be an array of ids');
  }
  if (new Set(value.claimIds).size !== value.claimIds.length) throw new TypeError('duplicate evidence claim id');
  if (value.kind === 'code') {
    if (!value.locator || typeof value.locator !== 'object') throw new TypeError('code locator is required');
    requireString(value.locator.path, 'code locator path');
    if (!Number.isInteger(value.locator.line) && !value.locator.symbol) {
      throw new TypeError('code locator requires a precise line or symbol');
    }
  }
  if (value.kind === 'command') {
    if (value.executed !== true) throw new TypeError('command executed metadata is required');
    if (!Array.isArray(value.argv) || value.argv.length === 0
      || value.argv.some((part) => typeof part !== 'string')) throw new TypeError('command argv is required');
    requireString(value.cwd, 'command cwd');
    if (!Number.isInteger(value.exitCode)) throw new TypeError('command exitCode is required');
    requireString(value.status, 'command status');
    if (!Object.hasOwn(value, 'stdout') || typeof value.stdout !== 'string') {
      throw new TypeError('command stdout raw output is required');
    }
    if (!Object.hasOwn(value, 'stderr') || typeof value.stderr !== 'string') {
      throw new TypeError('command stderr raw output is required');
    }
    requireString(value.codeIdentity, 'command codeIdentity');
  }
  if (value.kind === 'requirement') {
    requireString(value.text, 'requirement text');
    requireString(value.locator?.briefingId, 'requirement briefing locator');
  }
  if (value.kind === 'external') {
    requireString(value.locator?.url, 'external URL');
    requireString(value.retrievedAt, 'external retrieval time');
    requireString(value.version, 'external version');
    requireString(value.excerpt, 'external permitted excerpt');
  }
  if (value.kind === 'memory') {
    if (!Array.isArray(value.underlyingEvidenceIds) || value.underlyingEvidenceIds.length === 0) {
      throw new TypeError('memory evidence requires underlying evidence ids');
    }
  }
  if (value.kind === 'inference') {
    if (!Array.isArray(value.premiseIds) || value.premiseIds.length === 0) {
      throw new TypeError('inference evidence requires premise ids');
    }
    requireString(value.explanation, 'inference explanation');
  }
}

function writeImmutable(path, bytes) {
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`immutable evidence already exists: ${basename(path)}`);
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function captureEvidence({ projectId, root, directory, evidence }) {
  requireString(root, 'evidence root');
  requireString(directory, 'evidence directory');
  validateShape(evidence, projectId);
  const sanitized = redact(evidence);
  const value = sanitized.value;
  if (value.kind === 'command') {
    const canonicalRoot = nativePath(root);
    const commandCwd = nativePath(value.cwd);
    if (!segmentInside(canonicalRoot, commandCwd)) throw new Error('command cwd is outside the project scope');
  }
  let bytes;
  if (value.kind === 'code') {
    bytes = readFileSync(scopedExistingFile(root, value.locator.path));
    if (redactString(bytes.toString('utf8')).redacted) {
      throw new Error('code evidence contains sensitive credential material and cannot be captured exactly');
    }
  } else {
    bytes = Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');
  }
  mkdirSync(directory, { recursive: true });
  const safeId = digest(value.id);
  const extension = value.kind === 'code' ? '.source' : '.json';
  const capturedPath = join(nativePath(directory), `${safeId}${extension}`);
  writeImmutable(capturedPath, bytes);
  const captured = {
    ...value,
    sourceDigest: digest(bytes),
    capturedPath,
    ...(sanitized.redacted && value.required === true ? { contextIncomplete: true } : {}),
  };
  return {
    ...captured,
    recordDigest: digest(JSON.stringify(canonical(captured))),
  };
}

export function validateEvidence({ evidence, projectId, roots }) {
  try {
    validateShape(evidence, projectId);
    requireString(evidence.sourceDigest, 'evidence source digest');
    requireString(evidence.capturedPath, 'evidence captured path');
    if (!Array.isArray(roots) || roots.length === 0) throw new TypeError('authorized evidence roots are required');
    const canonicalRoots = roots.filter((root) => typeof root === 'string' && existsSync(root)).map(nativePath);
    if (canonicalRoots.length === 0) throw new Error('authorized evidence roots are missing');
    if (!existsSync(evidence.capturedPath)) throw new Error('captured evidence is missing');
    const capturedPath = nativePath(evidence.capturedPath);
    if (!canonicalRoots.some((root) => segmentInside(root, capturedPath))) {
      throw new Error('captured evidence is outside authorized scope');
    }
    if (!lstatSync(capturedPath).isFile()) throw new Error('captured evidence is not a regular file');
    if (digest(readFileSync(capturedPath)) !== evidence.sourceDigest) {
      throw new Error('captured evidence digest mismatch');
    }
    const { recordDigest, ...record } = evidence;
    requireString(recordDigest, 'evidence record digest');
    if (recordDigest !== digest(JSON.stringify(canonical(record)))) {
      throw new Error('evidence record metadata digest mismatch');
    }
    if (evidence.kind === 'code') {
      const candidates = [];
      for (const root of canonicalRoots) {
        const candidate = resolve(root, evidence.locator.path);
        if (segmentInside(root, candidate) && existsSync(candidate)) candidates.push({ root, candidate });
      }
      if (candidates.length === 0) throw new Error('current evidence source is missing');
      const matching = candidates.some(({ root, candidate }) => {
        const canonicalFile = nativePath(candidate);
        return segmentInside(root, canonicalFile)
          && lstatSync(canonicalFile).isFile()
          && digest(readFileSync(canonicalFile)) === evidence.sourceDigest;
      });
      if (!matching) throw new Error('evidence is stale: current source digest differs');
    }
    return { valid: true, evidence };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error), evidence };
  }
}

export function createInspectionReceipt({ operationId, seat, evidence, inspected, result }) {
  requireString(operationId, 'inspection operationId');
  requireString(seat, 'inspection seat');
  requireString(result, 'inspection result');
  if (!Array.isArray(evidence)) throw new TypeError('inspection evidence must be an array');
  const evidenceIds = evidence.map((item) => typeof item === 'string' ? item : item?.id);
  if (evidenceIds.some((id) => typeof id !== 'string' || id === '')) {
    throw new TypeError('inspection evidence ids are required');
  }
  const observed = inspected === true || (Array.isArray(inspected)
    && evidenceIds.every((id) => inspected.includes(id)));
  const material = {
    schemaVersion: 1,
    operationId,
    seat,
    evidenceIds,
    inspected,
    observed,
    result,
  };
  return { ...material, id: `receipt-${digest(JSON.stringify(canonical(material)))}` };
}

export function validateClaims({ claims, evidence, projectId, roots, verifications = [], seat }) {
  const errors = [];
  if (!Array.isArray(claims)) return { valid: false, errors: ['claims must be an array'] };
  if (!Array.isArray(evidence)) return { valid: false, errors: ['evidence must be an array'] };
  const evidenceById = new Map(evidence.map((item) => [item?.id, item]));
  for (const claim of claims) {
    if (!claim || typeof claim !== 'object' || typeof claim.id !== 'string' || claim.id === '') {
      errors.push('claim id is required');
      continue;
    }
    const evidenceIds = Array.isArray(claim.evidenceIds) ? claim.evidenceIds : [];
    if (!UNPROVEN_KINDS.has(claim.kind) && evidenceIds.length === 0) {
      errors.push(`claim ${claim.id} requires linked evidence`);
    }
    for (const evidenceId of evidenceIds) {
      const item = evidenceById.get(evidenceId);
      if (!item) {
        errors.push(`claim ${claim.id} references missing evidence ${evidenceId}`);
        continue;
      }
      const checked = validateEvidence({ evidence: item, projectId, roots });
      if (!checked.valid) errors.push(`claim ${claim.id} evidence ${evidenceId}: ${checked.reason}`);
      if (!item.claimIds?.includes(claim.id)) {
        errors.push(`evidence ${evidenceId} does not identify claim ${claim.id}`);
      }
      if (claim.kind === 'inference' && item.kind === 'inference'
        && (!Array.isArray(item.premiseIds) || item.premiseIds.length === 0)) {
        errors.push(`inference claim ${claim.id} has no premises`);
      }
    }
    for (const verification of verifications.filter((item) => item?.claimId === claim.id)) {
      const requestedIds = verification.evidenceIds ?? evidenceIds;
      if (!Array.isArray(requestedIds) || requestedIds.length === 0) {
        errors.push(`verification for claim ${claim.id} requires nonempty evidence`);
        continue;
      }
      for (const evidenceId of requestedIds) {
        const item = evidenceById.get(evidenceId);
        if (!item) {
          errors.push(`verification for claim ${claim.id} references missing evidence ${evidenceId}`);
          continue;
        }
        const checked = validateEvidence({ evidence: item, projectId, roots });
        if (!checked.valid) {
          errors.push(`verification for claim ${claim.id} evidence ${evidenceId}: ${checked.reason}`);
        }
        if (!item.claimIds?.includes(claim.id)) {
          errors.push(`verification evidence ${evidenceId} does not identify claim ${claim.id}`);
        }
      }
      const receiptList = verification.inspectionReceipts ?? verification.receipts ?? [];
      if (!Array.isArray(receiptList) || receiptList.length === 0) {
        errors.push(`verification for claim ${claim.id} has no available inspection receipt`);
        continue;
      }
      for (const receipt of receiptList) {
        if (!receipt?.observed || receipt.inspected === false) {
          errors.push(`inspection receipt for claim ${claim.id} was not inspected`);
        }
        if (receipt.seat !== seat) errors.push(`inspection receipt for claim ${claim.id} belongs to another seat`);
        if (verification.result === 'supports' && receipt.result !== 'supports') {
          errors.push(`inspection receipt does not support claim ${claim.id}`);
        }
        if (!requestedIds.every((id) => receipt.evidenceIds?.includes(id))) {
          errors.push(`inspection receipt omits evidence for claim ${claim.id}`);
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
