import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { copyWorkflowPackage, importWorkflowPackage } from './fixtures/workflow-profile-fixture.js';

const modulePath = fileURLToPath(new URL('../src/workflow-profiles.js', import.meta.url));

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sorted(value[key])]),
  );
  return value;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function digest(binding) {
  const { digest: ignored, ...material } = binding;
  return sha256(JSON.stringify(sorted(material)));
}

async function shippedModule() {
  assert.equal(existsSync(modulePath), true, 'offline workflow loader is missing');
  return import(pathToFileURL(modulePath).href);
}

test('shipped workflow binding can be captured without a provider or network', async () => {
  const { loadWorkflowBinding } = await shippedModule();
  const binding = loadWorkflowBinding();
  assert.equal(binding.mode, 'bound');
  assert.deepEqual(binding.profiles.map((profile) => profile.id), ['bmad', 'spec-kit']);
  assert.equal(Object.isFrozen(binding.profiles[0].sections), true);
});

test('loader hand-checks each shipped adapted, source, and notice byte before capture', async () => {
  const { loadWorkflowBinding } = await shippedModule();
  const binding = loadWorkflowBinding();
  const manifest = JSON.parse(readFileSync(new URL('../src/workflow-profiles/manifest.json', import.meta.url), 'utf8'));
  for (const profile of binding.profiles) {
    const saved = manifest.profiles.find((candidate) => candidate.id === profile.id);
    for (const group of ['sources', 'notices', 'sections']) {
      for (const asset of saved[group]) {
        const bytes = readFileSync(new URL(`../src/workflow-profiles/${asset.localPath}`, import.meta.url));
        assert.equal(sha256(bytes), asset.sha256, `${profile.id} ${group} ${asset.path}`);
      }
    }
  }
});

test('copied package refuses changed adapted content instead of silently using it', async (t) => {
  const fixture = copyWorkflowPackage(t);
  writeFileSync(join(fixture.assetsPath, 'adapted', 'bmad-planning.md'), 'changed bytes\n');
  const copied = await importWorkflowPackage(fixture.modulePath);
  assert.throws(() => copied.loadWorkflowBinding(), /bmad.*section|asset/i);
});

