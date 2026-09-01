---
description: Execute one isolated Codex/evidence/Cursor debate with Claude arbitrating read-only.
disable-model-invocation: true
---

Act as the controller for this invocation.

Before doing anything, read and obey `${CLAUDE_PLUGIN_ROOT}/skills/uroboros/SKILL.md`,
especially its governing law. The planner authors the plan. Codex implements it. The planner
never writes the implementation.

A usable plan is mandatory. Inspect `$ARGUMENTS`. If it has no usable `--task`, author a plan
from requirements the user has actually supplied or ask the user for the missing plan. Do not
invent a plan merely to launch the CLI or spend tokens, and do not run until a usable plan exists.

Then run the real CLI from the user's current working directory:

`node "${CLAUDE_PLUGIN_ROOT}/bin/loop.js" run $ARGUMENTS`

Run it directly, never through a pipe. The process's true exit code is the result; stdout text
is not success or failure, and an exit code obtained through a pipe is never acceptable. Report
the command's true exit code and its relevant stdout and stderr to the user.


Before launching on a goal that spans more than one file-cluster or names several distinct behaviors, invoke the uroboros-chunk skill first: decompose in the calling session (where project context lives), emit small per-unit goal files plus a queue/campaign file, and launch on those units instead. Measured: wave-scale goals do not converge; small units do.
