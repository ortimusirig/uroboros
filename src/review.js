import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { captureReviewSnapshot, restoreReviewSnapshot } from './review-protection.js';

const REVIEW_SEVERITIES = new Set(['blocking', 'suggestion']);

export const REVIEW_DIR = '__uro_review';
export const reviewDigest = (value) => createHash('sha256').update(value).digest('hex');

const TEST_EXTENSIONS = new Set([
  '.cjs', '.cs', '.go', '.java', '.js', '.jsx', '.kt', '.kts', '.mjs',
  '.php', '.py', '.rb', '.rs', '.swift', '.ts', '.tsx',
]);

export function parseReview(content) {
  if (typeof content !== 'string' || content.trim() === '') return null;

  const findings = [];
  let block = null;

  const finishBlock = () => {
    if (block === null) return;
    let severity = block.severity?.trim().toLowerCase();
    const description = block.description?.trim();
    if (!REVIEW_SEVERITIES.has(severity) || !description) return;
    const test = block.test?.trim() || null;
    if (severity === 'blocking' && test === null) severity = 'suggestion';
    findings.push({
      id: block.id,
      severity,
      category: block.category?.trim() || null,
      description,
      test,
    });
  };

  for (const line of content.split(/\r?\n/)) {
    const heading = /^\s*##\s+(F\d+)\s*$/i.exec(line);
    if (heading) {
      finishBlock();
      block = { id: heading[1].toUpperCase() };
      continue;
    }
    if (block === null) continue;
    const field = /^\s*(Severity|Category|Description|Test)\s*:\s*(.*?)\s*$/i.exec(line);
    if (field) block[field[1].toLowerCase()] = field[2];
  }
  finishBlock();

  return findings.length > 0 ? findings : null;
}

function findTestFiles(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && TEST_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(path);
      }
    }
  };
  visit(dir);
  return files.sort().map((path) => relative(dir, path).split(sep).join('/'));
}

export function detectReview({ dir, artifact, round, diffDigest }) {
  const reviewDirectory = join(dir, REVIEW_DIR);
  const reviewPath = join(reviewDirectory, 'REVIEW.md');
  if (round !== undefined || diffDigest !== undefined) {
    if (!artifact || artifact.round !== round || artifact.diffDigest !== diffDigest) return { reviewed: false };
    try {
      const manifest = JSON.parse(readFileSync(join(reviewDirectory, 'manifest.json'), 'utf8'));
      if (JSON.stringify(manifest) !== JSON.stringify(artifact)) return { reviewed: false };
      for (const [path, digest] of Object.entries(artifact.files)) {
        safeDestination(dir, path);
        if (reviewDigest(readFileSync(join(reviewDirectory, path))) !== digest) return { reviewed: false };
      }
    } catch { return { reviewed: false }; }
  }
  if (!existsSync(reviewPath) || !statSync(reviewPath).isFile()) return { reviewed: false };
  const content = readFileSync(reviewPath, 'utf8');
  // A blank file says nothing — measured emptiness, not a report. Any written
  // content IS the report; sections are structure for the debate, not proof
  // of life, so a prose-only "no findings" review counts with zero findings.
  if (content.trim() === '') return { reviewed: false };
  const findings = (parseReview(content) ?? []).map((finding) => {
    if (finding.severity !== 'blocking') return finding;
    const path = String(finding.test ?? '').replace(/\\/g, '/');
    let valid = false;
    try {
      const local = path.slice(`${REVIEW_DIR}/`.length);
      valid = path.startsWith(`${REVIEW_DIR}/tests/`) && validTestPath(local)
        && safeDestination(dir, local) && lstatSync(join(reviewDirectory, local)).isFile();
      if (artifact) valid = valid && Object.hasOwn(artifact.files, local);
    } catch { valid = false; }
    return valid ? finding : { ...finding, severity: 'suggestion', testInvalid: true };
  });
  const testFiles = findTestFiles(join(reviewDirectory, 'tests'))
    .map((path) => `${REVIEW_DIR}/tests/${path}`);
  return { reviewed: true, findings, testFiles };
}

