# Task 1 report — outcome-based decomposition documentation

**Status:** DONE

**Starting BASE:** `edb638d37e92d1dca0a7354dc171d66dad81cc66`

**Final HEAD:** `6d54eceababa3cd7a26d817490b25492ed7c5823`

## What I implemented

- Added `docs/guides/task-sizing.md`, a 799-word practical guide that maps conceptual epics to
  existing goals, conceptual stories to existing task units, and checklist steps to work inside a
  task. It keeps project → goals → task units and adds no storage or queue tier.
- Documented outcome-led boundary questions, tests/evidence, uncertainty and feedback, atomic work,
  requirement coverage, and dependency/context handoff as prompts rather than mandatory rounds or
  a sizing gate.
- Added the requested finance statement-import illustration using existing authentication and CSV
  parsing, including per-outcome tests, duplicate safety, and an inseparable migration/API example.
- Documented evidence-led retained-work replanning, phase authority, manual dispute handling, and
  the distinction between task approval and aggregate goal acceptance.
- Linked the pinned BMAD-METHOD, GitHub Spec Kit, and OpenSpec primary sources as optional
  references, without representing them as installed integrations or sizing oracles.
- Added one discovery link beside README decomposition, one beside Usage chunking, and one in the
  documentation guide index.

## Files changed

- `README.md`
- `docs/README.md`
- `docs/guides/task-sizing.md` (new)
- `docs/guides/usage.md`

No runtime, tests, command definitions, skills, dependencies, versions, or executable/plugin paths
were changed.

## Commits

```text
61facfd4e17ba9c98d50ea5db7da6951992877ea docs: explain outcome-based task sizing
0512a6d679eb43bd39530a2942d8b96ca3cfe756 docs: clarify required check approval gate
6d54eceababa3cd7a26d817490b25492ed7c5823 docs: name generated decomposition files
```

The follow-up commits preserve two source-audit corrections explicitly: required checks are hard
approval prerequisites even though they are not sizing scores, and generated decomposition files
use the literal `T<n>-plan.md` / `T<n>-gate.json` naming.

## Verification evidence

### Pinned research identity

Command:

```powershell
(Get-FileHash -Algorithm SHA256 'C:\Users\aiuser4\OneDrive - Applexus Technologies\Uroboros\outputs\2026-09-08-decomposition-sizing-open-source.md').Hash
```

Output and exit:

```text
470B52A0CC30B3F80E78264B2AFEDA38D8D5713E3F8AE92250E44BD8886A465C
EXIT=0
```

### Markdown whitespace, scope, length, targets, and anchors

Commands:

```powershell
git diff --check edb638d37e92d1dca0a7354dc171d66dad81cc66..HEAD
git diff --name-only edb638d37e92d1dca0a7354dc171d66dad81cc66..HEAD
((Get-Content -Raw 'docs\guides\task-sizing.md') | Measure-Object -Word).Words
```

The local-link check enumerated Markdown links in the four changed files, resolved each non-HTTP
target relative to its source document, and compared any fragment with normalized Markdown
headings in the target.

A concise confirmation of the new target and the existing indexed anchor was also run:

```powershell
$targetResults = @('docs\guides\task-sizing.md','docs\guides\usage.md') | ForEach-Object { [pscustomobject]@{ Path = $_; Exists = Test-Path -LiteralPath $_ } }; $anchorFound = Select-String -Path 'docs\guides\usage.md' -Pattern '^## Manual resume$' -Quiet; $targetResults | ForEach-Object { "$($_.Path)=$($_.Exists)" }; "manual-resume-anchor=$anchorFound"; if ($targetResults.Exists -contains $false -or -not $anchorFound) { 'LOCAL_TARGET_ANCHOR_CHECK=FAIL'; exit 1 }; 'LOCAL_TARGET_ANCHOR_CHECK=PASS'; 'EXIT=0'
```

Output:

```text
docs\guides\task-sizing.md=True
docs\guides\usage.md=True
manual-resume-anchor=True
LOCAL_TARGET_ANCHOR_CHECK=PASS
EXIT=0
```

