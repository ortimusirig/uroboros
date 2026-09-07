import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureEvidence,
  createInspectionReceipt,
  validateClaims,
  validateEvidence,
} from '../src/context-evidence.js';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'uro-evidence-'));
  const root = join(base, 'project');
  const directory = join(base, 'captured');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'feature.js'), 'export const enabled = true;\n');
  return { base, root, directory };
}

function codeEvidence(overrides = {}) {
  return {
    id: 'code-1',
    kind: 'code',
    projectId: 'p1',
    claimIds: ['claim-1'],
    locator: { path: 'src/feature.js', line: 1 },
    sourceIdentity: 'revision-base',
    ...overrides,
  };
}

test('captured code is valid only while its exact source and durable capture remain in scope', () => {
  const { base, root, directory } = fixture();
  try {
    const captured = captureEvidence({ projectId: 'p1', root, directory, evidence: codeEvidence() });
    assert.equal(validateEvidence({ evidence: captured, projectId: 'p1', roots: [root, directory] }).valid, true);

    const relinked = { ...captured, claimIds: ['unrelated-claim'] };
    assert.match(validateEvidence({
      evidence: relinked,
      projectId: 'p1',
      roots: [root, directory],
    }).reason, /metadata|record/i);

    writeFileSync(join(root, 'src', 'feature.js'), 'export const enabled = false;\n');
    assert.match(validateEvidence({
      evidence: captured,
      projectId: 'p1',
      roots: [root, directory],
    }).reason, /stale|digest/i);

    writeFileSync(join(root, 'src', 'feature.js'), 'export const enabled = true;\n');
    unlinkSync(captured.capturedPath);
    assert.match(validateEvidence({
      evidence: captured,
      projectId: 'p1',
      roots: [root, directory],
    }).reason, /missing/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('source and captured paths outside authorized native roots are rejected before reading', () => {
  const { base, root, directory } = fixture();
  try {
    const outside = join(base, 'outside.js');
    writeFileSync(outside, 'private\n');
    assert.throws(() => captureEvidence({
      projectId: 'p1',
      root,
      directory,
      evidence: codeEvidence({ locator: { path: '../outside.js', line: 1 } }),
    }), /outside|scope|scope/i);

    const captured = captureEvidence({ projectId: 'p1', root, directory, evidence: codeEvidence() });
    const displaced = { ...captured, capturedPath: outside };
    assert.match(validateEvidence({
      evidence: displaced,
      projectId: 'p1',
      roots: [root, directory],
    }).reason, /outside|scope/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('command evidence requires observed execution metadata and durable raw output', () => {
  const { base, root, directory } = fixture();
  try {
    const command = {
      id: 'command-1',
      kind: 'command',
      projectId: 'p1',
      claimIds: ['tests-pass'],
      sourceIdentity: 'revision-base',
      locator: { tool: 'node' },
      executed: true,
      argv: ['node', '--test', 'test/feature.test.js'],
      cwd: root,
      exitCode: 0,
      status: 'completed',
      stdout: '1..1\n# pass 1\n',
      stderr: '',
      codeIdentity: 'revision-base+clean-tree',
    };
    const captured = captureEvidence({ projectId: 'p1', root, directory, evidence: command });
    assert.equal(validateEvidence({ evidence: captured, projectId: 'p1', roots: [directory] }).valid, true);
    for (const missing of ['executed', 'argv', 'cwd', 'exitCode', 'status', 'stdout', 'codeIdentity']) {
      const incomplete = { ...command };
      delete incomplete[missing];
      assert.throws(() => captureEvidence({
        projectId: 'p1', root, directory, evidence: incomplete,
      }), new RegExp(missing, 'i'), `${missing} must be observed rather than inferred`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('false inspection receipts cannot verify a factual claim', () => {
  const { base, root, directory } = fixture();
  try {
    const evidence = captureEvidence({
      projectId: 'p1',
      root,
      directory,
      evidence: codeEvidence(),
    });
    const claim = { id: 'claim-1', kind: 'fact', text: 'The feature is enabled', evidenceIds: ['code-1'] };
    const falseReceipt = createInspectionReceipt({
      operationId: 'op-1', seat: 'codex', evidence: [evidence], inspected: false, result: 'supports',
    });
    const invalid = validateClaims({
      claims: [claim],
      evidence: [evidence],
      projectId: 'p1',
      roots: [root, directory],
      verifications: [{
        claimId: 'claim-1', evidenceIds: ['code-1'], result: 'supports',
        inspectionReceipts: [falseReceipt],
      }],
      seat: 'codex',
    });
    assert.equal(invalid.valid, false);
    assert.match(invalid.errors.join('\n'), /not inspected|receipt/i);

    const trueReceipt = createInspectionReceipt({
      operationId: 'op-2', seat: 'codex', evidence: [evidence], inspected: true, result: 'supports',
    });
    assert.equal(validateClaims({
      claims: [claim], evidence: [evidence], projectId: 'p1', roots: [root, directory],
      verifications: [{
        claimId: 'claim-1', evidenceIds: ['code-1'], result: 'supports',
        inspectionReceipts: [trueReceipt],
      }],
      seat: 'codex',
    }).valid, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('verification evidence must be nonempty and linked to the assessed claim', () => {
  const { base, root, directory } = fixture();
  try {
    writeFileSync(join(root, 'src', 'other.js'), 'export const other = true;\n');
    writeFileSync(join(root, 'src', 'independent.js'), 'export const independent = true;\n');
    const claimed = captureEvidence({
      projectId: 'p1', root, directory, evidence: codeEvidence(),
    });
    const unrelated = captureEvidence({
      projectId: 'p1',
      root,
      directory,
      evidence: codeEvidence({
        id: 'code-2',
        claimIds: ['other-claim'],
        locator: { path: 'src/other.js', line: 1 },
      }),
    });
    const independent = captureEvidence({
      projectId: 'p1',
      root,
      directory,
      evidence: codeEvidence({
        id: 'code-3',
        claimIds: ['claim-1'],
        locator: { path: 'src/independent.js', line: 1 },
      }),
    });
    const claim = {
      id: 'claim-1', kind: 'fact', text: 'The feature is enabled', evidenceIds: ['code-1'],
    };
    const receiptFor = (item, operationId) => createInspectionReceipt({
      operationId, seat: 'codex', evidence: [item], inspected: true, result: 'supports',
    });
    const check = (verification) => validateClaims({
      claims: [claim],
      evidence: [claimed, unrelated, independent],
      projectId: 'p1',
      roots: [root, directory],
      verifications: [verification],
      seat: 'codex',
    });

    const unrelatedResult = check({
      claimId: 'claim-1',
      evidenceIds: ['code-2'],
      result: 'supports',
      inspectionReceipts: [receiptFor(unrelated, 'op-unrelated')],
    });
    assert.equal(unrelatedResult.valid, false);
    assert.match(unrelatedResult.errors.join('\n'), /does not identify claim|unrelated/i);

    const emptyResult = check({
      claimId: 'claim-1',
      evidenceIds: [],
      result: 'supports',
      inspectionReceipts: [receiptFor(unrelated, 'op-empty')],
    });
    assert.equal(emptyResult.valid, false);
    assert.match(emptyResult.errors.join('\n'), /nonempty|evidence/i);

    assert.equal(check({
      claimId: 'claim-1',
      evidenceIds: ['code-3'],
      result: 'supports',
      inspectionReceipts: [receiptFor(independent, 'op-independent')],
    }).valid, true, 'separately discovered evidence remains valid when it links to the claim');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('inference evidence without identified premises is rejected', () => {
  const { base, root, directory } = fixture();
  try {
    assert.throws(() => captureEvidence({
      projectId: 'p1',
      root,
      directory,
      evidence: {
        id: 'in-1',
        kind: 'inference',
        projectId: 'p1',
        claimIds: ['conclusion-1'],
        sourceIdentity: 'analysis-1',
        explanation: 'Therefore the feature is safe',
        premiseIds: [],
      },
    }), /premise/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('capturing a required briefing redacts known secret values and reports incompleteness', () => {
  const { base, root, directory } = fixture();
  try {
    const supplied = {
      id: 'requirement-1',
      kind: 'requirement',
      projectId: 'p1',
      claimIds: ['request-1'],
      sourceIdentity: 'brief-1',
      locator: { briefingId: 'brief-1' },
      text: 'Use password=hunter2 while preserving offline use',
      required: true,
    };
    const captured = captureEvidence({ projectId: 'p1', root, directory, evidence: supplied });
    assert.doesNotMatch(JSON.stringify(captured), /hunter2/);
    assert.equal(captured.contextIncomplete, true);
    assert.equal(supplied.text, 'Use password=hunter2 while preserving offline use');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('code evidence containing a credential is refused before any durable copy is written', () => {
  const { base, root, directory } = fixture();
  try {
    writeFileSync(join(root, 'src', 'feature.js'), 'export const password = "hunter2";\n');
    assert.throws(() => captureEvidence({
      projectId: 'p1', root, directory, evidence: codeEvidence(),
    }), /credential|sensitive/i);
    assert.equal(existsSync(directory) ? readdirSync(directory).length : 0, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
