import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadWorkflowBinding } from '../src/workflow-profiles.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const payload = ['install.mjs', 'package.json', 'README.md', 'LICENSE', 'PORTING.md', '.claude-plugin',
  'bin', 'src', 'fixtures', 'test', 'docs', 'commands', 'skills'];
function scratch(t) {
  const base = process.env.URO_TEST_DISTRIBUTION_ARTIFACT_ROOT ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'uro-workflow-distribution-'));
  if (!process.env.URO_TEST_DISTRIBUTION_ARTIFACT_ROOT) t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function run(bin, args, options = {}) {
  return spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024, ...options });
}
function save(directory, name, result) {
  writeFileSync(join(directory, `${name}.stdout.txt`), result.stdout ?? '');
  writeFileSync(join(directory, `${name}.stderr.txt`), result.stderr ?? '');
  writeFileSync(join(directory, `${name}.json`), JSON.stringify({ status: result.status, signal: result.signal,
    error: result.error?.message, stdoutSha256: sha(result.stdout ?? ''), stderrSha256: sha(result.stderr ?? '') }, null, 2));
}

for (const [name, file, tamper] of [
  ['missing adapted profile', 'adapted/bmad-planning.md', false],
  ['missing MIT notice', 'upstream/spec-kit/LICENSE', false],
  ['altered original source', 'upstream/spec-kit/templates/tasks-template.md', true],
  ['altered trademark notice', 'upstream/bmad/TRADEMARK.md', true],
]) test(`installer refuses ${name} before reporting prepared and leaves managed state untouched`, t => {
  const directory = scratch(t), source = join(directory, 'source'), home = join(directory, 'home');
  mkdirSync(source); mkdirSync(home);
  for (const item of payload) cpSync(join(root, item), join(source, item), { recursive: true });
  const target = join(source, 'src/workflow-profiles', file);
  if (tamper) writeFileSync(target, readFileSync(target, 'utf8') + '\nALTERED_FIXTURE_BYTES\n');
  else rmSync(target);
  mkdirSync(join(home, '.claude/plugins'), { recursive: true });
  const state = join(home, '.claude/plugins/installed_plugins.json');
  writeFileSync(state, '{"sentinel":"existing-managed-state"}\n');
  const result = run(process.execPath, [join(source, 'install.mjs'), '--dry-run'], {
    cwd: source, env: { ...process.env, HOME: home, USERPROFILE: home } });
  save(directory, 'installer', result);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /workflow|profile|digest|mismatch|missing/i);
  assert.doesNotMatch(result.stdout, /PLUGIN_STATUS=PREPARED|self-test: PASS/);
  assert.equal(readFileSync(state, 'utf8'), '{"sentinel":"existing-managed-state"}\n');
  assert.deepEqual(readdirSync(join(home, '.claude')), ['plugins']);
});

test('actual npm archive retains pinned workflow assets and loads its module and CLI offline', t => {
  const directory = scratch(t), extracted = join(directory, 'extracted');
  mkdirSync(extracted);
  const npmCli = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  assert.ok(existsSync(npmCli), `npm CLI must be available at ${npmCli}`);
  const packed = run(process.execPath, [npmCli, 'pack', '--offline', '--ignore-scripts', '--json',
    '--pack-destination', directory, '--cache', join(directory, 'npm-cache')], { cwd: root });
  save(directory, 'npm-pack', packed);
  assert.equal(packed.status, 0, packed.stdout + packed.stderr);
  const info = JSON.parse(packed.stdout)[0], archive = join(directory, info.filename);
  const listed = run('tar', ['-tzf', archive]); save(directory, 'archive-list', listed);
  assert.equal(listed.status, 0, listed.stderr);
  const unpacked = run('tar', ['-xzf', archive, '-C', extracted]); save(directory, 'archive-extract', unpacked);
  assert.equal(unpacked.status, 0, unpacked.stderr);
  const packagedRoot = join(extracted, 'package'), assets = join(packagedRoot, 'src/workflow-profiles');
  const manifest = JSON.parse(readFileSync(join(assets, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.profiles.map(p => [p.id, p.upstream.commit]), [
    ['bmad', 'abe4eb1bce919c9d22cd18b3519353d5824c4b75'],
    ['spec-kit', '0c8e31ff0a98c362696c2edb6a1bb25a37f68544'],
  ]);
  const inventory = [];
  for (const profile of manifest.profiles) for (const item of [...profile.sources, ...profile.notices, ...profile.sections]) {
    const archivePath = `package/src/workflow-profiles/${item.localPath}`;
    assert.ok(listed.stdout.split(/\r?\n/).includes(archivePath), `${archivePath} missing from actual archive`);
    const bytes = readFileSync(join(assets, item.localPath));
    assert.equal(sha(bytes), item.sha256, item.localPath);
    assert.deepEqual(bytes, readFileSync(join(root, 'src/workflow-profiles', item.localPath)));
    inventory.push({ path: item.localPath, bytes: bytes.length, sha256: sha(bytes) });
  }
  assert.equal(inventory.length, 15);
  for (const profile of ['bmad', 'spec-kit']) assert.match(readFileSync(join(assets, 'upstream', profile, 'LICENSE'), 'utf8'),
    /The above copyright notice and this permission notice/);
  // Block all network/provider effects in the actual packaged process, including direct Node APIs.
  const deny = `import net from 'node:net'; import dns from 'node:dns'; import http from 'node:http'; import https from 'node:https'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    const denied = () => { throw new Error('OFFLINE_PACKAGE_EFFECT_DENIED'); };
    net.Socket.prototype.connect = denied; dns.lookup = denied; http.request = denied; http.get = denied; https.request = denied; https.get = denied;
    for (const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) cp[key] = denied;
    globalThis.fetch = denied; syncBuiltinESMExports();`;
  const offline = ['--import', `data:text/javascript,${encodeURIComponent(deny)}`];
  const loaded = run(process.execPath, [...offline, '--input-type=module', '-e',
    `import {loadWorkflowBinding} from ${JSON.stringify(pathToFileURL(join(packagedRoot, 'src/workflow-profiles.js')).href)}; console.log(JSON.stringify(loadWorkflowBinding()));`], { cwd: packagedRoot });
  save(directory, 'packaged-load', loaded);
  assert.equal(loaded.status, 0, loaded.stderr);
  const binding = JSON.parse(loaded.stdout);
  assert.equal(binding.digest, loadWorkflowBinding().digest);
  assert.equal(binding.mode, 'bound');
  const help = run(process.execPath, [...offline, join(packagedRoot, 'bin/loop.js'), '--help'], { cwd: packagedRoot });
  save(directory, 'packaged-help', help);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Commands:/);
  assert.doesNotMatch(loaded.stderr + help.stderr, /OFFLINE_PACKAGE_EFFECT_DENIED/);
  writeFileSync(join(directory, 'workflow-inventory.json'), JSON.stringify({ archive, archiveSha256: sha(readFileSync(archive)),
    bindingDigest: binding.digest, manifestSha256: sha(readFileSync(join(assets, 'manifest.json'))), inventory }, null, 2));
});