test('copied package refuses missing assets and traversal metadata before capture', async (t) => {
  const fixture = copyWorkflowPackage(t);
  rmSync(join(fixture.assetsPath, 'upstream', 'bmad', 'LICENSE'));
  let copied = await importWorkflowPackage(fixture.modulePath);
  assert.throws(() => copied.loadWorkflowBinding(), /bmad.*notice|asset/i);

  const second = copyWorkflowPackage(t);
  const manifestPath = join(second.assetsPath, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.profiles[0].sources[0].localPath = '../outside.md';
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  copied = await importWorkflowPackage(second.modulePath);
  assert.throws(() => copied.loadWorkflowBinding(), /path|source/i);

  const third = copyWorkflowPackage(t);
  const profileManifest = join(third.assetsPath, 'manifest.json');
  const withoutProfile = JSON.parse(readFileSync(profileManifest, 'utf8'));
  withoutProfile.profiles.pop();
  writeFileSync(profileManifest, `${JSON.stringify(withoutProfile, null, 2)}\n`);
  copied = await importWorkflowPackage(third.modulePath);
  assert.throws(() => copied.loadWorkflowBinding(), /profile/i);

  const fourth = copyWorkflowPackage(t);
  writeFileSync(join(fourth.assetsPath, 'manifest.json'), '{not json');
  copied = await importWorkflowPackage(fourth.modulePath);
  assert.throws(() => copied.loadWorkflowBinding(), /malformed/i);
});

test('copied package refuses symlinked profile assets when symlinks are permitted', async (t) => {
  const fixture = copyWorkflowPackage(t);
  const asset = join(fixture.assetsPath, 'adapted', 'bmad-execution.md');
  try {
    const content = readFileSync(asset);
    rmSync(asset);
    const replacement = join(fixture.root, 'replacement.md');
    writeFileSync(replacement, content);
    symlinkSync(replacement, asset, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) return;
    throw error;
  }
  const copied = await importWorkflowPackage(fixture.modulePath);
  assert.throws(() => copied.loadWorkflowBinding(), /regular|symlink|asset/i);
});

test('captured bindings reject malformed identities, duplicate and unknown profile sections', async () => {
  const module = await shippedModule();
  const binding = structuredClone(module.loadWorkflowBinding());
  binding.profiles[0].sections[0].content = 'changed capture';
  binding.digest = digest(binding);
  assert.throws(() => module.validateWorkflowBinding({ binding }), /section.*hash/i);

  const duplicate = structuredClone(module.loadWorkflowBinding());
  duplicate.profiles.push(structuredClone(duplicate.profiles[0]));
  duplicate.digest = digest(duplicate);
  assert.throws(() => module.validateWorkflowBinding({ binding: duplicate }), /profile|duplicate/i);

  const unknownProfile = structuredClone(module.loadWorkflowBinding());
  unknownProfile.profiles[1].id = 'other';
  unknownProfile.digest = digest(unknownProfile);
  assert.throws(() => module.validateWorkflowBinding({ binding: unknownProfile }), /profile/i);

  const duplicateSection = structuredClone(module.loadWorkflowBinding());
  duplicateSection.profiles[0].sections[1] = structuredClone(duplicateSection.profiles[0].sections[0]);
  duplicateSection.digest = digest(duplicateSection);
  assert.throws(() => module.validateWorkflowBinding({ binding: duplicateSection }), /section/i);

  const unknown = structuredClone(module.loadWorkflowBinding());
  unknown.profiles[0].sections[0].id = 'other';
  unknown.profiles[0].sections[0].phases = ['other'];
  unknown.profiles[0].sections[0].sha256 = sha256(unknown.profiles[0].sections[0].content);
  unknown.digest = digest(unknown);
  assert.throws(() => module.validateWorkflowBinding({ binding: unknown }), /section|phase/i);

});

test('copied package refuses a changed pinned source byte', async (t) => {
  const fixture = copyWorkflowPackage(t);
  writeFileSync(join(fixture.assetsPath, 'upstream', 'bmad', 'skills', 'bmad-correct-course', 'SKILL.md'), 'changed source bytes\n');
  const copied = await importWorkflowPackage(fixture.modulePath);
  assert.throws(() => copied.loadWorkflowBinding(), /bmad.*source|asset/i);
});

test('saved valid capture remains valid after a different installed package is damaged', async (t) => {
  const module = await shippedModule();
  const captured = structuredClone(module.loadWorkflowBinding());
  const fixture = copyWorkflowPackage(t);
  writeFileSync(join(fixture.assetsPath, 'adapted', 'spec-kit-acceptance.md'), 'new default would differ\n');
  const copied = await importWorkflowPackage(fixture.modulePath);
  assert.throws(() => copied.loadWorkflowBinding(), /spec-kit.*section|asset/i);
  assert.deepEqual(module.validateWorkflowBinding({ binding: captured }), captured);
});

test('snapshot binding marker and entry agree and reject conflicts', async () => {
  const module = await shippedModule();
  const binding = module.loadWorkflowBinding();
  const entry = module.workflowSnapshotEntry({ binding });
  const snapshot = { workflow: module.workflowIdentity({ binding }), entries: [entry] };
  assert.deepEqual(module.readWorkflowBinding({ snapshot, expected: snapshot.workflow }), binding);
  assert.throws(() => module.readWorkflowBinding({ snapshot: { ...snapshot, entries: [] } }), /entry|binding/i);
  assert.throws(() => module.readWorkflowBinding({ snapshot: { ...snapshot, workflow: { ...snapshot.workflow, digest: '0'.repeat(64) } } }), /identity|digest/i);
  assert.throws(() => module.readWorkflowBinding({ snapshot: { entries: [entry] } }), /marker|workflow/i);
});

test('snapshot binding accepts reordered equivalent bound marker and expected identity fields', async () => {
  const module = await shippedModule();
  const binding = module.loadWorkflowBinding();
  const entry = module.workflowSnapshotEntry({ binding });
  const identity = module.workflowIdentity({ binding });
  const reordered = { digest: identity.digest, mode: 'bound', schemaVersion: 1 };
  assert.deepEqual(module.readWorkflowBinding({
    snapshot: { workflow: reordered, entries: [entry] },
    expected: { mode: 'bound', schemaVersion: 1, digest: identity.digest },
  }), binding);
});

test('legacy absence accepts only an equivalent legacy expected identity', async () => {
  const module = await shippedModule();
  const absent = { entries: [] };
  assert.deepEqual(module.readWorkflowBinding({
    snapshot: absent,
    expected: { mode: 'legacy-unbound', schemaVersion: 1 },
    allowLegacy: true,
  }), { schemaVersion: 1, mode: 'legacy-unbound' });
  const binding = module.loadWorkflowBinding();
  assert.throws(() => module.readWorkflowBinding({
    snapshot: absent,
    expected: module.workflowIdentity({ binding }),
    allowLegacy: true,
  }), /expected|binding/i);
  assert.throws(() => module.readWorkflowBinding({
    snapshot: absent,
    expected: { mode: 'bound', schemaVersion: 1, digest: 'not-a-sha256' },
    allowLegacy: true,
  }), /expected|identity/i);
});

test('guidance projects only the requested fixed phase and summaries are curated', async () => {
  const module = await shippedModule();
  const binding = module.loadWorkflowBinding();
  const planning = module.renderWorkflowGuidance({ binding, phase: 'planning' });
  assert.match(planning, /BMAD/i);
  assert.match(planning, /Spec Kit/i);
  assert.doesNotMatch(planning, /Spec Kit execution/i);
  assert.throws(() => module.renderWorkflowGuidance({ binding, phase: 'unknown' }), /phase/i);
  assert.deepEqual(module.summarizeWorkflowBinding({ binding, phase: 'execution' }).profiles.map((profile) => profile.sections), [['execution'], ['execution']]);
  assert.match(module.renderWorkflowGuidance({ binding: { schemaVersion: 1, mode: 'legacy-unbound' }, phase: 'planning' }), /unbound/i);
});
