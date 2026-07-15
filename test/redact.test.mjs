import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, redact, REPLACEMENT, applyPathRules } from '../dist/redact.js';
const REPL2 = REPLACEMENT;

test('redacts string value by field name', () => {
  const cfg = buildConfig({ extraPatterns: [], useDefaults: true });
  const out = redact({ password: 'hunter2', user: 'alice' }, cfg);
  assert.equal(out.password, REPLACEMENT);
  assert.equal(out.user, 'alice');
});

test('redacts AWS-shape key inside a string value', () => {
  const cfg = buildConfig({ extraPatterns: [], useDefaults: true });
  const out = redact({ message: 'try AKIAIOSFODNN7EXAMPLE today' }, cfg);
  assert.equal(out.message, `try ${REPLACEMENT} today`);
});

test('redacts sk-* token embedded in string', () => {
  const cfg = buildConfig({ extraPatterns: [], useDefaults: true });
  // Fixture assembled at runtime so no full-shape literal exists in source
  // (secret scanners flag them; same pattern as the ghp_ test below).
  const sk = ['sk', 'abcdef1234567890qwertyuiop'].join('-');
  const out = redact({ note: `auth: ${sk} done` }, cfg);
  assert.equal(out.note, `auth: ${REPLACEMENT} done`);
});

test('redacts GitHub token', () => {
  const cfg = buildConfig({ extraPatterns: [], useDefaults: true });
  const tok = 'ghp_' + 'A'.repeat(36);
  const out = redact({ x: `header: ${tok}` }, cfg);
  assert.equal(out.x, `header: ${REPLACEMENT}`);
});

test('redacts JWT pattern', () => {
  const cfg = buildConfig({ extraPatterns: [], useDefaults: true });
  // The canonical jwt.io demo token, assembled at runtime (see sk-* test).
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0In0', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'].join('.');
  const out = redact({ x: `t=${jwt}` }, cfg);
  assert.equal(out.x, `t=${REPLACEMENT}`);
});

test('custom regex with no defaults', () => {
  const cfg = buildConfig({ extraPatterns: ['CUSTOM-[0-9]+'], useDefaults: false });
  const out = redact({ x: 'CUSTOM-1234' }, cfg);
  assert.equal(out.x, REPLACEMENT);
});

test('passthrough for non-sensitive data', () => {
  const cfg = buildConfig({ extraPatterns: [], useDefaults: true });
  const input = { tools: [{ name: 'read_file', args: { path: '/tmp/a' } }] };
  const out = redact(input, cfg);
  assert.deepEqual(out, input);
});

test('nested Authorization header', () => {
  const cfg = buildConfig({ extraPatterns: [], useDefaults: true });
  const out = redact({ headers: { Authorization: 'Bearer xyz' } }, cfg);
  assert.equal(out.headers.Authorization, REPLACEMENT);
});

test('field-name match wins over value-pattern scan', () => {
  const cfg = buildConfig({ extraPatterns: [], useDefaults: true });
  // even a non-secret value gets redacted when the field name says "token"
  const out = redact({ token: 'just-a-string' }, cfg);
  assert.equal(out.token, REPLACEMENT);
});

test('arrays of strings get value-pattern redaction', () => {
  const cfg = buildConfig({ extraPatterns: [], useDefaults: true });
  const out = redact({ logs: ['ok', 'leaked AKIAIOSFODNN7EXAMPLE'] }, cfg);
  assert.deepEqual(out.logs, ['ok', `leaked ${REPLACEMENT}`]);
});

test('null and number values untouched', () => {
  const cfg = buildConfig({ extraPatterns: [], useDefaults: true });
  const out = redact({ a: null, b: 42, c: true }, cfg);
  assert.deepEqual(out, { a: null, b: 42, c: true });
});

test('applyPathRules redacts a single nested field', () => {
  const out = applyPathRules({ params: { arguments: { api_key: 'sk-real' } } }, [
    { path: '$.params.arguments.api_key' },
  ]);
  assert.equal(out.params.arguments.api_key, REPL2);
});

test('applyPathRules recursive descend matches any depth', () => {
  const out = applyPathRules({ a: { b: { secret: 'x' } }, secret: 'y' }, [
    { path: '$..secret' },
  ]);
  assert.equal(out.a.b.secret, REPL2);
  assert.equal(out.secret, REPL2);
});

test('legacy substring match still applies to db_password (regression)', () => {
  const cfg = buildConfig({ extraPatterns: [], useDefaults: true });
  const out = redact({ db_password: 'hunter2', user_token: 'abc', api_key: 'xyz' }, cfg);
  // db_password matches /password/i substring; user_token matches /token/i; api_key matches /api[_-]?key/i.
  assert.equal(out.db_password, REPLACEMENT);
  assert.equal(out.user_token, REPLACEMENT);
  assert.equal(out.api_key, REPLACEMENT);
});
