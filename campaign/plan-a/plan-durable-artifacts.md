# Keep the record, and stop the scratch tree growing forever

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

Copy each run's record to a durable directory outside the worktree, and prune
old run directories

## Context — measured, not assumed

Every run produces five files that are the whole record of what happened:

| File | Typical size | What it is |
|---|---|---|
| `events.jsonl` | ~300 KB | every stage and timestamp — **the only timing source** |
| `CHANGES.diff` | ~44 KB | the code change |
| `uro-runfacts.json` | ~31 KB | outcome, verdicts, token usage |
| `uro-report.md` | ~6 KB | reviewer text |
| `TASK.md` | ~6 KB | what was asked |

About **390 KB of signal per run**. All of it is written *inside* the disposable
worktree at `<scratchRoot>/<runId>/w/`, which is a **full checkout of the target
repository**.

On this machine that scratch root now holds **177 run directories**, and `du -sh`
over it **did not finish within five minutes**. Nothing prunes them:
`isolation.js` builds a `cleanup()` closure on both isolation paths, but no code
in `src/` or `bin/` ever calls it — only `test/isolation.test.js` does.

Two consequences:

1. **The record is not durable.** It survives only as long as a scratch tree the
   tool does not own. Answering "how long did that run take?" already requires
   locating a worktree by hand and parsing its `events.jsonl`.
2. **The scratch tree grows without bound.** 390 KB of signal is buried inside
   gigabytes of repeated checkouts.

## Required behavior

### 1. Copy the record somewhere durable

After `writeReport` completes in `run.js`, copy the harness artifacts to a
per-run directory outside the disposable worktree:

```
<artifactRoot>/<runId>/
  TASK.md
  events.jsonl
  uro-report.md
  uro-runfacts.json
  CHANGES.diff        (when a diff was produced)
  DECISION.md         (when the run ended needs-decision)
```

- `artifactRoot` defaults to `<scratchRoot>/artifacts`, overridable by
  `URO_ARTIFACT_ROOT` and `--artifact-root`.
- The file list derives from `HARNESS_ARTIFACTS` in `src/artifacts.js`, already
  the single source of truth. **Do not introduce a second list.**
- Copying is **best-effort and non-fatal**. A failed copy is recorded in the
  facts and never changes `outcome`, `gateStatus`, the verdict, or the exit code.
  Same principle as `reportEvent`: the record is disposable, the run is not.
- A missing source file is skipped silently; it is not an error.

### 2. An index, so the record is discoverable

Maintain `<artifactRoot>/index.jsonl`, one line appended per completed run:
`runId`, ISO start and end timestamps, `durationMs`, `outcome`, `gateStatus`,
both verifier verdicts, and total input/output tokens.

Appending is best-effort and non-fatal on the same terms. This is what makes
"how long did that take?" answerable without opening any worktree.

### 3. Prune the scratch tree

Add a `loop prune` command that removes old run directories under the scratch
root.

- `--keep <n>` retains the **n most recent** run directories, default **20**.
- `--older-than <days>` removes directories older than the given age.
- Both may be combined; a directory is removed only if **both** conditions permit
  it, so the more conservative rule wins.
- **`--dry-run` lists what would be removed and deletes nothing.**
- Never removes anything under `artifactRoot` — the durable record is the point
  of the exercise and must outlive the worktrees.
- Refuses to run when the resolved scratch root fails `assertSafeScratchRoot`.
- Reports how many directories were removed and how many were kept.
- Uses `git worktree remove` where the directory is a registered worktree, so
  Git's administrative state stays consistent, falling back to a recursive delete
  as `cleanupWorktree` already does.

Pruning is **an explicit operator command only**. Do not prune automatically at
the end of a run: a run that deletes evidence on its way out is exactly the
failure mode being fixed.

## Invariants

- No run outcome, verdict, gate status or exit code may change because of
  anything in this task.
- The durable copy is a copy. The worktree is not modified and files are not
  moved out of it.
- `HARNESS_ARTIFACTS` stays the single list of harness files.
- `loop prune` never deletes a run directory that is currently in use, and never
  touches the target repository.
- Zero external dependencies. ESM style matching the rest of the codebase.

## Test requirements

1. A completed run leaves every produced artifact under `<artifactRoot>/<runId>/`.
2. A run producing no diff omits `CHANGES.diff` without erroring.
3. An unwritable artifact root does not fail the run and does not change
   `outcome`.
4. The copied `events.jsonl` is byte-identical to the worktree original.
5. `index.jsonl` gains exactly one line per run, carrying `durationMs`, outcome
   and both verdicts.
6. A failed index append does not change the run outcome.
7. `prune --keep 2` over five run directories removes three and keeps the two
   newest.
8. `prune --dry-run` removes nothing and lists what it would remove.
9. `prune` never removes anything under `artifactRoot` — assert the durable copy
   survives a prune that deletes its worktree.
10. `prune` refuses an unsafe scratch root.
11. **Positive control:** a run with `URO_ARTIFACT_ROOT` unset still writes to
    the default location, proving the default path is exercised.

Do not delete, skip, or weaken any existing test.

## Out of scope

- Automatic pruning at the end of a run.
- Compressing or deduplicating worktrees.
- Any change to the dashboard, the debate loop, or arbitration.
- Uploading or publishing artifacts anywhere.
