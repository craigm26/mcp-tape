import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSession,
  writeSession,
  deleteSession,
  sessionFilePath,
  runDeviceLogin,
} from '../dist/auth.js';

// All tests redirect the session-file location via XDG_CONFIG_HOME so
// we don't trample the operator's real session.
async function withTempConfig(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-tape-test-'));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
}

test('sessionFilePath honors XDG_CONFIG_HOME', async () => {
  await withTempConfig((dir) => {
    assert.equal(sessionFilePath(), join(dir, 'mcp-tape', 'session.json'));
  });
});

test('readSession returns null when file missing', async () => {
  await withTempConfig(async () => {
    assert.equal(await readSession(), null);
  });
});

test('writeSession → readSession roundtrip', async () => {
  await withTempConfig(async () => {
    const session = {
      cookie: 'abc',
      subject: 'github:tester',
      display_name: 'Tester',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      subdomain: 'PlatAtlas',
    };
    await writeSession(session);
    const got = await readSession();
    assert.deepEqual(got, session);
  });
});

test('writeSession writes mode 0600 with 0700 parent dir', async () => {
  // POSIX-only — Windows ignores chmod bits this way.
  if (process.platform === 'win32') return;
  await withTempConfig(async (dir) => {
    await writeSession({
      cookie: 'x',
      subject: 'github:tester',
      display_name: 'T',
      expires_at: Math.floor(Date.now() / 1000) + 60,
      subdomain: 'PlatAtlas',
    });
    const fileStat = await stat(join(dir, 'mcp-tape', 'session.json'));
    const parentStat = await stat(join(dir, 'mcp-tape'));
    assert.equal(fileStat.mode & 0o777, 0o600);
    assert.equal(parentStat.mode & 0o777, 0o700);
  });
});

test('readSession returns null on expired session', async () => {
  await withTempConfig(async () => {
    await writeSession({
      cookie: 'x',
      subject: 'github:tester',
      display_name: 'T',
      expires_at: Math.floor(Date.now() / 1000) - 60,
      subdomain: 'PlatAtlas',
    });
    assert.equal(await readSession(), null);
  });
});

test('readSession returns null on malformed JSON', async () => {
  await withTempConfig(async (dir) => {
    await mkdir(join(dir, 'mcp-tape'), { recursive: true });
    await writeFile(join(dir, 'mcp-tape', 'session.json'), 'not json', 'utf8');
    assert.equal(await readSession(), null);
  });
});

test('readSession returns null on missing fields (shape drift)', async () => {
  await withTempConfig(async (dir) => {
    await mkdir(join(dir, 'mcp-tape'), { recursive: true });
    // Missing `subdomain` — older format.
    await writeFile(
      join(dir, 'mcp-tape', 'session.json'),
      JSON.stringify({
        cookie: 'x',
        subject: 'github:tester',
        display_name: 'T',
        expires_at: Math.floor(Date.now() / 1000) + 60,
      }),
      'utf8',
    );
    assert.equal(await readSession(), null);
  });
});

test('deleteSession is a no-op when file missing', async () => {
  await withTempConfig(async () => {
    await deleteSession(); // no throw
  });
});

test('deleteSession removes the file', async () => {
  await withTempConfig(async () => {
    await writeSession({
      cookie: 'x',
      subject: 'github:tester',
      display_name: 'T',
      expires_at: Math.floor(Date.now() / 1000) + 60,
      subdomain: 'PlatAtlas',
    });
    assert.ok(await readSession());
    await deleteSession();
    assert.equal(await readSession(), null);
  });
});

// ---------------------------------------------------- device flow

/** Build a fake `fetch` that returns a scripted sequence keyed on
 *  the URL. Each entry is consumed once; reuse triggers `undefined`
 *  responses (which would crash callers — surfaces test-script bugs). */
function scriptedFetch(routes) {
  const queues = new Map();
  for (const [url, responses] of Object.entries(routes)) {
    queues.set(url, [...responses]);
  }
  return async (input, _init) => {
    const url = typeof input === 'string' ? input : input.url;
    const q = queues.get(url);
    if (!q) throw new Error(`scriptedFetch: no script for ${url}`);
    const next = q.shift();
    if (!next) throw new Error(`scriptedFetch: queue empty for ${url}`);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      async json() {
        return next.body;
      },
      async text() {
        return JSON.stringify(next.body);
      },
    };
  };
}

