# G1: The repo map serves large trees honestly and within budget

## Capability

`loop decompose` on a large repository (around 1,700 files) builds its repo map without reading every file in the tree end-to-end, without counting "lines" in binary files, and with every bound it applies declared in the rendered map itself — so the seats planning against the map always know what was measured, what was shortened, and what was skipped.

## Why now (evidence)

The whole-branch review of the decomposition spine (commits 415a33a..ac0614b) left these confirmed findings open, bundled as the T-repo-map ticket:

1. `buildRepoMap` in `src/repo-map.js` reads every file in the tree up front even when the budget can fit almost none of them — wasteful on large trees, which are the exact case decompose exists for.
2. Line counts are taken from binary files too, producing meaningless numbers in the map.
3. A non-finite `budget` (NaN or Infinity) is not guarded; it should be refused loudly, not silently tolerated.
4. `symbolsSkipped` self-description can misreport after the fallback ladder collapses detail.
5. The CLI `--map-budget` validation is not aligned with `MINIMUM_MAP_BUDGET` — the flag accepts values the builder cannot honour.

## Required behavior

- On a large tree the map builder bounds how much work it does, and the bound is never hidden: the rendered map declares what was skipped or shortened, in the same self-declaring style the existing fallback ladder already uses (grade and omission markers).
- Binary files are detected and never line-counted; the map states how they were treated.
- A budget that is not a finite number is refused with a clear message naming what was received.
- `symbolsSkipped` (and every similar self-description) is accurate on every return path.
- `--map-budget` at the CLI refuses values below `MINIMUM_MAP_BUDGET` with a message naming the floor, so the flag and the builder agree.

## Constraints

- Everything in `constitution.md` applies, especially rule 3: any new bound joins the audit table or does not ship.
- The existing repo-map tests in `test/repo-map.test.js`, including the budget sweep, must keep passing with 0 violations; new behavior gets its own tests in the same file's style.
- Feedback over refusal: where an input can be repaired by the caller (a fixable budget string, for example), the message must say how.

## Acceptance

The goal is achieved when `loop queue --accept-goal` judges the aggregate diff and finds all five findings closed, the map still self-declaring on every path, and the audit table updated for any bound that changed or was added.
