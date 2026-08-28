# Stop silently ignoring a recognised timeout variable

## IMPLEMENT THIS NOW

This design is **APPROVED**. Do not stop to ask for design approval, do not
propose an alternative and wait — write the code, add the tests, run the gate.
Producing no diff is a failed pass.

If you genuinely cannot proceed without a decision from the operator, write
`DECISION.md` in the worktree root using this exact shape and stop:

```
## Q1
Kind: technical | product | authority
Question: <one line>
Options: <one line>
Recommendation: <one line>
```

## Title

Warn on an unprefixed environment variable, and add CLI flags for stage timeouts

## Context — the defect

`src/env-compat.js` reads only `URO_<SUFFIX>` and the deprecated `CCC_<SUFFIX>`:

```js
export function readEnv(env, suffix, { warn = console.warn } = {}) {
  const current = env?.[`URO_${suffix}`];
  if (current !== undefined) return current;
  if (!ALIASED.has(suffix)) return undefined;    // ← a bare name falls off here
  ...
```

A bare `EXECUTOR_TIMEOUT_MS` — the name a person would guess, and the name that
survives a copy-paste out of shell history — returns `undefined` with **no
warning of any kind**. `src/timeouts.js` then silently applies
`DEFAULT_EXECUTOR_TIMEOUT_MS` (30 minutes).

`ALIASED` is an explicit list of the nine variables a user is *meant* to set.
The code knows the name is meaningful and ignores it anyway.

Observed consequence: a wave was killed at exactly 30 minutes **twice** before
anyone diagnosed it, each time discarding all partial work, by an operator who
believed they had raised the timeout. Two lost runs read as "the tool is slow"
when the setting was never applied.

Compounding it, `src/args.js` declares **no timeout flags at all**. Environment
variables are the only control surface for stage timeouts, and that surface
fails silently. There is no second path that would have saved the operator.

## Required behavior

### 1. Warn on a recognised-but-unprefixed name

In `readEnv`, before returning `undefined`, warn **once per suffix** when the
unprefixed name is present in the environment:

```
EXECUTOR_TIMEOUT_MS is set but ignored — did you mean URO_EXECUTOR_TIMEOUT_MS?
```

- Applies to **every** suffix in `ALIASED`, not only the timeouts.
- Warn at most once per suffix per process, using the existing `warned` Set.
- `resetDeprecationWarnings()` must clear these warnings too.
- Warn only when the value would otherwise be ignored. If `URO_<SUFFIX>` is set,
  return it and warn nothing, even if the bare name is also set.
- Route through the injected `warn` option exactly as the existing deprecation
  warning does, so tests never write to the real console.
- **This is a warning, not a fallback.** The unprefixed value is still ignored
  and the fallback still applies. Silently honouring both names would entrench
  the ambiguity this warning exists to surface.

### 2. CLI flags for stage timeouts

Add to the `run` and `batch` commands in `src/args.js`:

- `--executor-timeout <ms>`
- `--verifier-timeout <ms>`
- `--gate-timeout <ms>`

Each takes a positive integer number of milliseconds.

- Validate with the **same rules and the same error messages shape** that
  `src/timeouts.js` already applies to the environment variables: a positive
  safe integer between 1 and 2147483647. Do not duplicate the validation logic —
  reuse it, or factor it so both paths share one implementation.
- Precedence: **flag beats environment variable beats default.**
- Thread the resolved values into `run` so they reach `resolveStageTimeouts`'s
  consumers. `run.js` currently calls `resolveStageTimeouts()` with no argument;
  give it a way to accept explicit overrides rather than reading `process.env`
  unconditionally.
- Update the usage text in `src/cli-help.js` so the new flags are discoverable.
- Omitting a flag must leave today's behaviour exactly unchanged.

## Invariants

- Do not change `DEFAULT_EXECUTOR_TIMEOUT_MS`, `DEFAULT_VERIFIER_TIMEOUT_MS`, or
  `DEFAULT_GATE_TIMEOUT_MS`. The 30-minute default is not the defect.
- Do not add the unprefixed names to `ALIASED` or otherwise start honouring them.
- Do not change the existing `CCC_` deprecation warning's text or behaviour.
- Zero external dependencies. ESM style matching the rest of the codebase.
- Existing callers of `resolveStageTimeouts()` with no argument must keep working.

## Test requirements

In `test/env-compat.test.js`:

1. A bare `EXECUTOR_TIMEOUT_MS` with no `URO_`/`CCC_` name warns once, mentions
   both the bare and the `URO_` name, and still returns `undefined`.
2. Reading the same suffix twice warns only once.
3. `resetDeprecationWarnings()` re-arms the warning.
4. `URO_` set alongside the bare name returns the `URO_` value and warns nothing.
5. **Positive control:** a bare name that is *not* in `ALIASED` (for example
   `TEST_SCRATCH_ROOT`) warns nothing and returns `undefined`. Without this the
   first assertion could pass because every unknown name warns.

In `test/args.test.js` and `test/timeouts.test.js`:

6. Each new flag parses and reaches the resolved timeouts.
7. A flag overrides the corresponding environment variable.
8. An environment variable still applies when the flag is absent.
9. An invalid flag value (`0`, negative, non-numeric, above the maximum) is
   rejected with a clear error, matching the environment-variable rules.
10. With no flag and no environment variable, the documented default is returned.

Do not delete, skip, or weaken any existing test.

## Out of scope

- Changing any default timeout value.
- The evidence-based deadline, liveness/progress split, partial-work
  preservation, or the hard ceiling. Those are a separate task; this one only
  makes the existing timeout controllable and honest.
- Warning about unknown `URO_`-prefixed names that are not in `ALIASED`.
- `doctor` or `setup` reporting on environment variables.
