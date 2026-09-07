// Goal and project tiers share Claude authorship and Codex review; each tier
// retains its own artifact schema, validation, and write-once rollback.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { CONVERSATION_DNA, RepairableArtifactError, runConversation, stanceRepairLines } from './conversation.js';
import { decisionAuthority } from './decision-policy.js';
import { reportEvent } from './events.js';
import { createPlanningSeats, planningPreflight } from './plan.js';
import { buildRepoMap, DEFAULT_MAP_BUDGET } from './repo-map.js';
import { resolveStageTimeouts } from './timeouts.js';

const TIER2_INCREMENTAL_LAW = 'every task is a self-contained increment of the GOAL — runnable and testable alone, exactly one capability';

// The fractal incremental law at tier 1, quoted verbatim from the design spec.
// Same enforcement rule as tier 2: seat judgement only, never a parser.
const TIER1_INCREMENTAL_LAW = 'every goal is a self-contained increment of the PROJECT — after its tasks land, the project runs and is usable with one more coherent capability. Goals are dependency-ordered, MVP-first: goal 1 is the smallest true version of the whole project. No goal depends on a later goal.';

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

const GOALS_TAGGED_ARTIFACT_SHAPE = [
  'Return exactly two tagged artifacts and no prose outside them:',
  '<GOALS_JSON>',
  '[{"id":"G1","slug":"<slug>","statement":"...","capability":"...","dependsOn":[],"rationale":"..."}]',
  '</GOALS_JSON>',
  '<GOALS_MD>',
  '## G1: <title>',
  '...complete Markdown for that goal...',
  '</GOALS_MD>',
  'Every id in GOALS_JSON must have exactly one matching "## G<n>:" section in GOALS_MD, and every section must have a JSON entry.',
].join('\n');

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function looksLikePath(value) {
  return /[\\/]/.test(value) || /^[.~]/.test(value) || /\.[A-Za-z0-9]+$/.test(value);
}

/**
 * The project statement is file-or-prose, exactly like `loop plan`'s --goal
 * (`resolveGoal` in plan.js, same decision shape): a value that names
 * something already there but is not a file (a directory, most often) is a
 * mistake worth naming rather than silently read as prose; a value that
 * merely looks like a path but is not there at all is the same kind of
 * mistake, worded for absence instead; anything else is the prose itself.
 * Kept local rather than imported so the error text says "project", not
 * "goal" — the two CLI flags must never cross-name each other's mistakes.
 */
function resolveProjectStatement(project, { baseDirectory = process.cwd() } = {}) {
  if (typeof project !== 'string' || project.trim() === '') {
    throw new TypeError('project must be a non-empty string');
  }
  const candidate = isAbsolute(project) ? resolve(project) : resolve(baseDirectory, project);
  if (existsSync(candidate)) {
    if (!isFile(candidate)) throw new Error(`project path is not a file: ${candidate}`);
    try { return { source: candidate, text: readFileSync(candidate, 'utf8') }; }
    catch (error) { throw new Error(`cannot read project file ${candidate}: ${error.message}`); }
  }
  if (looksLikePath(project)) throw new Error(`project file not found: ${candidate}`);
  return { source: null, text: project };
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

// The tier-1 twin of assertWritableTasks: a goal has no gate and needs a
// `slug` (the directory it becomes) instead of a queue `name`, so this is not
// the same shape — but it is a contradiction inside an artifact that ARRIVED
// for the same reason, so every failure here is repairable too. Writing
// anyway would silently drop something: a duplicate id collapses two goals
// into one directory through topologicalOrder, and a dangling dependency
// reads as already satisfied.
function assertWritableGoals(items) {
  const ids = items.map((item) => String(item.id));
  const declared = new Set(ids);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicates.length > 0) {
    throw new RepairableArtifactError(
      `duplicate goal ids [${duplicates}] — every goal needs its own id, or the duplicates must be merged into one goal`);
  }
  for (const item of items) {
    if (typeof item.slug !== 'string' || item.slug.trim() === '') {
      throw new RepairableArtifactError(
        `goal ${item.id} has no slug — give every goal a directory slug such as "${item.id}-<slug>"`);
    }
    const dangling = (item.dependsOn ?? []).map(String).filter((dep) => !declared.has(dep));
    if (dangling.length > 0) {
      throw new RepairableArtifactError(
        `goal ${item.id} depends on [${dangling}], which this decomposition never defines — add those goals or drop the dependency`);
    }
  }
  return items;
}

