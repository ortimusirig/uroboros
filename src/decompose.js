// src/decompose.js
// Tier 2 of the decomposition spine: ONE goal converges into the task units the
// existing loop already executes. This tier IS the planning conversation for its
// tasks — it emits every task's plan.md and gate.json directly, so nothing is
// re-planned per task and no goal-sized run ever exists.
//
// The conversation itself lives in conversation.js and is shared with `loop
// plan`. What is tier-specific and lives here: what a request looks like, what a
// valid proposal is, and what converging writes.
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  ARBITER_UNVERIFIED,
  buildArbiterPrompt,
  DEFAULT_ARBITER_MODEL,
  runArbiter,
} from './arbiter.js';
import {
  CONVERSATION_DNA,
  parseSeatReview,
  RepairableArtifactError,
  runConversation,
} from './conversation.js';
import { reportEvent } from './events.js';
import { runExecutor } from './executor.js';
import { productionCapability, withSeatWorkspace } from './plan.js';
import { buildRepoMap, DEFAULT_MAP_BUDGET } from './repo-map.js';
import {
  applySuperpowersRequirement,
  verifySuperpowersSeats,
} from './superpowers.js';
import { resolveStageTimeouts } from './timeouts.js';
import { runVerifier } from './verifier.js';

// Cursor takes its prompt on argv, where a newline is not a line break, so the
// standing law travels flattened into those single-line prompts — everything
// else Cursor reads travels as files in its seat workspace.
const ONE_LINE_CONVERSATION_DNA = CONVERSATION_DNA.replace(/\n/g, ' ');

// The fractal incremental law at tier 2, quoted verbatim from the design spec
// into every seat's prompt. Seat judgement is the only thing that enforces it:
// no parser here measures incrementality, and a seat that believes an increment
// is not self-contained raises it as an ordinary S<id> suggestion.
const TIER2_INCREMENTAL_LAW = 'every task is a self-contained increment of the GOAL — runnable and testable alone, exactly one capability';

// The same standing sentence `loop plan` puts in front of every gate: commands
// are recorded evidence for the seats, never a mechanical verdict.
const GATE_IS_EVIDENCE = "Each task's gate is its evidence commands. The harness runs those commands once per round and records their full output as evidence for the seats; no exit code passes or fails the change.";

// A task's `## T<n>` section becomes its plan.md verbatim, so it must carry
// exactly the headings the loop's executor and reviewer already read.
const TASK_HEADINGS = 'Title, Required behavior, Invariants, Test requirements, and Out of scope';

const TAGGED_ARTIFACT_SHAPE = [
  'Return exactly two tagged artifacts and no prose outside them:',
  '<TASKS_JSON>',
  '[{"id":"T1","name":"T1-<slug>","dependsOn":[],"gate":[{"bin":"...","args":["..."]}]}]',
  '</TASKS_JSON>',
  '<TASKS_MD>',
  '## T1: <title>',
  '...complete Markdown for that task...',
  '</TASKS_MD>',
  'Every id in TASKS_JSON must have exactly one matching "## T<n>:" section in TASKS_MD, and every section must have a JSON entry.',
].join('\n');

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/**
 * Split a two-artifact tagged answer into its JSON items and its per-id Markdown
 * sections. Everything that can be wrong here — absent tags, unparseable JSON,
 * ids that do not line up — is a contradiction in an artifact that ARRIVED, so
 * every failure is repairable and travels back to the seat verbatim.
 */
