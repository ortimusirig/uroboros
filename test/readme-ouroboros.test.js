import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const readmePath = fileURLToPath(new URL('../README.md', import.meta.url));
const assetRelativePath = 'docs/assets/ouroboros.svg';
const assetPath = fileURLToPath(new URL(`../${assetRelativePath}`, import.meta.url));

const hasScriptElement = (source) => /<script(?=[\s/>])/i.test(source);
const hasForeignObjectElement = (source) => /<foreignObject(?=[\s/>])/i.test(source);
const decodeNumericXmlEntities = (value) => value.replace(
  /&#(?:x([0-9a-f]+)|(\d+));/gi,
  (entity, hexadecimal, decimal) => {
    const codePoint = Number.parseInt(hexadecimal ?? decimal, hexadecimal ? 16 : 10);
    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
  },
);
const hasRemoteHref = (source) => {
  const hrefAttribute = /(?:^|[\s<])(?:xlink:)?href\s*=\s*(["'])([\s\S]*?)\1/gi;

  for (const match of source.matchAll(hrefAttribute)) {
    const value = decodeNumericXmlEntities(match[2]).trim();
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) return true;
  }

  return false;
};

test('README ouroboros asset exists on disk', () => {
  assert.ok(existsSync(assetPath),
    `README ouroboros asset is missing: ${assetRelativePath}`);
});

test('README references the ouroboros asset by its repository-relative path', () => {
  const readme = readFileSync(readmePath, 'utf8');

  assert.ok(readme.includes(assetRelativePath),
    `README must reference ${assetRelativePath}`);
});

test('ouroboros asset excludes unsafe or externally loaded SVG constructs', () => {
  assert.ok(existsSync(assetPath),
    `ouroboros asset must exist before its contents can be checked: ${assetRelativePath}`);
  const asset = readFileSync(assetPath, 'utf8');
  const forbiddenConstructs = [
    {
      name: 'script element',
      predicate: hasScriptElement,
      positiveControls: [
        '<svg><script>alert("unsafe")</script></svg>',
        '<svg><script/></svg>',
      ],
    },
    {
      name: 'foreignObject element',
      predicate: hasForeignObjectElement,
      positiveControls: [
        '<svg><foreignObject><div>unsafe</div></foreignObject></svg>',
        '<svg><foreignObject/></svg>',
      ],
    },
    {
      name: 'remote href or xlink:href',
      predicate: hasRemoteHref,
      positiveControls: [
        '<svg><image href="https://example.com/image.png" /></svg>',
        '<svg><image xlink:href="//example.com/image.png" /></svg>',
        '<svg><image href="&#x68;ttps://example.com/image.png" /></svg>',
      ],
    },
  ];

  for (const { name, predicate, positiveControls } of forbiddenConstructs) {
    for (const sample of positiveControls) {
      assert.equal(predicate(sample), true,
        `positive control: ${name} predicate must detect a forbidden sample`);
    }
    assert.equal(predicate(asset), false,
      `ouroboros asset must not contain a ${name}`);
  }
});