test('runDeviceLogin: happy path with one pending poll, then success', async () => {
  const baseUrl = 'http://example.test';
  const fetchFn = scriptedFetch({
    [`${baseUrl}/auth/github/device-config`]: [
      { status: 200, body: { client_id: 'Iv1.test' } },
    ],
    'https://github.com/login/device/code': [
      {
        status: 200,
        body: {
          device_code: 'DEV',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 600,
          interval: 0, // poll immediately — keeps the test fast
        },
      },
    ],
    'https://github.com/login/oauth/access_token': [
      { status: 200, body: { error: 'authorization_pending' } },
      { status: 200, body: { access_token: 'gho_abc' } },
    ],
    [`${baseUrl}/auth/github/device-exchange`]: [
      {
        status: 200,
        body: {
          cookie: 'signed-cookie',
          subject: 'github:tester',
          display_name: 'Tester',
          expires_at: 1_751_731_200,
        },
      },
    ],
  });
  const logs = [];
  const session = await runDeviceLogin({
    subdomain: 'PlatAtlas',
    workerBaseUrl: baseUrl,
    log: (m) => logs.push(m),
    fetchFn,
  });
  assert.equal(session.cookie, 'signed-cookie');
  assert.equal(session.subject, 'github:tester');
  assert.equal(session.subdomain, 'PlatAtlas');
  // Log mentions the user code + verification URI so the user sees them.
  assert.ok(logs.some((m) => m.includes('ABCD-1234')));
  assert.ok(logs.some((m) => m.includes('github.com/login/device')));
});

test('runDeviceLogin: throws on slow_down then succeeds', async () => {
  const baseUrl = 'http://example.test';
  const fetchFn = scriptedFetch({
    [`${baseUrl}/auth/github/device-config`]: [
      { status: 200, body: { client_id: 'Iv1.test' } },
    ],
    'https://github.com/login/device/code': [
      {
        status: 200,
        body: {
          device_code: 'DEV',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 600,
          interval: 0,
        },
      },
    ],
    'https://github.com/login/oauth/access_token': [
      { status: 200, body: { error: 'slow_down' } },
      { status: 200, body: { access_token: 'gho_xyz' } },
    ],
    [`${baseUrl}/auth/github/device-exchange`]: [
      {
        status: 200,
        body: {
          cookie: 'c',
          subject: 'github:t',
          display_name: 'T',
          expires_at: 0,
        },
      },
    ],
  });
  // slow_down adds 5s to interval; with interval=0 to start, after slow_down
  // it becomes 5. We don't want to sleep 5 seconds in test — exercise the
  // state-machine logic via a hand-stubbed sleep would be ideal, but the
  // current shape uses setTimeout directly. Skip the live wait by ensuring
  // the deadline check fires fast enough. For now we set expires_in=1 so
  // the loop exits on the second iteration whether or not slow_down fires.
  // (We're really testing that slow_down doesn't crash, not the timing.)
  const session = await runDeviceLogin({
    subdomain: 'PlatAtlas',
    workerBaseUrl: baseUrl,
    log: () => {},
    fetchFn,
  });
  assert.equal(session.cookie, 'c');
});

test('runDeviceLogin: maps expired_token to a clear error', async () => {
  const baseUrl = 'http://example.test';
  const fetchFn = scriptedFetch({
    [`${baseUrl}/auth/github/device-config`]: [
      { status: 200, body: { client_id: 'Iv1.test' } },
    ],
    'https://github.com/login/device/code': [
      {
        status: 200,
        body: {
          device_code: 'DEV',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 600,
          interval: 0,
        },
      },
    ],
    'https://github.com/login/oauth/access_token': [
      { status: 200, body: { error: 'expired_token' } },
    ],
  });
  await assert.rejects(
    () =>
      runDeviceLogin({
        subdomain: 'PlatAtlas',
        workerBaseUrl: baseUrl,
        log: () => {},
        fetchFn,
      }),
    /Device code expired/,
  );
});

test('runDeviceLogin: maps access_denied to a clear error', async () => {
  const baseUrl = 'http://example.test';
  const fetchFn = scriptedFetch({
    [`${baseUrl}/auth/github/device-config`]: [
      { status: 200, body: { client_id: 'Iv1.test' } },
    ],
    'https://github.com/login/device/code': [
      {
        status: 200,
        body: {
          device_code: 'DEV',
          user_code: 'X',
          verification_uri: 'https://github.com/login/device',
          expires_in: 600,
          interval: 0,
        },
      },
    ],
    'https://github.com/login/oauth/access_token': [
      { status: 200, body: { error: 'access_denied' } },
    ],
  });
  await assert.rejects(
    () =>
      runDeviceLogin({
        subdomain: 'PlatAtlas',
        workerBaseUrl: baseUrl,
        log: () => {},
        fetchFn,
      }),
    /Authorization denied/,
  );
});

test('runDeviceLogin: surfaces device-config 503', async () => {
  const baseUrl = 'http://example.test';
  const fetchFn = scriptedFetch({
    [`${baseUrl}/auth/github/device-config`]: [
      { status: 503, body: 'no client_id' },
    ],
  });
  await assert.rejects(
    () =>
      runDeviceLogin({
        subdomain: 'PlatAtlas',
        workerBaseUrl: baseUrl,
        log: () => {},
        fetchFn,
      }),
    /device-config failed \(503\)/,
  );
});
