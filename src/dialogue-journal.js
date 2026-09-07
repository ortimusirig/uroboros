import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Deliberately includes delivery, accounting, operation and audit fields.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
function hash(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }

export function openDialogueJournal({ directory, runId, projectId }) {
  if (![directory, runId, projectId].every(v => typeof v === 'string' && v.trim())) throw new Error('journal identity required');
  const root = join(directory, '__uro_dialogue');
  if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('journal symbolic-link directory refused');
  mkdirSync(root, { recursive: true });
  const path = join(root, 'journal.jsonl'), lock = join(root, 'controller.lock'), owner = randomUUID();
  let closed = false, expectedJournal = existsSync(path);
  const durableWrite = (file, bytes, flags) => {
    const fd = openSync(file, flags, 0o600);
    try { writeFileSync(fd, bytes, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
  };
  try { durableWrite(lock, owner, 'wx'); } catch (error) { throw new Error(`journal ownership lock unavailable: ${error.message}`); }
  const assertOwner = () => {
    if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()
      || lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('journal symbolic-link redirection refused');
    if (closed || !existsSync(lock) || lstatSync(lock).isSymbolicLink() || readFileSync(lock, 'utf8') !== owner) throw new Error('journal controller ownership lost');
  };
  const read = () => {
    assertOwner();
    if (!existsSync(path)) {
      if (expectedJournal) throw new Error('active journal was removed');
      return [];
    }
    const bytes = readFileSync(path, 'utf8');
    if (bytes === '' || !bytes.endsWith('\n')) throw new Error('journal truncated or empty');
    const lines = bytes.slice(0, -1).split('\n'), events = [];
    let previousHash = null;
    const pending = new Set(), completed = new Set();
    for (const line of lines) {
      if (!line.trim()) throw new Error('journal contains empty line');
      let event;
      try { event = JSON.parse(line); } catch { throw new Error('journal malformed line'); }
      const { hash: savedHash, ...body } = event;
      if (body.sequence !== events.length + 1 || body.previousHash !== previousHash
        || body.runId !== runId || body.projectId !== projectId || hash(body) !== savedHash) throw new Error('journal identity, sequence or hash mismatch');
      if (body.type === 'prepare') {
        if (!body.operationId || pending.has(body.operationId)) throw new Error('journal duplicate operation');
        pending.add(body.operationId);
      }
      if (body.type === 'complete') {
        if (!pending.has(body.operationId) || completed.has(body.operationId)) throw new Error('journal unknown or duplicate completion');
        completed.add(body.operationId);
      }
      previousHash = savedHash;
      events.push(event);
    }
    return events;
  };
  const close = () => {
    if (!closed && !lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()
      && existsSync(lock) && !lstatSync(lock).isSymbolicLink() && readFileSync(lock, 'utf8') === owner) unlinkSync(lock);
    closed = true;
  };
  let recovered;
  try { recovered = new Set(read().filter(e => e.type === 'prepare').map(e => e.operationId)); }
  catch (error) { close(); throw error; }
  const append = (data) => {
    const events = read();
    if (!data || typeof data.type !== 'string' || !data.type) throw new Error('journal event type required');
    const body = JSON.parse(JSON.stringify({ ...data, runId, projectId, sequence: events.length + 1, previousHash: events.at(-1)?.hash ?? null }));
    const event = { ...body, hash: hash(body) };
    durableWrite(path, `${JSON.stringify(event)}\n`, 'a');
    expectedJournal = true;
    return structuredClone(event);
  };
  const operation = (operationId) => {
    const events = read(), prepared = events.find(e => e.type === 'prepare' && e.operationId === operationId);
    if (!prepared) return null;
    const completed = events.find(e => e.type === 'complete' && e.operationId === operationId);
    return { ...prepared, ...(completed ?? {}), status: completed ? 'completed' : recovered.has(operationId) ? 'uncertain' : 'prepared' };
  };
  const prepare = (intent) => {
    if (!intent || !['operationId', 'seat', 'input', 'contextDigest', 'artifactDigest', 'effect'].every(k => typeof intent[k] === 'string' && intent[k])) throw new Error('operation intent identity and input required');
    if (!Array.isArray(intent.evidenceIds) || !Array.isArray(intent.unreadMessageIds)) throw new Error('operation delivery ids required');
    const existing = operation(intent.operationId);
    if (existing) {
      for (const key of Object.keys(intent)) if (hash({ value: existing[key] }) !== hash({ value: intent[key] })) throw new Error('operation identity conflict');
      if (existing.status !== 'completed') throw new Error('operation is uncertain; replay refused');
      return existing;
    }
    append({ ...intent, type: 'prepare' });
    return operation(intent.operationId);
  };
  const complete = ({ operationId, result, usage = null, delivery = null }) => {
    const existing = operation(operationId);
    if (!existing) throw new Error('unknown operation completion');
    if (existing.status === 'uncertain') throw new Error('uncertain operation requires reconciliation');
    if (existing.status === 'completed') {
      if (hash({ result, usage, delivery }) !== hash({ result: existing.result, usage: existing.usage, delivery: existing.delivery })) throw new Error('operation completion conflict');
      return existing;
    }
    append({ type: 'complete', operationId, result, usage, delivery });
    return operation(operationId);
  };
  const account = () => {
    const events = read(), launches = events.filter(e => e.type === 'prepare' && ['provider', 'repair'].includes(e.effect));
    const total = { providerLaunches: launches.length, repairLaunches: 0, failedLaunches: 0,
      knownUsage: { inputTokens: 0, outputTokens: 0 }, usageUnknown: false };
    for (const launch of launches) {
      if (launch.effect === 'repair') total.repairLaunches++;
      const result = events.find(e => e.type === 'complete' && e.operationId === launch.operationId);
      if (result?.result?.error) total.failedLaunches++;
      for (const field of ['inputTokens', 'outputTokens']) {
        const value = result?.usage?.[field];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) total.knownUsage[field] += value;
        else total.usageUnknown = true;
      }
    }
    return total;
  };
  return { read, append, prepare, complete, operation, account, close };
}
