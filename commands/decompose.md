---
description: Debate a project into goals, or one goal into loop-ready task units.
disable-model-invocation: true
---

Act as the controller and run the real CLI from the user's current working directory:

`node "${CLAUDE_PLUGIN_ROOT}/bin/loop.js" decompose $ARGUMENTS`

Run it directly, never through a pipe. The process's true exit code is the result; stdout text
is not success or failure, and an exit code obtained through a pipe is never acceptable. Report
the command's true exit code and its relevant stdout and stderr to the user.

`--goal <spec.md>` decomposes one goal spec into the loop-ready task units it converges to —
`plan.md`/`gate.json` pairs plus a `queue.json`, written beside the goal spec under a `tasks/`
directory. Each task's `gate.json` commands are recorded evidence, not a verdict: the harness
runs them once per round and the seats read the full output, but no exit code passes or fails
the change. `--project <file-or-prose> --out <dir>` decomposes a project into the MVP-first,
dependency-ordered goals that make it up — `project.md`, a `goals/goals.json` manifest, and each
goal's own `goals/G<n>-<slug>/spec.md`; a goal's own tasks and gate commands come only from
decomposing it in turn with `--goal`.
