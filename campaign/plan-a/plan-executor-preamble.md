# Teach the executor the rules it is judged by

## IMPLEMENT THIS NOW

This design is **APPROVED**. Do not stop to ask for design approval, do not
propose an alternative and wait — write the code, add the tests, run the gate.
Producing no diff is a failed pass.

If you genuinely cannot proceed without a decision from the operator, write
`DECISION.md` in the worktree root using this exact shape and stop:

```
## Q1
Kind: technical | product | authority
Question: <one line>
Options: <one line>
Recommendation: <one line>
```

## Title

Prepend a harness-owned preamble to the plan, fix the scaffold, and name the
approval-request no-op

## Context — the defect

The plan reaches Codex completely unwrapped. `src/executor.js`:

```js
const r = await spawnCapture(bin, args, { cwd, input: plan, timeoutMs, signal, ... });
```

`input: plan` is whatever `resolveTask` read off disk, byte for byte. No
preamble, no protocol, no framing.

Consequently the executor is never told two things it is judged by:

1. **That the plan is approved and must be implemented**, not reviewed.
2. **That `DECISION.md` exists** as the sanctioned way to raise a blocking
   question. `DECISION.md` appears nowhere in `executor.js`, `task.js`,
   `skills/uroboros/SKILL.md`, `commands/`, the README, or the plan template —
   only in design docs, `src/decision.js`, `src/run.js`, and the artifact
   exclusion list.

Observed consequence: a round spent **381k input tokens, produced zero code**,
and ended with *"Approve this design and I'll implement it."* The executor had a
real question, no sanctioned way to ask it, and said so in prose.
`detectChallenge` found no file, the gate passed vacuously, the diff was empty,
and the run reported `no-op`. **A working challenge channel reported a
legitimate conversation opener as "produced nothing."**

The shipped scaffold invites exactly this. `PLAN_TEMPLATE` in `src/init.js` uses
`## Required behavior` / `## Invariants` / `## Out of scope` — headings that read
as a design document under review rather than a work order.

## Required behavior

### 1. A harness-owned preamble

Export a single constant (for example `EXECUTOR_PREAMBLE`) from `src/executor.js`
and prepend it to the plan text before it reaches the executor process. It is
owned by the harness, not the user, so it cannot be omitted by a plan author.

It must state, in plain imperative prose:

- The plan below is **approved**. Implement it. Do not stop to request design
  approval and do not wait for confirmation.
- Producing no diff and no `DECISION.md` is a **failed pass**, not a success.
- If a decision is genuinely required before proceeding, write `DECISION.md` in
  the working directory root in the documented block format (`## Q1`, then
  `Kind:` one of `technical | product | authority`, `Question:`, optional
  `Options:`, optional `Recommendation:`) and stop.

Constraints:

- The preamble is prepended, and the user's plan text follows it **unmodified**.
  Do not reformat, truncate, summarise, or re-indent the plan.
- Separate the two with an unambiguous delimiter so the executor can see where
  harness instruction ends and the operator's plan begins.
- The composed text is what must be written to `TASK.md` **and** what is sent to
  the executor, so the artifact matches what the executor actually received.
  Everywhere the plan is re-sent — gate retries, challenge re-runs, merge tasks —
  must send the same composed text. Compose once at a single point rather than at
  each call site.

### 2. Fix the scaffold

Rewrite `PLAN_TEMPLATE` in `src/init.js` so it reads as an instruction rather
than a proposal:

- Lead with what to build and the fact that it is to be implemented.
- Keep the genuinely useful sections — required behaviour, invariants, out of
  scope, test requirements — because they produce good plans. Change the framing,
  not the structure.
- Document the `DECISION.md` escape hatch inside the template, so an operator
  reading the scaffold learns the protocol exists.
- Keep the existing refuse-to-overwrite behaviour in `init` exactly as it is.

### 3. Name the approval-request no-op

When a pass ends with an empty diff, a zero exit code, and no `DECISION.md`,
inspect the executor's `agent_message` items for an approval request. On a match,
record a fact — `noOpReason: 'approval-requested'` — and say so in
`uro-report.md`, pointing the operator at `DECISION.md` as the supported channel.

- Detection is a conservative phrase match over the executor's own message text.
  Err toward missing a case rather than mislabelling a genuine no-op.
- `noOpReason` is **advisory only**. It must never change `outcome`,
  `gateStatus`, the verdict, or the process exit code.
- Absent a match, behaviour and facts are exactly as today.

## Invariants

- The operator's plan text is never altered, only preceded.
- Do not change `resolveTask`. Reading the plan and framing it are separate jobs.
- Do not modify `src/decision.js` or the challenge routing in `run.js`. This task
  teaches the executor the protocol; it does not change the protocol.
- Zero external dependencies. ESM style matching the rest of the codebase.
- Existing artifact handling is unchanged: `TASK.md` remains a harness artifact
  excluded from the diff.

## Test requirements

1. The text sent to the executor **starts with** the preamble and **contains the
   plan verbatim** after it. Assert the plan substring survives byte-for-byte.
2. The preamble mentions `DECISION.md` and states that an empty diff without one
   is a failure. Assert on the exported constant so wording drift is caught.
3. `TASK.md` written into the worktree matches the text the executor received.
4. A gate retry or challenge re-run sends the same composed text, not a bare
   plan. Prove it with a spy executor capturing every invocation's input.
5. `PLAN_TEMPLATE` contains no approval-seeking framing and does document
   `DECISION.md`. `init` still refuses to overwrite an existing `plan.md`.
6. An empty diff, exit 0, no `DECISION.md`, and an approval-request message sets
   `noOpReason: 'approval-requested'`.
7. **Positive control:** the same conditions with unrelated executor prose do
   *not* set it.
8. `noOpReason` never alters `outcome`, `gateStatus`, or the exit code — assert
   the outcome is still exactly `no-op` in case 6.

Do not delete, skip, or weaken any existing test.

## Out of scope

- Wiring a `decisionResolver` so something answers the questions. Separate task.
- The `debate` event vocabulary, the arbitration flow, or the STORM pivot.
- Any change to the gate, isolation, the verifier, or the dashboard.
- Rewriting existing plans under `campaign/`.
