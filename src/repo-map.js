// src/repo-map.js
// The input ration for big-tree conversations. It rations INPUT context only
// (never seat output), carries a single operator-set budget as its only bound,
// and DECLARES ITSELF: grade, omissions, fetchability. A bound that hides
// what it withheld is a defect.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnCapture } from './spawn.js';

export const DEFAULT_MAP_BUDGET = 12_000;

const SYMBOL_PATTERN = /^\s*(?:export\s+(?:default\s+)?(?:async\s+)?)?(?:function\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=|def\s+([A-Za-z_]\w*)\s*\()/;
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py']);

const BINARY_SAMPLE_SIZE = 8 * 1024;
const BINARY_SUSPICIOUS_FRACTION = 0.30;
const ADMISSION_READ_COST = 400;
const BYTE_CEILING_MULTIPLIER = 4;
const SYMBOL_PAYLOAD_DIVISOR = 3;

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

// The named content-admission rule runs before any file content is opened. Its
// stable lexical order is intentional: the same operator budget admits the
// same prefix regardless of how many paths follow it in `git ls-files`.
function contentAdmission(paths, budget) {
  const readCeiling = Math.max(1, Math.floor(budget / ADMISSION_READ_COST));
  const byteCeiling = Math.max(1, Math.floor(budget * BYTE_CEILING_MULTIPLIER));
  const longestPathLength = paths.reduce((longest, path) => Math.max(longest, path.length), 0);
  // A symbol row and a file row can name the same longest path.  Keep the
  // symbol payload small enough that its row cannot inflate the true maximum
  // beyond the normal one-third packing share; a genuinely long file row is
  // still allowed to be the (larger) reservation and is handled as such.
  const symbolPayloadCeiling = Math.max(
    1,
    Math.floor(budget / SYMBOL_PAYLOAD_DIVISOR) - longestPathLength - '- : '.length,
  );
  return {
    orderedPaths: [...paths].sort(),
    readCeiling,
    byteCeiling,
    prefixLength: byteCeiling + 1,
    symbolPayloadCeiling,
  };
}

// All possible per-file rows are defined here, before content reads. The
// reservation is the true maximum for the actual path/count/ceiling widths;
// no representative path or fixed column width can silently underestimate it.
function rowTemplateRegistry({ longestPath, countWidth, byteCeiling, symbolPayloadCeiling }) {
  const count = '9'.repeat(countWidth);
  const payload = 's'.repeat(symbolPayloadCeiling);
  const format = {
    inspectedText: (path, lines) => `- ${path} (${lines} lines) [inspected]`,
    inspectedBinary: (path) => `- ${path} (binary — not line-counted or symbol-scanned) [inspected]`,
    tooLargeMetadata: (path) => `- ${path} (admitted-but-too-large; metadata size exceeds ${byteCeiling}-byte ceiling)`,
    tooLargePrefix: (path) => `- ${path} (admitted-but-too-large; bounded content prefix exceeds ${byteCeiling}-byte ceiling)`,
    tooLargeContentUnavailable: (path) => `- ${path} (admitted-but-too-large; metadata size exceeds ${byteCeiling}-byte ceiling; content-unavailable)`,
    metadataUnavailable: (path, identity) => `- ${path} (metadata-unavailable; ${identity})`,
    contentUnavailable: (path, identity) => `- ${path} (content-unavailable; ${identity})`,
    omitted: (path) => `- ${path} (omitted; content admission budget)`,
    symbols: (path, names) => `- ${path}: ${names}`,
  };
  return {
    format,
    templates: [
      format.inspectedText(longestPath, count),
      format.inspectedBinary(longestPath),
      format.tooLargeMetadata(longestPath),
      format.tooLargePrefix(longestPath),
      format.tooLargeContentUnavailable(longestPath),
      format.metadataUnavailable(longestPath, 'inspected'),
      format.metadataUnavailable(longestPath, 'omitted'),
      format.contentUnavailable(longestPath, 'inspected'),
      format.contentUnavailable(longestPath, 'omitted'),
      format.omitted(longestPath),
      format.symbols(longestPath, payload),
    ],
  };
}

function rowTemplateContext(paths, admission) {
  const longestPath = paths.reduce((longest, path) => (path.length > longest.length ? path : longest), '');
  return {
    longestPath,
    countWidth: String(Math.max(1, paths.length, admission.readCeiling, admission.byteCeiling)).length,
    byteCeiling: admission.byteCeiling,
    symbolPayloadCeiling: admission.symbolPayloadCeiling,
  };
}

function reservePreReadRowSpace(paths, admission) {
  const { templates } = rowTemplateRegistry(rowTemplateContext(paths, admission));
  return Math.max(...templates.map((template) => template.length));
}

export function readPrefixSync(path, {
  length,
  adapters = { openSync, readSync, closeSync },
}) {
  const descriptor = adapters.openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const chunk = adapters.readSync(descriptor, buffer, bytesRead, length - bytesRead, bytesRead);
      if (chunk === 0) break;
      bytesRead += chunk;
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    adapters.closeSync(descriptor);
  }
}