export function parseTaggedPair(text, { jsonTag, mdTag, idPattern }) {
  const source = String(text ?? '');
  const jsonText = new RegExp(`<${jsonTag}>\\s*([\\s\\S]*?)\\s*</${jsonTag}>`, 'i').exec(source)?.[1];
  const mdText = new RegExp(`<${mdTag}>\\s*([\\s\\S]*?)\\s*</${mdTag}>`, 'i').exec(source)?.[1];
  if (jsonText === undefined || mdText === undefined) {
    throw new RepairableArtifactError(`missing <${jsonTag}> or <${mdTag}> tags — return both, exactly once`);
  }
  let items;
  try { items = JSON.parse(jsonText); } catch (error) {
    throw new RepairableArtifactError(`<${jsonTag}> is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new RepairableArtifactError(`<${jsonTag}> must be a non-empty array`);
  }
  const sections = new Map();
  const heading = new RegExp(`^## (${idPattern}):[^\\n]*$`, 'gm');
  const matches = [...mdText.matchAll(heading)];
  for (const [index, match] of matches.entries()) {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : mdText.length;
    // A second "## T<n>" heading for an id already seen would otherwise
    // overwrite the first section's body in this Map — the earlier task's
    // plan silently vanishes and id-set equality (below) still passes because
    // the KEY was already there. That is silent absorption, so it is a named
    // contradiction instead: it goes back to the seat as feedback.
    if (sections.has(match[1])) {
      throw new RepairableArtifactError(
        `duplicate section ## ${match[1]} — one section per task`);
    }
    sections.set(match[1], mdText.slice(start, end).trim());
  }
  const jsonIds = items.map((item) => String(item.id));
  const missing = jsonIds.filter((id) => !sections.has(id));
  const extra = [...sections.keys()].filter((id) => !jsonIds.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new RepairableArtifactError(
      `id mismatch between ${jsonTag} and ${mdTag}: missing sections [${missing}], unmatched sections [${extra}]`);
  }
  return { items, sections };
}

/**
 * Serialize the seats' declared partial order into the queue's total order.
 * Bookkeeping, never judgement: nothing here reorders on its own opinion, and a
 * cycle is not silently broken. Two tasks that depend on each other are a
 * CONTRADICTION, and contradiction asks — the named pair goes back to the
 * conversation as feedback for the next round. A task depending on itself is
 * the same class of contradiction but named honestly rather than reported as
 * a pair with a phantom second member.
 */
export function topologicalOrder(tasks) {
  const remaining = new Map(tasks.map((task) => [task.id, new Set(task.dependsOn ?? [])]));
  const ordered = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()].filter(([, deps]) =>
      [...deps].every((dep) => !remaining.has(dep))).map(([id]) => id);
    if (ready.length === 0) {
      // A self-dependency ([a] = ['T1'], b = undefined below) must be named
      // for what it is before falling through to the pair message, which
      // would otherwise read as the honest but false "T1 and undefined depend
      // on each other".
      const selfDependent = [...remaining.entries()].find(([id, deps]) => deps.has(id));
      if (selfDependent) {
        throw new RepairableArtifactError(
          `${selfDependent[0]} depends on itself — remove the self-dependency or split the task`);
      }
      const [a, b] = [...remaining.keys()];
      throw new RepairableArtifactError(`${a} and ${b} depend on each other — resolve or merge them`);
    }
    for (const id of ready) { ordered.push(tasks.find((task) => task.id === id)); remaining.delete(id); }
  }
  return ordered;
}

// Everything the writer needs that parseTaggedPair does not already guarantee.
// Each failure is a contradiction inside an artifact that arrived, so each is
// repairable and named exactly. The alternative — writing anyway — would be a
// silent drop: a duplicate id collapses two tasks into one on the way through
// topologicalOrder, and a dangling dependency reads as already satisfied.
function assertWritableTasks(items) {
  const ids = items.map((item) => String(item.id));
  const declared = new Set(ids);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicates.length > 0) {
    throw new RepairableArtifactError(
      `duplicate task ids [${duplicates}] — every task needs its own id, or the duplicates must be merged into one task`);
  }
  for (const item of items) {
    if (typeof item.name !== 'string' || item.name.trim() === '') {
      throw new RepairableArtifactError(
        `task ${item.id} has no name — give every task a queue name such as "${item.id}-<slug>"`);
    }
    if (!Array.isArray(item.gate)) {
      throw new RepairableArtifactError(
        `task ${item.id} gate must be an array of {bin,args} evidence commands (use [] only if the task truly has none)`);
    }
    const dangling = (item.dependsOn ?? []).map(String).filter((dep) => !declared.has(dep));
    if (dangling.length > 0) {
      throw new RepairableArtifactError(
        `task ${item.id} depends on [${dangling}], which this decomposition never defines — add those tasks or drop the dependency`);
    }
  }
  return items;
}

/**
 * The converged decomposition on disk: one plan.md and one gate.json per task,
 * plus the ordinary uroboros queue file that runs them. Every write is create-only
 * (`wx`), so a second convergence over the same goal collides loudly instead of
 * quietly replacing the decomposition an operator may already be executing.
 */
