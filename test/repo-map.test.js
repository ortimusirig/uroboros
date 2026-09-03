// test/repo-map.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRepoMap, DEFAULT_MAP_BUDGET, MINIMUM_MAP_BUDGET, readPrefixSync,
} from '../src/repo-map.js';

function fakeSpawnFor(files) {
  return async (bin, args) => {
    assert.equal(bin, 'git');
    assert.deepEqual(args.slice(-1), ['ls-files']);
    return { code: 0, stdout: `${files.join('\n')}\n`, stderr: '' };
  };
}
const fakeRead = (contents) => {
  const find = (path) => Object.keys(contents).find((name) => path.replaceAll('\\', '/').endsWith(name));
  const read = (path) => {
    const key = find(path);
    if (key === undefined) throw new Error(`ENOENT ${path}`);
    return contents[key];
  };
  read.stat = (path) => {
    const key = find(path);
    if (key === undefined) throw new Error(`ENOENT ${path}`);
    const content = contents[key];
    return { size: typeof content === 'string' ? Buffer.byteLength(content) : content.length };
  };
  return read;
};

function symbolAccounting(map) {
  const count = (label) => Number(map.match(new RegExp(`${label}(?::|=)\\s*(\\d+)`))?.[1] ?? 0);
  return {
    rendered: count('scan-ran-with-results-rendered'),
    withheld: count('scan-ran-but-result-withheld'),
    neverRan: count('scan-never-ran'),
    symbolsSkipped: count('symbolsSkipped'),
    zeroResults: count('zero-results'),
  };
}

function symbolStateFixture({ longOmissions = false } = {}) {
  const files = ['s/a.js', 's/b.js', 's/c.js', 's/d.js', 's/e.js'];
  const contents = {
    's/a.js': `export const shown = 1;\n${'// filler\n'.repeat(39)}`,
    's/b.js': '// no symbols\n'.repeat(35),
    's/c.js': `${Array.from({ length: 30 }, (_, i) => (
      `export const withheldSymbol_${String(i).padStart(2, '0')}_${'x'.repeat(24)} = ${i};`
    )).join('\n')}\n`,
    's/d.js': `export const neverOne = 1;\n${'// filler\n'.repeat(19)}`,
    's/e.js': `export const neverTwo = 2;\n${'// filler\n'.repeat(9)}`,
  };

  if (longOmissions) {
    for (let i = 0; i < 8; i++) {
      const path = `z${i}-${'x'.repeat(300)}/note.txt`;
      files.push(path);
      contents[path] = 'note\n';
    }
  }

  return { files, contents };
}

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

