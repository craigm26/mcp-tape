import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadTrace } from '../dist/upload.js';

async function withTempFile(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-tape-upload-test-'));
  const path = join(dir, 'trace.jsonl');
  await writeFile(path, content);
  return await fn(path);
}

function makeFetch(handler) {
  return async (url, init) => handler(String(url), init);
}

test('uploadTrace: happy path POSTs body + cookie + returns parsed result', async () => {
  await withTempFile('{"hello":"world"}\n', async (file) => {
    let seenUrl;
    let seenCookie;
    let seenContentType;
    let seenBody;
    const fetchFn = makeFetch(async (url, init) => {
      seenUrl = url;
      seenCookie = init?.headers?.cookie;
      seenContentType = init?.headers?.['content-type'];
      seenBody = init?.body;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            id: 'aabbccdd-eeff-4011-8022-001122334455',
            byte_size: 18,
            ingested_at: '2026-05-18T22:00:00Z',
          };
        },
        async text() {
          return '';
        },
      };
    });
    const result = await uploadTrace({
      file,
      session: {
        cookie: 'SIGNED',
        subject: 'github:tester',
        display_name: 'Tester',
        expires_at: Math.floor(Date.now() / 1000) + 60,
        subdomain: 'PlatAtlas',
      },
      fetchFn,
    });
    assert.equal(result.id, 'aabbccdd-eeff-4011-8022-001122334455');
    assert.equal(result.byte_size, 18);
    assert.equal(
      seenUrl,
      'https://PlatAtlas.platatlas.com/api/traces?source=mcp-tape',
    );
    assert.equal(seenCookie, 'platatlas_session=SIGNED');
    assert.equal(seenContentType, 'application/jsonl');
    assert.ok(seenBody instanceof Uint8Array, 'body should be Uint8Array');
    assert.equal(new TextDecoder().decode(seenBody), '{"hello":"world"}\n');
  });
});

test('uploadTrace: workerBaseUrl override is honored', async () => {
  await withTempFile('x', async (file) => {
    let seenUrl;
    const fetchFn = makeFetch(async (url) => {
      seenUrl = url;
      return {
        ok: true,
        status: 200,
        async json() {
          return { id: 'x', byte_size: 1, ingested_at: 't' };
        },
        async text() {
          return '';
        },
      };
    });
    await uploadTrace({
      file,
      workerBaseUrl: 'http://127.0.0.1:8788',
      session: {
        cookie: 'c',
        subject: 's',
        display_name: 'd',
        expires_at: Math.floor(Date.now() / 1000) + 60,
        subdomain: 'PlatAtlas',
      },
      fetchFn,
    });
    assert.equal(seenUrl, 'http://127.0.0.1:8788/api/traces?source=mcp-tape');
  });
});

test('uploadTrace: 401 from server → re-auth error message', async () => {
  await withTempFile('x', async (file) => {
    const fetchFn = makeFetch(async () => ({
      ok: false,
      status: 401,
      async json() {
        return {};
      },
      async text() {
        return 'authentication required';
      },
    }));
    await assert.rejects(
      () =>
        uploadTrace({
          file,
          session: {
            cookie: 'c',
            subject: 's',
            display_name: 'd',
            expires_at: Math.floor(Date.now() / 1000) + 60,
            subdomain: 'PlatAtlas',
          },
          fetchFn,
        }),
      /run `mcp-tape login` to re-auth/,
    );
  });
});

test('uploadTrace: surfaces other non-200 with body text', async () => {
  await withTempFile('x', async (file) => {
    const fetchFn = makeFetch(async () => ({
      ok: false,
      status: 413,
      async json() {
        return {};
      },
      async text() {
        return 'body too large';
      },
    }));
    await assert.rejects(
      () =>
        uploadTrace({
          file,
          session: {
            cookie: 'c',
            subject: 's',
            display_name: 'd',
            expires_at: Math.floor(Date.now() / 1000) + 60,
            subdomain: 'PlatAtlas',
          },
          fetchFn,
        }),
      /upload failed \(413\): body too large/,
    );
  });
});

test('uploadTrace: rejects empty file', async () => {
  await withTempFile('', async (file) => {
    await assert.rejects(
      () =>
        uploadTrace({
          file,
          session: {
            cookie: 'c',
            subject: 's',
            display_name: 'd',
            expires_at: Math.floor(Date.now() / 1000) + 60,
            subdomain: 'PlatAtlas',
          },
          fetchFn: () => {
            throw new Error('should not call fetch on empty file');
          },
        }),
      /empty file/,
    );
  });
});

test('uploadTrace: rejects when no session', async () => {
  await withTempFile('x', async (file) => {
    // No `session` passed and no readSession available — we set
    // XDG_CONFIG_HOME to an empty dir so readSession returns null.
    const prev = process.env.XDG_CONFIG_HOME;
    const dir = await mkdtemp(join(tmpdir(), 'mcp-tape-no-session-'));
    process.env.XDG_CONFIG_HOME = dir;
    try {
      await assert.rejects(
        () =>
          uploadTrace({
            file,
            fetchFn: () => {
              throw new Error('should not call fetch without session');
            },
          }),
        /not logged in/,
      );
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
    }
  });
});

test('uploadTrace: source query param encoded', async () => {
  await withTempFile('x', async (file) => {
    let seenUrl;
    const fetchFn = makeFetch(async (url) => {
      seenUrl = url;
      return {
        ok: true,
        status: 200,
        async json() {
          return { id: 'x', byte_size: 1, ingested_at: 't' };
        },
        async text() {
          return '';
        },
      };
    });
    await uploadTrace({
      file,
      source: 'claude-code',
      session: {
        cookie: 'c',
        subject: 's',
        display_name: 'd',
        expires_at: Math.floor(Date.now() / 1000) + 60,
        subdomain: 'PlatAtlas',
      },
      fetchFn,
    });
    assert.match(seenUrl, /\?source=claude-code$/);
  });
});

test('uploadTrace: --public appends &public=1 to request URL', async () => {
  await withTempFile('x', async (file) => {
    let seenUrl;
    const fetchFn = makeFetch(async (url) => {
      seenUrl = url;
      return {
        ok: true,
        status: 200,
        async json() { return { id: 'i', byte_size: 1, ingested_at: 't' }; },
        async text() { return ''; },
      };
    });
    await uploadTrace({
      file,
      public: true,
      session: {
        cookie: 'c', subject: 's', display_name: 'd',
        expires_at: Math.floor(Date.now() / 1000) + 60,
        subdomain: 'PlatAtlas',
      },
      fetchFn,
    });
    assert.equal(
      seenUrl,
      'https://PlatAtlas.platatlas.com/api/traces?source=mcp-tape&public=1',
    );
  });
});

test('uploadTrace: default omits the public query param', async () => {
  await withTempFile('x', async (file) => {
    let seenUrl;
    const fetchFn = makeFetch(async (url) => {
      seenUrl = url;
      return {
        ok: true,
        status: 200,
        async json() { return { id: 'i', byte_size: 1, ingested_at: 't' }; },
        async text() { return ''; },
      };
    });
    await uploadTrace({
      file,
      session: {
        cookie: 'c', subject: 's', display_name: 'd',
        expires_at: Math.floor(Date.now() / 1000) + 60,
        subdomain: 'PlatAtlas',
      },
      fetchFn,
    });
    assert.ok(
      !seenUrl.includes('public='),
      `URL should not include public= when default, got ${seenUrl}`,
    );
  });
});
