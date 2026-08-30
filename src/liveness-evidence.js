import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const DEFAULT_FILE_LIMIT = 200;
const IGNORED_DIRECTORIES = new Set(['.git']);

// Worktree inspection is intentionally bounded. A liveness question must never turn a
// very large checkout into a second stall, but the judge still needs concrete file names
// when ordinary source files changed while the seat was silent.
export function inspectWorktreeActivity(cwd, sinceMs, { fileLimit = DEFAULT_FILE_LIMIT } = {}) {
  if (!Number.isFinite(sinceMs)) {
    throw new TypeError('sinceMs must be a finite timestamp');
  }
  if (!Number.isSafeInteger(fileLimit) || fileLimit < 1) {
    throw new TypeError('fileLimit must be a positive safe integer');
  }

  const changedFiles = [];
  const pending = [cwd];
  let inspectedFiles = 0;
  let truncated = false;
  while (pending.length > 0 && !truncated) {
    const directory = pending.pop();
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      inspectedFiles++;
      if (inspectedFiles > fileLimit) {
        truncated = true;
        break;
      }
      const path = join(directory, entry.name);
      try {
        const stat = statSync(path);
        if (stat.mtimeMs > sinceMs) changedFiles.push(relative(cwd, path));
      } catch { /* a concurrently replaced file is simply absent from this snapshot */ }
    }
  }

  return {
    changed: changedFiles.length > 0,
    changedFiles,
    inspectedFiles: Math.min(inspectedFiles, fileLimit),
    truncated,
    sinceMs,
  };
}
