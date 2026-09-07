import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const guides = ['usage', 'publishing', 'porting'].map(name => `docs/guides/${name}.md`);
const history = ['2026-08-25-three-way-debate-loop', '2026-08-27-performance-findings',
  '2026-08-15-observability-completeness-audit'].map(name => `docs/history/${name}.md`);

test('canonical guides, history and public redirects have resolvable local navigation', () => {
  for (const file of ['README.md', 'docs/README.md', ...guides, ...history, 'docs/usage.md', 'docs/publishing.md', 'PORTING.md']) {
    const path = resolve(root, file);
    assert.ok(existsSync(path), `missing canonical document: ${file}`);
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/\]\((<[^>]+>|[^)]+)\)/g)) {
      const href = match[1].replace(/^<|>$/g, '');
      if (/^[a-z]+:/i.test(href)) continue;
      const [name, anchor] = href.split('#');
      const destination = name ? resolve(dirname(path), decodeURIComponent(name)) : path;
      assert.ok(!relative(root, destination).startsWith('..'), `${file}: link escapes repository: ${href}`);
      assert.ok(existsSync(destination), `${file}: broken link ${href}`);
      if (anchor) {
        const target = readFileSync(destination, 'utf8');
        const headings = [...target.matchAll(/^#{1,6}\s+(.+)$/gm)].map(item => item[1].toLowerCase()
          .replace(/[^\p{L}\p{N}_\- ]/gu, '').replaceAll(' ', '-'));
        assert.ok(headings.includes(anchor) || target.includes(`id="${anchor}"`), `${file}: broken fragment ${href}`);
      }
    }
  }
  for (const [old, canonical] of [['docs/usage.md', 'guides/usage.md'], ['docs/publishing.md', 'guides/publishing.md'], ['PORTING.md', 'docs/guides/porting.md']]) {
    const redirect = readFileSync(resolve(root, old), 'utf8');
    assert.ok(redirect.length < 700, `${old} duplicates live guidance`);
    assert.ok(redirect.includes(`](${canonical})`));
  }
  assert.match(readFileSync(resolve(root, 'docs/usage.md'), 'utf8'), /guides\/usage\.md#manual-resume/);
});

test('readable payload preserves precise historical findings exclusion and stable runtime records', () => {
  const installer = readFileSync(resolve(root, 'install.mjs'), 'utf8');
  const filterSource = installer.match(/function isPayloadFile\(item, child\) \{[\s\S]*?\n\}/)[0];
  const included = vm.runInNewContext(`(${filterSource})`);
  for (const path of ['guides/usage.md', 'guides/publishing.md', 'guides/porting.md', 'README.md',
    'history/2026-08-25-three-way-debate-loop.md', 'history/2026-08-15-observability-completeness-audit.md',
    'history/future-history.md', 'runs/README.md', 'optional-tools/logdy-run-events.json']) assert.equal(included('docs', path), true, path);
  assert.equal(included('docs', 'history/2026-08-27-performance-findings.md'), false);
  assert.equal(included('docs', 'runs/generated-run.md'), false);
  const payload = vm.runInNewContext(installer.match(/const PAYLOAD\s*=\s*(\[[\s\S]*?\]);/)[1]);
  for (const dir of ['campaign', 'uro-project']) {
    assert.ok(existsSync(resolve(root, dir)));
    assert.equal(payload.includes(dir), false);
  }
  for (const dir of ['src', 'bin', 'test', 'fixtures', 'commands', 'skills', 'docs', 'PORTING.md']) assert.ok(payload.includes(dir));
});
