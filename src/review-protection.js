import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { reportEvent } from './events.js';
import {
  captureWorktreeSnapshot,
  restoreWorktreeSnapshot,
} from './worktree-snapshot.js';

export class WorktreeRestorationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'WorktreeRestorationError';
  }
}

// The harness writes these into the worktree itself (append-only run log, the task
// brief, the diff handoff, the reviewer's sanctioned report area). They are never a
// seat's scope violation, and restoring the run log rewrites history mid-run — the
// peer session watched it happen twice in live runs.
export const HARNESS_ARTIFACT_PATTERNS = Object.freeze([
  /^events\.jsonl$/, /^TASK\.md$/, /^CHANGES\.diff$/, /^__uro_review(\/|\\|$)/,
  /^\.uro-tmp(\/|\\|$)/,
]);
export function isHarnessArtifact(relativePath) {
  const normalized = String(relativePath).replace(/\\/g, '/');
  return HARNESS_ARTIFACT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function reviewFiles(cwd, prefix) {
  const root = resolve(cwd, prefix);
  const fromCwd = relative(resolve(cwd), root);
  if (fromCwd.startsWith('..') || isAbsolute(fromCwd)) {
    throw new Error(`protected review directory escapes the worktree: ${prefix}`);
  }
  const entries = new Map();
  const visit = (path) => {
    let stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    const key = relative(cwd, path).split(sep).join('/');
    const mode = stats.mode & 0o7777;
    if (stats.isDirectory()) {
      entries.set(key, { type: 'directory', mode });
      for (const entry of readdirSync(path)) visit(join(path, entry));
    } else if (stats.isFile()) {
      entries.set(key, { type: 'file', content: readFileSync(path), mode });
    } else if (stats.isSymbolicLink()) {
      let linkType = 'file';
      try {
        if (statSync(path).isDirectory()) linkType = 'dir';
      } catch {
        // Preserve dangling links as file links; this is the only portable
        // representation available without a target to inspect.
      }
      entries.set(key, { type: 'symlink', target: readlinkSync(path), linkType, mode });
    } else {
      throw new Error(`unsupported entry in protected review directory: ${key}`);
    }
  };
  visit(root);
  return { root, entries };
}

export async function captureReviewSnapshot({ cwd, prefix = '__uro_review' }) {
  return { cwd, prefix, ...reviewFiles(cwd, prefix) };
}

function entriesEqual(before, after) {
  if (before === undefined || after === undefined) return false;
  if (before.type !== after.type || before.mode !== after.mode) return false;
  if (before.type === 'file') return before.content.equals(after.content);
  if (before.type === 'symlink') {
    return before.target === after.target && before.linkType === after.linkType;
  }
  return true;
}

export async function restoreReviewSnapshot({ snapshot }) {
  const current = reviewFiles(snapshot.cwd, snapshot.prefix);
  const restoredPaths = [...new Set([...snapshot.entries.keys(), ...current.entries.keys()])]
    .filter((path) => !entriesEqual(snapshot.entries.get(path), current.entries.get(path)))
    .sort();
  if (restoredPaths.length === 0) return { restoredPaths };

  rmSync(snapshot.root, { recursive: true, force: true });
  const directories = [...snapshot.entries.entries()]
    .filter(([, entry]) => entry.type === 'directory')
    .sort(([left], [right]) => left.length - right.length);
  for (const [path] of directories) {
    mkdirSync(join(snapshot.cwd, path), { recursive: true });
  }
  for (const [path, entry] of snapshot.entries) {
    if (entry.type === 'directory') continue;
    const target = join(snapshot.cwd, path);
    mkdirSync(dirname(target), { recursive: true });
    if (entry.type === 'file') {
      writeFileSync(target, entry.content);
      chmodSync(target, entry.mode);
    } else {
      symlinkSync(entry.target, target, entry.linkType);
    }
  }
  // Apply directory modes last so read-only directories do not prevent rebuilding
  // their captured descendants.
  for (const [path, entry] of directories.sort(([left], [right]) => right.length - left.length)) {
    chmodSync(join(snapshot.cwd, path), entry.mode);
  }
  return { restoredPaths };
}

export async function runProtectedOperation({
  cwd,
  scope,
  prefix,
  stage,
  role,
  runId,
  reporter,
  operation,
  onRestore,
  captureSnapshot = captureWorktreeSnapshot,
  restoreSnapshot = restoreWorktreeSnapshot,
}) {
  const snapshot = await captureSnapshot({ cwd, scope, prefix });
  let result;
  let restoredPaths = [];
  try {
    result = await operation();
  } finally {
    let restoration;
    try {
      restoration = await restoreSnapshot({ snapshot, scope, prefix });
    } catch (error) {
      throw new WorktreeRestorationError(
        `failed to restore ${role} writes for ${prefix}`,
        { cause: error },
      );
    }
    restoredPaths = restoration?.restoredPaths ?? [];
    onRestore?.(restoredPaths);
    if (restoredPaths.length > 0) {
      reportEvent(reporter, runId, stage, 'scope_violation', {
        role,
        paths: restoredPaths,
        action: 'restored',
      });
    }
  }
  return { result, restoredPaths };
}
