# Superpowers in all three seats, verified, and required

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

Implements **§Superpowers Skill Integration → Skill installation per actor** from
`docs/superpowers/specs/2026-08-25-three-way-debate-loop-design.md`, correctly
this time, and promotes it from an optional convenience to a **required
prerequisite**.

**Explicitly NOT implemented here:** the arbiter, the capability veto, Cursor's
scoped write, STORM planning, the FRESH pivot, and the verifier deadline. Each
has its own plan.

## Context — what shipped is wrong

> **Superseded in part.** The table below was written before the seats were
> measured on 2026-08-30. Read **"Measured 2026-08-30"** at the end of this plan
> first; where the two disagree, the measured section wins.

An earlier change claimed to wire superpowers into every seat. Measured
afterwards, **it reaches one seat of three**, and `doctor` reports `PASS`.

| Seat | Reality | Evidence |
|---|---|---|
| **Claude** | ✅ working | skills invoked and returned content |
| **Codex** | ❌ **not installed** | `codex plugin list` → `superpowers@openai-curated  not installed` |
| **Cursor** | ❌ **cannot load it** | the directory holds `.codex-plugin`; Cursor requires `.cursor-plugin` |

Three separate errors, one cause: **a resolved directory path was treated as
proof of availability.**

- Codex was passed `--plugin-dir`, **a flag it does not have** — it exited 2 and
  every run failed until that was reverted. Codex discovers plugins from its own
  registry; a cache directory on disk is not a registered plugin.
- Cursor was passed that same directory. Cursor **does not error** — it silently
  ignores a directory with no `.cursor-plugin` manifest. No exit code, no warning.
- `doctor` reported `PASS` for all of it, because it checked that a folder
  existed.

The executor itself stated the correct mechanism when asked, unprompted:

> *"There is no `codex exec --plugin-dir` flag… register through the plugin
> marketplace, then launch with the same `CODEX_HOME`. If 'installed on disk'
> only means a standalone directory exists, it must first be registered; **its
> mere presence is insufficient.**"*

## Required behavior

### 1. Each seat gets superpowers through its own mechanism

There is no shared mechanism. Each CLI has its own plugin system, and the
implementation must use each one correctly.

- **Codex** — registered in Codex's own plugin registry (`codex plugin
  marketplace add`, then `codex plugin add`), with `codex exec` launched under
  the `CODEX_HOME` where that registration lives. **Never a `--plugin-dir`
  flag.**
- **Cursor** — supplied a directory Cursor can actually load: one carrying a
  valid `.cursor-plugin` manifest and the superpowers skills beneath it, or
  registered through `agent plugin marketplace`. Passing a `.codex-plugin`
  directory is the current defect and must not survive.
- **Claude** — already works; verify rather than change it.

Registration is an **install-time** action, not something a run performs.
`setup` may perform it with the operator's consent, following the existing
consent pattern. A run never installs anything.

### 2. `doctor` verifies each seat, by asking the seat

Replace the single presence check with **three per-seat checks**, each
**required**:

| Seat | Verification |
|---|---|
| Codex | `codex plugin list` reports superpowers **installed and enabled** |
| Cursor | the supplied directory carries a valid `.cursor-plugin` manifest and the skills are readable; registration reported where the CLI can report it |
| Claude | the plugin is present and its skill files are readable |

**A check may only pass on evidence of the claim it makes.** A directory
existing is not a plugin loading, and must never render as the same result. Where
only presence can be established, the check must say so rather than reporting a
bare pass.

Each failing check names the exact remediation command for that seat.

### 3. Superpowers becomes required — the loop refuses to run without it

Superpowers moves from `optional` to `required` in `doctor`, and a run refuses to
start when any seat lacks it.

- `run`, `batch`, `plan` and `queue` all check before doing any work, in
  preflight, alongside the existing verifier liveness probe. **Failing costs no
  tokens.**
- The refusal names which seat is missing it and how to fix that seat.
- `URO_REQUIRE_SUPERPOWERS=0` allows an operator to proceed deliberately. It must
  be **explicit**, and a run started under it records that fact in the run facts
  and states it in the report, so a result produced without the skills is never
  mistaken for one produced with them.

This is a deliberate hardening: the loop's behaviour depends on these skills, so
running without them silently produces results shaped by a different system than
the one described.

### 4. Provenance in the facts

Run facts record, per seat: whether superpowers was verified, by what evidence,
and the resolved version. A reader of any run must be able to tell which seats
had the skills and how that was established.

**Record the version per seat.** They can differ — this machine currently holds
`6.0.2` for Claude and `6.3.0` in the Codex cache — and seats reasoning from
different skill versions is a real condition that must be visible, not inferred.

## Invariants

- **Zero runtime dependencies.** Nothing is vendored into this repository and no
  run downloads anything.
- A run never installs or registers a plugin. That is `setup`'s job, with
  consent.
- No seat's launch arguments gain a flag that CLI does not accept — verified
  against the binary, not assumed from a document.
- Existing `doctor` output for unrelated checks is unchanged.
- ESM style matching the rest of the codebase.

## Test requirements

1. Codex's launch arguments **never contain `--plugin-dir`** — the regression
   control for the flag that broke every run.
2. Cursor is supplied a directory carrying a `.cursor-plugin` manifest; a
   `.codex-plugin`-only directory is **rejected**, not passed silently.
3. `doctor` reports Codex verified when the plugin list shows installed and
   enabled, and fails when it shows `not installed`.
4. `doctor` fails Cursor's check for a directory with no `.cursor-plugin`
   manifest — **the exact defect in production today**.
5. Each failing check names a remediation command naming that seat.
6. All three checks are **required**: any one failing sets `ok: false`.
7. `run`, `batch`, `plan` and `queue` refuse to start when a seat is unverified,
   **before invoking any agent** — assert the executor was never called.
8. `URO_REQUIRE_SUPERPOWERS=0` permits the run, records the bypass in the facts,
   and the report states it.
9. Facts record per-seat verification, evidence, and version.
10. Differing versions across seats are recorded distinctly, not collapsed.
11. **Positive control:** with all three verified, `doctor` passes and a run
    starts normally.

Do not delete, skip, or weaken any existing test.

## Out of scope

- Vendoring or downloading superpowers.
- What each seat does with the skills once it has them.
- The arbiter, capability veto, scoped write, STORM, FRESH, or the verifier
  deadline.

---

## Measured 2026-08-30 — corrections to this plan's premise

Every line below was run on this machine before the plan was executed. Where it
contradicts the Context table above, this section is correct.

### Codex is now registered — the check should pass, not fail

`superpowers@openai-curated` was present in a configured marketplace but not
installed. Registering it worked and is the documented remediation:

```
codex plugin add superpowers@openai-curated
  → Added plugin `superpowers` from marketplace `openai-curated`.
