import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DebateLedger,
  detectCircling,
  shouldPivot,
  PIVOT_AMEND,
  PIVOT_FRESH,
  PIVOT_CONCLUDE,
} from '../src/debate.js';

// --- DebateLedger ---

test('DebateLedger tracks findings across rounds', () => {
  const ledger = new DebateLedger();
  ledger.record(1, ['F1', 'F2']);
  ledger.record(2, ['F1', 'F3']);

  assert.deepEqual(ledger.round(1), ['F1', 'F2']);
  assert.deepEqual(ledger.round(2), ['F1', 'F3']);
  assert.equal(ledger.currentRound, 2);
});

test('DebateLedger returns empty array for unrecorded round', () => {
  const ledger = new DebateLedger();
  assert.deepEqual(ledger.round(5), []);
});

test('DebateLedger reports all unique findings seen', () => {
  const ledger = new DebateLedger();
  ledger.record(1, ['F1', 'F2']);
  ledger.record(2, ['F2', 'F3']);
  ledger.record(3, ['F3']);

  const all = ledger.allFindings();
  assert.deepEqual([...all].sort(), ['F1', 'F2', 'F3']);
});

test('DebateLedger tracks resolved findings (appeared then disappeared)', () => {
  const ledger = new DebateLedger();
  ledger.record(1, ['F1', 'F2', 'F3']);
  ledger.record(2, ['F1', 'F3']);
  ledger.record(3, ['F1']);

  const resolved = ledger.resolvedFindings();
  assert.ok(resolved.has('F2'));
  assert.ok(resolved.has('F3'));
  assert.ok(!resolved.has('F1'));
});

// --- detectCircling ---

test('detectCircling returns true when findings decrease but one is stuck', () => {
  const ledger = new DebateLedger();
  ledger.record(1, ['F1', 'F2', 'F3']);
  ledger.record(2, ['F1', 'F2']);
  ledger.record(3, ['F1']);

  // F1 appears in all 3 rounds — stuck finding triggers circling
  // even though counts decrease (3→2→1), per the OR condition
  assert.equal(detectCircling(ledger), true);
});

test('detectCircling returns false when findings decrease and none stuck', () => {
  const ledger = new DebateLedger();
  ledger.record(1, ['F1', 'F2', 'F3']);
  ledger.record(2, ['F2', 'F4']);
  ledger.record(3, ['F5']);

  // No finding persists across all 3 rounds, and no count plateau
  assert.equal(detectCircling(ledger), false);
});

test('detectCircling returns true when same finding persists 3 rounds', () => {
  const ledger = new DebateLedger();
  ledger.record(1, ['F1', 'F2']);
  ledger.record(2, ['F1']);
  ledger.record(3, ['F1']);

  assert.equal(detectCircling(ledger), true);
});

test('detectCircling returns true when finding count not decreasing over 3 rounds', () => {
  const ledger = new DebateLedger();
  ledger.record(1, ['F1', 'F2']);
  ledger.record(2, ['F1', 'F3']);
  ledger.record(3, ['F1', 'F4']);

  assert.equal(detectCircling(ledger), true);
});

test('detectCircling returns false with fewer than 3 rounds', () => {
  const ledger = new DebateLedger();
  ledger.record(1, ['F1']);
  ledger.record(2, ['F1']);

  assert.equal(detectCircling(ledger), false);
});

test('detectCircling returns false when all findings eventually resolve', () => {
  const ledger = new DebateLedger();
  ledger.record(1, ['F1', 'F2']);
  ledger.record(2, ['F1']);
  ledger.record(3, []);

  assert.equal(detectCircling(ledger), false);
});

// --- shouldPivot (escalation ladder) ---

test('shouldPivot returns AMEND on first circling detection', () => {
  assert.equal(shouldPivot(0), PIVOT_AMEND);
});

test('shouldPivot returns FRESH on second circling detection', () => {
  assert.equal(shouldPivot(1), PIVOT_FRESH);
});

test('shouldPivot returns CONCLUDE on third circling detection', () => {
  assert.equal(shouldPivot(2), PIVOT_CONCLUDE);
});

test('shouldPivot returns CONCLUDE for any pivot count >= 2', () => {
  assert.equal(shouldPivot(3), PIVOT_CONCLUDE);
  assert.equal(shouldPivot(10), PIVOT_CONCLUDE);
});

// --- Pivot constants are distinct ---

test('pivot strategy constants are distinct strings', () => {
  const strategies = [PIVOT_AMEND, PIVOT_FRESH, PIVOT_CONCLUDE];
  assert.equal(new Set(strategies).size, 3);
  for (const s of strategies) {
    assert.equal(typeof s, 'string');
    assert.ok(s.length > 0);
  }
});

// --- DebateLedger.stuckFindings ---

test('stuckFindings returns findings present in last 3 rounds', () => {
  const ledger = new DebateLedger();
  ledger.record(1, ['F1', 'F2']);
  ledger.record(2, ['F1', 'F3']);
  ledger.record(3, ['F1', 'F4']);

  const stuck = ledger.stuckFindings();
  assert.deepEqual([...stuck], ['F1']);
});

test('stuckFindings returns empty set with fewer than 3 rounds', () => {
  const ledger = new DebateLedger();
  ledger.record(1, ['F1']);

  const stuck = ledger.stuckFindings();
  assert.equal(stuck.size, 0);
});

test('stuckFindings returns empty set when no finding persists across all 3', () => {
  const ledger = new DebateLedger();
  ledger.record(1, ['F1']);
  ledger.record(2, ['F2']);
  ledger.record(3, ['F3']);

  const stuck = ledger.stuckFindings();
  assert.equal(stuck.size, 0);
});