export function writeTier2Artifacts(goalDir, { items, sections }) {
  const ordered = topologicalOrder(assertWritableTasks(items));
  const tasksDirectory = join(goalDir, 'tasks');
  mkdirSync(tasksDirectory, { recursive: true });
  const created = [];
  const writeOnce = (path, content) => {
    writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' });
    created.push(path);
  };
  try {
    const units = ordered.map((item) => {
      const task = `${item.id}-plan.md`;
      const gate = `${item.id}-gate.json`;
      writeOnce(join(tasksDirectory, task), `${sections.get(String(item.id))}\n`);
      writeOnce(join(tasksDirectory, gate), `${JSON.stringify(item.gate, null, 2)}\n`);
      return { name: item.name, task, gate };
    });
    const queuePath = join(tasksDirectory, 'queue.json');
    writeOnce(queuePath, `${JSON.stringify(units, null, 2)}\n`);
    return {
      queuePath,
      taskPaths: units.map((unit) => ({
        plan: join(tasksDirectory, unit.task),
        gate: join(tasksDirectory, unit.gate),
      })),
    };
  } catch (error) {
    // A collision is loud — and it does not leave a half-decomposed goal behind
    // either. `wx` means every path in `created` is one this call made, so
    // removing them can never touch an artifact that was already there.
    for (const path of created.reverse()) {
      try { unlinkSync(path); } catch { /* the loud error below is the report */ }
    }
    throw error;
  }
}

// The text of an answer, whatever transport carried it. `null` means the seat
// answered with no artifact in it at all — which is silence, not a malformed
// artifact, and the callers below keep that distinction.
function artifactText(value) {
  if (typeof value === 'string') return value;
  if (typeof value?.answer === 'string') return value.answer;
  if (typeof value?.text === 'string') return value.text;
  return null;
}

// A storm draft is raw material for the proposing seat, not a written artifact:
// it is carried verbatim and never parsed into structure. Only a seat that
// produced no text at all has nothing to contribute.
function parseTaskDraft(value) {
  const text = artifactText(value);
  if (text === null || text.trim() === '') throw new Error('the seat returned no decomposition');
  return { text };
}

/**
 * The proposal contract. An artifact that ARRIVED but does not parse is
 * repairable and goes back verbatim; an answer with no artifact in it at all is
 * a seat that never really spoke, and that stays terminal. The engine hands this
 * the RAW response precisely so this tier — the only one that knows what a
 * TASKS_JSON/TASKS_MD pair looks like — owns that distinction.
 */
export function parseTaskProposal(response) {
  const text = artifactText(response);
  if (text === null || text.trim() === '') {
    throw new Error('the proposing seat returned no artifact');
  }
  const { items, sections } = parseTaggedPair(text, {
    jsonTag: 'TASKS_JSON', mdTag: 'TASKS_MD', idPattern: 'T\\d+',
  });
  // The proposal's own words are kept beside the parse. They are what the next
  // round's proposer, the pivot judgement, and a FRESH re-storm read, so nothing
  // downstream ever judges a lossy re-rendering of what a seat actually said.
  return { items, sections, text };
}

function goalContext({ goalSpec, constitution, repoMap }) {
  return [
    '# GOAL_SPEC.md — the goal being decomposed, verbatim',
    goalSpec,
    ...(constitution ? ['', '# CONSTITUTION.md — standing project rules; obey them', constitution] : []),
    '',
    '# REPO_MAP.md',
    repoMap,
  ].join('\n');
}

function goalDraftingPrompt({
  seat, goalSpec, constitution, repoMap, round, feedback, failedTasks,
}) {
  return [
    CONVERSATION_DNA,
    '',
    `# ${seat} goal decomposition seat`,
    '',
    'Work only as a planner. Explore the target for real evidence, but do not modify any file.',
    'You are one of three seats decomposing the SAME goal independently. Draft from your own reading of the repository; do not imagine what the other seats might write.',
    `Break this goal into the tasks that achieve it, obeying the tier-2 incremental law verbatim: "${TIER2_INCREMENTAL_LAW}".`,
    'A task you cannot state as exactly one capability is two tasks. Declare each task\'s dependencies; no task may depend on a later one, and two tasks may never depend on each other.',
    '',
    goalContext({ goalSpec, constitution, repoMap }),
    '',
    `This is decomposition round ${round}.`,
    `Each "## T<n>" section is that task's complete plan.md and must contain headings named ${TASK_HEADINGS}.`,
    'Every cited path and line must already exist in the target. Describe proposed new paths without formatting them as citations.',
    'Every absence assertion in Test requirements must include a positive control in the same numbered or bulleted item.',
    GATE_IS_EVIDENCE,
    TAGGED_ARTIFACT_SHAPE,
    ...(failedTasks ? [
      '',
      'Discarded decomposition:',
      failedTasks,
      'Do not amend or reproduce that split. Choose a genuinely different one.',
    ] : []),
    ...(feedback ? ['', 'Required corrections:', feedback] : []),
  ].join('\n');
}

