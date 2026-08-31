import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const verifierSkill = readFileSync(fileURLToPath(
  new URL('../cursor-plugin/skills/uro-verify/SKILL.md', import.meta.url),
), 'utf8');
const plannerSkill = readFileSync(fileURLToPath(
  new URL('../skills/uroboros/SKILL.md', import.meta.url),
), 'utf8');
const setupSkill = readFileSync(fileURLToPath(
  new URL('../skills/uroboros-setup/SKILL.md', import.meta.url),
), 'utf8');
const reviewSkillPath = fileURLToPath(
  new URL('../cursor-plugin/skills/uro-review/SKILL.md', import.meta.url),
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertWholeSkillName(document, name) {
  const pattern = new RegExp(`(?<![A-Za-z0-9:_-])${escapeRegExp(name)}(?![A-Za-z0-9:_-])`);
  assert.match(name, pattern, `positive control: ${name} must match itself`);
  assert.doesNotMatch(`prefix${name}suffix`, pattern,
    `discrimination control: ${name} inside a larger token must not count`);
  assert.match(document, pattern, `missing exact skill name ${name}`);
}

test('uro-verify names every reviewer superpowers skill exactly', () => {
  for (const name of [
    'superpowers:brainstorming',
    'superpowers:systematic-debugging',
    'superpowers:verification-before-completion',
    'superpowers:requesting-code-review',
    'superpowers:using-superpowers',
  ]) assertWholeSkillName(verifierSkill, name);
});

test('uro-review names all six decision-point skills and restricts writes to its artifact directory', () => {
  assert.equal(existsSync(reviewSkillPath), true, 'uro-review/SKILL.md must be shipped');
  const reviewSkill = readFileSync(reviewSkillPath, 'utf8');
  for (const name of [
    'superpowers:brainstorming',
    'superpowers:test-driven-development',
    'superpowers:systematic-debugging',
    'superpowers:verification-before-completion',
    'superpowers:requesting-code-review',
    'superpowers:using-superpowers',
  ]) assertWholeSkillName(reviewSkill, name);
  assert.match(reviewSkill,
    /write nothing outside [`']?__uro_review\/[`']?[\s\S]*reverted[\s\S]*reported/i);
});

test('uroboros names every Claude debate skill and the spec-coverage self-review rule', () => {
  for (const name of [
    'superpowers:brainstorming',
    'superpowers:writing-plans',
    'superpowers:executing-plans',
    'superpowers:test-driven-development',
    'superpowers:systematic-debugging',
    'superpowers:verification-before-completion',
    'superpowers:receiving-code-review',
    'superpowers:requesting-code-review',
  ]) assertWholeSkillName(plannerSkill, name);
  assert.match(plannerSkill, /plan written for this loop must run[\s\S]*spec-coverage self-review/i);
  assert.match(plannerSkill,
    /docs\/superpowers\/specs\/2026-08-25-three-way-debate-loop-design[.]md/);
  assert.match(plannerSkill, /enumerate every[\s\S]*section[\s\S]*does not implement/i);
});

test('setup treats superpowers loading as three required seat-specific prerequisites', () => {
  assert.match(setupSkill, /Codex[\s\S]*codex plugin list[\s\S]*installed, enabled/i);
  assert.match(setupSkill, /codex plugin add superpowers@openai-curated/);
  assert.match(setupSkill, /Cursor[\s\S]*[.]cursor-plugin[\s\S]*URO_SUPERPOWERS_DIR/i);
  assert.match(setupSkill, /Claude[\s\S]*[.]claude-plugin[\s\S]*readable/i);
  assert.match(setupSkill, /all three seats[\s\S]*required/i);
  assert.match(setupSkill, /URO_REQUIRE_SUPERPOWERS=0[\s\S]*run facts[\s\S]*report/i);
});
