// src/repo-map.js
// The input ration for big-tree conversations. It rations INPUT context only
// (never seat output), carries a single operator-set budget as its only bound,
// and DECLARES ITSELF: grade, omissions, fetchability. A bound that hides
// what it withheld is a defect.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnCapture } from './spawn.js';

export const DEFAULT_MAP_BUDGET = 12_000;

const SYMBOL_PATTERN = /^\s*(?:export\s+(?:default\s+)?(?:async\s+)?)?(?:function\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=|def\s+([A-Za-z_]\w*)\s*\()/;
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py']);

const HEADER = [
  '# Repository map (heuristic file/symbol survey, not the repository)',
  '',
  'This is a RATION, not a wall: you may read any file directly for the whole',
  'truth. File list from `git ls-files`; line counts read; symbols regex-scanned.',
  '',
].join('\n');

function extensionOf(path) {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot).toLowerCase();
}

function scanSymbols(text) {
  const symbols = [];
  for (const line of text.split('\n')) {
    const match = SYMBOL_PATTERN.exec(line);
    const name = match?.[1] ?? match?.[2] ?? match?.[3] ?? match?.[4];
    if (name) symbols.push(name);
  }
  return symbols;
}

export async function buildRepoMap({
  target,
  budget = DEFAULT_MAP_BUDGET,
  spawn = spawnCapture,
  readFile = readFileSync,
} = {}) {
  const ls = await spawn('git', ['-C', target, 'ls-files']);
  if (ls.code !== 0) {
    return `${HEADER}${(ls.stderr || 'git ls-files failed').trim()} — no file survey was produced; explore the directory directly.\n`;
  }
  const paths = ls.stdout.split(/\r?\n/).filter(Boolean);
  const entries = paths.map((path) => {
    let lines = null;
    let text = null;
    try {
      text = String(readFile(join(target, path)));
      lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    } catch { /* unreadable stays null — declared below, never invented */ }
    return { path, lines, text };
  });

  // Directory-grouped file listing, then symbol scans largest-first, appended
  // while the budget holds. Whatever does not fit is COUNTED and NAMED.
  const byDirectory = new Map();
  for (const entry of entries) {
    const slash = entry.path.lastIndexOf('/');
    const directory = slash === -1 ? '.' : entry.path.slice(0, slash);
    if (!byDirectory.has(directory)) byDirectory.set(directory, []);
    byDirectory.get(directory).push(entry);
  }

  const lines = [HEADER, '## Files', ''];
  const omitted = new Map();
  const reserve = 400; // space kept for omission notes + symbols header — itself declared: notes always fit.
  let spent = lines.join('\n').length;
  for (const [directory, group] of [...byDirectory.entries()].sort()) {
    const heading = `### ${directory}/`;
    if (spent + heading.length + 1 > budget - reserve) {
      omitted.set(directory, group.length);
      continue;
    }
    lines.push(heading);
    spent += heading.length + 1;
    for (const entry of group) {
      const row = `- ${entry.path} (${entry.lines ?? 'unreadable'} lines)`;
      if (spent + row.length + 1 > budget - reserve) {
        omitted.set(directory, (omitted.get(directory) ?? 0) + 1);
        continue;
      }
      lines.push(row);
      spent += row.length + 1;
    }
  }

  const largestFirst = entries
    .filter((entry) => entry.text !== null && SOURCE_EXTENSIONS.has(extensionOf(entry.path)))
    .sort((left, right) => (right.lines ?? 0) - (left.lines ?? 0));
  const symbolLines = [];
  let symbolFilesShown = 0;
  for (const entry of largestFirst) {
    const symbols = scanSymbols(entry.text);
    if (symbols.length === 0) continue;
    const row = `- ${entry.path}: ${symbols.join(', ')}`;
    if (spent + row.length + 24 > budget - reserve) break;
    symbolLines.push(row);
    spent += row.length + 1;
    symbolFilesShown++;
  }
  if (symbolLines.length > 0) lines.push('', '## Symbols (largest files first)', ...symbolLines);

  const notes = [];
  for (const [directory, count] of [...omitted.entries()].sort()) {
    notes.push(`… and ${count} more files under ${directory}/ (budget) — read them directly if relevant.`);
  }
  const symbolsSkipped = largestFirst.length - symbolFilesShown;
  if (symbolsSkipped > 0) {
    notes.push(`… symbol scans withheld for ${symbolsSkipped} more files (budget) — read them directly if relevant.`);
  }
  if (notes.length > 0) lines.push('', '## Withheld by the budget', ...notes);
  return `${lines.join('\n')}\n`;
}
