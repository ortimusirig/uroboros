// Explicit historical fixture construction, never a fresh production legacy mode.
// The supplied deterministic fake callbacks produce real Git/diff/review/evidence
// bytes and observations. No accepted answer, landing or provider receipt is seeded.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isolate } from '../../src/isolation.js';
import { diffText } from '../../src/run.js';
import { detectReview, reviewDigest } from '../../src/review.js';
import { createEvidenceWriter } from '../../src/evidence.js';
import { buildRunFacts, writeReport } from '../../src/report.js';
import { archiveRunArtifacts } from '../../src/artifacts.js';
import { saveCheckpoint } from '../../src/checkpoint.js';
import { addUsage, EMPTY_USAGE } from '../../src/usage.js';
import { resolveStageTimeouts } from '../../src/timeouts.js';

export async function savedV1Execution({ stage, setupTurns = 1, ...options }) {
  const { adapters, target, scratchRoot, runId, task } = options;
  const workspace = await (adapters.isolate ?? isolate)({ target, scratchRoot, runId });
  const messages = [], iterations = [], roundHistory = [];
  const evidence = createEvidenceWriter({ dir: workspace.dir, required: true });
  const tokens = { executor: EMPTY_USAGE, verifier: EMPTY_USAGE, arbiter: EMPTY_USAGE, planning: EMPTY_USAGE, total: EMPTY_USAGE };
  let diff, gateResult, review, observed, writer;
  for (let round = 1; round <= setupTurns; round++) {
    evidence.setRound(round);
    writer = await adapters.runExecutor({ cwd: workspace.dir, runId, plan: task, attempt: round });
    messages.push({ speaker: 'codex', phase: 'execution', role: 'implementation-author', turn: messages.length + 1,
      content: writer.lastMessage, response: writer });
    tokens.executor = addUsage(tokens.executor, writer.usage);
    diff = await diffText(workspace.dir, workspace.baseCommit);
    gateResult = await adapters.runGate({ cwd: workspace.dir, commands: options.gate,
      onEvidence: entry => evidence.write({ ...entry, source: 'saved-v1-fixture-command' }) });
    review = await adapters.runReview({ cwd: workspace.dir, runId, round, diffDigest: reviewDigest(diff),
      request: { originalRequirements: task, currentPlan: task, messages: [...messages], evidence: evidence.records() } });
    observed = detectReview({ dir: workspace.dir, artifact: review.artifact, round, diffDigest: reviewDigest(diff) });
    if (!observed.reviewed) throw new Error('historical fixture requires real current materialized reviewer evidence');
    messages.push({ speaker: 'claude', phase: 'execution', role: 'execution-reviewer', turn: messages.length + 1,
      content: review.answer, response: review });
    tokens.verifier = addUsage(tokens.verifier, review.usage);
    iterations.push({ n: round, executor: writer, executorUsage: writer.usage ?? null, gate: gateResult,
      reviewer: { artifact: review.artifact, reviewed: true, findings: observed.findings } });
    const findings = observed.findings;
    roundHistory.push({ round, findings, findingIds: findings.map(item => item.id), acceptedFindingIds: findings.map(item => item.id),
      blockingFindingIds: findings.filter(item => item.severity === 'blocking').map(item => item.id),
      suggestionFindingIds: findings.filter(item => item.severity !== 'blocking').map(item => item.id) });
  }
  tokens.total = addUsage(tokens.executor, tokens.verifier);
  tokens.usageUnknown = messages.some(message => !message.response.usage);
  writeFileSync(join(workspace.dir, 'CHANGES.diff'), diff);
  writeFileSync(join(workspace.dir, 'TASK.md'), task);
  const reviewerTests = observed.testFiles.sort();
  const openFindings = observed.findings.map((finding, index) => ({ ...finding, introducedAt: 0, order: index }));
  const decision = stage ? { mode: 'manual', phase: 'execution', authority: 'human', questions: stage === 'execution-pivot'
    ? [{ id: 'pivot', question: 'Choose the remaining strategy over retained work.', options: ['correction', 'fresh plan', 'stop'] }]
    : openFindings.map(finding => ({ id: finding.id, question: finding.description, options: ['Accept Codex rebuttal', 'Require correction'] })) } : null;
  const state = { version: 1, phase: 'execution', stage, runId, interactionMode: 'manual', authority: 'human',
    workspace: { ...workspace, targetPath: resolve(target), diff, diffDigest: reviewDigest(diff) },
    originalPlan: task, plan: task, commands: options.gate, iteration: setupTurns, debateRound: setupTurns,
    messages, iterations, exec: writer, gateResult, decision, reviewerTests, openFindings,
    evidenceTestDigest: reviewDigest(JSON.stringify(reviewerTests.map(path => [path, reviewDigest(readFileSync(join(workspace.dir, path)))]))),
    evidence: evidence.records(), tokens, stageTimeouts: resolveStageTimeouts(process.env, options),
    debate: { roundHistory, pivotHistory: [], openFindings },
    options: { target, scratchRoot, artifactRoot: options.artifactRoot ?? join(scratchRoot, 'artifacts'),
      debateRounds: options.debateRounds, pivotCandidates: options.pivotCandidates, superpowers: options.superpowers } };
  const approved = !stage && observed.conclusion === 'clean';
  const facts = buildRunFacts({ runId, target, targetPath: resolve(target), ...workspace, iterations, evidence: state.evidence,
    tokens, debate: state.debate, phase: 'execution', interactionMode: 'manual', messages,
    outcome: approved ? 'review-ready' : 'needs-decision', approved,
    approval: approved ? { artifactDigest: reviewDigest(diff), decidedBy: 'claude', basis: 'reviewer',
      reason: 'Current deterministic historical fixture review is clean', reviewEvidence: review.artifact } : null });
  facts.tokens = tokens;
  if (stage) {
    facts.checkpointState = state; facts.decision = decision;
    const checkpoint = await saveCheckpoint({ directory: workspace.dir, checkpointState: state });
    facts.checkpoint = { directory: workspace.dir, artifactDigest: checkpoint.artifactDigest, questions: checkpoint.pending.questions };
  }
  writeReport({ dir: workspace.dir, facts });
  archiveRunArtifacts({ dir: workspace.dir, runId, facts, scratchRoot, artifactRoot: state.options.artifactRoot,
    startedAt: new Date(), endedAt: new Date() });
  return facts;
}
