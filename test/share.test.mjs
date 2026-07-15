import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shareTrace, deleteShare } from '../dist/share.js';
import { parseArgs } from '../dist/args.js';

async function withTempFile(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-tape-share-test-'));
  const path = join(dir, 'trace.jsonl');
  await writeFile(path, content);
  return await fn(path, dir);
}

function makeFetch(handler) {
  return async (url, init) => handler(String(url), init);
}

function okShareResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    async json() {
      return {
        url: 'https://mcpreplay.dev/?trace=aabbccdd-eeff-4011-8022-001122334455',
        id: 'aabbccdd-eeff-4011-8022-001122334455',
        deleteToken: 'deadbeef'.repeat(8),
        expiresAt: '2026-08-14T00:00:00.000Z',
      };
    },
    async text() {
      return '';
    },
  };
}

// Base opts for tests: pin env (no MCP_TAPE_SELF, no MCP_TAPE_REDACT) and
// disable user-config auto-discovery so a redact.json on the dev machine
// can't change test behavior. Defaults still ALWAYS apply.
const ISOLATED = { env: {}, userRedactPath: null };

test('shareTrace: happy path POSTs JSONL and returns parsed result', async () => {
  await withTempFile('{"hello":"world"}\n{"n":2}\n', async (file) => {
    let seenUrl;
    let seenMethod;
    let seenContentType;
    let seenBody;
    const fetchFn = makeFetch(async (url, init) => {
      seenUrl = url;
      seenMethod = init?.method;
      seenContentType = init?.headers?.['content-type'];
      seenBody = init?.body;
      return okShareResponse();
    });
    const r = await shareTrace({ file, fetchFn, ...ISOLATED });
    assert.equal(seenUrl, 'https://mcpreplay.dev/api/share');
    assert.equal(seenMethod, 'POST');
    assert.equal(seenContentType, 'application/jsonl');
    assert.equal(seenBody, '{"hello":"world"}\n{"n":2}\n');
    assert.equal(r.id, 'aabbccdd-eeff-4011-8022-001122334455');
    assert.match(r.url, /mcpreplay\.dev\/\?trace=/);
    assert.equal(r.expiresAt, '2026-08-14T00:00:00.000Z');
    assert.ok(r.deleteToken.length > 0);
  });
});

test('shareTrace: fake secrets in the input file are ABSENT from the HTTP body', async () => {
  // One secret per redaction layer: a value-pattern token (sk-*), a
  // field-name hit (password), and a default-redact.json path rule (api_key).
  const skSecret = 'sk-wiretest0123456789abcdefFAKE';
  const password = 'hunter2-Sup3rSecret';
  const apiKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join(''); // runtime-assembled, scanner-safe
  const input =
    JSON.stringify({
      t: '2026-07-15T00:00:00Z',
      dir: 'in',
      raw: {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { note: `key is ${skSecret}`, password, api_key: apiKey },
      },
    }) + '\n';
  await withTempFile(input, async (file) => {
    let seenBody;
    const fetchFn = makeFetch(async (_url, init) => {
      seenBody = init?.body;
      return okShareResponse();
    });
    await shareTrace({ file, fetchFn, ...ISOLATED });
    assert.equal(typeof seenBody, 'string');
    assert.ok(!seenBody.includes(skSecret), 'sk-* secret leaked to the wire');
    assert.ok(!seenBody.includes(password), 'password value leaked to the wire');
    assert.ok(!seenBody.includes(apiKey), 'api_key value leaked to the wire');
    assert.ok(seenBody.includes('[REDACTED]'), 'expected [REDACTED] markers in body');
    // Non-secret content still travels.
    assert.ok(seenBody.includes('tools/call'));
  });
});

test('shareTrace: user redact config ADDS rules — defaults still apply even with extends:null', async () => {
  const customSecret = 'CUSTOMSECRET42';
  const skSecret = 'sk-wiretest0123456789abcdefFAKE';
  const input = JSON.stringify({ msg: `${customSecret} and ${skSecret}` }) + '\n';
  await withTempFile(input, async (file, dir) => {
    const cfgPath = join(dir, 'redact.json');
    // extends:null tells the proxy path to REPLACE the defaults. The share
    // path must not honor that: defaults are non-skippable there.
    await writeFile(
      cfgPath,
      JSON.stringify({ extends: null, rules: [{ type: 'regex', pattern: 'CUSTOMSECRET[0-9]+' }] }),
    );
    let seenBody;
    const fetchFn = makeFetch(async (_url, init) => {
      seenBody = init?.body;
      return okShareResponse();
    });
    await shareTrace({ file, fetchFn, env: {}, userRedactPath: cfgPath });
    assert.ok(!seenBody.includes(customSecret), 'custom rule was not applied');
    assert.ok(!seenBody.includes(skSecret), 'default rules were skipped — they must be non-skippable');
  });
});

test('shareTrace: rejects files over 10MB without calling fetch', async () => {
  const big = 'x'.repeat(10 * 1024 * 1024 + 1);
  await withTempFile(big, async (file) => {
    await assert.rejects(
      () =>
        shareTrace({
          file,
          fetchFn: () => {
            throw new Error('should not call fetch on oversize file');
          },
          ...ISOLATED,
        }),
      /at most 10485760 bytes \(10MB\)/,
    );
  });
});

test('shareTrace: rejects non-JSONL content without calling fetch', async () => {
  await withTempFile('{"ok":true}\nthis is not json\n', async (file) => {
    await assert.rejects(
      () =>
        shareTrace({
          file,
          fetchFn: () => {
            throw new Error('should not call fetch on non-JSONL file');
          },
          ...ISOLATED,
        }),
      /not a JSONL file: line 2/,
    );
  });
});