/**
 * Create-only writes with rollback, shared by both tiers' writers: every path
 * THIS call creates is tracked, and if any write in the batch fails, every one
 * of them is removed again — `wx` guarantees a path that already existed was
 * never touched, so rollback can never erase an artifact from a prior
 * convergence. A collision is loud and leaves that prior convergence, and
 * anything an operator may already be executing from it, completely alone.
 */
function createWriteOnce() {
  const created = [];
  const write = (path, content) => {
    writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' });
    created.push(path);
  };
  const rollback = () => {
    for (const path of created.reverse()) {
      try { unlinkSync(path); } catch { /* the loud error below is the report */ }
    }
  };
  return { write, rollback };
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
  const { write, rollback } = createWriteOnce();
  try {
    const units = ordered.map((item) => {
      const task = `${item.id}-plan.md`;
      const gate = `${item.id}-gate.json`;
      write(join(tasksDirectory, task), `${sections.get(String(item.id))}\n`);
      write(join(tasksDirectory, gate), `${JSON.stringify(item.gate, null, 2)}\n`);
      return { name: item.name, task, gate };
    });
    const queuePath = join(tasksDirectory, 'queue.json');
    write(queuePath, `${JSON.stringify(units, null, 2)}\n`);
    return {
      queuePath,
      taskPaths: units.map((unit) => ({
        plan: join(tasksDirectory, unit.task),
        gate: join(tasksDirectory, unit.gate),
      })),
    };
  } catch (error) {
    rollback();
    throw error;
  }
}

/**
 * "No goal depends on a later goal" is part of the tier-1 incremental law
 * quoted verbatim into every seat's prompt (TIER1_INCREMENTAL_LAW above) —
 * goal order is the seats' own MVP-first judgement, not something this
 * writer may compute or correct. A manifest that violates it is a
 * contradiction inside an artifact that ARRIVED, named and fed back exactly
 * like a cycle or a dangling id, never silently repaired by reordering the
 * seats' own sequence for them.
 */
function assertNoGoalDependsOnLaterGoal(items) {
  const position = new Map(items.map((item, index) => [String(item.id), index]));
  for (const item of items) {
    const itemIndex = position.get(String(item.id));
    for (const dep of (item.dependsOn ?? []).map(String)) {
      if (position.get(dep) > itemIndex) {
        throw new RepairableArtifactError(
          `${item.id} depends on later goal ${dep} — goals are MVP-first and dependency-ordered; reorder or re-scope`);
      }
    }
  }
}

// project.md is the operator's own words, not this writer's to reflow: a
// FILE source is copied byte-for-byte (no trim, no appended newline —
// resolveProjectStatement already read it verbatim); prose typed on the CLI
// becomes `${prose}\n`, otherwise untouched, so project.md is an ordinary
// text file without disturbing so much as the prose's own whitespace.
function projectMdBytes({ text, source }) {
  const value = String(text);
  return source ? value : `${value}\n`;
}

/**
 * The converged project decomposition on disk: the project statement copied
 * verbatim, one spec.md per goal (each goal's own tasks come later, from
 * decomposing it in turn with `--goal`), and the manifest that orders and
 * links them. Every write is create-only (`wx`), so a second convergence over
 * the same --out collides loudly instead of quietly replacing goals an
 * operator may already be decomposing further.
 *
 * goals.json is written in exactly the proposal's own order — order here is
 * the seats' judgement, never this writer's to compute. topologicalOrder is
 * reused only to validate (a cycle or a self-dependency is still the same
 * contradiction it is at tier 2); its computed ordering is discarded.
 */
