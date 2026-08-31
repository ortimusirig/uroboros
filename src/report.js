import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reportEvent } from './events.js';
import { DEFAULT_EXECUTOR_EFFORT, DEFAULT_EXECUTOR_MODEL } from './executor.js';
import { DEFAULT_VERIFIER_MODEL } from './verifier.js';
import { addUsage, EMPTY_USAGE } from './usage.js';

export function buildRunFacts({
  runId,
  physicalRunId,
  target,
  targetPath,
  dir,
  isRepo,
  baseRef = 'HEAD',
  baseCommit = null,
  branch,
  iterations,
  gateStatus,
  verdict,
  verdictSource = null,
  correctnessVerdict = null,
  correctnessVerdictSource = null,
  verifierFindings,
  verifierPlan = null,
  verifierEvidence = null,
  verifierConsistency = null,
  intentVerifierFindings,
  intentVerdict = null,
  intentVerdictSource = null,
  intentVerifierPlan = null,
  intentVerifierEvidence = null,
  intentVerifierConsistency = null,
  gateFailure = null,
  tokens = {},
  usageConsistency = null,
  models = {},
  outcome,
  noOpReason,
  gateRetries,
  timeouts = {},
  timeoutEvents = [],
  supervision = null,
  campaignId,
  round,
  unitId,
  campaignUnitKind,
  perspective,
  unitKind,
  merge,
  mutation,
  debate = null,
  skills = null,
  superpowers = null,
}) {
  const facts = {
    runId,
    ...(physicalRunId === undefined ? {} : { physicalRunId }),
    target,
    ...(targetPath === undefined ? {} : { targetPath }),
    dir, isRepo, baseRef, baseCommit, branch,
    model: {
      executor: models?.executor ?? DEFAULT_EXECUTOR_MODEL,
      executorEffort: models?.executorEffort ?? DEFAULT_EXECUTOR_EFFORT,
      verifier: models?.verifier ?? DEFAULT_VERIFIER_MODEL,
    },
    skills: skills ?? null,
    superpowers: superpowers ?? null,
    limits: {
      gateRetries,
      timeoutsMs: {
        executor: timeouts.executor ?? null,
        verifier: timeouts.verifier ?? null,
        gate: timeouts.gate ?? null,
      },
    },
    timeoutEvents: Array.isArray(timeoutEvents) ? timeoutEvents : [],
    iterations, gateStatus, verdict,
    verdictSource: verdictSource ?? null,
    correctnessVerdict: correctnessVerdict ?? null,
    correctnessVerdictSource: correctnessVerdictSource ?? null,
    verifierFindings: verifierFindings ?? null,
    verifierPlan: verifierPlan ?? null,
    verifierEvidence: verifierEvidence ?? null,
    verifierConsistency: verifierConsistency ?? null,
    intentVerifierFindings: intentVerifierFindings ?? null,
    intentVerdict: intentVerdict ?? null,
    intentVerdictSource: intentVerdictSource ?? null,
    intentVerifierPlan: intentVerifierPlan ?? null,
    intentVerifierEvidence: intentVerifierEvidence ?? null,
    intentVerifierConsistency: intentVerifierConsistency ?? null,
    gateFailure: gateFailure ?? null,
    tokens: {
      executor: addUsage(EMPTY_USAGE, tokens?.executor),
      verifier: addUsage(EMPTY_USAGE, tokens?.verifier),
      total: addUsage(EMPTY_USAGE, tokens?.total),
    },
    usageConsistency: usageConsistency ?? null,
    debate: debate ?? {
      roundsRun: 0,
      maxRounds: null,
      findingsPerRound: [],
      roundHistory: [],
      allFindingIds: [],
      recurredFindingIds: [],
      resolvedFindingIds: [],
      stuckFindingIds: [],
      circlingDetected: false,
      pivotCount: 0,
      finalPivotDecision: null,
      stopReason: 'not-started',
      ledger: {
        rounds: [], allFindingIds: [], recurredFindingIds: [],
        resolvedFindingIds: [], stuckFindingIds: [],
      },
    },
    outcome,
  };
  if (campaignId !== undefined) {
    facts.campaignId = campaignId;
    facts.round = round;
    facts.unitId = unitId;
    facts.campaignUnitKind = campaignUnitKind;
    if (perspective !== undefined) facts.perspective = perspective;
  }
  if (unitKind !== undefined) facts.unitKind = unitKind;
  if (merge !== undefined) facts.merge = merge;
  if (mutation !== undefined) facts.mutation = mutation;
  if (noOpReason !== undefined) facts.noOpReason = noOpReason;
  if (supervision !== null) {
    facts.limits.stall = {
      thresholdMs: supervision.thresholdMs,
      progressThresholdMs: supervision.progressThresholdMs,
      policy: supervision.policy,
      restartLimit: supervision.restartLimit,
    };
    facts.retryCounts = {
      gate: supervision.gateRetryCount,
      stall: supervision.restartCount,
    };
    facts.stallEvents = Array.isArray(supervision.stallEvents) ? supervision.stallEvents : [];
    facts.livenessChecks = Array.isArray(supervision.livenessChecks)
      ? supervision.livenessChecks
      : [];
  }
  return facts;
}

