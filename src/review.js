import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

const REVIEW_SEVERITIES = new Set(['blocking', 'suggestion']);

export const REVIEW_DIR = '__uro_review';

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

export function detectReview({ dir }) {
  const reviewDirectory = join(dir, REVIEW_DIR);
  const reviewPath = join(reviewDirectory, 'REVIEW.md');
  if (!existsSync(reviewPath) || !statSync(reviewPath).isFile()) return { reviewed: false };
  const content = readFileSync(reviewPath, 'utf8');
  // A blank file says nothing — measured emptiness, not a report. Any written
  // content IS the report; sections are structure for the debate, not proof
  // of life, so a prose-only "no findings" review counts with zero findings.
  if (content.trim() === '') return { reviewed: false };
  const findings = parseReview(content) ?? [];
  const testFiles = findTestFiles(join(reviewDirectory, 'tests'))
    .map((path) => `${REVIEW_DIR}/tests/${path}`);
  return { reviewed: true, findings, testFiles };
}