function boundedSymbols(symbols, ceiling) {
  const payload = symbols.join(', ');
  if (payload.length <= ceiling) return payload;
  return `${payload.slice(0, Math.max(0, ceiling - 1))}…`;
}

function countNoun(count) {
  return count === 1 ? 'file' : 'files';
}

function symbolAccountingNotes({
  scanRanWithResultsRendered,
  scanRanButResultWithheld,
  scanNeverRan,
  scannedWithZeroResults,
}) {
  const notes = [];
  if (scanRanWithResultsRendered > 0) {
    const zeroResults = scannedWithZeroResults > 0
      ? ` (zero-results=${scannedWithZeroResults})`
      : '';
    notes.push(
      `… scan-ran-with-results-rendered: ${scanRanWithResultsRendered} ${countNoun(scanRanWithResultsRendered)}${zeroResults}.`,
    );
  }
  if (scanRanButResultWithheld > 0) {
    notes.push(
      `… scan-ran-but-result-withheld: ${scanRanButResultWithheld} ${countNoun(scanRanButResultWithheld)} (budget) — completed scan results did not fit this rung; read the files directly if relevant.`,
    );
  }
  if (scanNeverRan > 0) {
    notes.push(
      `… scan-never-ran: ${scanNeverRan} ${countNoun(scanNeverRan)} (symbolsSkipped=${scanNeverRan}; budget) — scans were not attempted; read the files directly if relevant.`,
    );
  }
  return notes;
}

