---
description: Continue a saved human decision or eligible technical pause; saved mode and limits cannot change.
disable-model-invocation: true
---

Act as the controller. First read and obey `${CLAUDE_PLUGIN_ROOT}/skills/uroboros/SKILL.md`,
especially its recovery guidance. Preserve the saved phase, workspace, mode, limits, identities,
and any human answers. Do not author replacement implementation, invent answers, restart the
original task, or replay an uncertain effect. Inspect `$ARGUMENTS` for exactly one supported route:
`--run <run-directory> --decision-file <answers.json>` for authenticated human questions, or
`--run <run-directory> --continue` for an eligible saved technical pause with no human question.
The routes are mutually exclusive. `--continue` is reconciliation of validated current state,
not approval, a human answer, a mode/limit override, generic “continue anyway,” or retry authority.
The answer file belongs outside both the whole target repository/source tree and the execution
workspace; a durable artifact directory is suitable only if outside both. Ask for missing human
answers rather than treating unresolved questions as approval. Report placement
errors without excluding arbitrary source files. Follow the saved pivot's exact choices:
`stop` makes no further model call or landing; `fresh plan` requires a reviewed replacement
plan over preserved current work in either mode, not a reset. Resume any further planning question from its
new checkpoint rather than redrafting or repeating execution.

Run the real CLI from the user's current working directory:

`node "${CLAUDE_PLUGIN_ROOT}/bin/loop.js" resume $ARGUMENTS`

Run it directly, never through a pipe. The process's true exit code is the result; stdout text
is not success or failure, and an exit code obtained through a pipe is never acceptable. Report
the command's true exit code and its relevant stdout and stderr to the user. Report stale,
missing-workspace or interrupted-state errors; never replace the saved workspace to bypass them.
