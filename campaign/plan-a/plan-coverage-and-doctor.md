# Restore lost coverage, and lead `doctor` with its verdict

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

Restore the TASK.md-layout coverage dropped with the Detail view, and print the
health verdict before the detail in `doctor`

Two small, unrelated changes in one pass. Neither touches the other's files.

---

## Part 1 — restore the lost coverage

### Problem

When the Triage and Detail views were deleted in favour of the single
transcript, the test

```
run titles are read from either TASK.md layout and rendered above the short pass id
```

was deleted with them. It should not have been. It covered `readTaskTitle` and
`readTaskBody`, which **still exist and are still called** in
`src/dashboard-view.js` (`digestRunDirectory`), for both supported layouts:

- a nested worktree layout, `<runDir>/w/TASK.md`
- a run-root layout, `<runDir>/TASK.md`

That behaviour is now uncovered. The intent verifier seat reported it; it was
confirmed by hand before the transcript change was committed.

### Required behavior

No production change. Restore equivalent coverage in the current test suite,
against the surviving API rather than the deleted view.

- Assert a run digest picks up the title from **`<runDir>/w/TASK.md`**.
- Assert a run digest picks up the title from **`<runDir>/TASK.md`** when there
  is no nested `w/` copy.
- Assert the task **body** is read for the same two layouts, since
  `readTaskBody` feeds the inspector's plan tab.
- Assert a run directory with **no** `TASK.md` in either location degrades
  honestly — no throw, and no invented title.

Place these where they belong for the current structure — with the other
snapshot/digest tests — not in a resurrected Detail-view test file.

---

## Part 2 — `doctor` leads with its verdict

### Problem

`src/doctor.js` builds its output as: header, required checks, optional
features, then the health verdict last. A reader meets a column of `FAIL` lines
for absent optional tools — GitHub CLI, gitleaks, trufflehog, logdy — and only
after all of them learns that loop health is `HEALTHY` and that none of those
affect it.

This is first contact with the tool, and it reads as a broken install.

### Required behavior

Emit the health verdict **immediately after the `uroboros doctor` header**, then
the existing detail, then keep the existing trailing verdict block unchanged.

- The leading line states the same verdict as the trailing block. They can never
  disagree: derive both from the same value, do not compute it twice.
- The verdict depends only on **required** checks, exactly as today.
- Because the verdict is only known after the checks run, buffer the detail and
  assemble the final output with the verdict spliced in ahead of it. Do not
  reorder or re-run any check to achieve this.
- The trailing verdict, the `Deep readiness` line, and the closing note about
  GitHub and Logdy being optional all stay exactly as they are, so anything
  parsing the tail keeps working.

### Non-goal

**Do not change any status token.** Optional checks continue to report `FAIL`
when absent. Renaming those to `SKIP` was considered and **rejected by the
operator**: it changes output that scripts or CI may parse, and leading with the
verdict already solves the first-impression problem on its own.

---

## Invariants

- `runDoctor`'s return shape is unchanged: `{ ok, output }`, with `ok` still
  driven solely by required checks.
- `--fix` and `--deep` behaviour unchanged.
- No change to `doctor-checks.js`.
- Part 1 adds no production code at all.
- Zero external dependencies. ESM style matching the rest of the codebase.

## Test requirements

1. Digest reads the title from `<runDir>/w/TASK.md`.
2. Digest reads the title from `<runDir>/TASK.md` with no nested copy.
3. Task body is read for both layouts.
4. A run directory with no `TASK.md` anywhere does not throw and invents no title.
5. `doctor` output contains the health verdict within its first three lines.
6. The leading and trailing verdicts agree — assert on a healthy run **and** on
   one with a failing required check.
7. A failing required check still yields `ok: false`; a missing optional tool
   still yields `ok: true`.
8. **Positive control:** an absent optional tool still renders `FAIL`, proving
   the token was not quietly changed.

Do not delete, skip, or weaken any existing test.

## Out of scope

- Any change to the transcript UI or the dashboard modules beyond restoring test
  coverage.
- Renaming or regrouping doctor's status tokens.
- Durable run artifacts, arbitration, or the debate loop.
