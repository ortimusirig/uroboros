import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { runGate } from './gate.js';

export const REQUIRED_PLAN_SECTIONS = Object.freeze([
  'Title',
  'Required behavior',
  'Invariants',
  'Test requirements',
  'Out of scope',
]);

function failure(id, check, message, fields = {}) {
  return { id, check, message, ...fields };
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function withinTarget(target, path) {
  const child = relative(target, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

function normalizedCitation(value) {
  const citation = value.trim()
    .replace(/^<|>$/g, '')
    .replace(/[.,;)]$/g, '')
    // Codex on Windows cites files in the file-URL shape /C:/repo/src/thing.js.
    // Left alone, resolve() turns that into C:\C:\repo\src\thing.js, so a TRUE
    // citation inside the target is reported as "outside the target" — a peer
    // measured 11 of 13 failures in one round being this false positive.
    .replace(/^\/([A-Za-z]:[\\/])/, '$1')
    .replace(/^\.\//, '');
  if (citation === '' || citation.includes('://')) return null;
  if (citation.startsWith('-')) return null;
  const withoutLine = citation.replace(/:\d+(?::\d+)?$/, '');
  if (/\s/.test(withoutLine)
    && !/^[^`"'<>|\r\n]+[\\/][^`"'<>|\r\n]+\.[A-Za-z0-9]+$/.test(withoutLine)) return null;
  if (!/\s/.test(withoutLine)
    && !/(?:^|[\\/])[A-Za-z0-9_.-]+\.[A-Za-z0-9]+$/.test(withoutLine)
    && !/^[A-Za-z0-9_.-]+\.[A-Za-z0-9]+$/.test(withoutLine)) return null;
  return withoutLine.replaceAll('\\', '/');
}

export function collectPlanCitations(plan) {
  const citations = new Set();
  const lineReferences = [];
  const seenLines = new Set();
  const candidates = [];
  for (const match of String(plan).matchAll(/`([^`\r\n]+)`/g)) candidates.push(match[1]);
  for (const match of String(plan).matchAll(/\]\(([^)]+)\)/g)) candidates.push(match[1]);
  for (const match of String(plan).matchAll(
    /(?:^|[\s`(])([A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*\.[A-Za-z0-9]+):(\d+)(?=$|[\s`),.;])/gm,
  )) {
    candidates.push(match[1]);
    const citation = `${match[1]}:${match[2]}`;
    if (!seenLines.has(citation)) {
      seenLines.add(citation);
      lineReferences.push({ citation, path: match[1], line: Number(match[2]) });
    }
  }
  for (const candidate of candidates) {
    const path = normalizedCitation(candidate);
    if (path !== null) {
      citations.add(path);
      const reference = /^(.*):(\d+)(?::\d+)?$/.exec(candidate.trim());
      const citation = reference ? `${reference[1]}:${reference[2]}` : null;
      if (reference && !seenLines.has(citation)) {
        seenLines.add(citation);
        lineReferences.push({ citation, path: reference[1], line: Number(reference[2]) });
      }
    }
  }
  // A bare dotted token carries no path separator, so nothing distinguishes a
  // real citation like README.md from ordinary prose like `args.instruction` or
  // `facts.runId`. Both match name.ext. Reporting the identifier as a missing
  // file is a false positive that a reader then has to disprove, so bare tokens
  // are separated out: they still feed line-reference checks, and a missing one
  // is simply not claimed. Anything carrying a separator is unambiguously a path
  // and is still reported.
  // normalizedCitation has already turned every backslash into a forward slash.
  const separated = (path) => path.includes('/');
  const all = [...citations];
  return {
    paths: all.filter(separated),
    ambiguousPaths: all.filter((path) => !separated(path)),
    lineReferences,
  };
}

function sectionEntries(plan, sectionName) {
  const lines = String(plan).split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => (
    /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1].toLowerCase() === sectionName.toLowerCase()
  ));
  if (headingIndex < 0) return [];
  const level = /^#+/.exec(lines[headingIndex])[0].length;
  const body = [];
  for (let index = headingIndex + 1; index < lines.length; index++) {
    const heading = /^(#{1,6})\s+/.exec(lines[index]);
    if (heading && heading[1].length <= level) break;
    body.push(lines[index]);
  }
  const entries = [];
  let current = '';
  for (const line of body) {
    if (/^\s*(?:[-*+] |\d+[.)]\s+)/.test(line)) {
      if (current.trim() !== '') entries.push(current.trim());
      current = line.trim();
    } else if (line.trim() === '') {
      if (current.trim() !== '') entries.push(current.trim());
      current = '';
    } else {
      current += `${current === '' ? '' : ' '}${line.trim()}`;
    }
  }
  if (current.trim() !== '') entries.push(current.trim());
  return entries;
}

function absenceAssertion(entry) {
  return /\b(?:absent|absence|does not|doesn't|must not|never|no\s+(?:file|output|call|command|review|run|write|change|artifact|finding|implementation)|not\s+(?:exist|written|created|called|started|run|reach|overwrite|modify|delete|emit))\b/i.test(entry);
}

function gateShapeFailures(gate) {
  if (!Array.isArray(gate)) {
    return [failure('PG_GATE_SHAPE', 'gate-runs', 'gate.json must be a JSON array of commands')];
  }
  const failures = [];
  gate.forEach((command, index) => {
    const valid = command !== null && typeof command === 'object' && !Array.isArray(command)
      && typeof command.bin === 'string' && command.bin.trim() !== ''
      && Array.isArray(command.args) && command.args.every((arg) => typeof arg === 'string');
    if (!valid) {
      failures.push(failure(
        `PG_GATE_COMMAND_${index + 1}`,
        'gate-runs',
        `gate.json command ${index + 1} must have a non-empty bin and a string args array`,
        { commandIndex: index + 1 },
      ));
    }
  });
  return failures;
}

function namedTestPath(argument) {
  if (typeof argument !== 'string' || /[*?{}]/.test(argument)) return null;
  const value = argument.replace(/^['"]|['"]$/g, '').replace(/^\.\//, '');
  const looksLikeTest = /(?:^|[\\/])(?:test|tests|__tests__)(?:[\\/]).+\.[A-Za-z0-9]+$/i.test(value)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(value)
    || /(?:^|[\\/])test_[^\\/]+\.py$/i.test(value)
    || /(?:^|[\\/])[^\\/]+_test\.py$/i.test(value);
  return looksLikeTest ? value.replaceAll('\\', '/') : null;
}

function commandText(command) {
  return [command.bin, ...command.args].join(' ');
}

export async function runPlanGate({
  plan,
  gate,
  target,
  timeoutMs,
  executeGate = runGate,
} = {}) {
  const resolvedTarget = resolve(target);
  const failures = [];
  const observations = [];

  const shapeFailures = gateShapeFailures(gate);
  failures.push(...shapeFailures);

  const citations = collectPlanCitations(plan);
  for (const path of citations.paths) {
    const resolvedPath = resolve(resolvedTarget, path);
    if (!withinTarget(resolvedTarget, resolvedPath)) {
      failures.push(failure(
        `PG_PATH_${failures.length + 1}`,
        'cited-paths',
        `cited path is outside the target: ${path}`,
        { citation: path },
      ));
    } else if (!existsSync(resolvedPath)) {
      failures.push(failure(
        `PG_PATH_${failures.length + 1}`,
        'cited-paths',
        `cited path does not exist: ${path}`,
        { citation: path },
      ));
    }
  }
  for (const reference of citations.lineReferences) {
    const path = resolve(resolvedTarget, reference.path);
    if (!withinTarget(resolvedTarget, path) || !isFile(path)) continue;
    const content = readFileSync(path, 'utf8');
    const lines = content === '' ? 0 : content.split(/\r\n|\r|\n/).length
      - (/\r\n$|[\r\n]$/.test(content) ? 1 : 0);
    if (reference.line < 1 || reference.line > lines) {
      failures.push(failure(
        `PG_LINE_${failures.length + 1}`,
        'cited-lines',
        `cited line does not exist: ${reference.citation} (file has ${lines} lines)`,
        { citation: reference.citation, lineCount: lines },
      ));
    }
  }

  if (Array.isArray(gate)) {
    gate.forEach((command, commandIndex) => {
      if (!Array.isArray(command?.args)) return;
      for (const argument of command.args) {
        const testPath = namedTestPath(argument);
        if (testPath !== null && !isFile(resolve(resolvedTarget, testPath))) {
          failures.push(failure(
            `PG_TEST_${failures.length + 1}`,
            'named-test-files',
            `gate.json command ${commandIndex + 1} names a test file that does not exist: ${testPath}`,
            { citation: testPath, commandIndex: commandIndex + 1 },
          ));
        }
      }
    });
  }

  const headings = new Set([...String(plan).matchAll(/^#{1,6}\s+(.+?)\s*$/gm)]
    .map((match) => match[1].trim().toLowerCase()));
  for (const section of REQUIRED_PLAN_SECTIONS) {
    if (!headings.has(section.toLowerCase())) {
      failures.push(failure(
        `PG_SECTION_${section.toUpperCase().replaceAll(' ', '_')}`,
        'required-sections',
        `required section is missing: ${section}`,
        { section },
      ));
    }
  }

  for (const [index, entry] of sectionEntries(plan, 'Test requirements').entries()) {
    if (absenceAssertion(entry) && !/\bpositive control\b/i.test(entry)) {
      failures.push(failure(
        `PG_ABSENCE_${index + 1}`,
        'absence-controls',
        `test requirement has an absence assertion without a positive control: ${entry}`,
        { requirement: entry },
      ));
    }
  }

  // Snapshot every repository-evidence check before executing operator-proposed commands.
  // A mutating command remains the operator's responsibility, but it cannot manufacture the
  // path or line evidence used to validate the plan that proposed it.
  if (shapeFailures.length === 0) {
    let result;
    let launchFailed = false;
    try {
      result = await executeGate({ commands: gate, cwd: resolvedTarget, timeoutMs });
    } catch (error) {
      launchFailed = true;
      failures.push(failure(
        'PG_GATE_LAUNCH',
        'gate-runs',
        `gate.json could not run: ${error?.message ?? String(error)}`,
      ));
    }
    // A gate command that RAN and exited non-zero is not a broken gate. The check
    // is named gate-runs, and it ran. Before implementation a TDD-shaped gate is
    // supposed to fail: `pytest -k test_new_thing` exits 5 (collected nothing)
    // for tests the plan will create, and that hard-failed the candidate with no
    // way to express "collects nothing yet". Whether the gate passes is the code
    // gate's question at implementation time, not the plan gate's.
    //
    // The genuine "this gate cannot run" case is a launch failure, which
    // spawnCapture throws on (ENOENT) and PG_GATE_LAUNCH above already records.
    // No exit-code allowlist is needed, and none is used.
    if (result !== undefined && result?.passed !== true) {
      for (const command of result.results?.filter((item) => item.code !== 0) ?? []) {
        observations.push({
          check: 'gate-runs',
          message: `gate command exited ${command.code} before implementation: ${commandText(command)}`,
          command: commandText(command),
          code: command.code,
        });
      }
    } else if (result === undefined && !launchFailed) {
      // A thrown launch already reported PG_GATE_LAUNCH with the actual cause;
      // adding "did not return a gate result" on top buries it.
      failures.push(failure('PG_GATE_EXIT', 'gate-runs', 'gate.json did not return a gate result'));
    }
  }

  return { passed: failures.length === 0, failures, observations };
}
