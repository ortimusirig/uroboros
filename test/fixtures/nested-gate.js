import { runGate } from '../../src/gate.js';

// Owning fixtures are sequential. Nested node --test must not inherit the
// parent runner's child marker, which otherwise skips the requested test files.
export async function runNestedGate(options) {
  const present = Object.hasOwn(process.env, 'NODE_TEST_CONTEXT');
  const previous = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try { return await runGate(options); }
  finally {
    if (present) process.env.NODE_TEST_CONTEXT = previous;
    else delete process.env.NODE_TEST_CONTEXT;
  }
}