test('the detailed rung distinguishes rendered, withheld, and never-ran symbol scans', async () => {
  const { files, contents } = symbolStateFixture();
  const map = await buildRepoMap({
    target: 'T', budget: 1500, spawn: fakeSpawnFor(files), readFile: fakeRead(contents),
  });

  assert.match(map, /^## Symbols \(largest files first\)$/m);
  assert.match(map, /^- s\/a\.js: shown$/m);
  assert.deepEqual(symbolAccounting(map), {
    rendered: 2,
    withheld: 1,
    neverRan: 0,
    symbolsSkipped: 0,
    zeroResults: 1,
  });
});

test('collapsedNoSymbols reclassifies removed symbol rows as withheld results, not skipped scans', async () => {
  const base = symbolStateFixture();
  const crowded = symbolStateFixture({ longOmissions: true });
  let map;
  let selectedBudget;

  for (let budget = MINIMUM_MAP_BUDGET; budget <= 2600; budget++) {
    const control = await buildRepoMap({
      target: 'T', budget, spawn: fakeSpawnFor(base.files), readFile: fakeRead(base.contents),
    });
    const candidate = await buildRepoMap({
      target: 'T', budget, spawn: fakeSpawnFor(crowded.files), readFile: fakeRead(crowded.contents),
    });
    if (
      /^## Symbols \(largest files first\)$/m.test(control)
      && /^## Files$/m.test(candidate)
      && !/^## Symbols \(largest files first\)$/m.test(candidate)
      && /omissions for 8 directories \(8 files\)/.test(candidate)
    ) {
      map = candidate;
      selectedBudget = budget;
      break;
    }
  }

  assert.ok(map, 'fixture did not reach the collapsedNoSymbols rung');
  assert.ok(map.length <= selectedBudget);
  assert.doesNotMatch(map, /^- s\/a\.js: shown$/m, 'the rendered symbol row must be removed on this rung');
  assert.deepEqual(symbolAccounting(map), {
    rendered: 1,
    withheld: 2,
    neverRan: 0,
    symbolsSkipped: 0,
    zeroResults: 1,
  });
});

test('the compact fallback keeps all three symbol-scan states explicit', async () => {
  const files = ['s/empty.js', 's/withheld.js', 's/never-one.js', 's/never-two.js'];
  const contents = {
    's/empty.js': '// no symbols\n'.repeat(50),
    's/withheld.js': `export const withheld = 1;\n${'// filler\n'.repeat(39)}`,
    's/never-one.js': `export const neverOne = 1;\n${'// filler\n'.repeat(29)}`,
    's/never-two.js': `export const neverTwo = 2;\n${'// filler\n'.repeat(19)}`,
  };
  const map = await buildRepoMap({
    target: 'T', budget: MINIMUM_MAP_BUDGET,
    spawn: fakeSpawnFor(files), readFile: fakeRead(contents),
  });

  assert.match(map, /^## Files$/m, 'the fixture must exercise the compact fallback');
  assert.deepEqual(symbolAccounting(map), {
    rendered: 1,
    withheld: 1,
    neverRan: 0,
    symbolsSkipped: 0,
    zeroResults: 1,
  });
});

test('a scanned-empty source contributes zero to symbolsSkipped', async () => {
  const map = await buildRepoMap({
    target: 'T', budget: DEFAULT_MAP_BUDGET,
    spawn: fakeSpawnFor(['src/empty.js']),
    readFile: fakeRead({ 'src/empty.js': '// no declarations\n' }),
  });

  assert.deepEqual(symbolAccounting(map), {
    rendered: 1,
    withheld: 0,
    neverRan: 0,
    symbolsSkipped: 0,
    zeroResults: 1,
  });
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

  const budget = Math.max(900, MINIMUM_MAP_BUDGET);
  const map = await buildRepoMap({
    target: 'T', budget, spawn: fakeSpawnFor(files), readFile: fakeRead(contents),
  });

  assert.ok(map.length <= budget, `map ${map.length} exceeds its declared budget`);
  assert.doesNotMatch(map, /z-binary\.bin/, 'the fixture must exercise the trimmed-row fallback');
  assert.match(map, /Binary treatment:.*not line-counted or symbol-scanned/i);
  const declared = map.match(/inspected=(\d+)[,;].*admitted-but-too-large=(\d+)[,;].*omitted=(\d+)/);
  assert.equal(
    Number(declared?.[1] ?? 0) + Number(declared?.[2] ?? 0) + Number(declared?.[3] ?? 0),
    files.length,
    'the declared identities must account for the binary file',
  );
});

test('a trimming budget names exactly what it withheld — never a silent cap', async () => {
  const files = Array.from({ length: 400 }, (_, i) => `src/mod${String(i).padStart(3, '0')}.js`);
  const contents = Object.fromEntries(files.map((f) => [f, 'export const x = 1;\n'.repeat(3)]));
  const map = await buildRepoMap({
    target: 'T', budget: 1200, spawn: fakeSpawnFor(files), readFile: fakeRead(contents),
  });
  assert.ok(map.length <= 1200, `map ${map.length} exceeds its declared budget`);
  assert.match(map, /omitted=397/, 'the admission trim must be declared');
  assert.match(map, /Details withheld \(budget\)/, 'the fallback must name its withheld detail');
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
  const budget = Math.max(900, MINIMUM_MAP_BUDGET);
  const map = await buildRepoMap({
    target: 'T', budget, spawn: fakeSpawnFor(files), readFile: fakeRead(contents),
  });
  assert.ok(map.length <= budget, `map ${map.length} exceeds its declared budget of ${budget}`);
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
  const longMessage = `spawn git ENOENT: ${'a'.repeat(MINIMUM_MAP_BUDGET * 2)}`;
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

test('the named content-admission rule bounds positive reads equally for a large tree and its doubled twin', async () => {
  const large = Array.from({ length: 1700 }, (_, index) => `src/f${String(index).padStart(4, '0')}.js`);
  const doubled = [...large, ...large.map((path) => path.replace('src/', 'extra/'))];
  const budget = 1200;

  async function survey(files) {
    const reads = [];
    const map = await buildRepoMap({
      target: 'T', budget, spawn: fakeSpawnFor(files),
      stat: () => ({ size: 24 }),
      readFile: (path, options) => {
        reads.push({ path, options });
        return 'export const bounded = 1;\n';
      },
    });
    return { map, reads };
  }

  const one = await survey(large);
  const two = await survey(doubled);
  const ceiling = (map) => Number(map.match(/Content admission rule: [^\n]*r≤(\d+)/)?.[1]);

  assert.ok(ceiling(one.map) > 0, 'the declared ceiling must be positive at this budget');
  assert.equal(ceiling(one.map), ceiling(two.map), 'the operator budget alone determines the ceiling');
  assert.ok(one.reads.length > 0, 'the test must observe real content reads, not only a below-ceiling count');
  assert.ok(one.reads.length <= ceiling(one.map));
  assert.ok(two.reads.length <= ceiling(two.map));
  assert.equal(one.reads.length, two.reads.length, 'doubling tracked files must not double content reads');
});

test('an oversized admitted file is prefix-read at the declared limit and remains admitted-but-too-large', async () => {
  const calls = [];
  const map = await buildRepoMap({
    target: 'T', budget: 1200, spawn: fakeSpawnFor(['src/huge.js']),
    stat: () => ({ size: 50_000 }),
    readFile: (path, options) => {
      calls.push({ path, options });
      return Buffer.alloc(options.length, 0x61);
    },
  });

  const byteCeiling = Number(map.match(/Content admission rule: [^\n]*b≤(\d+)/)?.[1]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.length, byteCeiling + 1);
  assert.match(map, /states in rows/);
  assert.match(map, /src\/huge\.js \(admitted-but-too-large/);
});

test('metadata failures and a longest classified row remain declared within the pre-read template reservation', async () => {
  const longPath = `src/${'long-'.repeat(28)}name.js`;
  const map = await buildRepoMap({
    target: 'T', budget: 4000, spawn: fakeSpawnFor(['src/no-metadata.js', longPath]),
    stat: (path) => {
      if (path.endsWith('no-metadata.js')) throw new Error('EACCES');
      return { size: 28 };
    },
    readFile: () => 'export const visible = 1;\n',
  });

  const reservation = Number(map.match(/Pre-read row reservation: (\d+) chars/)?.[1]);
  const longRow = map.match(new RegExp(`^- ${longPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\([^\\n]+\\)(?: \\[inspected\\])?$`, 'm'))?.[0];
  assert.match(map, /src\/no-metadata\.js \(metadata-unavailable; inspected\)/);
  assert.ok(longRow, 'the longest classified path must have a visible row');
  assert.ok(longRow.length <= reservation, `${longRow.length} must fit the declared reservation ${reservation}`);
});

test('availability facets preserve admitted inspection identity and omitted identity', async () => {
  const files = [
    'a/stat-fails.js', 'b/read-fails.js', 'c/works.js', 'd/works.js', 'e/works.js',
    'f/works.js', 'g/works.js', 'h/works.js', 'i/works.js', 'j/works.js', 'z/omitted-stat-fails.js',
  ];
  const map = await buildRepoMap({
    target: 'T', budget: 4000, spawn: fakeSpawnFor(files),
    stat: (path) => {
      if (path.endsWith('stat-fails.js')) throw new Error('EACCES');
      return { size: 24 };
    },
    readFile: (path) => {
      if (path.endsWith('read-fails.js')) throw new Error('EIO');
      return 'export const works = 1;\n';
    },
  });

  assert.match(map, /inspected=10; admitted-but-too-large=0; omitted=1/);
  assert.match(map, /metadata-unavailable=2/);
  assert.match(map, /content-unavailable=1/);
  assert.match(map, /a\/stat-fails\.js \(metadata-unavailable; inspected\)/);
  assert.match(map, /b\/read-fails\.js \(content-unavailable; inspected\)/);
  assert.match(map, /z\/omitted-stat-fails\.js \(metadata-unavailable; omitted/);
});

test('fallback declarations retain every identity and render an omitted row whenever it fits', async () => {
  const files = [
    `src/${'a'.repeat(240)}.js`,
    `src/${'b'.repeat(1000)}.js`,
    `src/${'c'.repeat(240)}.js`,
    `src/${'d'.repeat(240)}.js`,
    `src/${'e'.repeat(240)}.js`,
    `src/${'f'.repeat(240)}.js`,
  ];
  const map = await buildRepoMap({
    target: 'T', budget: 2000, spawn: fakeSpawnFor(files),
    stat: (path) => ({ size: path.includes('b'.repeat(1000)) ? 50_000 : 24 }),
    readFile: () => 'export const visible = 1;\n',
  });

  assert.match(map, /^## Withheld by the budget$/m);
  assert.match(map, /inspected rows withheld/);
  assert.match(map, /admitted-but-too-large rows withheld/);
  assert.match(map, /omitted=1/);
  assert.match(map, /\.js \(omitted; content admission budget\)/);
});

test('content reads execute in declared lexical admission order', async () => {
  const calls = [];
  await buildRepoMap({
    target: 'T', budget: 1200,
    spawn: fakeSpawnFor(['src/m.js', 'src/z.js', 'src/a.js', 'src/q.js']),
    stat: () => ({ size: 24 }),
    readFile: (path) => {
      calls.push(path.replaceAll('\\', '/').split('/').slice(-2).join('/'));
      return 'export const ordered = 1;\n';
    },
  });
  assert.deepEqual(calls, ['src/a.js', 'src/m.js', 'src/q.js']);
});

test('the exact minimum declares all-zero content identities for an empty tracked tree', async () => {
  const map = await buildRepoMap({
    target: 'T', budget: MINIMUM_MAP_BUDGET, spawn: fakeSpawnFor([]), readFile: fakeRead({}),
  });
  assert.match(map, /inspected=0; admitted-but-too-large=0; omitted=0/);
});

test('an inspected binary source is not counted as a budget-skipped symbol scan', async () => {
  const map = await buildRepoMap({
    target: 'T', budget: DEFAULT_MAP_BUDGET,
    spawn: fakeSpawnFor(['src/binary.js', 'src/text.js']),
    readFile: fakeRead({
      'src/binary.js': Buffer.alloc(96, 0xff),
      'src/text.js': 'export const textSymbol = 1;\n',
    }),
  });
  assert.equal(symbolAccounting(map).neverRan, 0);
  assert.match(map, /textSymbol/);
  assert.doesNotMatch(map, /symbolsSkipped=1/);
});

test('the actual reservation is the declared true maximum even when it exceeds one third of the budget', async () => {
  const path = `src/${'long-'.repeat(900)}row.js`;
  const budget = 12000;
  const map = await buildRepoMap({
    target: 'T', budget, spawn: fakeSpawnFor([path]), stat: () => ({ size: 24 }),
    readFile: () => 'export const row = 1;\n',
  });
  const reservation = Number(map.match(/(?:Pre-read row reservation: |Reservation=)(\d+)/)?.[1]);
  assert.ok(reservation > budget / 3);
  assert.match(map, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('stat always completes before the first content read and stat failure prevents that read', async () => {
  const events = [];
  await buildRepoMap({
    target: 'T', budget: 1200, spawn: fakeSpawnFor(['a/fail.js', 'b/ok.js']),
    stat: (path) => {
      events.push(`stat:${path.split(/[\\/]/).slice(-2).join('/')}`);
      if (path.endsWith('fail.js')) throw new Error('EACCES');
      return { size: 24 };
    },
    readFile: (path) => { events.push(`read:${path.split(/[\\/]/).slice(-2).join('/')}`); return 'x\n'; },
  });
  assert.deepEqual(events, ['stat:a/fail.js', 'stat:b/ok.js', 'read:b/ok.js']);
});

test('the production prefix reader completes legal short reads without exceeding its requested bound', () => {
  const source = Buffer.from('abcdef');
  const calls = [];
  let closed = false;
  const result = readPrefixSync('virtual-file', {
    length: 5,
    adapters: {
      openSync: () => 17,
      readSync: (descriptor, buffer, offset, length, position) => {
        calls.push({ descriptor, length, position });
        assert.ok(position + length <= 5, 'a read request must stay within the prefix ceiling');
        const chunk = source.subarray(position, Math.min(position + length, position + 2));
        chunk.copy(buffer, offset);
        return chunk.length;
      },
      closeSync: (descriptor) => { assert.equal(descriptor, 17); closed = true; },
    },
  });
  assert.equal(result.toString(), 'abcde');
  assert.deepEqual(calls.map(({ position }) => position), [0, 2, 4]);
  assert.equal(closed, true);
});

test('every non-inspected classified row variant fits the declared pre-read reservation', async () => {
  const cases = [
    {
      name: 'admitted-but-too-large',
      path: `src/${'too-large-'.repeat(36)}row.js`,
      stat: () => ({ size: 50_000 }),
      readFile: () => 'x\n',
      expected: /admitted-but-too-large/,
    },
    {
      name: 'metadata-unavailable inspected',
      path: `src/${'metadata-'.repeat(34)}row.js`,
      stat: () => { throw new Error('EACCES'); },
      readFile: () => { throw new Error('must not read'); },
      expected: /metadata-unavailable; inspected/,
    },
    {
      name: 'metadata-unavailable omitted',
      path: `z/${'metadata-'.repeat(34)}omitted.js`,
      files: [
        ...Array.from({ length: 10 }, (_, index) => `a/${index}.js`),
        `z/${'metadata-'.repeat(34)}omitted.js`,
      ],
      stat: (path) => {
        if (path.endsWith('omitted.js')) throw new Error('EACCES');
        return { size: 24 };
      },
      readFile: () => 'x\n',
      expected: /metadata-unavailable; omitted/,
    },
    {
      name: 'content-unavailable inspected',
      path: `src/${'content-'.repeat(36)}row.js`,
      stat: () => ({ size: 24 }),
      readFile: () => { throw new Error('EIO'); },
      expected: /content-unavailable; inspected/,
    },
  ];

  for (const scenario of cases) {
    const map = await buildRepoMap({
      target: 'T', budget: 4000, spawn: fakeSpawnFor(scenario.files ?? [scenario.path]),
      stat: scenario.stat, readFile: scenario.readFile,
    });
    const reservation = Number(map.match(/Pre-read row reservation: (\d+) chars/)?.[1]);
    const row = map.match(new RegExp(`^- ${scenario.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\([^\\n]+\\)$`, 'm'))?.[0];
    assert.ok(row, `${scenario.name} row must remain visible`);
    assert.match(row, scenario.expected);
    assert.ok(row.length <= reservation, `${scenario.name} row must fit reservation`);
  }
});

test('minimal fallback compactly discloses its reservation at the exact minimum budget', async () => {
  const map = await buildRepoMap({
    target: 'T', budget: MINIMUM_MAP_BUDGET,
    spawn: fakeSpawnFor(['d0000/a.js', 'd0001/a.js']),
    stat: () => ({ size: 24 }), readFile: () => 'export const xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx = 1;\n',
  });
  assert.ok(map.length <= MINIMUM_MAP_BUDGET);
  assert.doesNotMatch(map, /^## Files$/m, 'fixture must reach the minimal fallback');
  assert.match(map, /Reservation=\d+\./);
});

test('the minimum fallback retains a fitting admission-omitted row', async () => {
  const files = ['d/f00.js', 'd/f01.js', 'd/f02.js'];
  const map = await buildRepoMap({
    target: 'T', budget: MINIMUM_MAP_BUDGET, spawn: fakeSpawnFor(files),
    stat: () => ({ size: 24 }), readFile: () => 'export const symbol = 1;\n',
  });

  assert.ok(map.length <= MINIMUM_MAP_BUDGET);
  assert.match(map, /^## Files$/m);
  assert.match(map, /^### d\/$/m);
  assert.match(map, /^- d\/f02\.js \(omitted; content admission budget\)$/m);
});

test('metadata-proven oversized files retain too-large identity when the prefix read fails', async () => {
  const map = await buildRepoMap({
    target: 'T', budget: 1200, spawn: fakeSpawnFor(['src/huge.js']),
    stat: () => ({ size: 50_000 }), readFile: () => { throw new Error('EIO'); },
  });

  assert.match(map, /inspected=0; admitted-but-too-large=1/);
  assert.match(map, /^- src\/huge\.js \(admitted-but-too-large; metadata size exceeds 4800-byte ceiling; content-unavailable\)$/m);
});

test('prefix-proven oversized files declare the bounded-content basis rather than metadata size', async () => {
  const map = await buildRepoMap({
    target: 'T', budget: 1200, spawn: fakeSpawnFor(['src/prefix.js']),
    stat: () => ({ size: 24 }), readFile: (path, options) => Buffer.alloc(options.length, 0x61),
  });

  assert.match(map, /^- src\/prefix\.js \(admitted-but-too-large; bounded content prefix exceeds 4800-byte ceiling\)$/m);
  assert.doesNotMatch(map, /src\/prefix\.js \(admitted-but-too-large; metadata size exceeds/);
});

test('the minimum budget reserves the maximum possible reservation display width', () => {
  // The maximum safe integer is the widest value this numeric reservation can
  // honestly display.  The real minimal render with its 16-digit placeholder
  // is 951 characters; the former empty-tree reservation produced only 938.
  assert.equal(String(Number.MAX_SAFE_INTEGER).length, 16);
  assert.ok(MINIMUM_MAP_BUDGET >= 951);
});

test('an admission-omitted path with available metadata uses its declared omitted row while it fits', async () => {
  const map = await buildRepoMap({
    target: 'T', budget: 1200,
    spawn: fakeSpawnFor(['src/a.js', 'src/m.js', 'src/q.js', 'src/z.js']),
    stat: () => ({ size: 24 }),
    readFile: () => 'export const ordered = 1;\n',
  });

  assert.match(map, /r≤3\b/, 'this fixture admits exactly three content reads');
  assert.match(map, /^- src\/z\.js \(omitted; content admission budget\)$/m);
});

test('an omitted directory heading and its fitting row bypass the conservative row reserve', async () => {
  const omittedDirectory = `z${'z'.repeat(40)}`;
  const omittedPath = `${omittedDirectory}/omitted.txt`;
  const files = ['a/a.txt', 'a/b.txt', 'a/c.txt', omittedPath];
  const map = await buildRepoMap({
    target: 'T', budget: 1200, spawn: fakeSpawnFor(files),
    stat: () => ({ size: 2 }), readFile: () => 'x\n',
  });

  assert.ok(map.length <= 1200);
  assert.match(map, new RegExp(`^### ${omittedDirectory}/$`, 'm'));
  assert.match(map, new RegExp(`^- ${omittedPath} \\(omitted; content admission budget\\)$`, 'm'));
});

test('symbolsSkipped excludes source paths omitted by content admission', async () => {
  const files = Array.from(
    { length: 100 },
    (_, index) => `src/f${String(index).padStart(3, '0')}.js`,
  );
  const map = await buildRepoMap({
    target: 'T', budget: 1200, spawn: fakeSpawnFor(files),
    stat: () => ({ size: 24 }),
    readFile: () => 'export const bounded = 1;\n',
  });

  const readCeiling = Number(map.match(/r≤(\d+)/)?.[1]);
  const symbolsSkipped = Number(map.match(/symbolsSkipped=(\d+)/)?.[1] ?? 0);
  assert.ok(readCeiling > 0);
  assert.ok(
    symbolsSkipped <= readCeiling,
    'only content-admitted source scans may contribute to symbolsSkipped',
  );
});
