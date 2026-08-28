# Uroboros field findings — 2026-08-27

Written from two live runs against a large real repo (`C:/mt/r`, the EULR
codebase: ~1,670 tracked files, `CLAUDE.md` 34KB, `AGENTS.md` 20KB) plus a
source read of `src/timeouts.js` and `src/env-compat.js` at **v2.0.2**.

Context for whoever picks this up: users are reporting "uroboros is slow".
Below is what I measured, what I verified in source, and which complaints I
think are actually something else.

---

## 1. The bare `EXECUTOR_TIMEOUT_MS` trap — verified in source

**This is my leading candidate for the "slow" reports.**

`src/timeouts.js:23`:

```js
executor: fromEnv(env, 'EXECUTOR_TIMEOUT_MS', DEFAULT_EXECUTOR_TIMEOUT_MS),
```

`fromEnv` builds the name as `URO_${suffix}` and delegates to
`readEnv(env, suffix)`. `src/env-compat.js:21`:

```js
export function readEnv(env, suffix, { warn = console.warn } = {}) {
  const current = env?.[`URO_${suffix}`];
  if (current !== undefined) return current;
  if (!ALIASED.has(suffix)) return undefined;
  ...
```

So only `URO_EXECUTOR_TIMEOUT_MS` (or the deprecated `CCC_` alias) is read.
A bare `EXECUTOR_TIMEOUT_MS` — the name a user would guess, and the name that
appears in shell history when someone copies a fragment — is **silently
ignored**. No warning, no error. The run falls back to
`DEFAULT_EXECUTOR_TIMEOUT_MS = 30 * 60 * 1000` (`timeouts.js:3`).

Observed consequence in this org: one wave timed out at exactly 30 minutes
**twice** before anyone diagnosed it. Each failure discards partial work. Two
lost 30-minute runs reads as "the tool is slow" when the timeout was never
applied at all.

### Suggested fix (cheap, high value)

Warn on a recognised-but-unprefixed env name. `ALIASED` already enumerates
exactly the user-settable suffixes, so the check is a few lines:

```js
// in readEnv, before returning undefined
if (env?.[suffix] !== undefined && !warned.has(suffix)) {
  warned.add(suffix);
  warn(`${suffix} is set but ignored — did you mean URO_${suffix}?`);
}
```

The `warned` Set and `resetDeprecationWarnings()` already exist for exactly
this pattern. Silent-ignore on a name the tool *knows about* is the defect;
the 30-minute default is fine.

---

## 2. Measured cost profile (two runs, same repo, same day)

| | Round 1 | Round 2 |
|---|---|---|
| Outcome | **no-op** | review-ready |
| Executor input | 381,140 (317,440 cached · 83%) | 5,310,951 (5,153,280 cached · 97%) |
| Executor output | 7,665 (4,671 reasoning) | 29,737 (16,971 reasoning) |
| Verifier | never ran | 1,283,709 in / 26,168 out |
| **Total** | 381k in / 7.6k out | **6.59M in / 55.9k out** |
| Iterations | 1 | 1 |
| Code produced | **none** | 140 lines across 5 files |

Round 2's cost is unremarkable for this org — the local ledger records ~9.5M
in / 74k out per round as typical.

**The cache ratio is the interesting number: 97%.** Nearly all input is
re-ingested context, not new material. Three sequential full-model passes
(executor writes → gate runs → verifier reviews) each re-read a very large
repo. That is inherent to the architecture, not a regression — but it is the
honest answer to "why does one small change take this long". Round 2 changed
140 lines and spent 6.6M input tokens doing it.

**Wall-clock was not captured** and I could not reconstruct it: the run
worktree under `C:/uro/w/<stamp>/w/` is cleaned up after the run, taking
`events.jsonl` and `uro-runfacts.json` with it. See §4.

---

## 3. The expensive no-op — a plan-authoring failure mode

Round 1 burned **381k input tokens and produced zero code**. The executor
ended its pass with:

> "Approve this design and I'll implement it."

The plan was written descriptively ("## Scope", "add these helpers") and the
executor read it as a proposal awaiting sign-off rather than an instruction.
The verifier never ran, so the run also produced no review.

Fixing it required a blunt header on the plan:

```markdown
## IMPLEMENT THIS NOW
This design is APPROVED. Do not stop to ask for design approval — write the
code, add the tests, run the gate.
```

Round 2, same plan plus that block, implemented cleanly in one iteration.

**Worth considering:** a no-op outcome with a non-trivial executor token spend
is almost always this. The harness could detect "outcome: no-op AND executor
output contains an approval request" and say so in `uro-report.md`, rather than
leaving the operator to diff two runs to work it out. Users hitting this
repeatedly would reasonably describe it as the tool being slow *and* useless.

**Credit where due:** the same round-1 executor caught a genuine
self-contradiction in my plan that I had missed (two stated safety rules that
were the same value in the code, which would have caused data loss). So the
381k was not wasted in the sense that matters — but it is a confusing outcome
to present to a user as "no-op".

---

## 4. Run artifacts are destroyed before they can be read

After a run completes, `C:/uro/w/<stamp>/w/` is cleaned. That removes:

- `events.jsonl` — the only per-stage timing source
- `uro-runfacts.json` — machine-readable outcome
- `uro-report.md` — the reviewer text

`uro-report.md` is the one artifact this org's practice depends on (unlike the
older ccc harness, uroboros *persists* reviewer verdict text, and the local
standing rule is "read it before landing, always"). Losing it on cleanup means
you must read it inside the window between completion and cleanup.

