export const CLI_COMMANDS = Object.freeze([
  'run', 'mutate', 'plan', 'queue', 'batch', 'status', 'dashboard', 'publish', 'prune', 'doctor', 'setup', 'init', 'help',
]);

export const CLI_USAGE = `Usage:
  node bin/loop.js run --task <plan-file-or-prose> --target <directory> --gate <gate.json> [--gate-retries <0-3>] [--pivot-candidates <1-5>] [--executor-model <model>] [--executor-effort <effort>] [--verifier-model <model>] [--arbiter-model <model>] [--executor-timeout <ms>] [--verifier-timeout <ms>] [--arbiter-timeout <ms>] [--gate-timeout <ms>] [--artifact-root <directory>] [--mutate] [--port <0-65535>] [--open] [--no-dashboard] [--quiet]
  node bin/loop.js mutate --target <directory> [--base <ref>] [--tests <command>] [--dry-run]
  node bin/loop.js plan --goal <prose-or-file> --target <directory> --out <directory> [--rounds <n>] [--candidates <1-5>] [--pivot-candidates <1-5>] [--planner-model <model>] [--verifier-model <model>] [--arbiter-model <model>] [--dry-run]
  node bin/loop.js queue --file <queue.json> [--mode <manual|autonomous>] [--max-runs <n>] [--token-budget <tokens>] [--dry-run]
  node bin/loop.js batch --task <plan> [--task <plan> ...] --target <directory> --gate <gate.json> [--gate-retries <0-3>] [--pivot-candidates <1-5>] [--executor-model <model>] [--executor-effort <effort>] [--verifier-model <model>] [--arbiter-model <model>] [--executor-timeout <ms>] [--verifier-timeout <ms>] [--arbiter-timeout <ms>] [--gate-timeout <ms>] [--artifact-root <directory>] [--concurrency <1-16>] [--token-budget <tokens>] [--rounds <1-3>] [--round <number> ...] [--unit-kind <candidate|node|merge> ...] [--unit-id <id> ...] [--perspective <name> ...] [--depends-on <child=parent> ...] [--port <0-65535>] [--open] [--no-dashboard] [--quiet]
  node bin/loop.js batch --campaign <file> [--executor-timeout <ms>] [--verifier-timeout <ms>] [--arbiter-timeout <ms>] [--gate-timeout <ms>] [--artifact-root <directory>] [--port <0-65535>] [--open] [--no-dashboard] [--quiet]
  node bin/loop.js status <run-or-campaign-directory>
  node bin/loop.js dashboard [<run-directory> | --run <run-directory> | --scratch-root <directory>] [--port <0-65535>]
  node bin/loop.js publish <completed-run-directory>
  node bin/loop.js prune [--keep <n>] [--older-than <days>] [--dry-run] [--scratch-root <directory>] [--artifact-root <directory>]
  node bin/loop.js doctor [--deep] [--scratch-root <directory>] [--repository <directory>]
  node bin/loop.js doctor --fix [--yes] [--scratch-root <directory>] [--repository <directory>]
  node bin/loop.js setup [--yes] [--scratch-root <directory>]
  node bin/loop.js init <directory>
  node bin/loop.js help

Shapes (choose by how the plans relate):
  Single      one plan: run
  Parallel    unrelated plans, keep all: batch (task-set)
  Graph       one plan consumes another: batch --campaign or batch --depends-on (task-set with parents)
  Candidates  competing approaches to one goal: batch --perspective (candidate-set)
  Rounds      candidates refined over 2-3 rounds: add --rounds (iterative-candidate-set)

Commands:
  run        Execute one isolated Codex/evidence/Cursor debate with Claude arbitrating read-only.
  mutate     Delete changed statements temporarily and report which selected tests do not notice.
  plan       Debate a goal into a mechanically checked plan and gate without changing the target.
  queue      Run and safely land queue units in order; never retry, skip, or push.
  batch      Execute one or more isolated plans as a campaign with a live dashboard.
  status     Read human-readable status for a run or campaign.
  dashboard  Serve the optional read-only local dashboard.
  publish    Optionally publish a completed run through GitHub.
  prune      Remove old disposable run directories while preserving durable artifacts.
  doctor     Check prerequisites; --deep spends agent tokens on write/read probes.
  setup      Prepare prerequisites with consent, then scaffold and run an isolated demo.
  init       Create a starter plan.md and runnable gate.json without overwriting.
  help       Print this usage. --help and -h are aliases.`;
