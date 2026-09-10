# Sizing goals and task units by outcome

Uroboros keeps one decomposition spine: a project becomes dependency-ordered goals, and each
goal becomes loop-ready task units. “Epic” is a useful way to think about the current **goal**:
a coherent capability that leaves the project usable when accepted. “Story” maps to the current
**task unit**: an outcome that can be implemented, tested, and reviewed independently. Checklist
steps belong inside that task. These terms do not add another JSON shape, queue level, or required
planning ceremony.

The useful boundary is an outcome, not an estimate. File count, elapsed hours, story points,
lines, tokens, or a preferred number of tasks cannot determine the ideal cut. A task may cross
several files when they jointly deliver one behavior. Conversely, several changes in one file may
belong to different tasks when each produces a separately approvable result. Sizing remains a
reasoned proposal by Claude and an independent review by Codex; it is not guaranteed to find a
perfect decomposition.

## Questions for the planning conversation

Use questions such as these to explain and challenge a proposed boundary:

- Can this outcome be demonstrated and approved without a later task?
- Which tests or other evidence show that its behavior works, including important failure paths?
- Which uncertainty should receive early feedback because its answer could change later work?
- Which changes must remain atomic so the project is not left with incompatible contracts or data?
- Which requirement has no responsible task, and which proposed work has no supporting requirement?
- Which dependencies, source anchors, decisions, and project context must travel with the task?

These are conversation prompts, not mandatory rounds or a new sizing pass/fail rubric. Evidence
commands in `gate.json` record what happened for the seats to interpret rather than producing a
size score or proving that a decomposition is ideal. Current required checks must still be complete,
fresh, and successful before execution approval; the reviewer judges what that evidence establishes.
Reviewers may inspect additional authorized context rather than relying only on the proposer’s
evidence selection.

## Example: importing a finance statement

Suppose authentication and basic CSV parsing already exist. One reasonable goal is “an authorized
user can safely import a statement.” Its task units could be:

1. **Upload and validation preview.** Accept an authenticated upload and show parsed rows plus
   actionable format errors. Tests cover authorization, a valid preview, malformed headers, and
   rejected rows.
2. **Column mapping and revalidated preview.** Let the user map source columns, then rerun validation
   against the mapped data. Tests cover saved mappings, required-field gaps, type conversion, and
   the revised preview. This depends on the upload-preview outcome.
3. **Duplicate-safe import.** Persist the reviewed rows without importing the same transaction
   twice. Tests cover successful persistence, idempotent retry, duplicate reporting, and atomic
   failure behavior.

That is an illustration, not a fixed three-task rule. Do not replace these outcomes with
file-shaped work such as “create controller” or “edit database module,” and do not add forecasting
placeholders that deliver no current behavior. If a database migration and its API contract would
leave either side unusable alone, keep them in one outcome and express migration, API, rollback,
and test work as checklist steps. A different codebase or risk profile may justify a different cut.

## Replan from evidence, without erasing completed work

Execution can disprove a planning assumption—for example, sample CSVs may reveal that transaction
identity is not stable across banks. Record the new evidence and its consequence, then revise only
the affected remaining work. Preserve completed code, checks, evidence, decisions, and attributed
history. Claude authors the retained-work replan and Codex reviews the changed plan; after Codex
implements, Claude reviews execution. In autonomous mode the current phase reviewer has final
authority. In manual mode, unresolved disputes go to the human. A changed artifact or context needs
current phase-appropriate approval; old approval is not silently carried forward.

Landing every task does not by itself prove that the whole goal is achieved. Task review approves
that unit’s current outcome. Aggregate goal acceptance separately inspects the goal specification,
the landed work, and its history to decide whether the coherent capability now exists.

For example, the following command uses a **sample, illustrative path**; substitute a real goal
specification and target:

```text
node bin/loop.js decompose --goal goals/G1-statement-import/spec.md --target .
```

This produces task pairs such as `tasks/T1-plan.md` and `tasks/T1-gate.json`, plus
`tasks/queue.json`, beneath the goal directory.

## Bundled adaptations and upstream references

Uroboros now bundles bounded BMAD and Spec Kit adaptations through its native workflow
binding. Read the [workflow profiles guide](workflow-profiles.md) for applicable sections,
pins, evidence limits, historical behavior and notices. The original projects remain
references; their toolkits and controllers are not installed. OpenSpec remains a reference only:

- [BMAD-METHOD epic design](https://github.com/bmad-code-org/BMAD-METHOD/blob/abe4eb1bce919c9d22cd18b3519353d5824c4b75/skills/bmad-create-epics-and-stories/steps/step-02-design-epics.md)
  emphasizes user outcomes and useful feedback or risk boundaries.
- [GitHub Spec Kit’s task template](https://github.com/github/spec-kit/blob/0c8e31ff0a98c362696c2edb6a1bb25a37f68544/templates/tasks-template.md)
  asks for independently testable stories and explicit dependency ordering.
- [OpenSpec’s spec-driven schema](https://github.com/Fission-AI/OpenSpec/blob/e062b9572be933564ba3899d059377dfa1393e32/schemas/spec-driven/schema.yaml)
  separates observable requirements from implementation detail and asks tasks to name completion
  evidence.

Uroboros borrows those questions while retaining its own artifacts, two-seat authority, and
evidence-led conversation.
