# Wire superpowers into every seat

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

## Source design

Implements **§Superpowers Skill Integration** and its "Skill installation per
actor" subsection from
`docs/superpowers/specs/2026-08-25-three-way-debate-loop-design.md`.

**Explicitly NOT implemented here** (each needs its own plan):

- §Cursor's scoped write — the reviewer writing test files under `__uro_review/`
- `cursor-plugin/skills/uro-review/SKILL.md` — the review-and-test-writing skill
- A Claude seat inside the loop, and finding validation with real judgement
- §Circling "no round cap", and the FRESH pivot re-branching from a pre-debate
  snapshot

## Title

Declare and deliver superpowers to Codex, Cursor and Claude, and make its
absence loud

## Context — the defect

The spec devotes a section to superpowers, mapping fourteen skills across three
actors and specifying an installation route for each. **The repository contains
zero references to superpowers in any executable file.** Every match is a path
under `docs/`, which is merely where design documents happen to live.

Concretely today:

- `buildCodexArgs` passes `mcp_servers={}` and no plugin path at all.
- `buildCursorArgs` passes `--plugin-dir cursor-plugin`, and that directory
  contains exactly one file: `skills/uro-verify/SKILL.md`. No superpowers.
- `skills/uroboros/SKILL.md` carries no debate protocol and no skill guidance.
- `doctor` never checks for superpowers.

**Worse than absent: it is silently present here.** On this machine Codex loads
superpowers from the operator's own global config
(`~/.codex/plugins/cache/.../superpowers/<version>/`). So the executor has been
receiving skills the tool does not know it is using, results are shaped by an
undeclared dependency, and a clean install would behave differently with nothing
reporting why.

An undeclared, invisible dependency is a worse failure than a missing one.

## Decision taken

Superpowers is **resolved from an installed location, not vendored** into this
repository. Vendoring would copy another project's plugin into a repository whose
defining property is zero dependencies, and would fork its version. Resolving
keeps it single-sourced.

The cost of resolving is that it can be absent — so absence must be **loud**,
which is what the `doctor` check below is for.

## Required behavior

### 1. Resolution

Add `src/superpowers.js` exporting `resolveSuperpowersDir({ env, home })`:

- Returns an absolute path to an installed superpowers plugin directory, or
  `null` when none is found.
- Honours `URO_SUPERPOWERS_DIR` first, read through `readEnv` so it behaves like
  every other setting.
- Otherwise searches the known install locations for the Claude and Codex plugin
  caches under the user's home directory, choosing the **highest version** when
  several are present.
- A configured `URO_SUPERPOWERS_DIR` that does not exist is an **error**, not a
  silent fallback. Asking for a specific directory and getting a different one is
  the failure this whole task exists to prevent.
- Pure and injectable: it takes `env` and `home`, touches nothing else, and never
  spawns.

### 2. Codex receives it

`buildCodexArgs` gains the superpowers plugin path when one resolves.

- Absent superpowers, the arguments are exactly as today — no empty flag, no
  placeholder.
- The resolved path is recorded in the run facts under `skills`, so a reader can
  tell which skills a run actually had.
- Do not change `mcp_servers={}`, the sandbox flag, or the model and effort
  flags.

### 3. Cursor receives it

`buildCursorArgs` already passes `--plugin-dir`. Extend the verifier so the
resolved superpowers directory is supplied alongside the existing
`cursor-plugin` directory rather than replacing it.

- `assertNoForbiddenFlags` must still run over the final argument list.
- `--mode plan` and `--trust` are unchanged. This task grants no write
  capability.

### 4. `uro-verify` names the skills it uses

`cursor-plugin/skills/uro-verify/SKILL.md` gains a short section naming, by
exact skill name, the skills the reviewer seat uses at its decision points, per
the spec's table:

| Decision point | Skill |
|---|---|
| Before review: failure-mode analysis | `superpowers:brainstorming` |
| Diagnosing persistent findings | `superpowers:systematic-debugging` |
| Verifying findings are real, not false positives | `superpowers:verification-before-completion` |
| Reviewing the executor's code | `superpowers:requesting-code-review` |
| Bootstrap | `superpowers:using-superpowers` |

Name them exactly. A misspelt skill name is a silent no-op.

### 5. `skills/uroboros/SKILL.md` carries the protocol

Extend it with a debate-protocol section covering, for Claude:

| Decision point | Skill |
|---|---|
| Before fix plans, pivots, validation | `superpowers:brainstorming` |
| Writing FIX_PLAN.md, pivot plans, reframed approaches | `superpowers:writing-plans` |
| Executing the debate protocol | `superpowers:executing-plans` |
| Validating test designs | `superpowers:test-driven-development` |
| Diagnosing why the loop is stuck | `superpowers:systematic-debugging` |
| Verifying convergence is genuine | `superpowers:verification-before-completion` |
| Reading reviews to validate | `superpowers:receiving-code-review` |
| Requesting Cursor re-review after fixes | `superpowers:requesting-code-review` |

It must also state the rule that was missed in practice: **a plan written for
this loop must run `superpowers:writing-plans`' spec-coverage self-review, name
the design document it implements, and enumerate the sections it does not.**

### 6. `doctor` makes absence loud

Add an **optional** check reporting whether superpowers resolved and from where.

- Optional, not required: the loop runs without it, so it must not turn a
  healthy install unhealthy.
- Reports the resolved path when found, and names `URO_SUPERPOWERS_DIR` in its
  remediation when not.
- Follows the existing check shape in `doctor-checks.js`; do not restructure that
  file.

## Invariants

- **Zero runtime dependencies.** Superpowers is resolved from disk at launch
  time, never installed, downloaded, or vendored.
- Absent superpowers, every seat launches exactly as it does today.
- No new required `doctor` check. A machine without superpowers stays healthy.
- No seat gains write capability in this task.
- `assertNoForbiddenFlags` still guards the verifier's arguments.
- ESM style matching the rest of the codebase.

## Test requirements

1. `resolveSuperpowersDir` honours `URO_SUPERPOWERS_DIR` when the directory
   exists.
2. A configured `URO_SUPERPOWERS_DIR` that does not exist **throws**, naming the
   variable and the path.
3. With no configuration and no install location present, it returns `null`.
4. Given several installed versions, it selects the highest.
5. `buildCodexArgs` includes the plugin path when one resolves.
6. **Positive control:** `buildCodexArgs` with no superpowers produces arguments
   byte-identical to today's — proving the flag is added, not always present.
7. The verifier's arguments carry both `cursor-plugin` and the resolved
   superpowers directory, and still pass `assertNoForbiddenFlags`.
8. `uro-verify/SKILL.md` names each of its five skills exactly, as whole tokens.
9. `skills/uroboros/SKILL.md` names each of Claude's eight skills exactly, and
   states the spec-coverage self-review rule.
10. The `doctor` check reports the path when resolved, and remediation naming
    `URO_SUPERPOWERS_DIR` when not — and leaves `ok: true` in both cases.
11. Run facts record the resolved skills path, or null.

Do not delete, skip, or weaken any existing test.

## Out of scope

- Installing, downloading, or vendoring superpowers.
- Cursor's scoped write and the `uro-review` skill.
- A Claude seat, or finding validation with judgement.
- Changing what any seat does with the skills once it has them.
