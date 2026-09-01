// test/repo-map.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRepoMap, DEFAULT_MAP_BUDGET, MINIMUM_MAP_BUDGET } from '../src/repo-map.js';

function fakeSpawnFor(files) {
  return async (bin, args) => {
    assert.equal(bin, 'git');
    assert.deepEqual(args.slice(-1), ['ls-files']);
    return { code: 0, stdout: `${files.join('\n')}\n`, stderr: '' };
  };
}
const fakeRead = (contents) => (path) => {
  const key = Object.keys(contents).find((name) => path.replaceAll('\\', '/').endsWith(name));
  if (key === undefined) throw new Error(`ENOENT ${path}`);
  return contents[key];
};

test('the map declares its grade, its fetchability, and every omission', async () => {
  const files = ['src/a.js', 'src/b.js', 'docs/c.md'];
  const map = await buildRepoMap({
    target: 'T', budget: DEFAULT_MAP_BUDGET,
    spawn: fakeSpawnFor(files),
    readFile: fakeRead({ 'src/a.js': 'export function alpha() {}\n', 'src/b.js': 'x\n', 'docs/c.md': '# c\n' }),
  });
  assert.match(map, /heuristic file\/symbol survey, not the repository/);
  assert.match(map, /may read any file directly/i);
  assert.match(map, /src\/a\.js \(1 lines?\)/);
  assert.match(map, /alpha/);
  assert.doesNotMatch(map, /and \d+ more files/, 'nothing was withheld, so nothing claims to be');
});

test('a trimming budget names exactly what it withheld — never a silent cap', async () => {
  const files = Array.from({ length: 400 }, (_, i) => `src/mod${String(i).padStart(3, '0')}.js`);
  const contents = Object.fromEntries(files.map((f) => [f, 'export const x = 1;\n'.repeat(3)]));
  const map = await buildRepoMap({
    target: 'T', budget: 1200, spawn: fakeSpawnFor(files), readFile: fakeRead(contents),
  });
  assert.ok(map.length <= 1200, `map ${map.length} exceeds its declared budget`);
  assert.match(map, /and \d+ more files under src/, 'the trim must be named');
  assert.match(map, /may read any file directly/i, 'fetchability survives trimming');
});

test('outside a git repository the map says so instead of pretending', async () => {
  const map = await buildRepoMap({
    target: 'T', spawn: async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }),
    readFile: fakeRead({}),
  });
  assert.match(map, /not a git repository/i);
  assert.match(map, /no file survey was produced/i);
});

test('many omitted directories collapse into one bounded note — the budget bounds the notes too', async () => {
  const files = Array.from({ length: 60 }, (_, i) => `d${String(i).padStart(2, '0')}/a.js`);
  const contents = Object.fromEntries(files.map((f) => [f, 'export const x = 1;\n']));
  const map = await buildRepoMap({
    target: 'T', budget: 900, spawn: fakeSpawnFor(files), readFile: fakeRead(contents),
  });
  assert.ok(map.length <= 900, `map ${map.length} exceeds its declared budget of 900`);
  assert.match(map, /withheld|more files/i, 'the omission declaration survives collapsing');
  assert.match(map, /may read any file directly/i, 'fetchability line survives collapsing');
});

test('a spawn rejection (e.g. ENOENT) is as honest a "no survey" as a non-zero exit', async () => {
  const map = await buildRepoMap({
    target: 'T',
    spawn: async () => { throw new Error('spawn git ENOENT'); },
    readFile: fakeRead({}),
  });
  assert.match(map, /no file survey was produced/i);
});

test('every budget from the minimum up stays within itself and stays honest', async () => {
  const files = Array.from({ length: 60 }, (_, i) => `d${String(i).padStart(2, '0')}/a.js`);
  const contents = Object.fromEntries(files.map((f) => [f, 'export const x = 1;\n']));
  for (let budget = MINIMUM_MAP_BUDGET; budget <= 1500; budget += 7) {
    const map = await buildRepoMap({
      target: 'T', budget, spawn: fakeSpawnFor(files), readFile: fakeRead(contents),
    });
    assert.ok(map.length <= budget, `budget ${budget}: map ${map.length} exceeds it`);
    assert.match(
      map,
      /read the tree directly|read any file directly/i,
      `budget ${budget}: no fetchability/withholding line survived`,
    );
  }
});

test("a budget below the survey's minimum is rejected, never silently overflowed", async () => {
  await assert.rejects(
    () => buildRepoMap({
      target: 'T',
      budget: MINIMUM_MAP_BUDGET - 1,
      spawn: fakeSpawnFor(['src/a.js']),
      readFile: fakeRead({ 'src/a.js': 'x\n' }),
    }),
    /at least .*characters/,
  );
});
