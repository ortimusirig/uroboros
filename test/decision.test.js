import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectChallenge, parseDecision } from '../src/decision.js';

test('parseDecision returns structured questions for valid decision markdown', () => {
  const questions = parseDecision(`
    ## Q1
    Kind: technical
    Question: Should the executor follow X or the existing Y convention?
    Options: follow X, adapt to Y
    Recommendation: adapt to Y

    ## Q2
    Kind: product
    Question: Should pagination use cursors?
  `);

  assert.deepEqual(questions, [
    {
      id: 'Q1',
      kind: 'technical',
      question: 'Should the executor follow X or the existing Y convention?',
      options: 'follow X, adapt to Y',
      recommendation: 'adapt to Y',
    },
    {
      id: 'Q2',
      kind: 'product',
      question: 'Should pagination use cursors?',
      options: null,
      recommendation: null,
    },
  ]);
});

test('parseDecision returns null for empty or malformed content', () => {
  assert.equal(parseDecision('   \n'), null);
  assert.equal(parseDecision('# Decision\n\nQuestion: Missing a Q heading'), null);
  assert.equal(parseDecision('## Q1\nKind: unknown\nQuestion: Invalid kind'), null);
  assert.equal(parseDecision('## Q1\nKind: technical'), null);
});

test('detectChallenge returns questions when DECISION.md exists and is valid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-'));
  try {
    writeFileSync(join(dir, 'DECISION.md'), `
## Q1
Kind: authority
Question: May the executor modify the generated lock file?
Recommendation: leave it unchanged
`);

    assert.deepEqual(detectChallenge({ dir }), {
      challenged: true,
      questions: [{
        id: 'Q1',
        kind: 'authority',
        question: 'May the executor modify the generated lock file?',
        options: null,
        recommendation: 'leave it unchanged',
      }],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectChallenge returns challenged false when DECISION.md does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-'));
  try {
    assert.deepEqual(detectChallenge({ dir }), { challenged: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
