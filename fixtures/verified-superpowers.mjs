import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'uro-verified-superpowers-'));
for (const manifest of ['.cursor-plugin', '.claude-plugin']) {
  mkdirSync(join(directory, manifest), { recursive: true });
  writeFileSync(join(directory, manifest, 'plugin.json'), JSON.stringify({
    name: 'superpowers', version: '6.0.2',
  }));
}
mkdirSync(join(directory, 'skills', 'using-superpowers'), { recursive: true });
writeFileSync(join(directory, 'skills', 'using-superpowers', 'SKILL.md'), '# test skill\n');
process.once('exit', () => rmSync(directory, { recursive: true, force: true }));

export const VERIFIED_SUPERPOWERS = Object.freeze({
  required: true,
  bypassed: false,
  seats: Object.freeze({
    codex: Object.freeze({
      seat: 'codex', verified: true, evidence: 'test Codex registry evidence',
      version: '6.3.0', path: null, remediation: 'Codex fix',
    }),
    cursor: Object.freeze({
      seat: 'cursor', verified: true, evidence: 'test Cursor manifest evidence',
      version: '6.0.2', path: directory, remediation: 'Cursor fix',
    }),
    claude: Object.freeze({
      seat: 'claude', verified: true, evidence: 'test Claude manifest evidence',
      version: '6.0.2', path: directory, remediation: 'Claude fix',
    }),
  }),
});

export function withVerifiedSuperpowers(options) {
  return { superpowers: VERIFIED_SUPERPOWERS, ...options };
}
