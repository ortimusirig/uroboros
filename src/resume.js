import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHECKPOINT_FILE, answerIdentity, checkpointDigest, checkpointPhaseIdentity, readCheckpoint, resolveCheckpointDirectory, saveCheckpoint,
  validateAnswerEnvelope, validateCheckpointWorkspace, validateDecisionFilePlacement, writeCheckpointAtomic } from './checkpoint.js';
import { continuePlanning } from './plan.js';
import { continueExecution, continueExecutionPlanning } from './run.js';
import { continueDecomposition } from './decompose.js';
import { continueQueue, queueContinuationPaths } from './queue.js';
import { createQueueRuntime, recoverQueueLanding } from './queue-runtime.js';
import { writeReport } from './report.js';
import { archiveRunArtifacts } from './artifacts.js';

export async function resumeRun({ runDirectory, decisionFile, adapters = {}, queueDependencies, reporter, env }) {
  let checkpoint = readCheckpoint(runDirectory);
  const directory = resolveCheckpointDirectory(checkpoint, runDirectory);
  checkpoint = readCheckpoint(directory);
  const envelope = JSON.parse(readFileSync(decisionFile, 'utf8'));
  const decisionId = answerIdentity(envelope);
  const prior = checkpoint.receipts.find(receipt => receipt.decisionId === decisionId);
  if (prior?.status === 'applied') return prior.result;
  const ruling = validateAnswerEnvelope(checkpoint, envelope);
  validateDecisionFilePlacement(checkpoint, decisionFile);
  const recovering = prior?.status === 'phase-complete';
  if (checkpoint.status !== 'needs-decision' && !recovering) throw new Error('decision was already accepted; no completed phase is recorded, so automatic replay is refused');
  const lockPath = join(directory, 'uro-resume.lock');
  let lock;
  try { lock = openSync(lockPath, 'wx', 0o600); writeFileSync(lock, JSON.stringify({ pid: process.pid, decisionId })); }
  catch { throw new Error('another resume owns this checkpoint, or an interrupted resume requires recovery'); }
  try {
    checkpoint = readCheckpoint(directory);
    validateAnswerEnvelope(checkpoint, envelope);
    const persist = () => {
      for (const receipt of checkpoint.receipts) if (receipt.result) receipt.resultDigest = checkpointDigest(receipt.result);
      writeCheckpointAtomic(join(directory, CHECKPOINT_FILE), checkpoint);
      const factsPath = join(directory, 'uro-runfacts.json');
      if (existsSync(factsPath)) {
        const facts = JSON.parse(readFileSync(factsPath, 'utf8'));
        if (facts.runId === checkpoint.runId && facts.artifacts?.directory) {
          writeCheckpointAtomic(join(facts.artifacts.directory, CHECKPOINT_FILE), checkpoint);
        }
      }
    };
    let receipt = checkpoint.receipts.find(item => item.decisionId === decisionId);
    if (receipt?.status === 'applied') return receipt.result;
    let recoveredLanding = false;
    let recoveredEntry, recoveredResult;
    if (receipt?.status === 'phase-complete' && checkpoint.queueJournal) {
      const entries = Object.values(checkpoint.queueJournal.units ?? {});
      const latest = entries.findLast(entry => entry.operationId);
      if (latest) {
        const recovered = await recoverQueueLanding({ target: checkpoint.queue.options.target,
          diffPath: join(latest.launch?.runDirectory ?? receipt.result.dir ?? directory, 'CHANGES.diff'), operationId: latest.operationId,
          allowedDirtyPaths: queueContinuationPaths({ ...checkpoint.queue, phaseResult: receipt.result, journal: checkpoint.queueJournal }) });
        if (recovered) { recoveredEntry = latest; recoveredResult = recovered; recoveredLanding = true; }
      }
    }
    try {
      await validateCheckpointWorkspace(checkpoint, directory, { completed: receipt?.identity, recoveredLanding });
    } catch (error) {
      checkpoint.history.push({ status: 'invalidated', reason: error.message, at: new Date().toISOString() });
      persist();
      throw error;
    }
    if (recoveredEntry) recoveredEntry.landing = recoveredResult;
    if (checkpoint.status !== 'needs-decision' && receipt?.status !== 'phase-complete') throw new Error('decision already accepted');
    if (!receipt) {
      receipt = { decisionId, artifactDigest: checkpoint.artifactDigest, answers: ruling.answers,
      questions: checkpoint.pending.questions, phase: checkpoint.phase, stage: checkpoint.continuation.stage,
      status: 'accepted', acceptedAt: new Date().toISOString() };
      checkpoint.receipts.push(receipt);
      checkpoint.status = 'accepted';
      checkpoint.history.push({ status: 'accepted', decisionId, at: receipt.acceptedAt });
      persist();
    }
    const planning = checkpoint.continuation.executionContinuation ? continueExecutionPlanning
      : checkpoint.continuation.tier === 'plan' ? continuePlanning : continueDecomposition;
    const result = receipt.status === 'phase-complete' ? receipt.result : checkpoint.phase === 'planning'
      ? await planning({ checkpointState: checkpoint.continuation, humanRuling: ruling, adapters, reporter, env })
      : await continueExecution({ checkpointState: checkpoint.continuation, humanRuling: ruling, adapters, reporter, env });
    receipt.result = result;
    receipt.identity ??= checkpointPhaseIdentity(checkpoint);
    receipt.status = 'phase-complete';
    persist();
    if (checkpoint.queue && result.reason !== 'needs-decision' && result.outcome !== 'needs-decision') {
      result.queueResult = await continueQueue({ context: checkpoint.queue, phaseResult: result,
        runDirectory: result.dir ?? directory, dependencies: queueDependencies ?? createQueueRuntime(),
        journal: checkpoint.queueJournal ?? {}, persistJournal: journal => {
          checkpoint.queueJournal = journal;
          persist();
        } });
    }
    receipt.status = 'applied';
    checkpoint.status = 'terminal';
    checkpoint.history.push({ status: 'applied', decisionId, at: new Date().toISOString() });
    if (result.reason === 'needs-decision' || result.outcome === 'needs-decision') {
      // Publish the new question and the old answer's result receipt together.
      // A crash must never expose "terminal" while another question is pending.
      checkpoint = await saveCheckpoint({ directory, checkpointState: result.checkpointState,
        references: checkpoint.references.map(item => item.path), previous: checkpoint, persist: false });
      result.checkpoint = { directory, artifactDigest: checkpoint.artifactDigest, questions: checkpoint.pending.questions };
    }
    persist();
    if (result.phase === 'execution') {
      writeReport({ dir: directory, facts: result });
      archiveRunArtifacts({ dir: directory, runId: checkpoint.runId, facts: result,
        scratchRoot: (checkpoint.continuation.executionContinuation ?? checkpoint.continuation).options.scratchRoot,
        artifactRoot: (checkpoint.continuation.executionContinuation ?? checkpoint.continuation).options.artifactRoot,
        startedAt: new Date(), endedAt: new Date(), refresh: true });
      persist();
    }
    if (runDirectory !== directory && existsSync(join(runDirectory, CHECKPOINT_FILE))) {
      writeCheckpointAtomic(join(runDirectory, CHECKPOINT_FILE), checkpoint);
    }
    return result;
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
