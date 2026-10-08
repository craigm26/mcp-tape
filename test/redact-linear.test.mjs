// Rules 10 (.env paths) and 11 (SSH key paths) in default-redact.json used to
// begin with a bare `[^\s"]*`, which a backtracking engine retries from every
// position inside a word: time proportional to the square of the word's
// length (seconds for a 40,000-character word, hours for a 2 MB base64
// image). They now only start where a word starts. These tests
// check that the anchored rules redact exactly what the old ones did, and do
// it in linear time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRedactConfig, redactWithConfig } from '../dist/redact-config.js';

const here = dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(readFileSync(join(here, '..', 'default-redact.json'), 'utf8')).rules;

const OLD_10 = /[^\s"]*\.env(?:\.[A-Za-z0-9._\-]+)?\b/g;
const OLD_11 = /[^\s"]*\bid_(?:rsa|ed25519|ecdsa|dsa)\b[^\s"]*/g;
const NEW_10 = new RegExp(rules.find((r) => r.pattern?.includes('\\.env')).pattern, 'g');
const NEW_11 = new RegExp(rules.find((r) => r.pattern?.includes('id_(?:rsa')).pattern, 'g');
const R = '[REDACTED]';

test('anchored rules give the same output as the old rules on random text', () => {
  // Pieces chosen to hit the patterns' edges: word boundaries, quotes, white
  // space (including non-ASCII), partial keywords, earlier replacements.
  const pieces = ['.env', '.', 'env', 'e', 'n', 'v', 'y', 'id_', 'rsa', 'ed25519', 'ecdsa', 'dsa',
    'd', '_', '-', 'x', 'Z', '9', '/', '\\', ' ', '\t', '"', '\n', ' ', ' ', 'é', R, '+', '=', ':'];
  let seed = 20261007;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  let compared = 0;
  for (let i = 0; i < 50_000; i++) {
    let s = '';
    const len = rand(14);
    for (let j = 0; j < len; j++) s += pieces[rand(pieces.length)];
    assert.equal(s.replace(NEW_10, R), s.replace(OLD_10, R), JSON.stringify(s));
    assert.equal(s.replace(NEW_11, R), s.replace(OLD_11, R), JSON.stringify(s));
    assert.equal(
      s.replace(NEW_10, R).replace(NEW_11, R),
      s.replace(OLD_10, R).replace(OLD_11, R),
      JSON.stringify(s),
    );
    compared += 3;
  }
  assert.equal(compared, 150_000);
});

test('anchored rules on the worked examples', () => {
  const cases = [
    ['load /srv/app/.env.local now', `load ${R} now`],
    ['a/.env.x+b/.env', R],
    ['my.envy', 'my.envy'],
    ['cfg/.env.', `${R}.`],
    ['.env.env-id_', `${R}-id_`],
    ['"path":"/x/.env"', `"path":"${R}"`],
  ];
  for (const [input, expected] of cases) assert.equal(input.replace(NEW_10, R), expected, input);
  assert.equal('key is ~/.ssh/id_ed25519.pub'.replace(NEW_11, R), `key is ${R}`);
  assert.equal('my_id_rsa_backup'.replace(NEW_11, R), 'my_id_rsa_backup');
  assert.equal('x/id_rsa-old y'.replace(NEW_11, R), `${R} y`);
});

test('a 2 MB base64 word goes through every default rule quickly', async () => {
  const cfg = await loadRedactConfig({ overridePath: null });
  const blob = 'QUJD'.repeat(512 * 1024);
  const started = performance.now();
  const out = redactWithConfig({ data: blob }, cfg);
  const ms = performance.now() - started;
  assert.equal(out.data, blob);
  // About 50 ms here; the old rules took minutes. The bound only has to
  // separate linear from quadratic on a slow CI machine.
  assert.ok(ms < 5_000, `took ${ms} ms`);
});