Exact output:

```text
DIFF_CHECK_EXIT=0
CHANGED_PATHS
README.md
docs/README.md
docs/guides/task-sizing.md
docs/guides/usage.md
WORD_COUNT=799
LOCAL_LINK_CHECK=PASS
HEAD=6d54eceababa3cd7a26d817490b25492ed7c5823
STATUS
STATUS_EXIT=0
```

The empty line after `STATUS` is the actual clean `git status --short` output.

### CLI example and role mapping

Command:

```powershell
node bin/loop.js decompose --help | Select-String -Pattern '^  node bin/loop.js decompose','^  --mode manual','^  --claude-model','^  --codex-model','^  Autonomous final authority'
```

Output and exit:

```text
  node bin/loop.js decompose (--goal <spec.md> | --project <file-or-prose> --out <dir>) --target <dir> [--rounds N]
[--map-budget CHARS] [--mode manual|autonomous] [--claude-model MODEL] [--codex-model MODEL] [--codex-effort EFFORT]
  --mode manual|autonomous     manual is default; human settles unresolved disputes.
  --claude-model MODEL         default sonnet; plans and reviews implementations.
  --codex-model MODEL          default gpt-6-astra; reviews plans and implements.
  Autonomous final authority: Codex for planning, Claude for execution.
EXIT=0
```

The illustrative command in the guide matches that signature and labels its path as illustrative.
`src/decompose.js` lines 262–269 were inspected to confirm `${item.id}-plan.md`,
`${item.id}-gate.json`, and `tasks/queue.json`. `src/decompose.js` lines 14, 18, and 22 were
inspected for task/goal incremental laws and evidence semantics. `src/run.js` lines 1283 and 1376
were inspected for the hard current-required-check approval prerequisite. The role, reviewer
authority, and retained-work claims were checked against `docs/guides/coworker-dialogue.md` lines
9, 27, and 47.

### Pinned upstream source links

Command form, run once for each of the three URLs:

```powershell
curl.exe -L --fail --silent --show-error --output NUL --write-out '%{http_code}' <commit-pinned-url>
```

Exact output:

```text
200 exit=0 https://github.com/bmad-code-org/BMAD-METHOD/blob/abe4eb1bce919c9d22cd18b3519353d5824c4b75/skills/bmad-create-epics-and-stories/steps/step-02-design-epics.md
200 exit=0 https://github.com/github/spec-kit/blob/0c8e31ff0a98c362696c2edb6a1bb25a37f68544/templates/tasks-template.md
200 exit=0 https://github.com/Fission-AI/OpenSpec/blob/e062b9572be933564ba3899d059377dfa1393e32/schemas/spec-driven/schema.yaml
```

### Commit evidence

The initial explicit four-path commit produced:

```text
CACHED_DIFF_CHECK_EXIT=0
README.md
docs/README.md
docs/guides/task-sizing.md
docs/guides/usage.md
[feat/shared-context-coworker-dialogue 61facfd] docs: explain outcome-based task sizing
 4 files changed, 99 insertions(+)
 create mode 100644 docs/guides/task-sizing.md
COMMIT_EXIT=0
```

Both source-accuracy follow-ups also ran `git diff --cached --check` with exit 0 before commit.
Their commit commands returned exit 0.

## Self-review and limitations

- Re-read the complete guide against every brief checkbox and audited restricted-scope terms.
- Corrected an initially loose evidence sentence after inspecting the current hard required-check
  approval guards; the final text distinguishes semantic reviewer judgment from prerequisites.
- Corrected the output-file wording after inspecting the literal writer paths.
- No full runtime suite or source-text assertion tests were run because this task changes
  documentation only. The CLI help command was read-only.
- No live providers, installation, merge, push, publication, or operational checkout change was
  performed. The three upstream HTTP checks establish link reachability, not compatibility or
  integration quality. The guide promises neither ideal sizing nor new automated enforcement.

## Fix round 1 — reproducible evidence transcript

