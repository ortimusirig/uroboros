---
description: Run and safely land queue units in order; never retry, skip, or push.
disable-model-invocation: true
---

Act as the controller and run the real CLI from the user's current working directory:

`node "${CLAUDE_PLUGIN_ROOT}/bin/loop.js" queue $ARGUMENTS`

Run it directly, never through a pipe. The process's true exit code is the result; stdout text
is not success or failure, and an exit code obtained through a pipe is never acceptable. Report
the command's true exit code and its relevant stdout and stderr to the user. Use `--dry-run` to
validate all queue paths without starting a run or spending tokens. Queue units may carry either
`task` plus `gate`, or `goal` plus `out`; goal units debate the plan before implementation starts.
