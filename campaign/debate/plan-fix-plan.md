# Implement src/fix-plan.js — Fix Plan Generator

## Title
FIX_PLAN.md generator for the debate loop

## Required behavior

Create `src/fix-plan.js` that exports:

1. **`validateFindings(findings)`** — validate an array of findings from parseReview.
   - A finding is valid if it has a non-empty `description` string
   - Returns `{ accepted: string[], rejected: string[] }` where each array contains finding IDs
   - `null` or empty array input returns `{ accepted: [], rejected: [] }`

2. **`buildFixPlan({ findings, accepted, rejected, originalTask })`** — generate FIX_PLAN.md content.
   - Returns a markdown string with these sections:
     - `## Validated Findings` — list each accepted finding with its id, severity, and description
     - Mark rejected findings as "overruled" or "rejected"
     - `## Cursor's Tests` — list test file paths from accepted findings, include instruction "Do NOT modify or delete files under __uro_review/"
     - Include the originalTask string for context
   - Returns empty string `''` when `accepted` is empty (nothing to fix)

## Invariants

- Do NOT modify the test file `test/fix-plan.test.js`
- Pure functions, zero external dependencies
- ESM module style matching the rest of the codebase

## Out of scope

- REVIEW.md parsing (that's in review.js)
- Debate loop logic (that's in debate.js)
- Any changes to existing files