export function writeTier1Artifacts(outDir, project, { items, sections }) {
  const goals = assertWritableGoals(items);
  topologicalOrder(goals); // validate-only: cycles and self-dependencies still throw.
  assertNoGoalDependsOnLaterGoal(goals);
  const goalsDirectory = join(outDir, 'goals');
  mkdirSync(goalsDirectory, { recursive: true });
  const { write, rollback } = createWriteOnce();
  const createdGoalDirs = [];
  try {
    write(join(outDir, 'project.md'), projectMdBytes(project));
    const manifest = goals.map((item) => {
      const goalDirectory = `${item.id}-${item.slug}`;
      const goalPath = join(goalsDirectory, goalDirectory);
      const preexisting = existsSync(goalPath);
      mkdirSync(goalPath, { recursive: true });
      if (!preexisting) createdGoalDirs.push(goalPath);
      write(join(goalPath, 'spec.md'), `${sections.get(String(item.id))}\n`);
      return {
        id: item.id,
        slug: item.slug,
        statement: item.statement,
        capability: item.capability,
        dependsOn: item.dependsOn ?? [],
        rationale: item.rationale,
      };
    });
    const manifestPath = join(goalsDirectory, 'goals.json');
    write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return {
      manifestPath,
      goalDirs: manifest.map((goal) => join(goalsDirectory, `${goal.id}-${goal.slug}`)),
    };
  } catch (error) {
    rollback();
    // Best-effort, empty-only: a directory THIS call created but that ends up
    // holding nothing once its write is rolled back should not linger for an
    // operator to find. A directory that predates this call — a prior
    // convergence's, or anything else already there — is left alone rather
    // than guessed at.
    for (const goalPath of createdGoalDirs.reverse()) {
      try { rmdirSync(goalPath); } catch { /* not empty, or already gone */ }
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

// Tier 1's twin of parseTaskProposal, same contract, GOALS_JSON/GOALS_MD tags.
export function parseGoalProposal(response) {
  const text = artifactText(response);
  if (text === null || text.trim() === '') {
    throw new Error('the proposing seat returned no artifact');
  }
  const { items, sections } = parseTaggedPair(text, {
    jsonTag: 'GOALS_JSON', mdTag: 'GOALS_MD', idPattern: 'G\\d+',
  });
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
    'You are Claude, the author of this goal decomposition. Codex independently reviews your proposal.',
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


function reviewResponseContract(agreementMeans) {
  return [
    'Respond in exactly this structure and nothing else:',
    'AGREE: yes or AGREE: no.',
    'Then zero or more suggestion lines, one per line, formatted: S<id> P0: description (or P1, P2 — your judgement of priority; nothing mechanical acts on it).',
    'Reuse the same S<id> for a suggestion you have raised in an earlier round so recurrence is visible.',
    'Then zero or more question lines formatted: Q<id>: question.',
    `AGREE: yes means ${agreementMeans}.`,
  ];
}

const TIER2_AGREEMENT_MEANS = 'you are satisfied these tasks achieve the goal and you could work from them as written';
const TIER1_AGREEMENT_MEANS = 'you are satisfied these goals achieve the project, each is a self-contained increment of it, and they are ordered MVP-first';

function goalReviewPrompt({
  seat, goalSpec, constitution, repoMap, tasks, round, repairContent,
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
    ...reviewResponseContract(TIER2_AGREEMENT_MEANS),
    ...(repairContent ? stanceRepairLines(repairContent) : []),
  ].join('\n');
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
  if (existsSync(join(goalDir, 'tasks', 'uro-checkpoint.json'))) throw new Error('refusing to overwrite an existing decomposition checkpoint; resume the saved run');
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

function projectContext({ project, constitution, repoMap }) {
  return [
    '# PROJECT.md — the project being decomposed, verbatim',
    project,
    ...(constitution ? ['', '# CONSTITUTION.md — standing project rules; obey them', constitution] : []),
    '',
    '# REPO_MAP.md',
    repoMap,
  ].join('\n');
}

function projectDraftingPrompt({
  seat, project, constitution, repoMap, round, feedback, failedGoals,
}) {
  return [
    CONVERSATION_DNA,
    '',
    `# ${seat} project decomposition seat`,
    '',
    'Work only as a planner. Explore the target for real evidence, but do not modify any file.',
    'You are Claude, the author of this project decomposition. Codex independently reviews your proposal.',
    `Break this project into the goals that achieve it, obeying the tier-1 incremental law verbatim: "${TIER1_INCREMENTAL_LAW}".`,
    'Declare each goal\'s dependencies; no goal may depend on a later one, and two goals may never depend on each other.',
    '',
    projectContext({ project, constitution, repoMap }),
    '',
    `This is decomposition round ${round}.`,
    'Each "## G<n>" section is that goal\'s complete spec.md — the input tier 2 decomposes next into task units.',
    'Every cited path and line must already exist in the target. Describe proposed new paths without formatting them as citations.',
    GOALS_TAGGED_ARTIFACT_SHAPE,
    ...(failedGoals ? [
      '',
      'Discarded decomposition:',
      failedGoals,
      'Do not amend or reproduce that split. Choose a genuinely different one.',
    ] : []),
    ...(feedback ? ['', 'Required corrections:', feedback] : []),
  ].join('\n');
}


function projectReviewPrompt({
  seat, project, constitution, repoMap, goals, round, repairContent,
}) {
  return [
    CONVERSATION_DNA,
    '',
    `# ${seat} project decomposition review seat`,
    '',
    'You receive the project statement and a proposed decomposition of it into goals. Judge independently whether those goals achieve the project, are dependency-ordered MVP-first, and each is a self-contained increment; explore the target repository for real evidence.',
    `The tier-1 incremental law, verbatim: "${TIER1_INCREMENTAL_LAW}". A goal you believe is not a self-contained increment, or is misordered, is a suggestion (S<id>), never a refusal.`,
    'Your review is of THIS decomposition only: every AGREE, suggestion, and question must be about these goals as they address this project statement. Repository exploration is evidence about this decomposition, never a licence to review other features or files on their own.',
    '',
    projectContext({ project, constitution, repoMap }),
    '',
    '# PROPOSED_GOALS',
    goals,
    '',
    `ROUND ${round}.`,
    ...reviewResponseContract(TIER1_AGREEMENT_MEANS),
    ...(repairContent ? stanceRepairLines(repairContent) : []),
  ].join('\n');
}


export function validateDecomposeProjectRequest({ project, target, out }) {
  if (typeof out !== 'string' || out.trim() === '') {
    throw new TypeError('out must be a non-empty directory path');
  }
  if (typeof target !== 'string' || target.trim() === '') {
    throw new TypeError('target must be a non-empty directory path');
  }
  const resolvedTarget = resolve(target);
  if (!isDirectory(resolvedTarget)) throw new Error(`target directory does not exist: ${resolvedTarget}`);
  const resolvedOut = resolve(out);
  if (existsSync(join(resolvedOut, 'uro-checkpoint.json'))) throw new Error('refusing to overwrite an existing decomposition checkpoint; resume the saved run');
  if (existsSync(resolvedOut) && !isDirectory(resolvedOut)) {
    throw new Error(`decompose output path is not a directory: ${resolvedOut}`);
  }
  const resolvedProject = resolveProjectStatement(project, { baseDirectory: process.cwd() });
  // The constitution is the operator's: never generated, never validated, quoted
  // when it is there and simply absent when it is not. `--out` is where it
  // lives for tier 1 — there is no goal directory to look beside yet.
  const constitutionPath = join(resolvedOut, 'constitution.md');
  const constitution = isFile(constitutionPath) ? readFileSync(constitutionPath, 'utf8') : '';
  return {
    project: resolvedProject.text,
    projectSource: resolvedProject.source,
    target: resolvedTarget,
    out: resolvedOut,
    constitution,
  };
}

async function runDecomposition(kind, {
  goalSpecPath, project, target, out, rounds, interactionMode = 'manual',
  mapBudget = DEFAULT_MAP_BUDGET, claudeModel, codexModel, codexEffort,
  plannerModel, verifierModel, arbiterModel,
  executorTimeout = resolveStageTimeouts().executor,
  arbiterTimeout = resolveStageTimeouts().arbiter,
  runId = `decompose-${kind}-${randomUUID()}`, reporter,
  env = process.env, home = homedir(), superpowers, adapters = {},
} = {}) {
  decisionAuthority({ interactionMode, phase: 'planning' });
  if (plannerModel !== undefined || verifierModel !== undefined) {
    throw new TypeError('plannerModel/verifierModel are ambiguous; use claudeModel or codexModel');
  }
  if (rounds !== undefined && (!Number.isSafeInteger(rounds) || rounds < 1)) throw new TypeError('rounds must be a positive integer');
  await planningPreflight({ adapters, superpowers, env, home });
  const isGoal = kind === 'goal';
  const request = isGoal ? validateDecomposeGoalRequest({ goalSpecPath, target })
    : validateDecomposeProjectRequest({ project, target, out });
  reportEvent(reporter, runId, 'plan', 'start', {
    tier: kind, target: request.target, out: request.out ?? request.tasksDir, rounds, mapBudget, interactionMode,
  });
  const repoMap = await buildRepoMap({ target: request.target, budget: mapBudget });
  const requirements = isGoal
    ? { goalSpec: request.goalSpec, constitution: request.constitution }
    : { project: request.project, constitution: request.constitution };
  const context = { ...requirements, repoMap };
  const result = await runConversation({
    runId, reporter, rounds, tier: kind, requirements, interactionMode,
    seats: createPlanningSeats({
      target: request.target, claudeModel: claudeModel ?? arbiterModel, codexModel, codexEffort,
      executorTimeout, arbiterTimeout, runId, env, reporter, adapters,
      authorPrompt: r => (isGoal ? goalDraftingPrompt : projectDraftingPrompt)({
        ...context, ...r, seat: 'Claude',
      }),
      reviewPrompt: r => (isGoal ? goalReviewPrompt : projectReviewPrompt)({
        ...context, ...r, seat: 'Codex',
      }),
    }),
    strategy: {
      parseProposal: isGoal ? parseTaskProposal : parseGoalProposal,
      proposalText: proposal => proposal.text,
      reviewRequests: ({ proposal, round }) => ({ codex: {
        ...context, [isGoal ? 'tasks' : 'goals']: proposal.text, round,
      } }),
      writeConverged: proposal => isGoal
        ? writeTier2Artifacts(request.goalDir, proposal)
        : writeTier1Artifacts(request.out, { text: request.project, source: request.projectSource }, proposal),
    },
  });
  result.checkpointState.planningContext = { kind, request, context,
    options: { claudeModel: claudeModel ?? arbiterModel, codexModel, codexEffort, executorTimeout, arbiterTimeout } };
  if (result.reason === 'needs-decision') {
    const { saveCheckpoint } = await import('./checkpoint.js');
    const directory = request.out ?? request.tasksDir;
    const source = isGoal ? request.goalSpecPath : request.projectSource;
    const constitutionPath = isGoal ? join(request.goalDir, '..', '..', 'constitution.md') : join(request.out, 'constitution.md');
    const checkpoint = await saveCheckpoint({ directory, checkpointState: result.checkpointState,
      references: [source, constitutionPath].filter(path => path && isFile(path)) });
    result.checkpoint = { directory, artifactDigest: checkpoint.artifactDigest, questions: checkpoint.pending.questions };
  }
  return { ...result, target: request.target, out: request.out ?? request.tasksDir,
    ...(isGoal ? { goalSpecPath: request.goalSpecPath, goalDir: request.goalDir }
      : { projectSource: request.projectSource }) };
}

export function runDecomposeGoal(options) { return runDecomposition('goal', options); }
export function runDecomposeProject(options) { return runDecomposition('project', options); }

export async function continueDecomposition({ checkpointState, humanRuling, adapters = {}, reporter, env }) {
  const state = structuredClone(checkpointState);
  const { kind, request, context, options } = state.planningContext;
  const isGoal = kind === 'goal';
  const result = await runConversation({ runId: state.runId, reporter, rounds: state.roundsLimit ?? undefined,
    tier: kind, requirements: state.requirements, interactionMode: state.interactionMode,
    continuation: state, humanRuling,
    seats: createPlanningSeats({ target: request.target, ...options, runId: state.runId, reporter, env, adapters,
      authorPrompt: r => (isGoal ? goalDraftingPrompt : projectDraftingPrompt)({ ...context, ...r, seat: 'Claude' }),
      reviewPrompt: r => (isGoal ? goalReviewPrompt : projectReviewPrompt)({ ...context, ...r, seat: 'Codex' }) }),
    strategy: {
      parseProposal: isGoal ? parseTaskProposal : parseGoalProposal,
      proposalText: proposal => proposal.text,
      reviewRequests: ({ proposal, round }) => ({ codex: { ...context, [isGoal ? 'tasks' : 'goals']: proposal.text, round } }),
      writeConverged: proposal => {
        const hydrated = { ...proposal, sections: proposal.sections instanceof Map
          ? proposal.sections : new Map(Object.entries(proposal.sections)) };
        return isGoal ? writeTier2Artifacts(request.goalDir, hydrated)
          : writeTier1Artifacts(request.out, { text: request.project, source: request.projectSource }, hydrated);
      },
    },
  });
  result.checkpointState.planningContext = state.planningContext;
  return { ...result, target: request.target, out: request.out ?? request.tasksDir };
}