function compactSymbolAccounting({
  scanRanWithResultsRendered,
  scanRanButResultWithheld,
  scanNeverRan,
  scannedWithZeroResults,
}) {
  const states = [];
  if (scanRanWithResultsRendered > 0) {
    const zeroResults = scannedWithZeroResults > 0
      ? ` (zero-results=${scannedWithZeroResults})`
      : '';
    states.push(`scan-ran-with-results-rendered=${scanRanWithResultsRendered}${zeroResults}`);
  }
  if (scanRanButResultWithheld > 0) {
    states.push(`scan-ran-but-result-withheld=${scanRanButResultWithheld} (budget)`);
  }
  if (scanNeverRan > 0) {
    states.push(`scan-never-ran=${scanNeverRan} (symbolsSkipped=${scanNeverRan}; budget)`);
  }
  return states.length > 0 ? `Symbol scan accounting: ${states.join('; ')}.` : '';
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
  const overhead = HEADER.length + NO_SURVEY_SHORTENED_MARKER.length + NO_SURVEY_SUFFIX.length;
  const detailLimit = Math.max(0, budget - overhead);
  if (detail.length <= detailLimit) return renderNoSurvey(detail);
  const shortenedDetail = detail.slice(0, detailLimit);
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

// The last detail line a map can EVER lose: it names content removed by the
// fallback without claiming its already-completed scans were withheld work.
const LAST_RESORT_LINE = 'Details withheld (budget); read the tree directly.';

function compactAdmissionDeclaration({ readCeiling, byteCeiling, prefixLength, symbolPayloadCeiling }, identity) {
  return `Content admission rule: lexical; r≤${readCeiling}, b≤${byteCeiling}, p≤${prefixLength}, s≤${symbolPayloadCeiling}; inspected=${identity.inspected}, admitted-but-too-large=${identity.tooLarge}, omitted=${identity.omitted}, metadata-unavailable=${identity.metadataUnavailable}; attempted survey declared.`;
}

function renderMinimal(symbolAccounting, admission, identity, preReadReservation = 0) {
  const accounting = compactSymbolAccounting(symbolAccounting);
  return `${HEADER}${compactAdmissionDeclaration(admission, identity)}\nReservation=${preReadReservation}. Content availability: unavailable=${identity.contentUnavailable ?? 0}.\n${LAST_RESORT_LINE}${accounting ? `\n${accounting}` : ''}\n`;
}

function renderCompactFallback({
  symbolAccounting, admission, identity, preReadReservation, entries, rowFormatters, budget,
}) {
  const accounting = compactSymbolAccounting(symbolAccounting);
  const prefix = `${HEADER}${compactAdmissionDeclaration(admission, identity)}\nReservation=${preReadReservation}. Content availability: unavailable=${identity.contentUnavailable ?? 0}.\n`;
  const suffix = `${LAST_RESORT_LINE}${accounting ? `\n${accounting}` : ''}\n`;
  const render = (fileLines) => `${prefix}${fileLines.length > 0
    ? `\n## Files\n\n${fileLines.join('\n')}\n`
    : ''}${suffix}`;
  const fileLines = [];
  const renderedPathByRow = new Map();
  const explicitlyWithheldPaths = new Set();
  const byDirectory = new Map();
  for (const entry of entries) {
    if (entry.identity !== 'omitted' || entry.metadata !== 'available') {
      // The last-resort line explicitly withholds this entry's detail. Record
      // that render decision here, independently of the classified-path set.
      explicitlyWithheldPaths.add(entry.path);
      continue;
    }
    const slash = entry.path.lastIndexOf('/');
    const directory = slash === -1 ? '.' : entry.path.slice(0, slash);
    if (!byDirectory.has(directory)) byDirectory.set(directory, []);
    byDirectory.get(directory).push(entry);
  }
  for (const [directory, group] of [...byDirectory.entries()].sort(byEntryKey)) {
    let wroteHeading = false;
    for (const entry of group) {
      const row = rowFormatters.omitted(entry.path);
      const candidate = wroteHeading
        ? [...fileLines, row]
        : [...fileLines, `### ${directory}/`, row];
      if (render(candidate).length > budget) {
        // This exact row did not render; LAST_RESORT_LINE declares it withheld.
        explicitlyWithheldPaths.add(entry.path);
        continue;
      }
      fileLines.push(...(wroteHeading ? [row] : [`### ${directory}/`, row]));
      // The finalizer parses the actual output against this row metadata, so a
      // dropped line cannot survive as a declaration by construction.
      renderedPathByRow.set(row, entry.path);
      wroteHeading = true;
    }
  }
  return {
    rung: 'compactFallback',
    text: render(fileLines),
    renderedPathByRow,
    explicitlyWithheldPathsByLine: new Map([[LAST_RESORT_LINE, explicitlyWithheldPaths]]),
  };
}

export function reconcileRepoMapCoverage({ classifiedPaths, declaredPaths, rung }) {
  for (const path of declaredPaths) {
    if (!classifiedPaths.has(path)) {
      throw new Error(
        `repo-map internal coverage error on ${rung}: extraneous declaration for unclassified path ${JSON.stringify(path)}`,
      );
    }
  }
  for (const path of classifiedPaths) {
    if (!declaredPaths.has(path)) {
      throw new Error(
        `repo-map internal coverage error on ${rung}: missing declaration for classified path ${JSON.stringify(path)}`,
      );
    }
  }
}

