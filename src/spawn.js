import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WINDOWS_TREE_SCRIPT = fileURLToPath(new URL('./windows-process-tree.ps1', import.meta.url));

// Resolve a bare command name to a full path via `where` (win) / `which` (posix).
// A bin that already carries a path separator is returned as-is when it exists.
// Returns null when it cannot be resolved.
function resolveBin(bin, env = process.env) {
  if (bin.includes('/') || bin.includes('\\')) {
    return Promise.resolve(existsSync(bin) ? bin : null);
  }
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((res) => {
    const c = spawn(probe, [bin], { windowsHide: true, env });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('error', () => res(null));
    c.on('close', (code) => {
      if (code !== 0) return res(null);
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (process.platform === 'win32') {
        // `where` may list an extensionless shim (e.g. npm's `codex`) BEFORE the runnable
        // `codex.cmd`; prefer a PATHEXT-executable variant Windows can actually launch.
        const exe = lines.find((l) => /\.(exe|cmd|bat|com)$/i.test(l));
        return res(exe || lines[0] || null);
      }
      return res(lines[0] || null);
    });
  });
}

// Quote a token for a cmd.exe command line: wrap in double quotes if it holds
// whitespace or a quote (doubling any internal quote); empty string -> "".
function quoteWin(s) {
  if (s === '') return '""';
  if (/[\s"]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function killWindowsTreeFallback(child) {
  const inspector = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', WINDOWS_TREE_SCRIPT, String(child.pid),
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    const pids = output.trim() === '' ? [] : output.trim().split(/\s+/).map(Number);
    for (const pid of pids.filter((value) => Number.isInteger(value) && value > 0)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* process already exited */ }
    }
    child.kill();
  };
  const timer = setTimeout(() => { inspector.kill(); finish(); }, 10_000);
  inspector.stdout.on('data', (chunk) => { output += chunk; });
  inspector.on('error', () => { clearTimeout(timer); finish(); });
  inspector.on('close', () => { clearTimeout(timer); finish(); });
}

function inspectWithProcess(bin, args, parse, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let output = '';
    let errorOutput = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let inspector;
    try {
      inspector = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ available: false, error: error?.message ?? String(error), descendants: [] });
      return;
    }
    const timer = setTimeout(() => {
      inspector.kill();
      finish({ available: false, error: `process-tree inspection exceeded ${timeoutMs}ms`, descendants: [] });
    }, timeoutMs);
    inspector.stdout.on('data', (chunk) => { output += chunk; });
    inspector.stderr.on('data', (chunk) => { errorOutput += chunk; });
    inspector.on('error', (error) => finish({
      available: false, error: error?.message ?? String(error), descendants: [],
    }));
    inspector.on('close', (code) => {
      if (code !== 0) {
        finish({
          available: false,
          error: errorOutput.trim() || `process-tree inspection exited ${code}`,
          descendants: [],
        });
        return;
      }
      try { finish(parse(output)); }
      catch (error) {
        finish({ available: false, error: error?.message ?? String(error), descendants: [] });
      }
    });
  });
}

export function inspectProcessTree(child) {
  const rootPid = Number(child?.pid);
  if (!Number.isInteger(rootPid) || rootPid < 1) {
    return Promise.resolve({ available: false, rootPid: null, descendants: [] });
  }
  if (process.platform === 'win32') {
    return inspectWithProcess('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', WINDOWS_TREE_SCRIPT, String(rootPid), '-Detailed',
    ], (output) => {
      const source = output.trim();
      const parsed = source === '' ? [] : JSON.parse(source);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const descendants = rows.map((row) => ({
        pid: Number(row.pid),
        name: String(row.name ?? ''),
        responding: row.responding !== false,
      })).filter((row) => Number.isInteger(row.pid) && row.pid > 0);
      return { available: true, rootPid, liveDescendantCount: descendants.length, descendants };
    });
  }
  return inspectWithProcess('ps', ['-eo', 'pid=,ppid=,stat=,comm='], (output) => {
    const rows = output.split(/\r?\n/).map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
      return match ? {
        pid: Number(match[1]), parentPid: Number(match[2]),
        status: match[3], name: match[4],
      } : null;
    }).filter(Boolean);
    const descendants = [];
    const parents = new Set([rootPid]);
    let added;
    do {
      added = false;
      for (const row of rows) {
        if (parents.has(row.pid) || !parents.has(row.parentPid)) continue;
        parents.add(row.pid);
        descendants.push(row);
        added = true;
      }
    } while (added);
    return { available: true, rootPid, liveDescendantCount: descendants.length, descendants };
  });
}

function killProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // A .cmd/.bat launch runs behind cmd.exe. Killing only that wrapper can leave
    // its real child alive, so taskkill /T is required to terminate the full tree.
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    let fallbackStarted = false;
    const fallback = () => {
      if (fallbackStarted) return;
      fallbackStarted = true;
      killWindowsTreeFallback(child);
    };
    const timer = setTimeout(() => { killer.kill(); fallback(); }, 5000);
    killer.on('error', () => { clearTimeout(timer); fallback(); });
    killer.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) fallback();
    });
    return;
  }
  try {
    // Timed POSIX launches get their own process group below, so descendants die too.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function timerInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new TypeError(`${name} must be a positive safe timer integer`);
  }
}

function clockValue(now) {
  const value = now();
  return value instanceof Date ? value.getTime() : value;
}

export function createLivenessDeadline({
  thresholdMs,
  getLiveness,
  onKill,
  judge,
  getProcessTree,
  getWorktreeActivity,
  onEvent,
  onDecision,
  judgeTimeoutMs = 60_000,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  timerInteger(thresholdMs, 'thresholdMs');
  timerInteger(judgeTimeoutMs, 'judgeTimeoutMs');
  if (typeof getLiveness !== 'function') throw new TypeError('getLiveness must be a function');
  if (typeof onKill !== 'function') throw new TypeError('onKill must be a function');

  let disposed = false;
  let killed = false;
  let timer = null;
  let judging = false;
  let intervalMs = thresholdMs;
  let checkCount = 0;

  const evidence = () => {
    const observed = getLiveness() ?? {};
    const rawGap = Number(observed.gapMs);
    return {
      gapMs: Number.isFinite(rawGap) ? Math.max(0, rawGap) : 0,
      lastEvent: observed.lastEvent ?? null,
      lastEvents: Array.isArray(observed.lastEvents) ? observed.lastEvents : [],
      lastAgentMessage: typeof observed.lastAgentMessage === 'string'
        ? observed.lastAgentMessage
        : '',
      seat: typeof observed.seat === 'string'
        ? observed.seat
        : observed.lastEvent?.stage ?? 'unknown',
      ...(observed.pass === undefined ? {} : { pass: observed.pass }),
    };
  };

  const notify = (type, fields) => {
    try { onEvent?.(type, fields); } catch { /* observability cannot decide liveness */ }
  };

  const decide = (decision) => {
    try { onDecision?.(decision); } catch { /* decision recording is best effort */ }
  };

  const finish = (reason) => {
    if (disposed || killed) return;
    killed = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
    try { onKill(reason); } catch { /* the termination callback owns its errors */ }
  };

  const unavailable = (observed, reason, gathered = {}) => {
    const reasoning = `Liveness check was unjudged: ${reason}`;
    const decision = {
      status: 'stuck',
      judged: false,
      unjudged: true,
      reasoning,
      gapMs: observed.gapMs,
      intervalMs,
      checkCount,
      seat: observed.seat,
      lastEvent: observed.lastEvent,
      ...gathered,
    };
    notify('stuck', decision);
    decide(decision);
    finish({
      kind: 'liveness',
      timeoutMs: intervalMs,
      gapMs: observed.gapMs,
      lastEvent: observed.lastEvent,
      setting: 'URO_STALL_THRESHOLD_MS',
      judged: false,
      unjudged: true,
      reasoning,
    });
  };

  const boundedOperation = (operation) => new Promise((resolve) => {
    let settled = false;
    const judgeTimer = setTimer(() => {
      if (settled) return;
      settled = true;
      resolve({ available: false, reason: `liveness judge exceeded its ${judgeTimeoutMs}ms bound` });
    }, judgeTimeoutMs);
    Promise.resolve()
      .then(operation)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimer(judgeTimer);
        resolve(value);
      }, (error) => {
        if (settled) return;
        settled = true;
        clearTimer(judgeTimer);
        resolve({
          available: false,
          reason: `liveness judge failed: ${error?.message ?? String(error)}`,
        });
      });
  });

  const ask = async (observed) => {
    checkCount++;
    notify('asked', {
      seat: observed.seat, gapMs: observed.gapMs, intervalMs,
      checkCount, judgeAvailable: typeof judge === 'function',
      lastEvent: observed.lastEvent,
    });
    if (typeof judge !== 'function') {
      unavailable(observed, 'no liveness judge was available');
      return;
    }

    judging = true;
    const sinceMs = clockValue(now) - observed.gapMs;
    const result = await boundedOperation(async () => {
      const [processTree, worktreeActivity] = await Promise.all([
        typeof getProcessTree === 'function'
          ? Promise.resolve().then(() => getProcessTree()).catch((error) => ({
            available: false, error: error?.message ?? String(error), descendants: [],
          }))
          : Promise.resolve({ available: false, descendants: [] }),
        typeof getWorktreeActivity === 'function'
          ? Promise.resolve().then(() => getWorktreeActivity(sinceMs)).catch((error) => ({
            available: false, error: error?.message ?? String(error), changed: false,
            changedFiles: [], sinceMs,
          }))
          : Promise.resolve({ available: false, changed: false, changedFiles: [], sinceMs }),
      ]);
      const input = {
        seat: observed.seat,
        ...(observed.pass === undefined ? {} : { pass: observed.pass }),
        askedAt: new Date(clockValue(now)).toISOString(),
        gapMs: observed.gapMs,
        currentIntervalMs: intervalMs,
        checkCount,
        lastEvents: observed.lastEvents,
        lastEvent: observed.lastEvent,
        lastAgentMessage: observed.lastAgentMessage,
        processTree,
        worktreeActivity,
      };
      return { judgement: await judge(input), processTree, worktreeActivity };
    });
    judging = false;
    if (disposed || killed) return;
    if (result?.available === false) {
      unavailable(observed, result.reason);
      return;
    }
    const { judgement, processTree, worktreeActivity } = result;
    if (!judgement || judgement.available === false
      || (judgement.status !== 'working' && judgement.status !== 'stuck')
      || typeof judgement.reasoning !== 'string' || judgement.reasoning.trim() === '') {
      unavailable(observed, judgement?.reason
        ?? 'the liveness judge returned no readable working/stuck judgement', {
        processTree, worktreeActivity,
      });
      return;
    }

    const reasoning = judgement.reasoning.trim();
    if (judgement.status === 'working') {
      const previousIntervalMs = intervalMs;
      let invalidNextInterval;
      if (judgement.nextIntervalMs !== undefined) {
        try {
          timerInteger(judgement.nextIntervalMs, 'nextIntervalMs');
          intervalMs = judgement.nextIntervalMs;
        }
        catch (error) {
          invalidNextInterval = {
            invalidNextIntervalMs: judgement.nextIntervalMs,
            nextIntervalError: error.message,
          };
        }
      } else if (Object.hasOwn(judgement, 'invalidNextIntervalMs')) {
        invalidNextInterval = {
          invalidNextIntervalMs: judgement.invalidNextIntervalMs,
          nextIntervalError: typeof judgement.nextIntervalError === 'string'
            ? judgement.nextIntervalError
            : 'nextIntervalMs was unusable',
        };
      }
      const decision = {
        status: 'working', judged: true, reasoning,
        gapMs: observed.gapMs, intervalMs, previousIntervalMs,
        nextIntervalMs: intervalMs,
        intervalReused: judgement.nextIntervalMs === undefined || invalidNextInterval !== undefined,
        ...(invalidNextInterval ?? {}),
        checkCount, seat: observed.seat,
        lastEvent: observed.lastEvent, processTree, worktreeActivity,
      };
      notify('working', decision);
      decide(decision);
      arm(intervalMs);
      return;
    }

    const decision = {
      status: 'stuck', judged: true, reasoning,
      gapMs: observed.gapMs, intervalMs,
      checkCount, seat: observed.seat,
      lastEvent: observed.lastEvent, processTree, worktreeActivity,
    };
    notify('stuck', decision);
    decide(decision);
    finish({
      kind: 'liveness', timeoutMs: intervalMs,
      gapMs: observed.gapMs, lastEvent: observed.lastEvent,
      setting: 'URO_STALL_THRESHOLD_MS', judged: true, reasoning,
    });
  };

  function arm(delayMs = intervalMs) {
    timer = setTimer(() => {
      timer = null;
      if (disposed || killed || judging) return;
      const observed = evidence();
      if (observed.gapMs < intervalMs) {
        arm(intervalMs - observed.gapMs);
        return;
      }
      void ask(observed);
    }, delayMs);
  }

  arm();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

