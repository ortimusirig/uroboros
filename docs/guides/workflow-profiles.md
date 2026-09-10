# BMAD and Spec Kit workflow profiles

Uroboros bundles adapted BMAD planning/replanning questions and Spec Kit development,
coverage and review questions. Uroboros remains the controller: Claude authors plans,
Codex reviews plans and implements, and Claude reviews execution. The current project
→ goals → task units, permissions and manual/autonomous authority remain unchanged.
This guide describes the integration in this checkout; it does not establish that an
installed marketplace plugin has been updated.

## Read the applicable adaptation

| Work | BMAD | Spec Kit |
| --- | --- | --- |
| Decomposition, planning, candidate preparation/selection, retained replan | [Planning](../../src/workflow-profiles/adapted/bmad-planning.md) | [Planning](../../src/workflow-profiles/adapted/spec-kit-planning.md) |
| Implementation and code review | [Execution](../../src/workflow-profiles/adapted/bmad-execution.md) | [Execution](../../src/workflow-profiles/adapted/spec-kit-execution.md) |
| Whole-goal acceptance | [Acceptance](../../src/workflow-profiles/adapted/bmad-acceptance.md) | [Acceptance](../../src/workflow-profiles/adapted/spec-kit-acceptance.md) |

BMAD contributes usable outcomes, dependency/risk boundaries, and adjustment of remaining
work when evidence changes a planning assumption. Spec Kit contributes requirement-to-work
and requirement-to-test coverage, contract preservation, failure paths, and reconciliation
of completion claims with actual evidence. Read the relevant adapted files above rather
than executing the preserved upstream instructions. See also [task sizing](task-sizing.md).

Calling-session preparation, including `uroboros-chunk`, is outside native harness enforcement.
Read this guide and the relevant adaptations, then route proposed goals or plans through
native reviewed `plan`/`decompose` and the existing queue. Freehand text is not an approved
native artifact. A supplied task can still enter `run --task` directly; the integration does
not insert a compulsory planning detour.

## What the harness enforces

At a fresh native entry, the loader validates the shipped manifest and every selected
source, adapted section and notice before the affected provider or effect can launch. It
captures one immutable binding containing profile identities, content and hashes. Both
seats receive the applicable sections through their existing shared-context input.
The operation records the delivered input and snapshot identity. Queues and campaigns pin
the same binding for their children and later units; aggregate goal acceptance consumes
its acceptance sections in the existing review call.

Questions, corrections and retained replanning carry the binding forward with completed
work, evidence and attributed history. Public resume validates captured content and uses
that saved version even after the installed default changes or is unavailable. A new run
can select a newer reviewed bundle; an existing approved run is not migrated in place.
Missing, malformed, altered or conflicting required captures refuse continuation. Do not
remove a binding or repair a saved run by injecting the current installed default.

True-v1 and pre-integration native records retain their original context and safeguards.
Their continuation remains `legacy-unbound` and receives no newly injected methodology.
Unknown usage and uncertain effects retain their existing pause/refusal rules.

## What the reports mean

Markdown reports and the read-only dashboard expose a curated `workflow` summary: mode,
binding digest, profile IDs, adapter revisions, upstream commits and applicable section IDs.
`bound` means the captured workflow binding validates; it is not a score for the work.
`legacy-unbound` identifies historical absence; `invalid` means available capture/identity
cannot be validated. A missing capture with a retained bound identity cannot become historical.
Display-only summaries are not accepted as raw authenticated captures.

The context manifest summarizes reserved workflow entries and known nested parent captures;
inspect retained snapshots for their full data. Reports do not dump the entire bundled
instructions or unknown binding fields. Ordinary conversation text remains subject to the
existing display screening, which is not universal private-data/DLP protection.

Observed delivery does not establish comprehension or quality. A method statement or checked
task list cannot substitute for captured source/command evidence, inspection and reviewer
assessment. Fake-provider transport tests establish delivered bytes and enforcement boundaries;
synthetic instruction-application probes show qualitative decisions in those cases. Neither
establishes improved real-provider quality or statistical performance.

Guidance adds prompt tokens to existing inputs. There are no added mandatory provider rounds,
automatic quality scores, numerical sizing thresholds, task counts or additional final-review
calls. Reviewers retain semantic judgment and can inspect further authorized context.

## Provenance, distribution and updates

The [manifest](../../src/workflow-profiles/manifest.json) pins BMAD-METHOD at
`abe4eb1bce919c9d22cd18b3519353d5824c4b75` and Spec Kit at
`0c8e31ff0a98c362696c2edb6a1bb25a37f68544`, both adapter revision 1. It inventories
six original source files, six adapted sections and three notices with SHA-256 hashes.
The [bundle index](../../src/workflow-profiles/README.md) explains the original/adapted boundary.

Both original MIT notices are preserved: [BMAD LICENSE](../../src/workflow-profiles/upstream/bmad/LICENSE)
and [Spec Kit LICENSE](../../src/workflow-profiles/upstream/spec-kit/LICENSE).
BMAD's [trademark notice](../../src/workflow-profiles/upstream/bmad/TRADEMARK.md) and
[pinned trademark guidelines](https://github.com/bmad-code-org/BMAD-METHOD/blob/abe4eb1bce919c9d22cd18b3519353d5824c4b75/TRADEMARK.md)
remain applicable. This adaptation does not imply endorsement or rebrand Uroboros as BMAD.

Only the adapted sections are runtime guidance. Preserved originals are inspectable data;
upstream personas, hooks and executable instructions are not installed or run. No upstream
toolkit, Python/uv, new runtime dependency, external service or download is needed. Updates
require a reviewed bundle/adapter/manifest change; runtime never fetches a newer profile.

`node install.mjs --dry-run` validates the checkout and prints plugin preparation instructions
without writing managed plugin state or running the self-test. Workflow validation occurs
before reporting `PREPARED` or beginning the non-dry-run self-test. The existing `src` payload
carries the complete bundle. Disposable npm archive checks verify actual packaged bytes and
offline module/CLI loading; they are not installation or publication. The separate existing
broad npm package-file allowlist obligation remains a before-release item.