// The floor: below this, not even the least detailed honest output fits, so
// there is no honest string buildRepoMap could return. DERIVED from the max
// of the two candidates that could each, on their own path, be the smallest
// thing this module ever returns — the ladder's last-resort line and the
// no-survey path's fully-shortened form — never a guessed number, so it can
// never drift from what those renders really produce.
// `paths` is an Array, whose maximum length is 2^32 - 1; using that maximum in
// every state reserves enough decimal digits for any possible runtime count.
const MAX_ARRAY_COUNT = (2 ** 32) - 1;
// Reservations are numeric string lengths.  The minimal-rung floor cannot use
// the empty-tree value because a real applied reservation may need every digit
// a safe JavaScript integer can display; render that widest honest placeholder
// directly, without constructing a representative path or circularly asking
// the admission calculation for one.
const MAX_RESERVATION_FOR_DISPLAY = Number.MAX_SAFE_INTEGER;
const MAX_SYMBOL_ACCOUNTING = {
  scanRanWithResultsRendered: MAX_ARRAY_COUNT,
  scanRanButResultWithheld: MAX_ARRAY_COUNT,
  scanNeverRan: MAX_ARRAY_COUNT,
  scannedWithZeroResults: MAX_ARRAY_COUNT,
};
const MAX_ADMISSION_IDENTITY = {
  inspected: MAX_ARRAY_COUNT,
  tooLarge: MAX_ARRAY_COUNT,
  omitted: MAX_ARRAY_COUNT,
  metadataUnavailable: MAX_ARRAY_COUNT,
  contentUnavailable: MAX_ARRAY_COUNT,
};
let minimumMapBudget = 0;
for (let attempt = 0; attempt < 8; attempt++) {
  const candidate = Math.max(
    renderMinimal(
      MAX_SYMBOL_ACCOUNTING,
      contentAdmission([], minimumMapBudget),
      MAX_ADMISSION_IDENTITY,
      MAX_RESERVATION_FOR_DISPLAY,
    ).length,
    renderNoSurveyMinimal().length,
  );
  if (candidate === minimumMapBudget) break;
  minimumMapBudget = candidate;
}
export const MINIMUM_MAP_BUDGET = minimumMapBudget;

