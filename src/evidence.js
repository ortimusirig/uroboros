import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Execution evidence, kept whole. Under "no green, no red" the harness still
// runs commands — as a stenographer, not a judge. Every command's COMPLETE
// stdout and stderr goes to a file the seats can read in full; the run facts
// carry only a short excerpt plus the path. Nothing here computes a verdict,
// and nothing downstream may branch on these records — they are transcript.
//
// The directory lives beside __uro_review inside the worktree so the reviewer
// seats (which read files, not argv) can open it, and it is excluded from
// CHANGES.diff the same way the review directory is.
export const EVIDENCE_DIR = '__uro_evidence';

const EXCERPT_LIMIT = 500;

function excerptOf(stdout, stderr) {
  // The end of the output is where a run says why it stopped; keep the tail.
  const combined = [
    stdout.trim() === '' ? '' : `[stdout]\n${stdout.trim()}`,
    stderr.trim() === '' ? '' : `[stderr]\n${stderr.trim()}`,
  ].filter(Boolean).join('\n');
  return combined.length <= EXCERPT_LIMIT ? combined : combined.slice(-EXCERPT_LIMIT);
}

export function createEvidenceWriter({ dir, round = 1 } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new TypeError('evidence writer requires a worktree directory');
  }
  const records = [];
  let sequence = 0;

  const write = ({
    bin, args = [], code, timedOut = false, attempt, harness, stdout = '', stderr = '',
    source = 'command',
  }) => {
    sequence += 1;
    const name = `round-${round}-${String(sequence).padStart(2, '0')}`;
    const directory = join(dir, EVIDENCE_DIR);
    const outPath = join(directory, `${name}.out.txt`);
    const errPath = join(directory, `${name}.err.txt`);
    const record = {
      source,
      bin,
      args: [...args],
      ...(harness === undefined ? {} : { harness }),
      code,
      timedOut,
      ...(attempt === undefined ? {} : { attempt }),
      round,
      excerpt: excerptOf(String(stdout), String(stderr)),
      outFile: `${EVIDENCE_DIR}/${name}.out.txt`,
      errFile: `${EVIDENCE_DIR}/${name}.err.txt`,
    };
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(outPath, String(stdout), 'utf8');
      writeFileSync(errPath, String(stderr), 'utf8');
    } catch (error) {
      record.writeError = error instanceof Error ? error.message : String(error);
    }
    records.push(record);
    return record;
  };

  return {
    write,
    setRound(value) { round = value; },
    records: () => records.map((record) => ({ ...record })),
  };
}
