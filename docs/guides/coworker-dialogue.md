# Coworker dialogue

> Release status: this guide describes the locally verified shared-context branch. It is not evidence that the marketplace plugin has been updated, installed, tested against live providers, pushed, merged, or released.

## The two-seat flow

Uroboros captures the goal, required constraints, evidence references, and selected project recall in an explicit versioned shared-context snapshot. The same complete required snapshot reaches both seats; it is harness-delivered context, not hidden chat transfer or proof that a digest is semantically true. Each seat may investigate further within the authorized project and evidence roots.

Planning is **Claude author → Codex reviewer**. Execution is **Codex implementer → Claude reviewer**. Either seat can ask, answer, inspect, challenge, rebut, withdraw, verify, decide, replan, or approve as its role permits. Conversation-only actions are read-only. Only the designated author or implementer changes the artifact during an explicit revision or implementation action.

[Bundled BMAD and Spec Kit adaptations](workflow-profiles.md) travel in a validated captured
binding. Both seats receive the applicable planning, execution or acceptance sections through
the common input projection; saved snapshots retain the complete binding. Queues, campaigns,
retained replans and resume preserve the selected version. Reports expose curated identity
and applicability, summarize nested parent captures, and label invalid or historical unbound
state honestly. Guidance delivery is distinct from inspection, assessment and approval.

## Messages, issues, and evidence

Substantive factual claims identify resolvable evidence. Code references bind captured bytes to a path/symbol and source identity; command evidence records actual argv, cwd, status, exit, output, and code identity. External and recalled sources retain their version and attribution. Missing, stale, irrelevant, out-of-scope, or unknown evidence stays visible and cannot support approval.

These records are intentionally different:

- delivery records that input was observably submitted;
- an inspection receipt records a harness-observed read/check;
- an assessment records whether cited evidence supports, contradicts, or is insufficient for a claim;
- an issue disposition settles an authorized issue;
- approval binds the current artifact and context after all blocking issues have authorized dispositions.

None implies the next. Acknowledgment is not assessment or approval, and the harness does not claim to prove model comprehension. Questions and hypotheses may request missing evidence without inventing citations. `decide` settles identified issues; it is not whole-artifact approval. `approve` is the explicit current-artifact sign-off.

## Authority and final review

Codex is the planning reviewer and Claude is the execution reviewer. In autonomous mode, that phase reviewer has final authority. In manual mode, the reviewer can still approve a clean evidenced artifact; the human settles unresolved disputes. A validated missing product-intent or permission request can require a human in either mode. A human answer settles only the authenticated questions/issues it names and is not automatic artifact approval.

Questions remain available during final review. The reviewer chooses useful depth. If an already-running review response supplies sufficient current-artifact approval, Uroboros does not require a redundant extra provider call. Silence, unreadable or malformed responses, quota failures, and legacy-only replies never become agreement.

## Limits and resource accounting

There is no default dialogue-round, provider-call, or elapsed-conversation ceiling. Explicit candidate breadth, proposal/correction cycles, challenge limits, campaign rounds, token budgets, gate retries, and operational timeouts remain separate controls; Q&A is not a proposal or correction cycle. Initial planning breadth defaults to one, while fresh/replan exploration currently defaults to three and can be configured explicitly.

Reports label cumulative run resources, current-phase deltas, ordered per-phase deltas, and queue-cumulative resources separately. A reused completed operation is not charged again. Known tokens remain a known subtotal when `usageUnknown` is true; unknown usage is never zero. Under an enforced token budget, an in-flight writer with unknown usage prevents a concurrent paid liveness judgment—there is no reservation, estimate, or fallback spend.

Requested native mutation analysis runs after successful required checks and before the next discretionary Claude review. Identical completed analysis input can reuse its receipt; genuine code, test, or policy changes can make optional analysis spend repeat. Mutation evidence does not require a separate extra final-review call, and disposable trial source is not current live code.

## Project notebook and recall

The project notebook is a bounded, versioned, evidence-linked aid, not universal memory. Current requirements do not depend on optional search. Selected immutable versions and a selection manifest are frozen into shared context, and conflicting/historical versions retain attribution. Either seat may propose an item; only the harness promotes it after the relevant disposition or current-artifact approval. Disputed, unsupported, withdrawn, or retired claims do not become verified facts.

Required context/dialogue storage failure pauses before further mutation. Optional recall/search failure may visibly fall back to available records; fallback does not grant continuation authority.

## Correction, replan, and recovery

A clarification is byte-neutral. A correction applies once and must be reviewed at its new artifact/context identity. A substantive planning error triggers a genuinely revised Claude plan over useful retained code, evidence, and history; Codex reviews that plan before remaining execution continues. This retained-work rule applies in both manual and autonomous modes. A question or replan does not reset the entire review or authorize replay of an uncertain effect.

Human answers use:

```text
node bin/loop.js resume --run <run-directory> --decision-file <answers.json>
```

Put the answer file outside the target source tree and execution workspace. The saved phase, workspace, mode, limits, identities, and unanswered scope remain authoritative.

An eligible saved technical pause with no human question uses:

```text
node bin/loop.js resume --run <run-directory> --continue
```

`--continue` is mutually exclusive with `--decision-file`. It reconciles the validated current saved state; it is not a new run, human answer, mode/limit change, approval, generic “continue anyway,” or permission to retry an uncertain provider/writer/Git effect. Human-pending, corrupted required journals, exhausted/incomplete accounting, stale workspace/identity, and uncertain effects remain refused or paused. A consumed receipt alone does not guarantee exit 0. Run the command directly and use its true child exit code.

## Reports and compatibility

`uro-runfacts.json`, `uro-report.md`, the read-only dashboard, and offline run journal project an allowlisted current view: context identity/recall, attributed dialogue and dissent, issues/dispositions, evidence/delivery/inspection/assessment state, current authority/approval/next action, and resource scopes. Model text is HTML-escaped, known credential patterns are screened from new projections, arbitrary locators never become executable links, and private checkpoint/options/credential fields are not dumped. This is not a universal DLP guarantee.

Current facts override a historical approval signer or phase summary. Planning/execution history remains readable without flattening alternatives into current premises or double-counting resources/messages. Required post-retention failure revokes approval in the final visible source and durable projections.

Historical v1 records remain readable. Native execution does not synthesize the legacy `diff/*`, `debate/*`, or `decision/*` event pairs, and schema-constructor tests do not prove native emission. Native dialogue state/journal and actual executor/check/reviewer/report events are separate inputs. Uncertain native writers pause rather than blindly replay.

## Installation and release status

For released versions, use the marketplace installation documented in the README. A checkout is for development; `node install.mjs` validates/prepares that checkout and does not mutate installed plugin state. Local tests, dry runs, and guidance probes do not establish live-provider behavior, installation, publication, or release.
