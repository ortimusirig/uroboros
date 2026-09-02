---
description: Debate a project into goals, or one goal into loop-ready task units.
disable-model-invocation: true
---

Act as the controller and run the real CLI from the user's current working directory:

`node "${CLAUDE_PLUGIN_ROOT}/bin/loop.js" decompose $ARGUMENTS`

Run it directly, never through a pipe. The process's true exit code is the result; stdout text
is not success or failure, and an exit code obtained through a pipe is never acceptable. Report
the command's true exit code and its relevant stdout and stderr to the user.

`--goal <spec.md>` decomposes one goal spec into the loop-ready task units it converges to;
`--project <file-or-prose> --out <dir>` decomposes a project into the goals that make it up. In
both modes, each task's `gate.json` commands are recorded evidence, not a verdict: the harness
runs them once per round and the seats read the full output, but no exit code passes or fails
the change.
