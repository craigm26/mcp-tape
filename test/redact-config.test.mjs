import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRedactConfig, redactWithConfig } from '../dist/redact-config.js';

async function tempDir() {
  return await mkdtemp(join(tmpdir(), 'mcp-tape-rc-'));
}

test('loadRedactConfig returns defaults when no override', async () => {
  const cfg = await loadRedactConfig({ overridePath: null });
  assert.ok(cfg.pathRules.length > 0);
  assert.ok(cfg.regexes.length > 0);
});

test('user file with extends:default merges rules', async () => {
  const dir = await tempDir();
  const f = join(dir, 'redact.json');
  await writeFile(f, JSON.stringify({
    extends: 'default',
    rules: [{ type: 'path', path: '$.custom.field' }],
  }));
  const cfg = await loadRedactConfig({ overridePath: f });
  assert.ok(cfg.pathRules.some((r) => r.path === '$.custom.field'));
  assert.ok(cfg.pathRules.some((r) => r.path === '$..api_key'));
  await rm(dir, { recursive: true });
});

test('user file with extends:null replaces defaults', async () => {
  const dir = await tempDir();
  const f = join(dir, 'redact.json');
  await writeFile(f, JSON.stringify({ extends: null, rules: [] }));
  const cfg = await loadRedactConfig({ overridePath: f });
  assert.equal(cfg.pathRules.length, 0);
  assert.equal(cfg.regexes.length, 0);
  await rm(dir, { recursive: true });
});

test('malformed file fails loud', async () => {
  const dir = await tempDir();
  const f = join(dir, 'redact.json');
  await writeFile(f, 'not json {');
  await assert.rejects(loadRedactConfig({ overridePath: f }));
  await rm(dir, { recursive: true });
});

test('redactWithConfig redacts via both regex and path rules', () => {
  const cfg = {
    regexes: [/AKIA[A-Z0-9]+/g],
    pathRules: [{ path: '$.user.password' }],
    replacement: '[REDACTED]',
  };
  const out = redactWithConfig({ user: { password: 'p' }, msg: ['AKIA', 'ABCDEFGHIJKLMNOP'].join('') }, cfg);
  assert.equal(out.user.password, '[REDACTED]');
  assert.equal(out.msg, '[REDACTED]');
});

test('default rules redact Authorization header in value', async () => {
  const cfg = await loadRedactConfig({ overridePath: null });
  const out = redactWithConfig({ raw: 'Authorization: Bearer sk-leakedtoken123' }, cfg);
  assert.ok(out.raw.includes('[REDACTED]'));
  assert.ok(!out.raw.includes('sk-leakedtoken123'));
});

test('default rules redact id_rsa path', async () => {
  const cfg = await loadRedactConfig({ overridePath: null });
  const out = redactWithConfig({ path: '/home/user/.ssh/id_rsa' }, cfg);
  assert.ok(out.path.includes('[REDACTED]'));
});

test('default rules redact .env path', async () => {
  const cfg = await loadRedactConfig({ overridePath: null });
  const out = redactWithConfig({ msg: 'read /var/app/.env.production' }, cfg);
  assert.ok(out.msg.includes('[REDACTED]'));
});

test('default rules redact JWT in string value', async () => {
  const cfg = await loadRedactConfig({ overridePath: null });
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const out = redactWithConfig({ msg: `auth=${jwt}` }, cfg);
  assert.ok(out.msg.includes('[REDACTED]'));
  assert.ok(!out.msg.includes('eyJ'));
});

test('default rules redact Slack xoxb token', async () => {
  const cfg = await loadRedactConfig({ overridePath: null });
  // Fixture assembled at runtime so the fake token never appears as a
  // literal in source — full-shape literals trip GitHub push protection.
  const tok = ['xoxb', '2444555666', '1234567890123', 'AbCdEfGhIjKlMnOpQrSt'].join('-');
  const out = redactWithConfig({ msg: `slack auth ${tok} done` }, cfg);
  assert.ok(out.msg.includes('[REDACTED]'));
  assert.ok(!out.msg.includes('xoxb-'));
});

test('default rules redact all Slack xox[baprs] variants', async () => {
  const cfg = await loadRedactConfig({ overridePath: null });
  for (const kind of ['b', 'a', 'p', 'r', 's']) {
    const out = redactWithConfig({ msg: `t=xox${kind}-1234567890-abcdefABCDEF123456` }, cfg);
    assert.ok(!out.msg.includes(`xox${kind}-`), `xox${kind}- should be redacted`);
    assert.ok(out.msg.includes('[REDACTED]'));
  }
});

test('default rules redact Stripe rk_live_ key', async () => {
  const cfg = await loadRedactConfig({ overridePath: null });
  // Runtime-assembled fixture (see xoxb test above).
  const rk = ['rk', 'live', '51AbCdEf0123456789QrStUvWx'].join('_');
  const out = redactWithConfig({ msg: `key ${rk} here` }, cfg);
  assert.ok(out.msg.includes('[REDACTED]'));
  assert.ok(!out.msg.includes('rk_live_'));
});

test('default rules redact Stripe sk_live_ key without clobbering the sk- rule', async () => {
  const cfg = await loadRedactConfig({ overridePath: null });
  // Runtime-assembled fixture (see xoxb test above).
  const sk = ['sk', 'live', '51AbCdEf0123456789QrStUvWx'].join('_');
  const out = redactWithConfig(
    { a: `stripe ${sk}`, b: 'openai sk-abcdef1234567890qwertyuiop' },
    cfg,
  );
  assert.ok(!out.a.includes('sk_live_'));
  assert.ok(out.a.includes('[REDACTED]'));
  // pre-existing generic sk-* rule still fires
  assert.ok(!out.b.includes('sk-abcdef'));
  assert.ok(out.b.includes('[REDACTED]'));
});

test('default rules redact connection-string password, preserving URL shape', async () => {
  const cfg = await loadRedactConfig({ overridePath: null });
  const out = redactWithConfig({ dsn: 'postgres://u:secret@host:5432/db' }, cfg);
  assert.equal(out.dsn, 'postgres://u:[REDACTED]@host:5432/db');
  assert.ok(!out.dsn.includes(':secret@'));
});

test('connection-string rule leaves credential-free URLs alone', async () => {
  const cfg = await loadRedactConfig({ overridePath: null });
  const out = redactWithConfig(
    { a: 'https://example.com/path?q=1', b: 'http://host:8080/x' },
    cfg,
  );
  assert.equal(out.a, 'https://example.com/path?q=1');
  assert.equal(out.b, 'http://host:8080/x');
});

test('default rules redact capitalized Authorization key in JSON payloads', async () => {
  const cfg = await loadRedactConfig({ overridePath: null });
  const out = redactWithConfig({ headers: { Authorization: 'Bearer eyJabc.def.ghi' } }, cfg);
  assert.equal(out.headers.Authorization, '[REDACTED]');
});

test('default rules redact bare Bearer value in a string', async () => {
  const cfg = await loadRedactConfig({ overridePath: null });
  const out = redactWithConfig({ note: 'sent Bearer eyJhbGciOi.payload.sig to api' }, cfg);
  assert.ok(out.note.includes('[REDACTED]'));
  assert.ok(!out.note.includes('eyJhbGciOi'));
});
