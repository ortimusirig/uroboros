import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isolate, prepareCampaignBase } from '../src/isolation.js';

const checkpoint = await import('../src/checkpoint.js').catch(() => ({}));
function fixture() {
  const base = process.platform === 'win32' ? 'C:/ccc-test' : tmpdir();
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'uro-checkpoint-'));
  const target = join(root, 'target');
  const dir = join(root, 'scratch', 'run-1', 'w');
  mkdirSync(target, { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(target, 'source.js'), 'original\n');
  for (const path of [target, dir]) {
    execFileSync('git', ['init', '-q', path]);
    writeFileSync(join(path, 'source.js'), 'original\n');
    execFileSync('git', ['-C', path, 'add', '.']);
    execFileSync('git', ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-qm', 'baseline']);
  }
  writeFileSync(join(dir, 'source.js'), 'existing implementation\n');
  const state = { version: 1, phase: 'execution', stage: 'executor-challenge',
    runId: 'run-1', interactionMode: 'manual', workspace: { dir, targetPath: target },
    originalPlan: 'Use the existing schema.', plan: 'Use the existing schema.', commands: [],
    decision: { questions: [{ id: 'Q1', question: 'Which schema?', options: ['existing', 'new'] }] },
    messages: [], options: { target, scratchRoot: join(root, 'scratch') } };
  return { root, target, dir, state };
}
test('a durable checkpoint rejects unknown, missing, duplicate, blank, wrong-run and stale answers', async () => {
  assert.equal(typeof checkpoint.saveCheckpoint, 'function');
  const f = fixture();
  const saved = await checkpoint.saveCheckpoint({ directory: f.dir, checkpointState: f.state });
  const good = { schemaVersion: 1, runId: 'run-1', artifactDigest: saved.artifactDigest,
    answers: [{ id: 'Q1', answer: 'Use the existing schema.' }] };
  assert.doesNotThrow(() => checkpoint.validateAnswerEnvelope(saved, good));
  const bad = [ { ...good, schemaVersion: 2 }, { ...good, runId: 'other' },
    { ...good, artifactDigest: 'known-old-digest' }, { ...good, answers: [] },
    { ...good, answers: [{ id: 'Q9', answer: 'existing' }] },
    { ...good, answers: [...good.answers, ...good.answers] },
    { ...good, answers: [{ id: 'Q1', answer: '   ' }] } ];
  for (const answer of bad) assert.throws(() => checkpoint.validateAnswerEnvelope(saved, answer));
  assert.deepEqual(checkpoint.readCheckpoint(f.dir), saved);
});

for (const topology of ['linked', 'copy', 'campaign']) test(`checkpoint validates the actual ${topology} isolation relationship`, async () => {
  const f = fixture();
  const target = join(f.root, 'original');
  mkdirSync(target);
  writeFileSync(join(target, 'source.js'), 'seed\n');
  if (topology === 'linked') {
    execFileSync('git', ['init', '-q', target]);
    execFileSync('git', ['-C', target, 'add', '.']);
    execFileSync('git', ['-C', target, '-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-qm', 'baseline']);
  }
  const scratchRoot = join(f.root, 'isolates');
  const campaignBase = topology === 'campaign' ? await prepareCampaignBase({ target, scratchRoot, campaignId: 'campaign-1' }) : undefined;
  const workspace = await isolate({ target, scratchRoot, runId: 'real-1', campaignBase });
  const state = { ...f.state, runId: 'real-1', workspace: { ...workspace, targetPath: target },
    options: { target, scratchRoot, campaignBase } };
  const saved = await checkpoint.saveCheckpoint({ directory: workspace.dir, checkpointState: state });
  await checkpoint.validateCheckpointWorkspace(saved, workspace.dir);
  assert.equal(workspace.isRepo, topology === 'linked');
});

test('a different standalone repository cannot impersonate a linked target workspace', async () => {
  const f = fixture();
  const saved = await checkpoint.saveCheckpoint({ directory: f.dir, checkpointState: { ...f.state,
    workspace: { ...f.state.workspace, isRepo: true } } });
  await assert.rejects(checkpoint.validateCheckpointWorkspace(saved, f.dir), /relationship|target repository/i);
});

test('corrupt persisted target metadata cannot replace the original checkpoint identity', async () => {
  const f = fixture();
  const saved = await checkpoint.saveCheckpoint({ directory: f.dir, checkpointState: f.state });
  saved.target.treeDigest = '0'.repeat(64);
  writeFileSync(join(f.dir, 'uro-checkpoint.json'), JSON.stringify(saved));
  assert.throws(() => checkpoint.readCheckpoint(f.dir), /corrupt|checksum/);
});
test('new question semantics with the same artifact and reused Q1 reject the previous envelope', async () => {
  assert.equal(typeof checkpoint.saveCheckpoint, 'function');
  const f = fixture();
  const first = await checkpoint.saveCheckpoint({ directory: f.dir, checkpointState: f.state });
  f.state.decision.questions[0].question = 'May we delete the existing schema?';
  const second = await checkpoint.saveCheckpoint({ directory: f.dir, checkpointState: f.state });
  assert.notEqual(first.artifactDigest, second.artifactDigest);
  assert.throws(() => checkpoint.validateAnswerEnvelope(second, { schemaVersion: 1, runId: 'run-1',
    artifactDigest: first.artifactDigest, answers: [{ id: 'Q1', answer: 'existing' }] }), /stale/i);
});
test('workspace and target drift invalidate the saved checkpoint before continuation', async () => {
  assert.equal(typeof checkpoint.validateCheckpointWorkspace, 'function');
  const f = fixture();
  const saved = await checkpoint.saveCheckpoint({ directory: f.dir, checkpointState: f.state });
  await checkpoint.validateCheckpointWorkspace(saved, f.dir);
  writeFileSync(join(f.dir, 'source.js'), 'unreviewed edit\n');
  await assert.rejects(checkpoint.validateCheckpointWorkspace(saved, f.dir), /workspace.*changed/i);
  writeFileSync(join(f.dir, 'source.js'), 'existing implementation\n');
  writeFileSync(join(f.target, 'source.js'), 'target edit\n');
  await assert.rejects(checkpoint.validateCheckpointWorkspace(saved, f.dir), /target.*changed/i);
  const bytes = readFileSync(join(f.dir, 'uro-checkpoint.json'), 'utf8');
  assert.doesNotMatch(bytes, /process\.env|API_KEY|access_token/);
});

test('a nested repository target still detects dirty content outside its selected subfolder', async () => {
  const f = fixture();
  const nested = join(f.target, 'nested');
  mkdirSync(nested);
  writeFileSync(join(nested, 'input.txt'), 'input');
  const state = { ...f.state, workspace: { ...f.state.workspace, targetPath: nested },
    options: { ...f.state.options, target: nested } };
  const saved = await checkpoint.saveCheckpoint({ directory: f.dir, checkpointState: state });
  writeFileSync(join(f.target, 'source.js'), 'changed outside selected folder');
  await assert.rejects(checkpoint.validateCheckpointWorkspace(saved, f.dir), /target.*changed/);
});
