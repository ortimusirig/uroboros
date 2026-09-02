import { parseArgs as nodeParseArgs } from 'node:util';
import { CLI_COMMANDS } from './cli-help.js';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_ROUNDS,
  DEFAULT_TOKEN_BUDGET,
  MAX_CONCURRENCY,
  MAX_ROUNDS,
} from './campaign-validation.js';
import { loadCampaignFile } from './campaign-file.js';
import { UNIT_KINDS } from './events.js';
import { parseTimeoutMs } from './timeouts.js';

const EXECUTOR_EFFORTS = new Set([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
]);
const RUN_MODES = new Set(['manual', 'autonomous']);
const MAX_PLAN_CANDIDATES = 5;
const UNIT_KIND_SET = new Set(UNIT_KINDS);
const STAGE_TIMEOUT_FLAGS = new Set([
  '--executor-timeout', '--verifier-timeout', '--arbiter-timeout', '--gate-timeout',
]);

// This is the single source of truth for the batch flag surface and its precedence class.
// parseArgs derives node:util's option table from it, so tests can enumerate the real flags
// without maintaining a second list that can drift.
export const BATCH_FLAG_DEFINITIONS = Object.freeze({
  campaign: Object.freeze({ type: 'string', scope: 'selector' }),
  task: Object.freeze({ type: 'string', multiple: true, scope: 'campaign' }),
  target: Object.freeze({ type: 'string', scope: 'campaign' }),
  gate: Object.freeze({ type: 'string', scope: 'campaign' }),
  'gate-retries': Object.freeze({ type: 'string', scope: 'campaign' }),
  'pivot-candidates': Object.freeze({ type: 'string', scope: 'campaign' }),
  'executor-model': Object.freeze({ type: 'string', scope: 'campaign' }),
  'executor-effort': Object.freeze({ type: 'string', scope: 'campaign' }),
  'verifier-model': Object.freeze({ type: 'string', scope: 'campaign' }),
  'arbiter-model': Object.freeze({ type: 'string', scope: 'campaign' }),
  'executor-timeout': Object.freeze({ type: 'string', scope: 'invocation' }),
  'verifier-timeout': Object.freeze({ type: 'string', scope: 'invocation' }),
  'arbiter-timeout': Object.freeze({ type: 'string', scope: 'invocation' }),
  'gate-timeout': Object.freeze({ type: 'string', scope: 'invocation' }),
  'artifact-root': Object.freeze({ type: 'string', scope: 'invocation' }),
  concurrency: Object.freeze({ type: 'string', scope: 'campaign' }),
  'token-budget': Object.freeze({ type: 'string', scope: 'campaign' }),
  rounds: Object.freeze({ type: 'string', scope: 'campaign' }),
  round: Object.freeze({ type: 'string', multiple: true, scope: 'campaign' }),
  'unit-kind': Object.freeze({ type: 'string', multiple: true, scope: 'campaign' }),
  'unit-id': Object.freeze({ type: 'string', multiple: true, scope: 'campaign' }),
  perspective: Object.freeze({ type: 'string', multiple: true, scope: 'campaign' }),
  'depends-on': Object.freeze({ type: 'string', multiple: true, scope: 'campaign' }),
  quiet: Object.freeze({ type: 'boolean', scope: 'invocation' }),
  'no-dashboard': Object.freeze({ type: 'boolean', scope: 'invocation' }),
  open: Object.freeze({ type: 'boolean', scope: 'invocation' }),
  port: Object.freeze({ type: 'string', scope: 'invocation' }),
});

export const BATCH_CAMPAIGN_FLAGS = Object.freeze(Object.keys(BATCH_FLAG_DEFINITIONS)
  .filter((flag) => BATCH_FLAG_DEFINITIONS[flag].scope === 'campaign'));
export const BATCH_INVOCATION_FLAGS = Object.freeze(Object.keys(BATCH_FLAG_DEFINITIONS)
  .filter((flag) => BATCH_FLAG_DEFINITIONS[flag].scope === 'invocation'));

const BATCH_PARSE_OPTIONS = Object.fromEntries(Object.entries(BATCH_FLAG_DEFINITIONS)
  .map(([flag, { scope: _scope, ...definition }]) => [flag, definition]));