function goalProposePrompt({
  goalSpec, constitution, repoMap, drafts, feedback, questions, previousProposal,
}) {
  return [
    CONVERSATION_DNA,
    '',
    '# Claude goal decomposition proposal seat',
    '',
    'You are read-only. Do not create, edit, or delete files and do not run a gate.',
    'Three seats decomposed this goal independently. Collate them into ONE decomposition: keep the strongest split, graft the better tasks from the others, and resolve their disagreements by judgement stated in the task plans themselves.',
    `The tier-2 incremental law, verbatim: "${TIER2_INCREMENTAL_LAW}".`,
    '',
    goalContext({ goalSpec, constitution, repoMap }),
    '',
    ...(drafts ?? []).flatMap((draft) => [
      `## Decomposition from the ${draft.seat} seat`,
      String(draft.text ?? '(this seat produced no decomposition)'),
      '',
    ]),
    ...(previousProposal ? ['Previous proposal:', previousProposal, ''] : []),
    ...(feedback ? ['Required corrections:', feedback, ''] : []),
    ...((questions ?? []).length > 0 ? [
      'Open questions from the reviewing seats. Answer each explicitly inside the task plans, or revise the decomposition so the question does not arise:',
      ...questions.map((question) => `- ${question.seat} ${question.id}: ${question.text}`),
      '',
    ] : []),
    `Each "## T<n>" section is that task's complete plan.md and must contain headings named ${TASK_HEADINGS}.`,
    'Every cited path and line must already exist in the target; verify each citation by reading before citing.',
    GATE_IS_EVIDENCE,
    TAGGED_ARTIFACT_SHAPE,
  ].join('\n');
}

// The agreement seat has the final say on this goal's decomposition, so it
// gets the same standing context every other seat gets — the constitution
// (when the operator has one) and the repo-map ration — not goalSpec alone.
function goalAgreementPrompt({
  goalSpec, constitution, repoMap, proposal, reviews,
}) {
  return [
    CONVERSATION_DNA,
    '',
    '# Claude arbiter seat',
    'You are read-only. Do not create, edit, or delete files and do not run a gate.',
    'Judge independently on the merits. Return exactly one JSON object and no prose.',
    "You are the final arbiter of this goal's decomposition. Two seats have reviewed it against the goal specification; their responses are below, verbatim, severities included. No severity blocks by rule — weigh everything by judgement.",
    `The tier-2 incremental law, verbatim: "${TIER2_INCREMENTAL_LAW}".`,
    'Converge only when these tasks genuinely achieve THIS goal, each task is a self-contained increment of it, and both seats have said AGREE: yes. If either seat disagrees, or you are not satisfied, do not converge; say what must change.',
    'Schema: {"converged":true,"reason":"brief merits"} or {"converged":false,"reason":"...","feedback":"exact corrections for the next proposal"}.',
    goalContext({ goalSpec, constitution, repoMap }),
    `TASKS ${proposal}`,
    `CODEX_REVIEW ${JSON.stringify(reviews?.codex ?? null, null, 2)}`,
    `CURSOR_REVIEW ${JSON.stringify(reviews?.cursor ?? null, null, 2)}`,
  ].join('\n\n');
}

// The review contract is the planning contract, pinned to THIS goal spec.
// Codex reads its prompt on stdin, so the artifacts travel as themselves rather
// than flattened onto one line.
const REVIEW_RESPONSE_CONTRACT = [
  'Respond in exactly this structure and nothing else:',
  'AGREE: yes or AGREE: no.',
  'Then zero or more suggestion lines, one per line, formatted: S<id> P0: description (or P1, P2 — your judgement of priority; nothing mechanical acts on it).',
  'Reuse the same S<id> for a suggestion you have raised in an earlier round so recurrence is visible.',
  'Then zero or more question lines formatted: Q<id>: question.',
  'AGREE: yes means you are satisfied these tasks achieve the goal and you could work from them as written.',
];