codex plugin list | grep superpowers
  → superpowers@openai-curated   installed, enabled   3fdeeb49
```

Codex's check must pass on this evidence. **Do not write a test that assumes
Codex is unregistered** — assert both states from injected `plugin list` output.

### Cursor cannot be installed non-interactively

`agent plugin` exposes only `marketplace`; there is no `install`. The
marketplace was added successfully:

```
agent plugin marketplace add https://github.com/obra/superpowers-marketplace.git
  → ✓ Added marketplace superpowers-marketplace (10 plugins)
  → Tip: use /plugins in interactive mode to install plugins
```

Interactive-only installation is unusable from a harness. **Cursor's supported
route is therefore `--plugin-dir` at a directory carrying `.cursor-plugin`** —
the flag Cursor genuinely has, and which `src/verifier.js:58,61` already passes.

### The actual defect: resolution picks a Codex-only directory

`resolveSuperpowersDir` sorts every candidate by version and returns the highest,
irrespective of which seat will consume it. Run today:

```
resolved: C:\Users\aiuser4\.codex\plugins\cache\openai-curated-remote\superpowers\6.3.0
   .claude-plugin ABSENT
   .codex-plugin  PRESENT
   .cursor-plugin ABSENT
```

That directory is handed to Cursor via `--plugin-dir`, and Cursor silently
ignores it — no exit code, no warning. Meanwhile:

```
C:\Users\aiuser4\.claude\plugins\cache\superpowers-marketplace\superpowers\6.0.2
   .claude-plugin .codex-plugin .cursor-plugin .kimi-plugin   (all four)
```

**The lower-versioned directory is the only one Cursor can load.** Picking the
highest version globally is what breaks the seat. The bug is not a missing
manifest check bolted onto the current resolver; it is that resolution is
seat-blind.

### Required behavior, corrected

- **Resolution is per seat, keyed on the manifest that seat requires.** Cursor
  resolves only among directories carrying `.cursor-plugin`; Claude only among
  those carrying `.claude-plugin`. Highest version *within the eligible set*,
  never highest version overall.
- **Codex resolves no directory at all.** It loads from its own registry under
  `CODEX_HOME`. Codex's launch arguments must remain free of any plugin flag —
  requirement 1 already covers this and is the regression control for the flag
  that broke every run.
- If no eligible directory exists for a seat, that is a **failed check naming
  that seat**, never a silent fallback to an ineligible directory. Passing a
  directory the seat cannot load is the defect being fixed; it must not survive
  as a fallback.
- Seats legitimately end up on different versions — Cursor on 6.0.2, Codex on
  its registry copy. Record each seat's version separately, as §4 already
  requires. This is now a measured condition, not a hypothetical.

### Additional test requirements

12. Given one directory with only `.codex-plugin` at a **higher** version and one
    with `.cursor-plugin` at a **lower** version, Cursor resolves the lower one.
    This is the exact production state measured above and the control that fails
    against the current seat-blind resolver.
13. With no `.cursor-plugin` directory available anywhere, Cursor's check fails
    and names Cursor. It must not fall back to a `.codex-plugin` directory.
14. Codex's verification passes on `plugin list` output showing
    `installed, enabled`, and fails on `not installed` — both from injected
    output, with no real CLI invoked.
