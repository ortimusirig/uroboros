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

const BINARY_SAMPLE_SIZE = 8 * 1024;
const BINARY_SUSPICIOUS_FRACTION = 0.30;

// Conservative binary rule: any NUL unit anywhere is binary. Otherwise, sample
// the first 8,192 units and classify as binary when more than 30% of them are
// outside printable ASCII (0x20..0x7e) plus TAB, LF, and CR. Buffer units are
// inspected as raw bytes; string test doubles use their UTF-16 character units.
function isBinaryContent(content) {
  const units = typeof content === 'string' || Buffer.isBuffer(content)
    ? content
    : String(content);
  const unitAt = typeof units === 'string'
    ? (index) => units.charCodeAt(index)
    : (index) => units[index];

  for (let index = 0; index < units.length; index++) {
    if (unitAt(index) === 0) return true;
  }

  const sampleLength = Math.min(units.length, BINARY_SAMPLE_SIZE);
  if (sampleLength === 0) return false;
  let suspicious = 0;
  for (let index = 0; index < sampleLength; index++) {
    const unit = unitAt(index);
    const printableAscii = unit >= 0x20 && unit <= 0x7e;
    const commonWhitespace = unit === 0x09 || unit === 0x0a || unit === 0x0d;
    if (!printableAscii && !commonWhitespace) suspicious++;
  }
  return suspicious / sampleLength > BINARY_SUSPICIOUS_FRACTION;
}

// Extra characters the '## Symbols (largest files first)' section header costs
// once the symbol loop below prepends it — DERIVED from the same two elements
// that lines.push() adds ('' then the header, each costing its length plus a
// join separator), so this margin and that push can never drift apart the way
// a hand-picked number silently could.
const SYMBOLS_HEADER_MARGIN = ['', '## Symbols (largest files first)'].join('\n').length + 1;