function goalReviewPrompt({
  seat, goalSpec, constitution, repoMap, tasks, round,
}) {
  return [
    CONVERSATION_DNA,
    '',
    `# ${seat} goal decomposition review seat`,
    '',
    'You receive the goal specification and a proposed decomposition of it into tasks. Judge independently whether those tasks achieve the goal; explore the target repository for real evidence.',
    `The tier-2 incremental law, verbatim: "${TIER2_INCREMENTAL_LAW}". A task you believe is not a self-contained increment is a suggestion (S<id>), never a refusal.`,
    'Your review is of THIS decomposition only: every AGREE, suggestion, and question must be about these tasks as they address this goal specification. Repository exploration is evidence about this decomposition, never a licence to review other features or files on their own.',
    '',
    goalContext({ goalSpec, constitution, repoMap }),
    '',
    '# PROPOSED_TASKS',
    tasks,
    '',
    `ROUND ${round}.`,
    ...REVIEW_RESPONSE_CONTRACT,
  ].join('\n');
}

async function productionGoalDraft(request) {
  const result = await runExecutor({
    plan: request.input,
    cwd: request.target,
    model: request.plannerModel,
    sandbox: request.sandbox,
    timeoutMs: request.timeoutMs,
    runId: request.runId,
    attempt: request.round,
    env: request.env,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`goal decomposition seat exited ${result.exitCode}${result.timedOut ? ' after timing out' : ''}`);
  }
  return { text: String(result.lastMessage ?? ''), usage: result.usage };
}

async function productionGoalCursorDraft({
  goalSpec, constitution, repoMap, target, round, verifierModel, timeoutMs,
  env, home, superpowersDir, feedback, failedTasks,
}) {
  return withSeatWorkspace({
    'GOAL_SPEC.md': `${goalSpec}\n`,
    'REPO_MAP.md': `${repoMap}\n`,
    ...(constitution ? { 'CONSTITUTION.md': `${constitution}\n` } : {}),
    ...(feedback ? { 'FEEDBACK.md': `${feedback}\n` } : {}),
    ...(failedTasks ? { 'DISCARDED_TASKS.md': `${failedTasks}\n` } : {}),
  }, async (workspace) => {
    const prompt = [
      ONE_LINE_CONVERSATION_DNA,
      '# Cursor goal decomposition seat',
      'You are one of three seats decomposing the same goal independently. Draft from your own reading of the repository.',
      `Read the goal specification from ${join(workspace, 'GOAL_SPEC.md')} and the repository survey from ${join(workspace, 'REPO_MAP.md')} (a ration, not a wall: read any file directly).`,
      ...(constitution ? [`Obey the standing project rules in ${join(workspace, 'CONSTITUTION.md')}.`] : []),
      `Break that goal into the tasks that achieve it, obeying the tier-2 incremental law verbatim: "${TIER2_INCREMENTAL_LAW}". A task you cannot state as exactly one capability is two tasks.`,
      'Declare each task\'s dependencies; no task may depend on a later one, and two tasks may never depend on each other.',
      ...(feedback ? [`Apply the required corrections in ${join(workspace, 'FEEDBACK.md')}.`] : []),
      ...(failedTasks ? [`${join(workspace, 'DISCARDED_TASKS.md')} holds a discarded split; choose a genuinely different one.`] : []),
      `This is decomposition round ${round}.`,
      `Each "## T<n>" section is that task's complete plan.md and must contain headings named ${TASK_HEADINGS}.`,
      'Every cited path and line must already exist in the target; verify each citation by reading before citing.',
      GATE_IS_EVIDENCE,
      'Reply in plain chat text, not a plan tool artifact. If your client renders a plan tool anyway, ALSO print both tagged artifacts as chat text — the tags are the only thing read.',
      'Return exactly <TASKS_JSON>[{"id":"T1","name":"T1-<slug>","dependsOn":[],"gate":[{"bin":"...","args":["..."]}]}]</TASKS_JSON> then <TASKS_MD>## T1: <title> ...</TASKS_MD> and no prose outside them. Every id in TASKS_JSON needs exactly one matching "## T<n>:" section in TASKS_MD.',
    ].join(' ');
    const result = await runVerifier({
      cwd: target, prompt, model: verifierModel, timeoutMs, pass: 'plan', env, home, superpowersDir,
    });
    return { text: `${result.findings ?? ''}\n${result.plan ?? ''}`, usage: result.usage };
  });
}