function formatUsage(usage) {
  const normalized = addUsage(EMPTY_USAGE, usage);
  return `input: ${normalized.inputTokens}; cached input: ${normalized.cachedInputTokens}; `
    + `output: ${normalized.outputTokens}; reasoning output: ${normalized.reasoningOutputTokens}; `
    + `cache write: ${normalized.cacheWriteTokens}`;
}

function tokenTableRow(label, usage) {
  const normalized = addUsage(EMPTY_USAGE, usage);
  return `| ${label} | ${normalized.inputTokens} | ${normalized.cachedInputTokens} `
    + `| ${normalized.outputTokens} | ${normalized.reasoningOutputTokens} `
    + `| ${normalized.cacheWriteTokens} |`;
}

function tokenLines(facts, style) {
  if (style === 'table') {
    return [
      '| Seat | Input | Cached input | Output | Reasoning output | Cache write |',
      '| --- | ---: | ---: | ---: | ---: | ---: |',
      tokenTableRow('Executor', facts.tokens?.executor),
      tokenTableRow('Verifier', facts.tokens?.verifier),
      tokenTableRow('Total', facts.tokens?.total),
    ];
  }
  return [
    `- **Executor:** ${formatUsage(facts.tokens?.executor)}`,
    `- **Verifier:** ${formatUsage(facts.tokens?.verifier)}`,
    `- **Total:** ${formatUsage(facts.tokens?.total)}`,
  ];
}

