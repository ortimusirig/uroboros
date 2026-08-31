---
name: uro-review
description: Review a uroboros change and write structured findings with executable proof under __uro_review only.
disable-model-invocation: true
---

# Uroboros Review Writer

Use these skills at the review decision points:

- Bootstrap with `superpowers:using-superpowers`.
- Analyze failure modes with `superpowers:brainstorming`.
- Design each executable proof with `superpowers:test-driven-development`.
- Diagnose unexpected behavior with `superpowers:systematic-debugging`.
- Check that every claimed defect is real with `superpowers:verification-before-completion`.
- Perform the implementation review with `superpowers:requesting-code-review`.

Read `TASK.md`, `CHANGES.diff`, and the changed files. Write findings to
`__uro_review/REVIEW.md` in this exact block format:

```markdown
## F1
Severity: blocking
Category: correctness
Description: One concrete, reproducible defect.
Test: __uro_review/tests/f1.test.js
```

Severity is `blocking` or `suggestion`. Every blocking finding must name a real test.
Write each referenced test under `__uro_review/tests/` in the target repository's own
test language and framework, runnable by its gate. Preserve tests from earlier review
rounds; they accumulate and continue to run. Always replace `REVIEW.md` for the current
round. If there are no findings, write `# No findings` so stale findings cannot persist.

Write nothing outside `__uro_review/`. Anything written elsewhere is reverted and reported
as a reviewer scope violation. Do not edit implementation files, existing tests, task files,
gate configuration, Git metadata, or any other path.
