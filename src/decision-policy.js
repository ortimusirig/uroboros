export function decisionAuthority({ interactionMode = 'manual', phase } = {}) {
  if (!['manual', 'autonomous'].includes(interactionMode)) {
    throw new TypeError(`unknown interaction mode: ${interactionMode}`);
  }
  if (!['planning', 'execution'].includes(phase)) {
    throw new TypeError(`unknown decision phase: ${phase}`);
  }
  return interactionMode === 'manual' ? 'human' : phase === 'planning' ? 'codex' : 'claude';
}
