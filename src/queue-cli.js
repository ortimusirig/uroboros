import { homedir } from 'node:os';
import { runQueue } from './queue.js';
import { createQueueRuntime } from './queue-runtime.js';
import {
  applySuperpowersRequirement,
  verifySuperpowersSeats,
} from './superpowers.js';

export async function executeQueueCommand(options, {
  target = process.cwd(),
  runtime,
  createRuntime = createQueueRuntime,
  runQueueFn = runQueue,
  verifySuperpowers = verifySuperpowersSeats,
  env = process.env,
  home = homedir(),
} = {}) {
  const verification = await verifySuperpowers({ env, home });
  const requirement = applySuperpowersRequirement(verification, env);
  if (!requirement.ok) throw new Error(`superpowers preflight failed: ${requirement.reason}`);
  return runQueueFn({
    file: options.file,
    target,
    mode: options.mode,
    ...(options.maxRuns === undefined ? {} : { maxRuns: options.maxRuns }),
    ...(options.tokenBudget === undefined ? {} : { tokenBudget: options.tokenBudget }),
    ...(options.acceptGoalSpec === undefined ? {} : { acceptGoalSpec: options.acceptGoalSpec }),
    dryRun: options.dryRun,
    dependencies: runtime ?? createRuntime({ env }),
  });
}