Concretely: I could not answer "how long did round 2 take" an hour later,
because every timing artifact was gone.

**Suggestion:** copy the four harness files (`TASK.md`, `events.jsonl`,
`uro-report.md`, `uro-runfacts.json`) to a durable per-run directory outside
the disposable worktree before cleanup. Without wall-clock retention, "it's
slow" cannot even be quantified — which is the position I am in writing this.

---

## 5. Not a defect, but shapes the experience

- **A fresh git worktree per run** over a 1,670-file repo. Real setup cost,
  and it is why the bare checkout has no `node_modules` — gate suites must be
  dependency-free or they fail for environmental reasons rather than real ones.
- **Strict exit-code gate.** Known-red suites deadlock it, so they must be
  deselected by name up front. A user who has not learned this will watch runs
  fail on pre-existing reds and blame the tool.
- **`doctor` reports several optional FAILs** (GitHub CLI, gitleaks,
  trufflehog, logdy) before the `HEALTHY` line. A new user reading top-down
  sees a wall of FAIL and reasonably concludes the install is broken. Consider
  ordering or grouping so the core verdict leads.

---

## Priority if someone works on this

1. **§1 warn on unprefixed env names** — small, verified, likely the actual
   cause of the "slow" reports.
2. **§4 persist run artifacts** — without this, no performance claim can be
   measured or refuted.
3. **§3 name the approval-request no-op** in the report.
4. **§5 doctor output ordering** — cosmetic, but it is first contact.

§2 is the architecture. It is not obviously wrong, but if the goal is "make it
feel faster", the 97% cache ratio is where the headroom is.


---

## 6. The verifier cannot be driven standalone — and it fails SILENTLY

Added 2026-08-27 after four failed attempts to run a verify-only pass over two
already-committed diffs (no executor, review only). This is the highest-value
finding in the doc for anyone relying on the loop's review seats.

**What happened.** Importing `runVerifier` from `src/verifier.js` and calling it
directly returns, every time:

```
verdict      : ISSUES  (source: plan)
exit         : 0   launchFailed: false
```

`exit 0`, `launchFailed: false`, **empty findings text** — i.e. it looks like a
completed review that found problems. It is not. `ISSUES (source: plan)` is the
FAIL-SAFE DEFAULT: no verdict marker was parsed, so the harness assumes the
worst. A caller who reads only the verdict line will confidently report
"the reviewer found issues" when no review occurred at all.

**Attempts, in order:**
1. `cwd` = a bare directory holding only `CHANGES.diff` + `TASK.md`. Wrong — a
   real round gives the verifier the WORKTREE, so it can open the files the diff
   touches. Returned instantly.
2. `cwd` = a proper git worktree checked out at the commit, with both files
   alongside full source. Took minutes (so something ran) — same empty result.
3. Found the cause looked like PATH: `agent` is not on PATH; the binary lives at
   `%LOCALAPPDATA%\cursor-agentgent.cmd` and works (`--version` →
   `2026.08.25-3e8eec8`).
4. Re-ran with that directory prepended to PATH. **Same empty result.** So PATH
   was not the whole story — the process runs, exits 0, and emits nothing the
   verdict parser can read. Most likely it needs an interactive auth context or
   a TTY that a spawned non-interactive shell does not provide.

**Why this matters more than it looks.** The review seats are where the loop
earns its cost. On this repo, the same day, they caught two data-loss defects
that a 646/646 green gate missed. If the seat can silently no-op while
reporting a plausible verdict, a run can appear reviewed when it was not — and
the failure looks like a *finding*, which is the most misleading possible shape.

**The codebase already knows this failure mode exists.** `buildCursorArgs` in
`src/verifier.js:35-38` carries a comment saying that without `--trust` the agent
*"exits 1 with no output and every review defaults to fail-safe ISSUES."* Same
end state, different cause — so this is a known class, not a one-off.

**Suggested fixes, in priority order:**
1. **Distinguish "no review happened" from "the review found issues."** A verdict
   with `source: plan` and empty findings text is the former and should be
   reported as `UNVERIFIED` / `REVIEW_DID_NOT_RUN`, never as `ISSUES`. Fail-safe
   is right; fail-safe *disguised as a finding* is not.
2. **Assert the seat can actually run** before the executor spends tokens — a
   cheap liveness probe of the verifier binary at run start would have turned
   four failed attempts into one clear error.
3. **Document how to invoke the seats standalone**, or state that it is
   unsupported. Verify-only review of an existing commit is an obviously useful
   mode (waves that time out with the gate unrun leave exactly this need) and
   there is currently no way to do it.


**Addendum after a fifth attempt.** With the Cursor binary on PATH, one of four
passes returned `source: result` (a genuinely parsed verdict) while the other
three stayed `source: plan` (fail-safe). Same script, same inputs, same
invocation — so the seat IS reachable and the behaviour is INTERMITTENT rather
than a hard configuration failure. In every case `r.text` was empty, so even the
real verdict arrived without reasoning.

Two consequences for anyone relying on these seats:
1. An intermittently-reachable verifier that fail-safes to ISSUES is worse than
   one that never runs, because some runs look reviewed and some do not, and the
   report gives no way to tell them apart.
2. `runVerifier` returning a verdict with empty findings should itself be
   treated as a failure by the caller. The harness's own comment says a verdict
   without reasoning is not actionable; it should refuse to report one.
