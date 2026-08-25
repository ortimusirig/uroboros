# Implement src/review.js — REVIEW.md Parser

## Title
REVIEW.md file protocol parser for the debate loop

## Required behavior

Create `src/review.js` that mirrors the existing `src/decision.js` pattern. It must export:

1. **`parseReview(content)`** — parse a REVIEW.md string into structured findings.
   - Headings: `## F1`, `## F2`, etc. (regex: `/^\s*##\s+(F\d+)\s*$/i`)
   - Fields per block: `Severity`, `Category`, `Description`, `Test` (parsed from `Key: value` lines)
   - Valid severities: `blocking`, `suggestion` (anything else = invalid, skip the finding)
   - A finding is valid only if it has a recognized severity AND a non-empty description
   - `Category` and `Test` are optional (null if absent)
   - **Demotion rule**: a `blocking` finding with no `Test` field is demoted to `suggestion`
   - Returns an array of finding objects, or `null` if no valid findings

2. **`detectReview({ dir })`** — check for review artifacts in a worktree.
   - Look for `__uro_review/REVIEW.md` under `dir`
   - If it exists and has valid findings, return `{ reviewed: true, findings: [...], testFiles: [...] }`
   - `testFiles` = list of all `.py` files under `__uro_review/tests/` (relative to `dir`)
   - If no review dir or empty/invalid REVIEW.md: `{ reviewed: false }`

3. **`REVIEW_DIR`** — exported constant, the string `'__uro_review'`

## Invariants

- Do NOT modify the test file `test/review.test.js`
- Follow the exact same code style as `src/decision.js` (ESM imports, pure functions, no deps)
- The module must have zero external dependencies

## Out of scope

- Debate loop logic (that's in debate.js)
- Fix plan generation (that's in fix-plan.js)
- Any changes to existing files