export function buildReportMarkdown(facts, {
  changedFiles = facts.iterations.at(-1)?.changedFiles ?? [],
  formatChangedFile = (file) => file,
  tokenStyle = 'list',
} = {}) {
  const last = facts.iterations.at(-1) ?? {};
  const configuredTimeouts = facts.limits?.timeoutsMs;
  const usageDisagreements = (facts.usageConsistency?.checks ?? [])
    .filter((check) => check.status === 'disagreement');
  const correctnessUnverified = facts.correctnessVerdict === 'UNVERIFIED'
    || (facts.correctnessVerdict === null && facts.verdict === 'UNVERIFIED');
  const intentUnverified = facts.intentVerdict === 'UNVERIFIED';
  const assumedDecision = facts.assumedDecision
    ?? (facts.decision?.escalation === 'operator-absent' ? facts.decision : null);
  const presence = assumedDecision?.presenceEvidence ?? {};
  const unverifiedSuperpowersSeats = Object.entries(facts.superpowers?.seats ?? {})
    .filter(([, seat]) => seat?.verified !== true);
  const md = [
    `# CCC run ${facts.runId}`,
    ``,
    ...(facts.superpowers?.bypassed
      ? [
          `## Superpowers prerequisite bypassed`,
          ``,
          ...(unverifiedSuperpowersSeats.length > 0
            ? [`This run started with \`URO_REQUIRE_SUPERPOWERS=0\`; results were produced without all required seat skills being verified.`]
            : [`This run started with \`URO_REQUIRE_SUPERPOWERS=0\`; the bypass was requested even though all required seat skills were verified.`]),
          ...unverifiedSuperpowersSeats
            .map(([name, seat]) => `- **${name[0].toUpperCase()}${name.slice(1)}:** not verified — ${seat?.evidence ?? 'no evidence recorded'}`),
          ``,
        ]
      : []),
    ...(assumedDecision
      ? [
          `## Decision made while the operator was absent`,
          ``,
          `This was decided without you. The harness concluded you were away before `
            + `continuing inside the isolated worktree.`,
          `- **Presence evidence:** TTY attached: ${presence.ttyAttached ? 'yes' : 'no'}; `
            + `invocation: ${presence.invocation ?? 'unknown'}; operator wait: `
            + `${presence.operatorWait ?? 'unknown'}`,
          `- **Reasoning:** ${assumedDecision.reasoning}`,
          `- **Answers:** ${(assumedDecision.answers ?? [])
            .map((answer) => `${answer.id}: ${answer.answer}`).join('; ') || '(none)'}`,
          ``,
        ]
      : []),
    `- **Outcome:** ${facts.outcome}`,
    ...(facts.noOpReason === undefined ? [] : [`- **No-op reason:** ${facts.noOpReason}`]),
    `- **Gate:** ${facts.gateStatus}`,
    `- **Verdict:** ${facts.verdict ?? 'n/a'} (source: ${facts.verdictSource ?? 'n/a'})`,
    `- **Intent verdict:** ${facts.intentVerdict ?? 'n/a'} (source: ${facts.intentVerdictSource ?? 'n/a'})`,
    `- **Verdict evidence consistency:** ${facts.verifierConsistency?.status ?? 'n/a'}`,
    `- **Intent evidence consistency:** ${facts.intentVerifierConsistency?.status ?? 'n/a'}`,
    `- **Token accounting consistency:** ${facts.usageConsistency?.status ?? 'n/a'}`,
    `- **Base ref:** ${facts.baseRef}`,
    `- **Base commit:** ${facts.baseCommit}`,
    `- **Branch:** ${facts.branch}`,
    ...(facts.perspective === undefined ? [] : [`- **Perspective:** ${facts.perspective}`]),
    `- **Iterations:** ${facts.iterations.length}`,
    `- **Debate rounds:** ${facts.debate?.roundsRun ?? 0}`,
    `- **Debate stopped:** ${facts.debate?.stopReason ?? 'not-recorded'}`,
    ...(facts.debate?.circlingDetected ? [`- **Debate circling detected:** yes`] : []),
    ...(facts.debate?.finalPivotDecision
      ? [`- **Final pivot decision:** ${facts.debate.finalPivotDecision}`]
      : []),
    ...(facts.unitKind === 'merge'
      ? [
          `- **Unit kind:** merge`,
          `- **Parent order:** ${(facts.merge?.parentOrder ?? []).join(' -> ')}`,
          `- **Merge base:** ${facts.merge?.mergeBase ?? 'n/a'}`,
        ]
      : []),
    ...(facts.mutation
      ? [
          `- **Mutation units examined:** ${facts.mutation.summary?.unitsExamined ?? 0}`,
          `- **Mutation survivors:** ${facts.mutation.summary?.survivors ?? 0}`,
          `- **Mutation unexamined:** ${facts.mutation.summary?.unexamined ?? 0}`,
        ]
      : []),
    ...(configuredTimeouts && Object.values(configuredTimeouts).some((value) => value !== null)
      ? [`- **Timeouts (ms):** executor ${configuredTimeouts.executor}; verifier ${configuredTimeouts.verifier}; gate ${configuredTimeouts.gate}`]
      : []),
    ...(facts.limits?.stall
      ? [
          `- **Stall policy:** ${facts.limits.stall.policy}; gap ${facts.limits.stall.thresholdMs} ms`,
          `- **Progress notice:** ${facts.limits.stall.progressThresholdMs} ms`,
          `- **Retries used:** gate ${facts.retryCounts?.gate ?? 0}/${facts.limits.gateRetries}; ` +
            `stall ${facts.retryCounts?.stall ?? 0}/${facts.limits.stall.restartLimit}`,
        ]
      : []),
    ...(correctnessUnverified
      ? [``, `Correctness verifier produced no readable verdict; the review did not run for this seat.`]
      : facts.verdictSource === 'none'
        ? [``, `Correctness verifier: no verdict marker was found; ISSUES is the fail-safe default.`]
      : []),
    ...(intentUnverified
      ? [``, `Intent verifier produced no readable verdict; the review did not run for this seat.`]
      : facts.intentVerdictSource === 'none'
        ? [``, `Intent verifier: no verdict marker was found; ISSUES is the fail-safe default.`]
      : []),
    ...(facts.verifierConsistency?.status === 'disagreement'
      ? [
          ``,
          `Correctness verifier bookkeeping disagreement: recorded `
            + `${facts.verifierConsistency.recordedVerdict}/${facts.verifierConsistency.recordedSource}; `
            + `re-derived ${facts.verifierConsistency.rederivedVerdict}/`
            + `${facts.verifierConsistency.rederivedSource} from retained evidence.`,
        ]
      : []),
    ...(facts.intentVerifierConsistency?.status === 'disagreement'
      ? [
          ``,
          `Intent verifier bookkeeping disagreement: recorded `
            + `${facts.intentVerifierConsistency.recordedVerdict}/`
            + `${facts.intentVerifierConsistency.recordedSource}; re-derived `
            + `${facts.intentVerifierConsistency.rederivedVerdict}/`
            + `${facts.intentVerifierConsistency.rederivedSource} from retained evidence.`,
        ]
      : []),
    ...(usageDisagreements.length > 0
      ? [
          ``,
          `Token accounting bookkeeping disagreement: cached input exceeded total input. `
            + usageDisagreements.map((check) => {
              const location = [check.seat, check.pass, check.attempt === undefined
                ? null : `attempt ${check.attempt}`].filter(Boolean).join('/');
              return `${location || 'usage'} recorded input ${check.inputTokens}, `
                + `cached input ${check.cachedInputTokens}`;
            }).join('; ') + `.`,
        ]
      : []),
    ...(facts.verifierEvidence?.inputTruncated
      ? [``, `Correctness verifier evidence was truncated before judgment; the retained text is the complete judged input.`]
      : []),
    ...(facts.intentVerifierEvidence?.inputTruncated
      ? [``, `Intent verifier evidence was truncated before judgment; the retained text is the complete judged input.`]
      : []),
    ...(facts.noOpReason === 'approval-requested'
      ? [
          ``,
          `The executor requested approval instead of implementing the approved plan. `
            + `For a genuinely blocking question, use \`DECISION.md\`, the supported decision channel.`,
        ]
      : []),
    ``,
    `## What changed`,
    changedFiles.map((file) => `- ${formatChangedFile(file)}`).join('\n') || '- (nothing)',
    ``,
    `## Why / reasoning`,
    last.lastMessage ?? '(no executor message)',
    ...(facts.verifierPlan !== null
      ? [``, `## Verifier plan artifact`, facts.verifierPlan || '(empty plan artifact)']
      : []),
    ``,
    `## Verifier findings`,
    facts.verifierFindings || '(none recorded)',
    ...(facts.intentVerifierPlan !== null
      ? [``, `## Intent verifier plan artifact`, facts.intentVerifierPlan || '(empty plan artifact)']
      : []),
    ``,
    `## Intent verifier findings`,
    facts.intentVerifierFindings || '(none recorded)',
  ];
  if (facts.gateFailure !== null) {
    const command = [facts.gateFailure.bin, ...(facts.gateFailure.args ?? [])].join(' ');
    md.push(
      ``,
      `## Gate failure`,
      ...(facts.gateFailure.harness
        ? [`- **Harness check:** ${facts.gateFailure.harness}`]
        : []),
      `- **Command:** ${command}`,
      `- **Exit code:** ${facts.gateFailure.code}`,
      ...(facts.gateFailure.timedOut
        ? [`- **Timed out:** yes, after ${facts.gateFailure.timeoutMs} ms`]
        : []),
      ``,
      '```text',
      facts.gateFailure.outputTail ?? '',
      '```',
    );
  }
  if ((facts.timeoutEvents ?? []).length > 0) {
    md.push(``, `## Stage timeouts`);
    for (const event of facts.timeoutEvents) {
      const pass = event.pass ? ` (${event.pass} pass)` : '';
      const attempt = event.attempt ? `, attempt ${event.attempt}` : '';
      const command = event.bin
        ? `, command ${[event.bin, ...(event.args ?? [])].join(' ')}`
        : '';
      const last = event.lastEvent ?? {};
      const evidence = Number.isFinite(event.gapMs)
        ? `; ${event.gapMs} ms silence after ${last.stage ?? 'unknown'}/${last.type ?? 'unknown'}`
          + (event.setting ? `; governed initially by ${event.setting}` : '')
          + (event.judged === false ? '; unjudged fallback' : '')
          + (event.reasoning ? `; reason: ${event.reasoning}` : '')
        : '';
      md.push(`- ${event.stage}${pass}: timed out after ${event.timeoutMs} ms `
        + `(iteration ${event.iteration}${attempt}${command})${evidence}`);
    }
  }
  if ((facts.livenessChecks ?? []).length > 0) {
    md.push(``, `## Liveness judgements`);
    for (const check of facts.livenessChecks) {
      const pass = check.pass ? `/${check.pass}` : '';
      const interval = check.status === 'working'
        ? `; next check in ${check.nextIntervalMs} ms`
        : '';
      const provenance = check.judged === false ? 'unjudged fallback' : 'judged';
      md.push(`- ${check.seat ?? 'seat'}${pass}: ${check.status} (${provenance})${interval}; `
        + `reason: ${check.reasoning}`);
    }
  }
  if ((facts.stallEvents ?? []).length > 0) {
    md.push(``, `## Stalls`);
    for (const event of facts.stallEvents) {
      const last = event.lastEvent ?? {};
      const action = event.action === 'restart'
        ? `restart ${event.restart}`
        : 'reported only';
      md.push(`- ${event.stage}: ${event.gapMs} ms gap after ` +
        `${last.stage ?? 'unknown'}/${last.type ?? 'unknown'}; ${action}`);
    }
  }
  if (facts.unitKind === 'merge') {
    const counts = facts.merge?.testCounts ?? {};
    md.push(
      ``,
      `## Merge test-count floor`,
      `- **Count source:** ${counts.source ?? 'n/a'}`,
      `- **Baseline:** ${counts.baseline ?? 'n/a'}`,
      `- **Parents:** ${(counts.parents ?? [])
        .map((parent) => `${parent.unitId}=${parent.count}`).join(', ') || '(none)'}`,
      `- **Required:** ${counts.required ?? 'n/a'}`,
      `- **Actual:** ${counts.actual ?? 'n/a'}`,
      ``,
      `## Merge conflict resolutions`,
    );
    if ((facts.merge?.resolutions ?? []).length === 0) {
      md.push('- (no conflicting paths)');
    } else {
      for (const resolution of facts.merge.resolutions) {
        md.push(`- **${resolution.path}** (${resolution.parentUnitId}): `
          + `${resolution.chosen} — ${resolution.reason}`);
      }
    }
  }
  if (facts.mutation) {
    md.push(
      ``,
      `## Mutation evidence`,
      `- **Status:** ${facts.mutation.status ?? 'unknown'}`,
      `- **Grouping:** ${facts.mutation.grouping?.method ?? 'not-run'} `
        + `(${facts.mutation.grouping?.judged ? 'judged' : 'unjudged'})`,
    );
    for (const survivor of facts.mutation.survivors ?? []) {
      const locations = (survivor.lines ?? [])
        .map((line) => `${line.path}:${line.line}`).join(', ') || '(unknown lines)';
      const tests = (survivor.tests ?? []).join(', ') || '(none selected)';
      md.push(
        `- **Survivor — ${survivor.name}:** ${locations}; tests: ${tests}; `
          + `arbiter: ${survivor.judgement?.verdict ?? 'unjudged'} — `
          + `${survivor.judgement?.reasoning ?? 'no reasoning recorded'}`,
      );
    }
    for (const unit of facts.mutation.unexamined ?? []) {
      md.push(`- **Unexamined — ${unit.name}:** ${unit.reason ?? 'no reason recorded'}`);
    }
  }
  md.push(
    ``,
    `## Tokens`,
    ...tokenLines(facts, tokenStyle),
    ``,
  );
  return md.join('\n');
}

export function writeReport({ dir, facts, reporter, runId = facts.runId }) {
  const jsonPath = join(dir, 'uro-runfacts.json');
  const mdPath = join(dir, 'uro-report.md');
  reportEvent(reporter, runId, 'report', 'start', {
    files: ['uro-runfacts.json', 'uro-report.md'],
  });
  writeFileSync(jsonPath, JSON.stringify(facts, null, 2));
  const markdown = buildReportMarkdown(facts);
  writeFileSync(mdPath, markdown);
  reportEvent(reporter, runId, 'report', 'finish', {
    file: 'uro-runfacts.json', files: ['uro-runfacts.json', 'uro-report.md'],
  });
  return { jsonPath, mdPath };
}