function validTestPath(path) {
  if (typeof path !== 'string' || !path.startsWith('tests/') || /[\x00-\x1f\x7f:]/.test(path)) return false;
  const parts = path.split('/');
  return parts.every((part) => part && part !== '.' && part !== '..'
    && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
    && TEST_EXTENSIONS.has(extname(path).toLowerCase());
}

// Reject links, including links to locations inside the root. The harness owns
// these destinations; following a link would give someone else write authority.
function safeDestination(cwd, path) {
  if (path !== 'REVIEW.md' && path !== 'manifest.json' && !validTestPath(path)) {
    throw new Error(`unsafe review destination: ${path}`);
  }
  const root = resolve(cwd);
  const parts = [REVIEW_DIR, ...path.split('/')];
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stats;
    try { stats = lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stats.isSymbolicLink() || (index < parts.length - 1 ? !stats.isDirectory() : !stats.isFile())) {
      throw new Error(`unsafe review destination: ${path}`);
    }
  }
  return true;
}

export function assertReviewDestination(cwd, path) { return safeDestination(cwd, path); }

export async function materializeReviewBundle({ cwd, bundle, round = 1, diffDigest = '' }) {
  if (typeof bundle === 'string') bundle = JSON.parse(bundle.trim().replace(/^```json\s*|\s*```$/g, ''));
  if (!bundle || (bundle.version !== undefined && bundle.version !== 1)
    || typeof bundle.report !== 'string' || !bundle.report.trim()
    || !Array.isArray(bundle.tests ?? [])) throw new Error('invalid review bundle');
  const findingHeaders = bundle.report.match(/^\s*##\s+F\d+\s*$/gim) ?? [];
  if (findingHeaders.length !== (parseReview(bundle.report) ?? []).length) {
    throw new Error('invalid structured review report');
  }
  const tests = bundle.tests ?? [];
  if (tests.length > 100) throw new Error('too many review test files');
  const files = new Map();
  const seen = new Set();
  let total = Buffer.byteLength(bundle.report);
  if (total > 1024 * 1024) throw new Error('review report too large');
  for (const test of tests) {
    const path = typeof test?.path === 'string' ? test.path.replace(/\\/g, '/') : '';
    if (!validTestPath(path) || typeof test.content !== 'string') throw new Error(`invalid review test: ${path}`);
    const key = path.toLowerCase();
    if ([...seen].some((other) => key === other || key.startsWith(`${other}/`) || other.startsWith(`${key}/`))) {
      throw new Error(`colliding review test: ${path}`);
    }
    seen.add(key);
    const size = Buffer.byteLength(test.content);
    total += size;
    if (size > 1024 * 1024 || total > 5 * 1024 * 1024) throw new Error('review bundle too large');
    files.set(path, test.content);
  }
  files.set('REVIEW.md', bundle.report);
  for (const path of [...files.keys(), 'manifest.json']) safeDestination(cwd, path);
  const snapshot = await captureReviewSnapshot({ cwd });
  const previous = {};
  for (const path of files.keys()) {
    try { previous[path] = reviewDigest(readFileSync(join(cwd, REVIEW_DIR, path))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const artifact = { version: 1, round, diffDigest,
    bundleDigest: reviewDigest(JSON.stringify(bundle)),
    files: Object.fromEntries([...files].map(([path, content]) => [path, reviewDigest(content)])),
    testFiles: [...files.keys()].filter((path) => path.startsWith('tests/')).map((path) => `${REVIEW_DIR}/${path}`),
    revisions: [...files.keys()].filter((path) => previous[path] && previous[path] !== reviewDigest(files.get(path)))
      .map((path) => ({ path, before: previous[path], after: reviewDigest(files.get(path)), round })),
    dispositions: Array.isArray(bundle.dispositions) ? bundle.dispositions : [],
  };
  try {
    for (const [path, content] of [...files, ['manifest.json', JSON.stringify(artifact)]]) {
      safeDestination(cwd, path);
      const destination = join(cwd, REVIEW_DIR, path);
      mkdirSync(dirname(destination), { recursive: true });
      safeDestination(cwd, path);
      writeFileSync(destination, content, 'utf8');
    }
  } catch (error) {
    await restoreReviewSnapshot({ snapshot });
    throw error;
  }
  return artifact;
}