async function productionGoalCodexReview({
  goalSpec, constitution, repoMap, tasks, round, target, plannerModel, timeoutMs, runId, env,
}) {
  const result = await runExecutor({
    plan: goalReviewPrompt({ seat: 'Codex', goalSpec, constitution, repoMap, tasks, round }),
    cwd: target,
    model: plannerModel,
    sandbox: 'read-only',
    timeoutMs,
    runId,
    env,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    return { agree: false, readable: false, suggestions: [], questions: [], content: '', unavailable: true, usage: result.usage };
  }
  return { ...parseSeatReview(result.lastMessage), usage: result.usage };
}

async function productionGoalCursorReview({
  goalSpec, constitution, repoMap, tasks, round, target, verifierModel, timeoutMs,
  env, home, superpowersDir,
}) {
  return withSeatWorkspace({
    'GOAL_SPEC.md': `${goalSpec}\n`,
    'REPO_MAP.md': `${repoMap}\n`,
    'PROPOSED_TASKS.md': `${tasks}\n`,
    ...(constitution ? { 'CONSTITUTION.md': `${constitution}\n` } : {}),
  }, async (workspace) => {
    const prompt = [
      ONE_LINE_CONVERSATION_DNA,
      '# Cursor goal decomposition review seat',
      `Read the goal specification from ${join(workspace, 'GOAL_SPEC.md')}, the proposed decomposition from ${join(workspace, 'PROPOSED_TASKS.md')}, and the repository survey from ${join(workspace, 'REPO_MAP.md')} (a ration, not a wall: read any file directly).`,
      ...(constitution ? [`The standing project rules are in ${join(workspace, 'CONSTITUTION.md')}.`] : []),
      'Judge independently whether those tasks achieve the goal; explore the target repository for real evidence.',
      `The tier-2 incremental law, verbatim: "${TIER2_INCREMENTAL_LAW}". A task you believe is not a self-contained increment is a suggestion (S<id>), never a refusal.`,
      'Your review is of THIS decomposition only: every AGREE, suggestion, and question must be about these tasks as they address that goal specification. Repository exploration is evidence about this decomposition, never a licence to review other features or files on their own.',
      `ROUND ${round}.`,
      'Respond in plain chat text,',
      ...REVIEW_RESPONSE_CONTRACT,
    ].join(' ');
    const result = await runVerifier({
      cwd: target, prompt, model: verifierModel, timeoutMs, pass: 'plan', env, home, superpowersDir,
    });
    if (result.launchFailed || result.timedOut) {
      return { agree: false, readable: false, suggestions: [], questions: [], content: '', unavailable: true, usage: result.usage };
    }
    return { ...parseSeatReview(`${result.findings ?? ''}\n${result.plan ?? ''}`), usage: result.usage };
  });
}

export function validateDecomposeGoalRequest({ goalSpecPath, target }) {
  if (typeof goalSpecPath !== 'string' || goalSpecPath.trim() === '') {
    throw new TypeError('goalSpecPath must be a non-empty path to the goal spec.md');
  }
  if (typeof target !== 'string' || target.trim() === '') {
    throw new TypeError('target must be a non-empty directory path');
  }
  const specPath = resolve(goalSpecPath);
  if (!isFile(specPath)) throw new Error(`goal spec file not found: ${specPath}`);
  let goalSpec;
  try { goalSpec = readFileSync(specPath, 'utf8'); }
  catch (error) { throw new Error(`cannot read goal spec ${specPath}: ${error.message}`); }
  if (goalSpec.trim() === '') throw new Error(`goal spec is empty: ${specPath}`);
  const resolvedTarget = resolve(target);
  if (!isDirectory(resolvedTarget)) throw new Error(`target directory does not exist: ${resolvedTarget}`);
  const goalDir = dirname(specPath);
  // The constitution is the operator's: never generated, never validated, quoted
  // when it is there and simply absent when it is not.
  const constitutionPath = join(goalDir, '..', '..', 'constitution.md');
  const constitution = isFile(constitutionPath) ? readFileSync(constitutionPath, 'utf8') : '';
  return {
    goalSpecPath: specPath,
    goalSpec,
    target: resolvedTarget,
    goalDir,
    tasksDir: join(goalDir, 'tasks'),
    constitution,
  };
}

/**
 * Tier 2: one goal, three seats, one converged set of task units on disk.
 *
 * The wrapper owns what is tier-specific — validation, the superpowers preflight,
 * seat wiring, the prompts, the artifact contract, and the writer. Everything
 * else (the rounds, the ledger, circling, the pivot, capability vetoes, the usage
 * meter, the event stream, and the five terminal reasons) is the shared
 * conversation engine, identical to `loop plan`'s.
 */
export async function runDecomposeGoal({
  goalSpecPath,
  target,
  rounds,
  mapBudget = DEFAULT_MAP_BUDGET,
  plannerModel,
  verifierModel,
  arbiterModel = DEFAULT_ARBITER_MODEL,
  executorTimeout = resolveStageTimeouts().executor,
  verifierTimeout = resolveStageTimeouts().verifier,
  arbiterTimeout = resolveStageTimeouts().arbiter,
  runId = `decompose-goal-${randomUUID()}`,
  reporter,
  env = process.env,
  home = homedir(),
  superpowers,
  adapters = {},
} = {}) {
  if (rounds !== undefined && (!Number.isSafeInteger(rounds) || rounds < 1)) {
    throw new TypeError('rounds must be a positive integer');
  }
  const verifySuperpowers = adapters.verifySuperpowers ?? verifySuperpowersSeats;
  const verification = superpowers?.seats
    ? { ok: Object.values(superpowers.seats).every((seat) => seat.verified === true), seats: superpowers.seats }
    : await verifySuperpowers({ env, home });
  const requirement = applySuperpowersRequirement(verification, env);
  if (!requirement.ok) throw new Error(`superpowers preflight failed: ${requirement.reason}`);
  const verifiedSeats = requirement.verification.seats;
  const cursorSuperpowersDir = verifiedSeats.cursor.verified ? verifiedSeats.cursor.path : null;
  const request = validateDecomposeGoalRequest({ goalSpecPath, target });
  reportEvent(reporter, runId, 'plan', 'start', {
    tier: 'goal',
    target: request.target,
    goalSpec: request.goalSpecPath,
    out: request.tasksDir,
    rounds,
    mapBudget,
    constitution: request.constitution !== '',
  });

  // Built once for the whole conversation: the engine's prompt builders are
  // synchronous, and a survey rebuilt per round would ration nothing while
  // costing a `git ls-files` every time. It rations INPUT context only, and it
  // declares its own omissions — the seats can always read past it.
  const repoMap = await buildRepoMap({ target: request.target, budget: mapBudget });
  const context = {
    goalSpec: request.goalSpec,
    constitution: request.constitution,
    repoMap,
  };

  // Seat wiring. Injecting `draft` marks a hermetic test: production seats then
  // stay out unless explicitly supplied, so a unit test can never launch a CLI.
  const draftCodex = adapters.draft ?? productionGoalDraft;
  const hermetic = adapters.draft !== undefined;
  const draftCursor = adapters.cursorDraft ?? (hermetic ? null : productionGoalCursorDraft);
  const reviewCursor = adapters.review ?? (hermetic ? null : productionGoalCursorReview);
  const reviewCodex = adapters.codexReview ?? (hermetic ? null : productionGoalCodexReview);
  const runArbiterSeat = adapters.runArbiter ?? (hermetic ? null : runArbiter);
  const checkCapability = adapters.checkCapability
    ?? adapters.capabilityCheck
    ?? (hermetic || adapters.review !== undefined ? null : productionCapability);

  // Every tier-2 judgement Claude makes is built here, so the standing law and
  // THIS goal's specification reach the drafting, proposing and agreement
  // prompts the same way they reach the other two seats. The pivot judgement is
  // tier-agnostic and keeps the arbiter's own prompt.
  const tier2Prompt = (arbiterRequest) => {
    if (arbiterRequest?.type === 'draft') {
      return goalDraftingPrompt({ seat: 'Claude', ...context, ...arbiterRequest });
    }
    if (arbiterRequest?.type === 'propose') {
      return goalProposePrompt({ ...context, ...arbiterRequest });
    }
    if (arbiterRequest?.type === 'agreement') {
      return goalAgreementPrompt({ ...context, ...arbiterRequest });
    }
    return `${CONVERSATION_DNA}\n\n${buildArbiterPrompt(arbiterRequest)}`;
  };

  const arbitrate = async (arbiterRequest) => {
    if (typeof runArbiterSeat !== 'function') {
      return { verdict: ARBITER_UNVERIFIED, unavailable: true };
    }
    const injected = adapters.runArbiter !== undefined;
    if (injected) reportEvent(reporter, runId, 'arbiter', 'start', {
      model: arbiterModel, judgement: arbiterRequest?.type,
    });
    let result;
    try {
      result = await runArbiterSeat({
        cwd: request.target,
        request: arbiterRequest,
        prompt: tier2Prompt(arbiterRequest),
        model: arbiterModel,
        timeoutMs: arbiterTimeout,
        runId,
        env,
        reporter: injected ? undefined : reporter,
      });
    } catch {
      result = { verdict: ARBITER_UNVERIFIED };
    }
    if (injected) reportEvent(reporter, runId, 'arbiter', 'finish', {
      verdict: result?.verdict ?? (result ? 'ANSWERED' : ARBITER_UNVERIFIED),
      judgement: arbiterRequest?.type,
    });
    return result;
  };

  // The capability seats are launched by this tier, so the tier — not the
  // engine — carries their models, timeouts and directories.
  const capabilityContext = {
    target: request.target,
    plannerModel,
    verifierModel,
    arbiterModel,
    executorTimeout,
    verifierTimeout,
    arbiterTimeout,
    runId,
    env,
    home,
    superpowersDir: cursorSuperpowersDir,
  };

  const result = await runConversation({
    runId,
    reporter,
    rounds,
    tier: 'goal',
    seats: {
      draftCodex,
      draftCursor,
      reviewCodex,
      reviewCursor,
      arbitrate,
      checkCapability: typeof checkCapability === 'function'
        ? (seatRequest) => checkCapability({ ...capabilityContext, ...seatRequest })
        : null,
    },
    strategy: {
      draftRequest: ({ round, feedback, failedPlan }) => ({
        codexInput: {
          input: goalDraftingPrompt({
            seat: 'Codex', ...context, round, feedback, failedTasks: failedPlan,
          }),
          goalSpec: request.goalSpec,
          target: request.target,
          round,
          plannerModel,
          sandbox: 'read-only',
          timeoutMs: executorTimeout,
          runId,
          env,
        },
        cursorRequest: {
          ...context,
          target: request.target,
          round,
          verifierModel,
          timeoutMs: verifierTimeout,
          runId,
          env,
          home,
          superpowersDir: cursorSuperpowersDir,
          feedback,
          failedTasks: failedPlan,
        },
        claudeRequest: {
          type: 'draft', round, feedback, failedTasks: failedPlan,
        },
      }),
      parseDraft: parseTaskDraft,
      parseProposal: parseTaskProposal,
      // What this tier's proposal READS AS: the seat's own artifact text,
      // carried verbatim rather than re-rendered from items and sections. The
      // next proposal, the pivot judgement and a FRESH re-storm all answer what
      // was actually said.
      proposalText: (proposal) => proposal.text,
      proposeRequest: ({ drafts, feedback, questions, previousProposal }) => ({
        type: 'propose',
        drafts: drafts.map(({ seat, text }) => ({ seat, text })),
        feedback,
        questions,
        previousProposal,
      }),
      reviewRequests: ({ round, proposal }) => ({
        codex: {
          ...context, tasks: proposal.text, round,
          target: request.target, plannerModel, timeoutMs: executorTimeout, runId, env,
        },
        cursor: {
          ...context, tasks: proposal.text, round,
          target: request.target, verifierModel, timeoutMs: verifierTimeout,
          env, home, superpowersDir: cursorSuperpowersDir,
        },
      }),
      agreementRequest: ({ proposal, reviews }) => ({
        type: 'agreement',
        proposal: proposal.text,
        reviews: {
          codex: {
            agree: reviews.codex.agree,
            suggestions: reviews.codex.suggestions,
            questions: reviews.codex.questions,
            content: reviews.codex.content,
          },
          cursor: {
            agree: reviews.cursor.agree,
            suggestions: reviews.cursor.suggestions,
            questions: reviews.cursor.questions,
            content: reviews.cursor.content,
          },
        },
      }),
      capabilityPlanText: (proposal) => proposal.text,
      writeConverged: (proposal) => writeTier2Artifacts(request.goalDir, proposal),
    },
  });
  return {
    ...result,
    target: request.target,
    goalSpecPath: request.goalSpecPath,
    goalDir: request.goalDir,
    out: request.tasksDir,
  };
}