const HEADER = [
  '# Repository map (heuristic file/symbol survey, not the repository)',
  '',
  'This is a RATION, not a wall: you may read any file directly for the whole',
  'truth. File list from `git ls-files`; text line counts read; text symbols regex-scanned.',
  'Binary treatment: a NUL byte/character anywhere, or >30% of the first 8192 byte/character units outside printable ASCII plus TAB/LF/CR, means binary — not line-counted or symbol-scanned.',
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

// Sort [key, ...] entry pairs by the key alone. Array#sort()'s default comparator
// stringifies and compares lexicographically too, but leaving it implicit invites
// exactly the bug it doesn't have yet — spell out what's actually being compared.
function byEntryKey([a], [b]) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Detail-shortening marker for the no-survey path: explicit, like every other
// truncation note in this file ('…'-prefixed), so a shortened git-error detail
// is never mistaken for the whole message.
const NO_SURVEY_SHORTENED_MARKER = '… (git error detail shortened: budget)';
const NO_SURVEY_SUFFIX = ' — no file survey was produced; explore the directory directly.\n';

function renderNoSurvey(detail) {
  return `${HEADER}${detail}${NO_SURVEY_SUFFIX}`;
}

// The floor of the no-survey path: even when the error detail is shortened
// all the way down to nothing, the shortened-marker itself still has to fit.
// This is the smallest noSurvey() can ever render — DERIVED by actually
// rendering it, never guessed — and feeds MINIMUM_MAP_BUDGET below.
function renderNoSurveyMinimal() {
  return renderNoSurvey(NO_SURVEY_SHORTENED_MARKER);
}

// noSurvey() joins the same measured discipline as buildRepoMap's fallback
// ladder below: build the full text, and only if it overflows `budget`,
// shorten ONLY the error-detail portion, marking the cut explicitly so
// nothing is silently withheld. The surrounding self-declaration ('no file
// survey was produced...') is fixed text and is never what gets cut.
function noSurvey(reason, budget) {
  const detail = (reason || 'git ls-files failed').trim();
  const full = renderNoSurvey(detail);
  if (full.length <= budget) return full;

  const overhead = HEADER.length + NO_SURVEY_SHORTENED_MARKER.length + NO_SURVEY_SUFFIX.length;
  const shortenedDetail = detail.slice(0, Math.max(0, budget - overhead));
  const shortened = renderNoSurvey(`${shortenedDetail}${NO_SURVEY_SHORTENED_MARKER}`);

  // Defensive final guard, in the same spirit as the fallback ladder's last
  // rung further down: impossible by construction (budget >= MINIMUM_MAP_BUDGET,
  // and MINIMUM_MAP_BUDGET is derived from — among other things — this exact
  // zero-detail rendering) — but self-naming and loud rather than a silent
  // overflow if a future edit ever breaks that invariant.
  if (shortened.length > budget) {
    throw new Error(
      `repo-map bug: the shortened no-survey self-declaration (${shortened.length} chars) exceeds budget ${budget} even though budget >= MINIMUM_MAP_BUDGET (${MINIMUM_MAP_BUDGET}) — this should be impossible; noSurvey() and MINIMUM_MAP_BUDGET have drifted apart`,
    );
  }
  return shortened;
}

// The last line a map can EVER lose: even when nothing else fits, this alone
// must survive, because a bound that hides its own withholding is the exact
// defect this module exists to prevent.
const LAST_RESORT_LINE = "survey withheld (budget below the survey's minimum); read the tree directly.";

function renderMinimal() {
  return `${HEADER}${LAST_RESORT_LINE}\n`;
}

// The floor: below this, not even the least detailed honest output fits, so
// there is no honest string buildRepoMap could return. DERIVED from the max
// of the two candidates that could each, on their own path, be the smallest
// thing this module ever returns — the ladder's last-resort line and the
// no-survey path's fully-shortened form — never a guessed number, so it can
// never drift from what those renders really produce.
export const MINIMUM_MAP_BUDGET = Math.max(renderMinimal().length, renderNoSurveyMinimal().length);

export async function buildRepoMap({
  target,
  budget = DEFAULT_MAP_BUDGET,
  spawn = spawnCapture,
  readFile = readFileSync,
} = {}) {
  // Loud input validation, like the repo's other argument checks: do not let
  // JavaScript coerce malformed values into character counts. Below the floor
  // no return path — not even the last-resort one — can be honest, so fail
  // before doing any work rather than let a later step overflow trying anyway.
  if (!Number.isFinite(budget)) {
    const stringRepair = typeof budget === 'string'
      ? 'pass a number (parse or convert it); '
      : '';
    const receivedType = typeof budget === 'string' ? ' (string)' : '';
    throw new TypeError(
      `map budget received ${String(budget)}${receivedType}; ${stringRepair}budget must be a finite number of characters, e.g. 12000`,
    );
  }
  if (budget < MINIMUM_MAP_BUDGET) {
    throw new TypeError(
      `map budget received ${budget}; budget must be at least MINIMUM_MAP_BUDGET (${MINIMUM_MAP_BUDGET}) characters — increase it to ${MINIMUM_MAP_BUDGET} or more`,
    );
  }
  let ls;
  try {
    ls = await spawn('git', ['-C', target, 'ls-files']);
  } catch (error) {
    // A launch failure (ENOENT, permissions, ...) is exactly as honest a "no
    // survey" as a non-zero exit — both mean git never handed back a file list.
    // Reject instead of throw so the caller always gets the self-declaring text.
    return noSurvey(error?.message ?? String(error), budget);
  }
  if (ls.code !== 0) {
    return noSurvey(ls.stderr, budget);
  }
  const paths = ls.stdout.split(/\r?\n/).filter(Boolean);
  const entries = paths.map((path) => {
    let lines = null;
    let text = null;
    let binary = false;
    try {
      const content = readFile(join(target, path));
      binary = isBinaryContent(content);
      if (!binary) {
        text = String(content);
        lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      }
    } catch { /* unreadable stays null — declared below, never invented */ }
    return { path, lines, text, binary };
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
  // Space kept clear of Files/Symbols content so the '## Withheld by the budget'
  // section below usually has room without falling back further. A packing
  // heuristic only, not a correctness guarantee — the fallback ladder after this
  // function measures every candidate's actual rendered length against `budget`
  // regardless of what this reserve left behind.
  const reserve = 400;
  let spent = lines.join('\n').length;
  for (const [directory, group] of [...byDirectory.entries()].sort(byEntryKey)) {
    const heading = `### ${directory}/`;
    if (spent + heading.length + 1 > budget - reserve) {
      omitted.set(directory, group.length);
      continue;
    }
    lines.push(heading);
    spent += heading.length + 1;
    for (const entry of group) {
      const treatment = entry.binary
        ? 'binary — not line-counted or symbol-scanned'
        : `${entry.lines ?? 'unreadable'} lines`;
      const row = `- ${entry.path} (${treatment})`;
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
    if (spent + row.length + SYMBOLS_HEADER_MARGIN > budget - reserve) break;
    symbolLines.push(row);
    spent += row.length + 1;
    symbolFilesShown++;
  }
  // Snapshot BEFORE the Symbols section (if any) is spliced in, for the
  // collapsedNoSymbols rung below — that rung must never show a Symbols
  // section (partial or not) whose incompleteness it isn't declaring, so it
  // renders from a base that never had one, rather than trusting a dropped
  // note to speak for content that's still sitting in `lines`.
  const linesWithoutSymbols = [...lines];
  if (symbolLines.length > 0) lines.push('', '## Symbols (largest files first)', ...symbolLines);

  const symbolsSkipped = largestFirst.length - symbolFilesShown;
  const render = (notes, baseLines = lines) => {
    const withNotes = notes.length > 0 ? [...baseLines, '', '## Withheld by the budget', ...notes] : baseLines;
    return `${withNotes.join('\n')}\n`;
  };

  // Prefer one note per omitted directory — most specific — but the budget bounds
  // this section too: with many small omitted directories, one line each is
  // unbounded and can itself blow the budget. Try the detailed form first...
  const directoryNotesDetailed = [...omitted.entries()].sort(byEntryKey)
    .map(([directory, count]) => `… and ${count} more files under ${directory}/ (budget) — read them directly if relevant.`);
  // ...and when it doesn't fit, collapse every omitted directory into one bounded
  // summary line instead of truncating mid-list (a silent, undeclared cap — the
  // exact defect this exists to prevent).
  const omittedFilesTotal = [...omitted.values()].reduce((sum, count) => sum + count, 0);
  const directoryNotesCollapsed = omitted.size > 0
    ? [`… omissions for ${omitted.size} directories (${omittedFilesTotal} files) withheld (budget) — this survey is incomplete; read the tree directly.`]
    : [];
  const symbolsNote = symbolsSkipped > 0
    ? [`… symbol scans withheld for ${symbolsSkipped} more files (budget) — read them directly if relevant.`]
    : [];

  // The collapsedNoSymbols rung (below) strips the '## Symbols' section
  // entirely rather than merely dropping its note — so from that rung's
  // perspective ALL symbol info is withheld, not just whatever symbolsNote
  // above would have named. Fold that into ONE line with the directory
  // omissions so a dropped note can never leave an (im)partial section
  // undeclared.
  const symbolsWithheldEntirely = largestFirst.length > 0;
  const collapsedNoSymbolsNotes = (() => {
    const clauses = [];
    if (omitted.size > 0) clauses.push(`omissions for ${omitted.size} directories (${omittedFilesTotal} files)`);
    if (symbolsWithheldEntirely) clauses.push('all symbol scans');
    return clauses.length > 0
      ? [`… ${clauses.join(' and ')} withheld (budget) — this survey is incomplete; read the tree directly.`]
      : [];
  })();

  // Fallback ladder from most to least detailed, MEASURING THE ACTUAL RENDERED
  // STRING at every step — the `reserve` above is a packing heuristic that keeps
  // this ladder short in the common case, never a guarantee, so nothing here
  // trusts it. Every rung but the last is checked before it is returned.
  const detailed = render([...directoryNotesDetailed, ...symbolsNote]);
  if (detailed.length <= budget) return detailed;

  const collapsed = render([...directoryNotesCollapsed, ...symbolsNote]);
  if (collapsed.length <= budget) return collapsed;

  const collapsedNoSymbols = render(collapsedNoSymbolsNotes, linesWithoutSymbols);
  if (collapsedNoSymbols.length <= budget) return collapsedNoSymbols;

  // Last rung: drop the Files/Symbols sections entirely and fall back to the
  // header plus the one last-resort line. Not measured against `budget` above
  // like the rungs before it — by construction (MINIMUM_MAP_BUDGET is this
  // exact string's length, and budget was already rejected below that floor)
  // it always fits. The check below is not what makes that true; it is a
  // defensive, self-explaining guard against a future edit breaking the
  // invariant silently instead of loudly.
  const minimal = renderMinimal();
  if (minimal.length > budget) {
    throw new Error(
      `repo-map bug: the minimal self-declaration (${minimal.length} chars) exceeds budget ${budget} even though budget >= MINIMUM_MAP_BUDGET (${MINIMUM_MAP_BUDGET}) — this should be impossible; renderMinimal() and MINIMUM_MAP_BUDGET have drifted apart`,
    );
  }
  return minimal;
}
