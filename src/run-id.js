import { createHash } from 'node:crypto';

const PORTABLE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const PHYSICAL_NAMESPACE = 'uro-physical-';
const STANDARD_RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z0-9._-]+$/;
const STANDARD_RUN_ID_CASE_INSENSITIVE = /^\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}-\d{3}z-[a-z0-9._-]+$/i;

export function isSafePhysicalRunId(runId) {
  return typeof runId === 'string'
    && PORTABLE_RUN_ID.test(runId)
    && runId !== '.'
    && runId !== '..'
    && !runId.endsWith('.')
    && !WINDOWS_RESERVED_NAME.test(runId);
}

function canUseLogicalIdDirectly(runId) {
  if (!isSafePhysicalRunId(runId)) return false;
  if (runId.toLowerCase().startsWith(PHYSICAL_NAMESPACE)) return false;
  if (STANDARD_RUN_ID.test(runId)) return true;
  return runId === runId.toLowerCase()
    && !STANDARD_RUN_ID_CASE_INSENSITIVE.test(runId);
}

export function physicalRunIdFor(runId) {
  if (typeof runId !== 'string' || runId === '') {
    throw new TypeError('runId must be a non-empty string');
  }
  if (canUseLogicalIdDirectly(runId)) return runId;
  const digest = createHash('sha256').update(runId).digest('hex');
  return `${PHYSICAL_NAMESPACE}${digest}`;
}