export async function buildRepoMap({
  target,
  budget = DEFAULT_MAP_BUDGET,
  spawn = spawnCapture,
  readFile = readPrefixSync,
  stat,
  renderHook = (result) => result,
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
  const admission = contentAdmission(paths, budget);
  const admittedPaths = admission.orderedPaths.slice(0, admission.readCeiling);
  const admittedPathSet = new Set(admittedPaths);
  const preReadReservation = reservePreReadRowSpace(paths, admission);
  const { format: rowFormatters } = rowTemplateRegistry(rowTemplateContext(paths, admission));
  const statAdapter = stat ?? readFile.stat ?? statSync;
  const entries = paths.map((path) => {
    let lines = null;
    let text = null;
    let binary = false;
    const admitted = admittedPathSet.has(path);
    let size = null;
    try {
      size = statAdapter(join(target, path)).size;
    } catch {
      return {
        path, lines, text, binary, size,
        identity: admitted ? 'inspected' : 'omitted', metadata: 'unavailable', content: 'not-attempted',
      };
    }
    return {
      path, lines, text, binary, size, tooLargeBasis: null,
      identity: admitted ? 'inspected' : 'omitted', metadata: 'available', content: 'not-attempted',
    };
  });

  // Admission order is the declared lexical order, not the source order from
  // git. Stat collection above intentionally never opens file content.
  const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const path of admittedPaths) {
    const entry = entriesByPath.get(path);
    if (entry.metadata === 'unavailable') continue;
    if (entry.size > admission.byteCeiling) {
      entry.identity = 'admitted-but-too-large';
      entry.tooLargeBasis = 'metadata';
    }
    entry.content = 'available';
    try {
      const content = readFile(join(target, path), { length: admission.prefixLength });
      if (content.length > admission.byteCeiling) {
        entry.identity = 'admitted-but-too-large';
        if (entry.tooLargeBasis === null) entry.tooLargeBasis = 'prefix';
      }
      if (entry.identity === 'admitted-but-too-large') {
        continue;
      }
      entry.binary = isBinaryContent(content);
      if (!entry.binary) {
        entry.text = String(content);
        entry.lines = entry.text.split('\n').length - (entry.text.endsWith('\n') ? 1 : 0);
      }
    } catch {
      entry.content = 'unavailable';
    }
  }

  // Directory-grouped file listing, then symbol scans largest-first, appended
  // while the budget holds. Whatever does not fit is COUNTED and NAMED.
  const byDirectory = new Map();
  for (const entry of entries) {
    const slash = entry.path.lastIndexOf('/');
    const directory = slash === -1 ? '.' : entry.path.slice(0, slash);
    if (!byDirectory.has(directory)) byDirectory.set(directory, []);
    byDirectory.get(directory).push(entry);
  }

  const admissionCounts = {
    inspected: entries.filter((entry) => entry.identity === 'inspected').length,
    tooLarge: entries.filter((entry) => entry.identity === 'admitted-but-too-large').length,
    omitted: entries.filter((entry) => entry.identity === 'omitted').length,
    metadataUnavailable: entries.filter((entry) => entry.metadata === 'unavailable').length,
    contentUnavailable: entries.filter((entry) => entry.content === 'unavailable').length,
  };
  const availabilityCounts = {
    metadataUnavailable: entries.filter((entry) => entry.metadata === 'unavailable').length,
    contentUnavailable: entries.filter((entry) => entry.content === 'unavailable').length,
  };
  const admissionDeclaration = [
    `Content admission rule: lexical; r≤${admission.readCeiling}, b≤${admission.byteCeiling}, p≤${admission.prefixLength}, s≤${admission.symbolPayloadCeiling}; states in rows.`,
    `Identity: inspected=${admissionCounts.inspected}; admitted-but-too-large=${admissionCounts.tooLarge}; omitted=${admissionCounts.omitted}; metadata-unavailable=${availabilityCounts.metadataUnavailable}; content-unavailable=${availabilityCounts.contentUnavailable}.`,
    `Pre-read row reservation: ${preReadReservation} chars.`,
  ];
  const lines = [HEADER, ...admissionDeclaration, '', '## Files', ''];
  const omitted = new Map();
  const renderedPathByRow = new Map();
  const recordWithheld = (directory, entry) => {
    const key = `${entry.identity}\u0000${directory}`;
    const declaration = omitted.get(key) ?? { count: 0, paths: new Set() };
    declaration.count++;
    declaration.paths.add(entry.path);
    omitted.set(key, declaration);
  };
  // Space kept clear of Files/Symbols content so the '## Withheld by the budget'
  // section below usually has room without falling back further. A packing
  // heuristic only, not a correctness guarantee — the fallback ladder after this
  // function measures every candidate's actual rendered length against `budget`
  // regardless of what this reserve left behind.
  const reserve = preReadReservation;
  let spent = lines.join('\n').length;
  for (const [directory, group] of [...byDirectory.entries()].sort(byEntryKey)) {
    const heading = `### ${directory}/`;
    const omittedRowFitsWithHeading = group.some((entry) => (
      entry.identity === 'omitted'
      && entry.metadata === 'available'
      && spent + heading.length + rowFormatters.omitted(entry.path).length + 2 <= budget
    ));
    const headingPackingLimit = omittedRowFitsWithHeading ? budget : budget - reserve;
    if (spent + heading.length + 1 > headingPackingLimit) {
      for (const entry of group) recordWithheld(directory, entry);
      continue;
    }
    lines.push(heading);
    spent += heading.length + 1;
    for (const entry of group) {
      const row = entry.metadata === 'unavailable'
        ? rowFormatters.metadataUnavailable(entry.path, entry.identity)
        : entry.identity === 'admitted-but-too-large'
          ? entry.content === 'unavailable'
            ? rowFormatters.tooLargeContentUnavailable(entry.path)
            : entry.tooLargeBasis === 'prefix'
              ? rowFormatters.tooLargePrefix(entry.path)
              : rowFormatters.tooLargeMetadata(entry.path)
          : entry.content === 'unavailable'
            ? rowFormatters.contentUnavailable(entry.path, entry.identity)
            : entry.identity === 'omitted'
              ? rowFormatters.omitted(entry.path)
              : entry.binary
                ? rowFormatters.inspectedBinary(entry.path)
                : rowFormatters.inspectedText(entry.path, entry.lines);
      if (row.length > preReadReservation) {
        throw new Error('repo-map bug: classified row exceeds its pre-read template reservation');
      }
      const packingLimit = entry.identity === 'omitted' ? budget : budget - reserve;
      if (spent + row.length + 1 > packingLimit) {
        recordWithheld(directory, entry);
        continue;
      }
      lines.push(row);
      renderedPathByRow.set(row, entry.path);
      spent += row.length + 1;
    }
  }

  const eligibleSymbolFiles = entries
    .filter((entry) => (
      entry.identity === 'inspected'
      && entry.metadata === 'available'
      && entry.content === 'available'
      && !entry.binary
      && SOURCE_EXTENSIONS.has(extensionOf(entry.path))
    ));
  const largestFirst = entries
    .filter((entry) => entry.identity === 'inspected' && entry.text !== null && SOURCE_EXTENSIONS.has(extensionOf(entry.path)))
    .sort((left, right) => (right.lines ?? 0) - (left.lines ?? 0));
  const symbolLines = [];
  let symbolFilesScanned = 0;
  let symbolResultsRendered = 0;
  let symbolResultsWithheld = 0;
  let scannedWithZeroResults = 0;
  for (const entry of largestFirst) {
    const symbols = scanSymbols(entry.text);
    symbolFilesScanned++;
    if (symbols.length === 0) {
      scannedWithZeroResults++;
      continue;
    }
    const row = rowFormatters.symbols(entry.path, boundedSymbols(symbols, admission.symbolPayloadCeiling));
    if (row.length > preReadReservation) {
      throw new Error('repo-map bug: symbol row exceeds its pre-read template reservation');
    }
    if (spent + row.length + SYMBOLS_HEADER_MARGIN > budget - reserve) {
      symbolResultsWithheld++;
      break;
    }
    symbolLines.push(row);
    spent += row.length + 1;
    symbolResultsRendered++;
  }
  // Snapshot BEFORE the Symbols section (if any) is spliced in, for the
  // collapsedNoSymbols rung below — that rung must never show a Symbols
  // section (partial or not) whose incompleteness it isn't declaring, so it
  // renders from a base that never had one, rather than trusting a dropped
  // note to speak for content that's still sitting in `lines`.
  const linesWithoutSymbols = [...lines];
  if (symbolLines.length > 0) lines.push('', '## Symbols (largest files first)', ...symbolLines);

  // `symbolsSkipped` means exactly one thing: eligible files whose scan never
  // ran. Empty scans and completed scans whose result row did not fit are
  // tracked independently and can never inflate this count.
  const symbolsSkipped = eligibleSymbolFiles.length - symbolFilesScanned;
  const accountingWithSymbolRows = {
    scanRanWithResultsRendered: symbolResultsRendered + scannedWithZeroResults,
    scanRanButResultWithheld: symbolResultsWithheld,
    scanNeverRan: symbolsSkipped,
    scannedWithZeroResults,
  };
  const accountingWithoutSymbolRows = {
    scanRanWithResultsRendered: scannedWithZeroResults,
    scanRanButResultWithheld: symbolResultsWithheld + symbolResultsRendered,
    scanNeverRan: symbolsSkipped,
    scannedWithZeroResults,
  };
  const render = (rung, directoryDeclarations, symbolAccounting, baseLines = lines) => {
    const rendered = [...baseLines];
    const accountingNotes = symbolAccountingNotes(symbolAccounting);
    if (accountingNotes.length > 0) {
      rendered.push('', '## Symbol scan accounting', ...accountingNotes);
    }
    if (directoryDeclarations.length > 0) {
      rendered.push(
        '',
        '## Withheld by the budget',
        ...directoryDeclarations.map(({ line }) => line),
      );
    }
    return {
      rung,
      text: `${rendered.join('\n')}\n`,
      renderedPathByRow,
      explicitlyWithheldPathsByLine: new Map(
        directoryDeclarations.map(({ line, paths }) => [line, paths]),
      ),
    };
  };

  // Prefer one note per omitted directory — most specific — but the budget bounds
  // this section too: with many small omitted directories, one line each is
  // unbounded and can itself blow the budget. Try the detailed form first...
  const directoryDeclarationsDetailed = [...omitted.entries()].sort(byEntryKey)
    .map(([key, { count, paths: declaredPaths }]) => {
      const [identity, directory] = key.split('\u0000');
      return {
        line: `… and ${count} more files under ${directory}/ (budget) — ${identity} rows withheld; read them directly if relevant.`,
        paths: declaredPaths,
      };
    });
  // ...and when it doesn't fit, collapse every omitted directory into one bounded
  // summary line instead of truncating mid-list (a silent, undeclared cap — the
  // exact defect this exists to prevent).
  const omittedFilesTotal = [...omitted.values()].reduce((sum, { count }) => sum + count, 0);
  const withheldIdentityCounts = Object.fromEntries(
    ['inspected', 'admitted-but-too-large', 'omitted'].map((identity) => [
      identity,
      [...omitted.entries()]
        .filter(([key]) => key.startsWith(`${identity}\u0000`))
        .reduce((sum, [, { count }]) => sum + count, 0),
    ]),
  );
  const collapsedDeclaredPaths = new Set();
  for (const { paths: declaredPaths } of omitted.values()) {
    for (const path of declaredPaths) collapsedDeclaredPaths.add(path);
  }
  const directoryDeclarationsCollapsed = omitted.size > 0
    ? [{
      line: `… omissions for ${new Set([...omitted.keys()].map((key) => key.split('\u0000')[1])).size} directories (${omittedFilesTotal} files) withheld (budget) — inspected rows withheld=${withheldIdentityCounts.inspected}; admitted-but-too-large rows withheld=${withheldIdentityCounts['admitted-but-too-large']}; omitted rows withheld=${withheldIdentityCounts.omitted}; this survey is incomplete; read the tree directly.`,
      paths: collapsedDeclaredPaths,
    }]
    : [];
  // Fallback ladder from most to least detailed, MEASURING THE ACTUAL RENDERED
  // STRING at every step — the `reserve` above is a packing heuristic that keeps
  // this ladder short in the common case, never a guarantee, so nothing here
  // trusts it. Every rung but the last is checked before it is returned.
  // Classification and declarations are now complete. The former comes from
  // the surveyed entries; every renderer derives the latter from rows it
  // actually emitted plus omission declarations it actually included.
  const classifiedPaths = new Set(entries.map((entry) => entry.path));
  const finalize = (result) => {
    const rendered = renderHook(result);
    const renderedLines = new Set(rendered.text.split('\n'));
    const declaredPaths = new Set();
    for (const [row, path] of rendered.renderedPathByRow) {
      if (renderedLines.has(row)) declaredPaths.add(path);
    }
    for (const [line, pathsForLine] of rendered.explicitlyWithheldPathsByLine) {
      if (!renderedLines.has(line)) continue;
      for (const path of pathsForLine) declaredPaths.add(path);
    }
    reconcileRepoMapCoverage({
      classifiedPaths,
      declaredPaths,
      rung: result.rung,
    });
    return rendered.text;
  };

  const detailed = render('detailed', directoryDeclarationsDetailed, accountingWithSymbolRows);
  if (detailed.text.length <= budget) return finalize(detailed);

  const collapsed = render('collapsed', directoryDeclarationsCollapsed, accountingWithSymbolRows);
  if (collapsed.text.length <= budget) return finalize(collapsed);

  // This rung removes symbol result rows, not the scans that produced them.
  // Reclassify only those removed results as withheld while leaving genuinely
  // unrun scans in `symbolsSkipped` and empty completed scans as rendered zeroes.
  const collapsedNoSymbols = render(
    'collapsedNoSymbols',
    directoryDeclarationsCollapsed,
    accountingWithoutSymbolRows,
    linesWithoutSymbols,
  );
  if (collapsedNoSymbols.text.length <= budget) return finalize(collapsedNoSymbols);

  // Last rung: drop the Files/Symbols sections entirely and fall back to the
  // header, one last-resort detail line, and compact scan accounting. Not
  // measured against `budget` above
  // like the rungs before it — by construction (MINIMUM_MAP_BUDGET is this
  // exact string's length, and budget was already rejected below that floor)
  // it always fits. The check below is not what makes that true; it is a
  // defensive, self-explaining guard against a future edit breaking the
  // invariant silently instead of loudly.
  const compactFallback = renderCompactFallback({
    symbolAccounting: accountingWithoutSymbolRows,
    admission,
    identity: admissionCounts,
    preReadReservation,
    entries,
    rowFormatters,
    budget,
  });
  if (compactFallback.text.length > budget) {
    throw new Error(
      `repo-map bug: the compact fallback (${compactFallback.text.length} chars) exceeds budget ${budget} even though budget >= MINIMUM_MAP_BUDGET (${MINIMUM_MAP_BUDGET}) — this should be impossible; renderCompactFallback() and MINIMUM_MAP_BUDGET have drifted apart`,
    );
  }
  return finalize(compactFallback);
}
