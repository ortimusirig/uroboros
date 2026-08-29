import { runQueue } from './queue.js';
import { createQueueRuntime } from './queue-runtime.js';

export async function executeQueueCommand(options, {
  target = process.cwd(),
  runtime,
  createRuntime = createQueueRuntime,
  runQueueFn = runQueue,
} = {}) {
  return runQueueFn({
    file: options.file,
    target,
    mode: options.mode,
    ...(options.maxRuns === undefined ? {} : { maxRuns: options.maxRuns }),
    ...(options.tokenBudget === undefined ? {} : { tokenBudget: options.tokenBudget }),
    dryRun: options.dryRun,
    dependencies: runtime ?? createRuntime(),
  });
}
