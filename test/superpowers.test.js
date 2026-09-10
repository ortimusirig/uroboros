import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  applySuperpowersRequirement,
  resolveSuperpowersDir,
  verifyCodexSuperpowers,
  verifyDirectorySuperpowers,
} from '../src/superpowers.js';

function temporaryHome() {
  return mkdtempSync(join(tmpdir(), 'uro-superpowers-home-'));
}

function writePlugin(path, manifest, version) {
  mkdirSync(join(path, manifest), { recursive: true });
  mkdirSync(join(path, 'skills', 'using-superpowers'), { recursive: true });
  writeFileSync(join(path, manifest, 'plugin.json'), JSON.stringify({
    name: 'superpowers', version, skills: './skills/',
  }));
  writeFileSync(join(path, 'skills', 'using-superpowers', 'SKILL.md'), '# using superpowers\n');
}

test('resolveSuperpowersDir honours an existing URO_SUPERPOWERS_DIR', () => {
  const home = temporaryHome();
  const configured = join(home, 'configured-superpowers');
  writePlugin(configured, '.claude-plugin', '6.4.0');
  try {
    assert.equal(
      resolveSuperpowersDir({ seat: 'claude', env: { URO_SUPERPOWERS_DIR: configured }, home }),
      resolve(configured),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('resolveSuperpowersDir rejects a configured path that does not exist', () => {
  const home = temporaryHome();
  const missing = join(home, 'missing-superpowers');
  try {
    assert.throws(
      () => resolveSuperpowersDir({
        seat: 'claude', env: { URO_SUPERPOWERS_DIR: missing }, home,
      }),
      (error) => error instanceof Error
        && error.message.includes('URO_SUPERPOWERS_DIR')
        && error.message.includes(resolve(missing)),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('resolveSuperpowersDir returns null when no configured or cached install exists', () => {
  const home = temporaryHome();
  try {
    assert.equal(resolveSuperpowersDir({ seat: 'claude', env: {}, home }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('resolveSuperpowersDir selects the highest eligible version for the requested seat', () => {
  const home = temporaryHome();
  const versions = [
    join(home, '.claude', 'plugins', 'cache', 'superpowers-marketplace', 'superpowers', '6.9.0'),
    join(home, '.codex', 'plugins', 'cache', 'openai-curated-remote', 'superpowers', '6.10.0'),
    join(home, '.codex', 'plugins', 'cache', 'superpowers', '5.0.0'),
  ];
  writePlugin(versions[0], '.claude-plugin', '6.9.0');
  writePlugin(versions[1], '.codex-plugin', '6.10.0');
  writePlugin(versions[2], '.claude-plugin', '5.0.0');
  try {
    assert.equal(
      resolveSuperpowersDir({ seat: 'claude', env: {}, home }),
      resolve(versions[0]),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Claude resolves a lower compatible version instead of a higher Codex-only version', () => {
  const home = temporaryHome();
  const claude = join(
    home, '.claude', 'plugins', 'cache', 'superpowers-marketplace', 'superpowers', '6.0.2',
  );
  const codex = join(
    home, '.codex', 'plugins', 'cache', 'openai-curated-remote', 'superpowers', '6.3.0',
  );
  writePlugin(claude, '.claude-plugin', '6.0.2');
  writePlugin(codex, '.codex-plugin', '6.3.0');
  try {
    assert.equal(resolveSuperpowersDir({ seat: 'claude', env: {}, home }), resolve(claude));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Claude never falls back to a Codex-only plugin directory', () => {
  const home = temporaryHome();
  const codex = join(
    home, '.codex', 'plugins', 'cache', 'openai-curated-remote', 'superpowers', '6.3.0',
  );
  writePlugin(codex, '.codex-plugin', '6.3.0');
  try {
    assert.equal(resolveSuperpowersDir({ seat: 'claude', env: {}, home }), null);
    const verification = verifyDirectorySuperpowers({ seat: 'claude', env: {}, home });
    assert.equal(verification.verified, false);
    assert.match(verification.evidence, /Claude/i);
    assert.match(verification.remediation, /Claude/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a configured Claude directory without a valid .claude-plugin manifest is rejected', () => {
  const home = temporaryHome();
  const configured = join(home, 'codex-only-superpowers');
  writePlugin(configured, '.codex-plugin', '6.3.0');
  try {
    assert.throws(
      () => resolveSuperpowersDir({
        seat: 'claude', env: { URO_SUPERPOWERS_DIR: configured }, home,
      }),
      /Claude.*[.]claude-plugin/i,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Codex verification accepts only installed and enabled registry output', async () => {
  let installedInvocation;
  const installed = await verifyCodexSuperpowers({
    bin: 'codex',
    env: { CODEX_HOME: 'C:/registered-codex-home' },
    spawn: async (bin, args, options) => {
      installedInvocation = { bin, args, options };
      return {
        code: 0,
        timedOut: false,
        stdout: 'superpowers@openai-curated  installed, enabled  6.3.0  C:/plugins/superpowers\n',
        stderr: '',
      };
    },
  });
  const absent = await verifyCodexSuperpowers({
    bin: 'codex',
    spawn: async () => ({
      code: 0,
      timedOut: false,
      stdout: 'superpowers@openai-curated  not installed  C:/plugins/superpowers\n',
      stderr: '',
    }),
  });

  assert.equal(installed.verified, true);
  assert.equal(installed.version, '6.3.0');
  assert.match(installed.evidence, /installed, enabled/);
  assert.deepEqual(installedInvocation.args, ['plugin', 'list']);
  assert.equal(installedInvocation.options.env.CODEX_HOME, 'C:/registered-codex-home');
  assert.equal(absent.verified, false);
  assert.equal(absent.version, null);
  assert.match(absent.evidence, /not installed/);
  assert.match(absent.remediation, /Codex.*codex plugin add superpowers@openai-curated/i);
});

test('Codex verification requires the openai-curated registration, not a namesake plugin', async () => {
  const verification = await verifyCodexSuperpowers({
    spawn: async () => ({
      code: 0,
      timedOut: false,
      stdout: [
        'superpowers@untrusted-marketplace  installed, enabled  99.0.0  C:/other',
        'superpowers@openai-curated  not installed  C:/curated',
      ].join('\n'),
      stderr: '',
    }),
  });

  assert.equal(verification.verified, false);
  assert.match(verification.evidence, /superpowers@openai-curated.*not installed/i);
});

test('Codex verification recognizes the installed remote marketplace registration', async () => {
  const verification = await verifyCodexSuperpowers({
    spawn: async () => ({
      code: 0,
      timedOut: false,
      stdout: 'Name  Status  Version  Location\r\n  superpowers@openai-curated-remote  installed, enabled  6.3.0  C:/plugins/superpowers\r\n',
      stderr: '',
    }),
  });

  assert.equal(verification.verified, true);
  assert.equal(verification.version, '6.3.0');
  assert.match(verification.evidence, /superpowers@openai-curated-remote\s+installed, enabled/);
});

test('Codex verification selects an enabled supported registration regardless of row order', async (t) => {
  const cases = [
    {
      name: 'disabled remote before enabled curated',
      rows: [
        'superpowers@openai-curated-remote  installed, disabled  6.3.0  C:/remote',
        'superpowers@openai-curated  installed, enabled  6.2.0  C:/curated',
      ],
      version: '6.2.0', evidence: 'superpowers@openai-curated  installed, enabled',
    },
    {
      name: 'enabled curated before disabled remote',
      rows: [
        'superpowers@openai-curated  installed, enabled  6.2.0  C:/curated',
        'superpowers@openai-curated-remote  installed, disabled  6.3.0  C:/remote',
      ],
      version: '6.2.0', evidence: 'superpowers@openai-curated  installed, enabled',
    },
    {
      name: 'absent curated before enabled remote',
      rows: [
        'superpowers@openai-curated  not installed  C:/curated',
        'superpowers@openai-curated-remote  installed, enabled  6.3.0  C:/remote',
      ],
      version: '6.3.0', evidence: 'superpowers@openai-curated-remote  installed, enabled',
    },
    {
      name: 'enabled remote before absent curated',
      rows: [
        'superpowers@openai-curated-remote  installed, enabled  6.3.0  C:/remote',
        'superpowers@openai-curated  not installed  C:/curated',
      ],
      version: '6.3.0', evidence: 'superpowers@openai-curated-remote  installed, enabled',
    },
    {
      name: 'no enabled supported registration',
      rows: [
        'superpowers@openai-curated-remote  installed, disabled  6.3.0  C:/remote',
        'superpowers@openai-curated  not installed  C:/curated',
        'superpowers@untrusted-marketplace  installed, enabled  99.0.0  C:/untrusted',
      ],
      version: null, evidence: 'superpowers@openai-curated-remote  installed, disabled',
    },
    {
      name: 'lookalike first cannot replace rejected supported registrations',
      rows: [
        'superpowers@openai-curated-remote-untrusted  installed, enabled  99.0.0  C:/untrusted',
        'superpowers@openai-curated  not installed  C:/curated',
        'superpowers@openai-curated-remote  installed, disabled  6.3.0  C:/remote',
      ],
      version: null, evidence: 'superpowers@openai-curated  not installed',
    },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const verification = await verifyCodexSuperpowers({
        spawn: async () => ({
          code: 0, timedOut: false, stdout: fixture.rows.join('\n'), stderr: '',
        }),
      });
      assert.equal(verification.verified, fixture.version !== null);
      assert.equal(verification.version, fixture.version);
      assert.ok(verification.evidence.includes(fixture.evidence), 'evidence must describe the selected supported row');
    });
  }
});

test('Codex remote registration still requires installed and enabled status', async (t) => {
  for (const status of ['not installed', 'installed, disabled', 'installed', 'enabled']) {
    await t.test(status, async () => {
      const verification = await verifyCodexSuperpowers({
        spawn: async () => ({
          code: 0, timedOut: false,
          stdout: `superpowers@openai-curated-remote  ${status}  6.3.0  C:/plugins/superpowers\n`,
          stderr: '',
        }),
      });
      assert.equal(verification.verified, false);
      assert.equal(verification.version, null);
      assert.ok(verification.evidence.includes(status), 'retain the actual rejected registry status');
    });
  }
});

test('Codex verification rejects lookalike remote marketplace identifiers', async (t) => {
  for (const identifier of [
    'superpowers@openai-curated-remote-untrusted',
    'superpowers@openai-curated-untrusted',
    'superpowers-extra@openai-curated-remote',
    'superpowers@untrusted-marketplace',
  ]) {
    await t.test(identifier, async () => {
      const verification = await verifyCodexSuperpowers({
        spawn: async () => ({
          code: 0, timedOut: false,
          stdout: `${identifier}  installed, enabled  6.3.0  C:/plugins/superpowers\n`,
          stderr: '',
        }),
      });
      assert.equal(verification.verified, false);
      assert.equal(verification.version, null);
    });
  }
});

test('the hard requirement treats an omitted seat as unverified', () => {
  const verification = {
    ok: true,
    seats: {
      codex: {
        seat: 'codex', verified: true, evidence: 'Codex verified', remediation: 'unused',
      },
    },
  };

  const result = applySuperpowersRequirement(verification, {});

  assert.equal(result.ok, false);
  assert.match(result.reason, /Claude.*missing verification evidence/i);
  assert.match(result.reason, /plugin install superpowers@superpowers-marketplace/);
});