test('shareTrace: rejects empty and missing files', async () => {
  await withTempFile('', async (file) => {
    const noFetch = () => {
      throw new Error('should not call fetch');
    };
    await assert.rejects(() => shareTrace({ file, fetchFn: noFetch, ...ISOLATED }), /empty file/);
    await assert.rejects(
      () => shareTrace({ file: file + '.nope', fetchFn: noFetch, ...ISOLATED }),
      /no such file/,
    );
  });
});

test('shareTrace: X-MCP-Tape-Self header present iff MCP_TAPE_SELF=1', async () => {
  await withTempFile('{"a":1}\n', async (file) => {
    let seenHeaders;
    const fetchFn = makeFetch(async (_url, init) => {
      seenHeaders = init?.headers;
      return okShareResponse();
    });
    await shareTrace({ file, fetchFn, env: { MCP_TAPE_SELF: '1' }, userRedactPath: null });
    assert.equal(seenHeaders['X-MCP-Tape-Self'], '1');

    await shareTrace({ file, fetchFn, env: {}, userRedactPath: null });
    assert.equal(seenHeaders['X-MCP-Tape-Self'], undefined);

    // Only the documented value "1" opts in.
    await shareTrace({ file, fetchFn, env: { MCP_TAPE_SELF: '0' }, userRedactPath: null });
    assert.equal(seenHeaders['X-MCP-Tape-Self'], undefined);
  });
});

test('shareTrace: 413 / 422 / 429 map to clear messages', async () => {
  await withTempFile('{"a":1}\n', async (file) => {
    const respond = (status, retryAfter = null) =>
      makeFetch(async () => ({
        ok: false,
        status,
        headers: { get: (h) => (h === 'Retry-After' ? retryAfter : null) },
        async json() {
          return {};
        },
        async text() {
          return 'server says no';
        },
      }));
    await assert.rejects(
      () => shareTrace({ file, fetchFn: respond(413), ...ISOLATED }),
      /413.*10MB/,
    );
    await assert.rejects(
      () => shareTrace({ file, fetchFn: respond(422), ...ISOLATED }),
      /422.*JSONL.*server says no/,
    );
    await assert.rejects(
      () => shareTrace({ file, fetchFn: respond(429, '1800'), ...ISOLATED }),
      /429.*rate limited.*retry in 30m/,
    );
  });
});

test('deleteShare: sends DELETE with X-Delete-Token, 204 resolves', async () => {
  let seenUrl;
  let seenMethod;
  let seenToken;
  const fetchFn = makeFetch(async (url, init) => {
    seenUrl = url;
    seenMethod = init?.method;
    seenToken = init?.headers?.['X-Delete-Token'];
    return { ok: true, status: 204, async text() { return ''; } };
  });
  await deleteShare({ id: 'aabbccdd-eeff-4011-8022-001122334455', token: 'tok123', fetchFn });
  assert.equal(seenUrl, 'https://mcpreplay.dev/api/trace/aabbccdd-eeff-4011-8022-001122334455');
  assert.equal(seenMethod, 'DELETE');
  assert.equal(seenToken, 'tok123');
});

test('deleteShare: 404 and 403 map to clear messages', async () => {
  const respond = (status) =>
    makeFetch(async () => ({ ok: false, status, async text() { return 'nope'; } }));
  await assert.rejects(
    () => deleteShare({ id: 'x', token: 't', fetchFn: respond(404) }),
    /not found — already deleted or expired/,
  );
  await assert.rejects(
    () => deleteShare({ id: 'x', token: 't', fetchFn: respond(403) }),
    /delete token rejected/,
  );
});

// --- arg parsing ---

test('parseArgs: share <file> parses; delete mode parses', () => {
  const a = parseArgs(['share', 'trace.jsonl']);
  assert.equal(a.subcommand, 'share');
  assert.equal(a.shareFile, 'trace.jsonl');
  assert.equal(a.shareDelete, null);

  const d = parseArgs(['share', '--delete', 'some-uuid', '--token', 'tok']);
  assert.equal(d.subcommand, 'share');
  assert.equal(d.shareDelete, 'some-uuid');
  assert.equal(d.shareToken, 'tok');
  assert.equal(d.shareFile, null);
});

test('parseArgs: share rejects --no-redact-defaults (redaction is non-skippable)', () => {
  assert.throws(
    () => parseArgs(['share', 'trace.jsonl', '--no-redact-defaults']),
    /share always redacts/,
  );
});

test('parseArgs: share validates its argument shapes', () => {
  assert.throws(() => parseArgs(['share']), /share requires a file argument/);
  assert.throws(
    () => parseArgs(['share', '--delete', 'id']),
    /requires both --delete <id> and --token <t>/,
  );
  assert.throws(
    () => parseArgs(['share', 'f.jsonl', '--delete', 'id', '--token', 't']),
    /does not take a file argument/,
  );
  assert.throws(() => parseArgs(['share', 'a.jsonl', 'b.jsonl']), /unexpected share argument/);
  assert.throws(() => parseArgs(['share', 'a.jsonl', '--bogus']), /unknown share flag/);
  // --redact / --redact-file are additive and accepted.
  const a = parseArgs(['share', 'a.jsonl', '--redact', 'FOO[0-9]+', '--redact-file', '/tmp/r.json']);
  assert.deepEqual(a.redactPatterns, ['FOO[0-9]+']);
  assert.equal(a.redactFile, '/tmp/r.json');
});
