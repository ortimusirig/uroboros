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

test('dense non-NUL bytes are binary while equal-length printable ASCII remains text', async () => {
  const binary = Buffer.alloc(96, 0xff);
  const text = Buffer.from('a'.repeat(binary.length));
  const map = await buildRepoMap({
    target: 'T', budget: DEFAULT_MAP_BUDGET,
    spawn: fakeSpawnFor(['fixtures/dense.bin', 'fixtures/control.txt']),
    readFile: fakeRead({ 'fixtures/dense.bin': binary, 'fixtures/control.txt': text }),
  });

  assert.match(map, /fixtures\/dense\.bin \(binary — not line-counted or symbol-scanned\)/);
  assert.match(map, /fixtures\/control\.txt \(1 lines?\)/);
  assert.match(map, /Binary treatment:.*NUL.*30%.*not line-counted or symbol-scanned/i);
});

test('binary string test doubles use the same conservative classification', async () => {
  const map = await buildRepoMap({
    target: 'T', budget: DEFAULT_MAP_BUDGET,
    spawn: fakeSpawnFor(['fixtures/dense.dat']),
    readFile: fakeRead({ 'fixtures/dense.dat': '\xff'.repeat(64) }),
  });

  assert.match(map, /fixtures\/dense\.dat \(binary — not line-counted or symbol-scanned\)/);
});

test('a NUL anywhere marks a file binary, even beyond the heuristic sample', async () => {
  const content = Buffer.alloc(8 * 1024 + 1, 0x61);
  content[content.length - 1] = 0;
  const map = await buildRepoMap({
    target: 'T', budget: DEFAULT_MAP_BUDGET,
    spawn: fakeSpawnFor(['fixtures/late-nul.bin']),
    readFile: fakeRead({ 'fixtures/late-nul.bin': content }),
  });

  assert.match(map, /fixtures\/late-nul\.bin \(binary — not line-counted or symbol-scanned\)/);
});

test('binary content with a source extension is neither line-counted nor symbol-scanned', async () => {
  const binarySource = `${'\xff'.repeat(96)}\nexport function binaryTrap() {}\n`;
  const map = await buildRepoMap({
    target: 'T', budget: DEFAULT_MAP_BUDGET,
    spawn: fakeSpawnFor(['src/not-really.js']),
    readFile: fakeRead({ 'src/not-really.js': binarySource }),
  });

  assert.match(map, /src\/not-really\.js \(binary — not line-counted or symbol-scanned\)/);
  assert.doesNotMatch(map, /\d+ lines?/);
  assert.doesNotMatch(map, /binaryTrap/);
});

test('a budget-trimmed binary row remains covered by omission accounting and treatment disclosure', async () => {
  const textFiles = Array.from({ length: 40 }, (_, i) => `src/t${String(i).padStart(2, '0')}.txt`);
  const binaryPath = 'src/z-binary.bin';
  const files = [...textFiles, binaryPath];
  const contents = Object.fromEntries(textFiles.map((file) => [file, 'text\n']));
  contents[binaryPath] = Buffer.alloc(96, 0xff);

  const map = await buildRepoMap({
    target: 'T', budget: 900, spawn: fakeSpawnFor(files), readFile: fakeRead(contents),
  });

  assert.ok(map.length <= 900, `map ${map.length} exceeds its declared budget`);
  assert.doesNotMatch(map, /z-binary\.bin/, 'the fixture must exercise the trimmed-row fallback');
  assert.match(map, /Binary treatment:.*not line-counted or symbol-scanned/i);
  const omitted = Number(map.match(/… and (\d+) more files under src\/ \(budget\)/)?.[1]);
  const shown = [...map.matchAll(/^- src\/t\d+\.txt /gm)].length;
  assert.equal(shown + omitted, files.length, 'the omitted count must include the binary file');
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

test('a no-git fixture is measured against the budget too, even at the survey minimum', async () => {
  const map = await buildRepoMap({
    target: 'T',
    budget: MINIMUM_MAP_BUDGET,
    spawn: async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }),
    readFile: fakeRead({}),
  });
  assert.ok(map.length <= MINIMUM_MAP_BUDGET, `map ${map.length} exceeds MINIMUM_MAP_BUDGET ${MINIMUM_MAP_BUDGET}`);
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

test('a long spawn-rejection message is shortened to fit the budget, with an explicit marker', async () => {
  const longMessage = `spawn git ENOENT: ${'a'.repeat(180)}`;
  const map = await buildRepoMap({
    target: 'T',
    budget: MINIMUM_MAP_BUDGET,
    spawn: async () => { throw new Error(longMessage); },
    readFile: fakeRead({}),
  });
  assert.ok(map.length <= MINIMUM_MAP_BUDGET, `map ${map.length} exceeds MINIMUM_MAP_BUDGET ${MINIMUM_MAP_BUDGET}`);
  assert.match(map, /shortened: budget/);
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

    // The no-survey path is bound by the exact same budget, at every rung.
    const noGitMap = await buildRepoMap({
      target: 'T', budget,
      spawn: async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }),
      readFile: fakeRead({}),
    });
    assert.ok(noGitMap.length <= budget, `budget ${budget}: no-git map ${noGitMap.length} exceeds it`);
    assert.match(
      noGitMap,
      /no file survey was produced/i,
      `budget ${budget}: no-git declaration did not survive`,
    );
  }
});

test('non-finite numeric budgets are rejected with the received value and a repair', async () => {
  for (const budget of [NaN, Infinity]) {
    await assert.rejects(
      () => buildRepoMap({
        target: 'T', budget, spawn: fakeSpawnFor([]), readFile: fakeRead({}),
      }),
      (error) => {
        assert.match(error.message, new RegExp(`received ${String(budget)}`));
        assert.match(error.message, /must be a finite number of characters, e\.g\. 12000/);
        return true;
      },
    );
  }
});

test('numeric-looking string budgets are rejected with conversion guidance', async () => {
  for (const budget of ['12k', '12000']) {
    await assert.rejects(
      () => buildRepoMap({
        target: 'T', budget, spawn: fakeSpawnFor([]), readFile: fakeRead({}),
      }),
      (error) => {
        assert.ok(error.message.includes(budget), `message did not name received value ${budget}`);
        assert.match(error.message, /pass a number \(parse or convert it\)/);
        assert.match(error.message, /must be a finite number of characters, e\.g\. 12000/);
        return true;
      },
    );
  }
});

test("budgets below the survey's minimum are rejected with the value, floor, and repair", async () => {
  for (const budget of [0, MINIMUM_MAP_BUDGET - 1]) {
    await assert.rejects(
      () => buildRepoMap({
        target: 'T', budget, spawn: fakeSpawnFor([]), readFile: fakeRead({}),
      }),
      (error) => {
        assert.match(error.message, new RegExp(`received ${budget}`));
        assert.match(error.message, new RegExp(`MINIMUM_MAP_BUDGET \\(${MINIMUM_MAP_BUDGET}\\)`));
        assert.match(error.message, new RegExp(`increase it to ${MINIMUM_MAP_BUDGET} or more`, 'i'));
        return true;
      },
    );
  }
});

test('the exact minimum map budget remains valid', async () => {
  const map = await buildRepoMap({
    target: 'T',
    budget: MINIMUM_MAP_BUDGET,
    spawn: fakeSpawnFor(['src/a.js']),
    readFile: fakeRead({ 'src/a.js': 'x\n' }),
  });
  assert.ok(map.length <= MINIMUM_MAP_BUDGET);
});