export async function spawnCapture(bin, args, opts = {}) {
  const timeoutMs = opts.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) {
    throw new TypeError('timeoutMs must be a positive safe integer');
  }
  let cmd = bin;
  let cmdArgs = args;
  let verbatim = false;
  if (process.platform === 'win32') {
    const resolved = await resolveBin(bin, opts.env);
    if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
      // Node cannot exec .cmd/.bat directly (CVE-2024-27980), and `shell:true`
      // RE-SPLITS args (`a b c` -> three args). Spawn cmd.exe (an .exe) directly and
      // build the command line ourselves with windowsVerbatimArguments: wrap the WHOLE
      // command in one extra outer quote pair so `cmd /s` strips exactly that pair,
      // leaving a correctly-quoted "path" + args — this survives spaces in the path
      // (e.g. the OneDrive package path), which a plain quoted `cmd /c "x" "a b"` mangles.
      // (Known cmd limit: a .cmd reading an `=`-bearing arg via %~1 splits on `=`; our
      // .cmd targets carry no `=` args — the only `=` argv, codex `mcp_servers={}`, goes
      // to codex.exe, spawned directly.)
      cmd = process.env.ComSpec || 'cmd.exe';
      const line = '"' + [resolved, ...args].map(quoteWin).join(' ') + '"';
      cmdArgs = ['/d', '/s', '/c', line];
      verbatim = true;
    } else if (resolved) {
      cmd = resolved;
    }
  }
  const spawnProcess = opts.spawnProcess ?? spawn;
  const terminateProcessTree = opts.killProcessTree ?? killProcessTree;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(cmd, cmdArgs, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      detached: (timeoutMs !== undefined || opts.livenessSupervision !== undefined)
        && process.platform !== 'win32',
    });
    const outChunks = [];
    const errChunks = [];
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let childClosed = false;
    let timeoutReason = null;
    let killPromise = null;
    const requestKill = (reason, isTimeout) => {
      if (settled || killPromise) return killPromise;
      if (isTimeout) timedOut = true;
      timeoutReason = isTimeout ? reason : null;
      killPromise = Promise.resolve()
        .then(() => opts.beforeKill?.(reason))
        .catch(() => {})
        .then(() => {
          // The child may finish naturally while partial work is being preserved.
          // Never target a closed PID, which could already have been reused.
          if (!settled && !childClosed) terminateProcessTree(child);
        });
      return killPromise;
    };
    let livenessDeadline = null;
    let timer = null;
    const setTimer = opts.setTimer ?? setTimeout;
    const clearTimer = opts.clearTimer ?? clearTimeout;
    if (opts.livenessSupervision) {
      livenessDeadline = createLivenessDeadline({
        ...opts.livenessSupervision,
        getProcessTree: opts.livenessSupervision.getProcessTree
          ?? (() => inspectProcessTree(child)),
        onKill: (reason) => { requestKill(reason, true); },
      });
    }
    if (timeoutMs !== undefined) {
      timer = setTimer(() => {
        requestKill({
          kind: 'deadline',
          timeoutMs,
          ...(opts.timeoutSetting ? { setting: opts.timeoutSetting } : {}),
        }, true);
      }, timeoutMs);
    }
    const signal = opts.signal;
    const onAbort = () => {
      if (settled || aborted) return;
      aborted = true;
      if (timer) { clearTimer(timer); timer = null; }
      livenessDeadline?.dispose();
      requestKill(signal?.reason ?? { kind: 'aborted' }, false);
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
    child.stdout.on('data', (d) => {
      outChunks.push(d);
      if (typeof opts.onStdout === 'function') {
        try {
          // Observation is additive: keep the vendor-owned chunk in the capture and hand
          // observers a copy, so mutation or failure cannot change returned stdout.
          const observed = opts.onStdout(Buffer.from(d));
          if (observed && typeof observed.catch === 'function') observed.catch(() => {});
        } catch {
          // Capture is part of the run; an optional observer is disposable.
        }
      }
    });
    child.stderr.on('data', (d) => {
      errChunks.push(d);
      if (typeof opts.onStderr === 'function') {
        try {
          // Same additive contract as onStdout: the observer gets a copy, the
          // capture keeps the original. This is how a parent process streams a
          // child's heartbeat through live instead of sitting silent for the
          // whole run and dumping everything at exit.
          const observed = opts.onStderr(Buffer.from(d));
          if (observed && typeof observed.catch === 'function') observed.catch(() => {});
        } catch {
          // Capture is part of the run; an optional observer is disposable.
        }
      }
    });
    child.on('error', (error) => {
      childClosed = true;
      if (timer) clearTimer(timer);
      livenessDeadline?.dispose();
      signal?.removeEventListener('abort', onAbort);
      if (!settled) { settled = true; reject(error); }
    });
    child.on('close', (code, closeSignal) => {
      childClosed = true;
      if (timer) clearTimer(timer);
      livenessDeadline?.dispose();
      opts.signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      const finishClose = () => {
        if (settled) return;
        settled = true;
        resolve({
          code: code ?? -1,
          signal: closeSignal ?? null,
          stdout: Buffer.concat(outChunks).toString('utf8'),
          stderr: Buffer.concat(errChunks).toString('utf8'),
          timedOut,
          ...(opts.signal ? { aborted } : {}),
          timeoutMs: timeoutMs ?? null,
          ...(timeoutReason ? { timeoutReason } : {}),
        });
      };
      // A timeout outcome is not complete until its best-effort preservation is.
      if (killPromise) killPromise.then(finishClose, finishClose);
      else finishClose();
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export async function commandExists(bin, opts = {}) {
  if (bin.includes('/') || bin.includes('\\')) return existsSync(bin);
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = await spawnCapture(probe, [bin], { env: opts.env });
    return r.code === 0;
  } catch {
    return false;
  }
}