function clampInt(v, def, lo, hi) {
  if (v === undefined) return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < lo || n > hi) {
    throw new Error(`value out of range [${lo}-${hi}]: ${v}`);
  }
  return n;
}

function strictInt(v, def, lo, hi) {
  if (v === undefined) return def;
  if (!/^\d+$/.test(v)) throw new Error(`value out of range [${lo}-${hi}]: ${v}`);
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < lo || n > hi) {
    throw new Error(`value out of range [${lo}-${hi}]: ${v}`);
  }
  return n;
}

function validateExecutorEffort(executorEffort) {
  if (executorEffort !== undefined && !EXECUTOR_EFFORTS.has(executorEffort)) {
    throw new Error(`invalid --executor-effort: ${executorEffort}; expected one of: ${
      [...EXECUTOR_EFFORTS].join(', ')}`);
  }
}

function parseDashboardPort(value) {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid dashboard port: ${value}; expected an integer from 0 to 65535`);
  }
  return port;
}

function assignStageTimeouts(parsed, values) {
  for (const [flag, property] of [
    ['executor-timeout', 'executorTimeout'],
    ['verifier-timeout', 'verifierTimeout'],
    ['arbiter-timeout', 'arbiterTimeout'],
    ['gate-timeout', 'gateTimeout'],
  ]) {
    if (values[flag] !== undefined) {
      parsed[property] = parseTimeoutMs(values[flag], `--${flag}`);
    }
  }
  return parsed;
}

function normalizeNegativeTimeoutArguments(args) {
  const normalized = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const value = args[index + 1];
    if (STAGE_TIMEOUT_FLAGS.has(argument) && /^-\d/.test(value)) {
      normalized.push(`${argument}=${value}`);
      index++;
    } else {
      normalized.push(argument);
    }
  }
  return normalized;
}

function normalizeNegativePruneArguments(args) {
  const normalized = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const value = args[index + 1];
    if ((argument === '--keep' || argument === '--older-than') && /^-\d/.test(value)) {
      normalized.push(`${argument}=${value}`);
      index++;
    } else {
      normalized.push(argument);
    }
  }
  return normalized;
}

export function parseArgs(argv) {
  const command = argv[0];
  if (argv.length === 1 && (command === 'help' || command === '--help' || command === '-h')) {
    return { command: 'help' };
  }
  if (!CLI_COMMANDS.includes(command)) {
    throw new Error(`unknown command: ${command ?? '(none)'}`);
  }
  if (command === 'doctor') {
    const { values } = nodeParseArgs({
      args: argv.slice(1),
      options: {
        deep: { type: 'boolean' },
        fix: { type: 'boolean' },
        yes: { type: 'boolean' },
        'scratch-root': { type: 'string' },
        repository: { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    });
    if (values.deep && values.fix) {
      throw new Error('doctor --deep and --fix cannot be combined');
    }
    if (values.yes && !values.fix) {
      throw new Error('doctor --yes requires --fix');
    }
    return {
      command,
      deep: values.deep === true,
      ...(values.fix === true ? { fix: true } : {}),
      ...(values.yes === true ? { yes: true } : {}),
      ...(values['scratch-root'] === undefined ? {} : { scratchRoot: values['scratch-root'] }),
      ...(values.repository === undefined ? {} : { repository: values.repository }),
    };
  }
  if (command === 'setup') {
    const { values } = nodeParseArgs({
      args: argv.slice(1),
      options: {
        'scratch-root': { type: 'string' },
        yes: { type: 'boolean' },
      },
      allowPositionals: false,
      strict: true,
    });
    return {
      command,
      ...(values.yes === true ? { yes: true } : {}),
      ...(values['scratch-root'] === undefined ? {} : { scratchRoot: values['scratch-root'] }),
    };
  }
  if (command === 'prune') {
    const { values } = nodeParseArgs({
      args: normalizeNegativePruneArguments(argv.slice(1)),
      options: {
        keep: { type: 'string' },
        'older-than': { type: 'string' },
        'dry-run': { type: 'boolean' },
        'scratch-root': { type: 'string' },
        'artifact-root': { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    });
    return {
      command,
      keep: strictInt(values.keep, 20, 0, Number.MAX_SAFE_INTEGER),
      ...(values['older-than'] === undefined ? {} : {
        olderThan: strictInt(values['older-than'], undefined, 0, Number.MAX_SAFE_INTEGER),
      }),
      dryRun: values['dry-run'] === true,
      ...(values['scratch-root'] === undefined ? {} : { scratchRoot: values['scratch-root'] }),
      ...(values['artifact-root'] === undefined ? {} : { artifactRoot: values['artifact-root'] }),
    };
  }
  if (command === 'queue') {
    const { values } = nodeParseArgs({
      args: argv.slice(1),
      options: {
        file: { type: 'string' },
        mode: { type: 'string' },
        'max-runs': { type: 'string' },
        'token-budget': { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
      allowPositionals: false,
      strict: true,
    });
    if (!values.file) throw new Error('missing required option: --file');
    const mode = values.mode ?? 'manual';
    if (!RUN_MODES.has(mode)) {
      throw new Error(`invalid --mode: ${mode}; expected one of: manual, autonomous`);
    }
    return {
      command,
      file: values.file,
      mode,
      ...(values['max-runs'] === undefined ? {} : {
        maxRuns: strictInt(values['max-runs'], undefined, 1, Number.MAX_SAFE_INTEGER),
      }),
      ...(values['token-budget'] === undefined ? {} : {
        tokenBudget: strictInt(values['token-budget'], undefined, 1, Number.MAX_SAFE_INTEGER),
      }),
      dryRun: values['dry-run'] === true,
    };
  }
  if (command === 'plan') {
    const { values } = nodeParseArgs({
      args: argv.slice(1),
      options: {
        goal: { type: 'string' },
        target: { type: 'string' },
        out: { type: 'string' },
        rounds: { type: 'string' },
        candidates: { type: 'string' },
        'pivot-candidates': { type: 'string' },
        'planner-model': { type: 'string' },
        'verifier-model': { type: 'string' },
        'arbiter-model': { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
      allowPositionals: false,
      strict: true,
    });
    for (const required of ['goal', 'target', 'out']) {
      if (!values[required]) throw new Error(`missing required option: --${required}`);
    }
    return {
      command,
      goal: values.goal,
      target: values.target,
      out: values.out,
      ...(values.rounds === undefined ? {} : {
        rounds: strictInt(values.rounds, undefined, 1, Number.MAX_SAFE_INTEGER),
      }),
      candidates: strictInt(values.candidates, 3, 1, MAX_PLAN_CANDIDATES),
      pivotCandidates: strictInt(
        values['pivot-candidates'], 3, 1, MAX_PLAN_CANDIDATES,
      ),
      ...(values['planner-model'] === undefined ? {} : { plannerModel: values['planner-model'] }),
      ...(values['verifier-model'] === undefined ? {} : { verifierModel: values['verifier-model'] }),
      ...(values['arbiter-model'] === undefined ? {} : { arbiterModel: values['arbiter-model'] }),
      dryRun: values['dry-run'] === true,
    };
  }
  if (command === 'decompose') {
    const { values } = nodeParseArgs({
      args: argv.slice(1),
      options: {
        goal: { type: 'string' },
        project: { type: 'string' },
        target: { type: 'string' },
        out: { type: 'string' },
        rounds: { type: 'string' },
        'map-budget': { type: 'string' },
        'planner-model': { type: 'string' },
        'verifier-model': { type: 'string' },
        'arbiter-model': { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    });
    const hasGoal = values.goal !== undefined;
    const hasProject = values.project !== undefined;
    if (hasGoal === hasProject) {
      throw new Error('decompose requires exactly one of --goal or --project');
    }
    if (!values.target) throw new Error('missing required option: --target');
    if (hasGoal && values.out !== undefined) {
      throw new Error('--out is not allowed with --goal; a goal decomposes beside its own spec');
    }
    if (hasProject && values.out === undefined) {
      throw new Error('missing required option: --out (required with --project)');
    }
    return {
      command,
      mode: hasGoal ? 'goal' : 'project',
      ...(hasGoal ? { goal: values.goal } : { project: values.project }),
      target: values.target,
      ...(values.out === undefined ? {} : { out: values.out }),
      mapBudget: strictInt(values['map-budget'], 12000, 1, Number.MAX_SAFE_INTEGER),
      ...(values.rounds === undefined ? {} : {
        rounds: strictInt(values.rounds, undefined, 1, Number.MAX_SAFE_INTEGER),
      }),
      ...(values['planner-model'] === undefined ? {} : { plannerModel: values['planner-model'] }),
      ...(values['verifier-model'] === undefined ? {} : { verifierModel: values['verifier-model'] }),
      ...(values['arbiter-model'] === undefined ? {} : { arbiterModel: values['arbiter-model'] }),
    };
  }
  if (command === 'mutate') {
    const { values } = nodeParseArgs({
      args: argv.slice(1),
      options: {
        target: { type: 'string' },
        base: { type: 'string' },
        tests: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
      allowPositionals: false,
      strict: true,
    });
    if (!values.target) throw new Error('missing required option: --target');
    return {
      command,
      target: values.target,
      base: values.base ?? 'HEAD',
      ...(values.tests === undefined ? {} : { tests: values.tests }),
      dryRun: values['dry-run'] === true,
    };
  }
  if (command === 'init') {
    if (argv.length !== 2 || !argv[1]) {
      throw new Error('usage: init <directory>');
    }
    return { command, directory: argv[1] };
  }
  if (command === 'publish') {
    if (argv.length !== 2 || !argv[1]) {
      throw new Error('usage: publish <run-directory>');
    }
    return { command, runDirectory: argv[1] };
  }
  if (command === 'status') {
    if (argv.length !== 2 || !argv[1]) {
      throw new Error('usage: status <run-directory>');
    }
    return { command, runDirectory: argv[1] };
  }
  if (command === 'dashboard') {
    const { values, positionals } = nodeParseArgs({
      args: argv.slice(1),
      options: {
        port: { type: 'string' },
        run: { type: 'string' },
        'scratch-root': { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 1) {
      throw new Error('usage: dashboard [run-directory] [--scratch-root <directory>] [--port <port>]');
    }
    if (positionals[0] && values.run) {
      throw new Error('dashboard run directory must be positional or --run, not both');
    }
    const runDirectory = values.run ?? positionals[0];
    if (runDirectory && values['scratch-root']) {
      throw new Error('dashboard accepts either a run directory or --scratch-root, not both');
    }
    const parsed = { command };
    if (runDirectory) parsed.runDirectory = runDirectory;
    if (values['scratch-root']) parsed.scratchRoot = values['scratch-root'];
    if (values.port !== undefined) parsed.port = parseDashboardPort(values.port);
    return parsed;
  }
  if (command !== 'run' && command !== 'batch') {
    throw new Error(`unknown command: ${command ?? '(none)'}`);
  }
  const { values } = nodeParseArgs({
    args: normalizeNegativeTimeoutArguments(argv.slice(1)),
    options: command === 'batch' ? BATCH_PARSE_OPTIONS : {
      task: { type: 'string' },
      target: { type: 'string' },
      gate: { type: 'string' },
      'gate-retries': { type: 'string' },
      corrects: { type: 'string' },
      'executor-model': { type: 'string' },
      'executor-effort': { type: 'string' },
      'verifier-model': { type: 'string' },
      'arbiter-model': { type: 'string' },
      'executor-timeout': { type: 'string' },
      'verifier-timeout': { type: 'string' },
      'arbiter-timeout': { type: 'string' },
      'gate-timeout': { type: 'string' },
      'artifact-root': { type: 'string' },
      'pivot-candidates': { type: 'string' },
      mode: { type: 'string' },
      mutate: { type: 'boolean' },
      quiet: { type: 'boolean' },
      'no-dashboard': { type: 'boolean' },
      open: { type: 'boolean' },
      port: { type: 'string' },
    },
    strict: true,
  });
  if (command === 'batch' && values.campaign !== undefined) {
    const conflict = BATCH_CAMPAIGN_FLAGS.find((flag) => Object.hasOwn(values, flag));
    if (conflict !== undefined) {
      throw new Error(
        `--${conflict} cannot be used with --campaign; declare campaign-shaping inputs in the file`,
      );
    }
    const parsed = { command, ...loadCampaignFile(values.campaign) };
    if (values.quiet) parsed.quiet = true;
    if (values['no-dashboard']) parsed.noDashboard = true;
    if (values.open) parsed.open = true;
    if (values.port !== undefined) parsed.port = parseDashboardPort(values.port);
    if (values['artifact-root'] !== undefined) parsed.artifactRoot = values['artifact-root'];
    return assignStageTimeouts(parsed, values);
  }
  for (const req of ['task', 'target', 'gate']) {
    if (!values[req]) throw new Error(`missing required option: --${req}`);
  }
  const executorEffort = values['executor-effort'];
  validateExecutorEffort(executorEffort);
  if (command === 'run') {
    if (values.mode !== undefined && !RUN_MODES.has(values.mode)) {
      throw new Error(`invalid --mode: ${values.mode}; expected one of: manual, autonomous`);
    }
    const parsed = {
      command,
      task: values.task,
      target: values.target,
      gate: values.gate,
      gateRetries: clampInt(values['gate-retries'], 2, 0, 3),
      correctsRunId: values.corrects,
      executorModel: values['executor-model'],
      executorEffort,
      verifierModel: values['verifier-model'],
      arbiterModel: values['arbiter-model'],
      ...(values['pivot-candidates'] === undefined ? {} : {
        pivotCandidates: strictInt(
          values['pivot-candidates'], undefined, 1, MAX_PLAN_CANDIDATES,
        ),
      }),
      ...(values['artifact-root'] === undefined ? {} : { artifactRoot: values['artifact-root'] }),
    };
    if (values.mode !== undefined) parsed.mode = values.mode;
    if (values.mutate) parsed.mutate = true;
    if (values.quiet) parsed.quiet = true;
    if (values['no-dashboard']) parsed.noDashboard = true;
    if (values.open) parsed.open = true;
    if (values.port !== undefined) parsed.port = parseDashboardPort(values.port);
    return assignStageTimeouts(parsed, values);
  }

  const tasks = values.task;
  let maxRounds = strictInt(values.rounds, DEFAULT_ROUNDS, 1, MAX_ROUNDS);
  const rawTaskRounds = values.round;
  if (rawTaskRounds !== undefined && rawTaskRounds.length !== tasks.length) {
    throw new Error('--round must be given once per --task');
  }
  const taskRounds = rawTaskRounds?.map((value) => (
    strictInt(value, undefined, 1, MAX_ROUNDS)
  ));
  if (values.rounds === undefined && taskRounds !== undefined) {
    maxRounds = Math.max(...taskRounds);
  }
  if (taskRounds?.some((value) => value > maxRounds)) {
    throw new Error(`--round cannot exceed configured --rounds ${maxRounds}`);
  }
  const rawKinds = values['unit-kind'] ?? ['candidate'];
  for (const kind of rawKinds) {
    if (!UNIT_KIND_SET.has(kind)) {
      throw new Error(`invalid --unit-kind: ${kind}; expected one of: ${UNIT_KINDS.join(', ')}`);
    }
  }
  if (rawKinds.length !== 1 && rawKinds.length !== tasks.length) {
    throw new Error('--unit-kind must be given once for all tasks or once per --task');
  }
  if (maxRounds > 1 && !rawKinds.every((kind) => kind === 'candidate')) {
    throw new Error('iterative --rounds may contain only candidate units');
  }
  const unitIds = values['unit-id'];
  if (unitIds !== undefined && unitIds.length !== tasks.length) {
    throw new Error('--unit-id must be given once per --task');
  }
  if (unitIds?.some((unitId) => unitId === '')) {
    throw new Error('--unit-id values must be non-empty');
  }
  if (unitIds && new Set(unitIds).size !== unitIds.length) {
    throw new Error(`duplicate --unit-id: ${unitIds.find((id, index) => unitIds.indexOf(id) !== index)}`);
  }
  const perspectives = values.perspective;
  if (perspectives !== undefined && perspectives.length !== tasks.length) {
    throw new Error('--perspective must be given once per --task');
  }
  if (perspectives?.some((perspective) => perspective.trim() === '')) {
    throw new Error('--perspective values must be non-empty');
  }
  if (perspectives !== undefined) {
    const normalized = perspectives.map((perspective, index) => ({
      value: perspective.trim().toLocaleLowerCase('en-US'),
      round: taskRounds?.[index] ?? 1,
    }));
    const duplicateIndex = normalized.findIndex((candidate, index) => normalized.some(
      (other, otherIndex) => otherIndex < index
        && other.round === candidate.round
        && other.value === candidate.value,
    ));
    if (duplicateIndex !== -1) {
      throw new Error(`duplicate --perspective: ${perspectives[duplicateIndex]}`);
    }
  }
  const rawEdges = values['depends-on'] ?? [];
  if (maxRounds > 1 && perspectives === undefined) {
    throw new Error('iterative --rounds require one --perspective per --task');
  }
  if (maxRounds > 1 && rawEdges.length > 0) {
    throw new Error('iterative candidate rounds cannot declare --depends-on edges');
  }
  if (rawEdges.length > 0 && unitIds === undefined) {
    throw new Error('--depends-on requires one --unit-id per --task');
  }
  const parentsByChild = new Map();
  for (const edge of rawEdges) {
    const separator = edge.indexOf('=');
    const child = separator < 0 ? '' : edge.slice(0, separator);
    const parent = separator < 0 ? '' : edge.slice(separator + 1);
    if (!child || !parent) {
      throw new Error(`invalid --depends-on ${edge}; expected CHILD=PARENT`);
    }
    if (!unitIds.includes(child)) {
      throw new Error(`--depends-on names unknown child unit "${child}"`);
    }
    const parents = parentsByChild.get(child) ?? [];
    parents.push(parent);
    parentsByChild.set(child, parents);
  }
  const campaignTasks = tasks.map((task, index) => {
    const unit = {
      task,
      unitKind: rawKinds.length === 1 ? rawKinds[0] : rawKinds[index],
      ...(unitIds === undefined ? {} : { unitId: unitIds[index] }),
      ...(perspectives === undefined ? {} : { perspective: perspectives[index] }),
    };
    const parents = parentsByChild.get(unit.unitId) ?? [];
    if (parents.length === 1) unit.dependsOn = parents[0];
    else if (parents.length > 1) {
      unit.dependsOn = parents;
      unit.unitKind = 'merge';
    }
    return unit;
  });
  const parsed = {
    command,
    tasks: campaignTasks,
    // Mode A is keyed off --perspective ALONE. `candidate` is the documented default
    // unit kind, so naming it explicitly must not change behaviour: a batch of
    // independent tasks passing `--unit-kind candidate` without perspectives stayed a
    // plain batch before and must stay one now. Including --unit-kind in this condition
    // is redundant when perspectives are present and breaks compatibility when they are
    // absent, because validateCandidateSet then rejects the batch for missing
    // perspectives before any executor runs.
    candidateSet: perspectives !== undefined
      && rawKinds.every((kind) => kind === 'candidate'),
    target: values.target,
    gate: values.gate,
    gateRetries: clampInt(values['gate-retries'], 2, 0, 3),
    ...(values['pivot-candidates'] === undefined ? {} : {
      pivotCandidates: strictInt(
        values['pivot-candidates'], undefined, 1, MAX_PLAN_CANDIDATES,
      ),
    }),
    executorModel: values['executor-model'],
    executorEffort,
    verifierModel: values['verifier-model'],
    arbiterModel: values['arbiter-model'],
    ...(values['artifact-root'] === undefined ? {} : { artifactRoot: values['artifact-root'] }),
    concurrency: strictInt(values.concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY),
    tokenBudget: strictInt(
      values['token-budget'], DEFAULT_TOKEN_BUDGET, 1, Number.MAX_SAFE_INTEGER,
    ),
  };
  if (maxRounds > DEFAULT_ROUNDS) {
    const declaredTaskRounds = taskRounds ?? tasks.map(() => 1);
    const highestDeclaredRound = Math.max(...declaredTaskRounds);
    for (let round = 1; round <= highestDeclaredRound; round++) {
      if (!declaredTaskRounds.includes(round)) {
        throw new Error(`--round declarations must be contiguous; round ${round} is missing`);
      }
    }
    parsed.maxRounds = maxRounds;
    parsed.roundPlans = Array.from({ length: highestDeclaredRound }, (_, roundIndex) => (
      campaignTasks.filter((_, taskIndex) => declaredTaskRounds[taskIndex] === roundIndex + 1)
    ));
  }
  if (values.quiet) parsed.quiet = true;
  if (values['no-dashboard']) parsed.noDashboard = true;
  if (values.open) parsed.open = true;
  if (values.port !== undefined) parsed.port = parseDashboardPort(values.port);
  return assignStageTimeouts(parsed, values);
}
