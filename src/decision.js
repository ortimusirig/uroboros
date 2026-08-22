import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DECISION_KINDS = new Set(['technical', 'product', 'authority']);

export function parseDecision(content) {
  if (typeof content !== 'string' || content.trim() === '') return null;

  const questions = [];
  let block = null;

  const finishBlock = () => {
    if (block === null) return;
    const kind = block.kind?.trim().toLowerCase();
    const question = block.question?.trim();
    if (!DECISION_KINDS.has(kind) || !question) return;
    questions.push({
      id: block.id,
      kind,
      question,
      options: block.options?.trim() || null,
      recommendation: block.recommendation?.trim() || null,
    });
  };

  for (const line of content.split(/\r?\n/)) {
    const heading = /^\s*##\s+(Q\d+)\s*$/i.exec(line);
    if (heading) {
      finishBlock();
      block = { id: heading[1].toUpperCase() };
      continue;
    }
    if (block === null) continue;
    const field = /^\s*(Kind|Question|Options|Recommendation)\s*:\s*(.*?)\s*$/i.exec(line);
    if (field) block[field[1].toLowerCase()] = field[2];
  }
  finishBlock();

  return questions.length > 0 ? questions : null;
}

export function detectChallenge({ dir }) {
  const decisionPath = join(dir, 'DECISION.md');
  if (!existsSync(decisionPath)) return { challenged: false };
  const questions = parseDecision(readFileSync(decisionPath, 'utf8'));
  return questions === null
    ? { challenged: false }
    : { challenged: true, questions };
}