The earlier sections preserve the original observations, but the local-link section did not retain
the literal checker command and the upstream section used a `<commit-pinned-url>` placeholder.
Those command-form records were insufficient for independent reproduction. No historical command
is reconstructed here. The following are fresh checks run against final documentation HEAD
`6d54eceababa3cd7a26d817490b25492ed7c5823`; commands and outputs are retained verbatim.

### Complete local Markdown target and anchor check

Exact command:

```powershell
$files = @('README.md','docs/README.md','docs/guides/usage.md','docs/guides/task-sizing.md'); $localCount = 0; $anchorCount = 0; $failures = @(); foreach ($file in $files) { $content = Get-Content -Raw -LiteralPath $file; foreach ($match in [regex]::Matches($content, '\[[^\]]+\]\(([^)]+)\)')) { $target = $match.Groups[1].Value.Trim('<','>'); if ($target -match '^(https?://|mailto:)') { continue }; $localCount++; $parts = $target -split '#',2; $pathPart = $parts[0]; if ([string]::IsNullOrEmpty($pathPart)) { $resolved = (Resolve-Path -LiteralPath $file).Path } else { $resolved = Join-Path (Split-Path -Parent (Resolve-Path -LiteralPath $file).Path) $pathPart }; if (-not (Test-Path -LiteralPath $resolved)) { $failures += "$file -> $target (missing target)"; continue }; if ($parts.Count -eq 2) { $anchorCount++; $headings = Select-String -Path $resolved -Pattern '^#{1,6}\s+(.+)$' | ForEach-Object { $slug = $_.Matches[0].Groups[1].Value.ToLowerInvariant(); $slug = [regex]::Replace($slug, '[^\p{L}\p{N}\s-]', ''); $slug = [regex]::Replace($slug, '\s+', '-'); $slug.Trim('-') }; if ($headings -notcontains $parts[1].ToLowerInvariant()) { $failures += "$file -> $target (missing anchor)" } } } }; "LOCAL_LINKS_CHECKED=$localCount"; "ANCHORS_CHECKED=$anchorCount"; if ($failures.Count -gt 0) { $failures; 'LOCAL_MARKDOWN_CHECK=FAIL'; exit 1 }; 'LOCAL_MARKDOWN_CHECK=PASS'; 'EXIT=0'
```

Exact output:

```text
LOCAL_LINKS_CHECKED=50
ANCHORS_CHECKED=3
LOCAL_MARKDOWN_CHECK=PASS
EXIT=0
```

### Exact commit-pinned upstream checks

Exact commands:

```powershell
$code = & curl.exe -L --fail --silent --show-error --output NUL --write-out '%{http_code}' 'https://github.com/bmad-code-org/BMAD-METHOD/blob/abe4eb1bce919c9d22cd18b3519353d5824c4b75/skills/bmad-create-epics-and-stories/steps/step-02-design-epics.md'; "BMAD_HTTP=$code CURL_EXIT=$LASTEXITCODE"
$code = & curl.exe -L --fail --silent --show-error --output NUL --write-out '%{http_code}' 'https://github.com/github/spec-kit/blob/0c8e31ff0a98c362696c2edb6a1bb25a37f68544/templates/tasks-template.md'; "SPEC_KIT_HTTP=$code CURL_EXIT=$LASTEXITCODE"
$code = & curl.exe -L --fail --silent --show-error --output NUL --write-out '%{http_code}' 'https://github.com/Fission-AI/OpenSpec/blob/e062b9572be933564ba3899d059377dfa1393e32/schemas/spec-driven/schema.yaml'; "OPENSPEC_HTTP=$code CURL_EXIT=$LASTEXITCODE"
```

Exact output:

```text
BMAD_HTTP=200 CURL_EXIT=0
SPEC_KIT_HTTP=200 CURL_EXIT=0
OPENSPEC_HTTP=200 CURL_EXIT=0
```

No runtime tests were run in this evidence-only fix round, and the four accepted documentation
files were not modified.
