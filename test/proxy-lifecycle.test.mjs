// End-to-end tests of the proxy: run dist/cli.js around a fixture child and
// check what reaches each side and what lands in the trace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { constants as osConstants, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'dist', 'cli.js');
const SERVER = join(here, 'fixtures', 'scenario-server.mjs');
const isWindows = process.platform === 'win32';

/**
 * Run the CLI. `input` is written to its stdin; stdin is then closed unless
 * `keepStdinOpen`. Resolves with the exit status, both outputs and the trace
 * lines (parsed), or rejects if the CLI is still running after `timeoutMs`.
 */
async function runTape(cliArgs, { input = '', keepStdinOpen = false, timeoutMs = 10_000, env } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-tape-life-'));
  const out = join(dir, 'traces');
  const child = spawn(process.execPath, [CLI, '--out', out, ...cliArgs], {
    cwd: dir,
    env: env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (d) => stdout.push(d));
  child.stderr.on('data', (d) => stderr.push(d));
  child.stdin.on('error', () => {});
  if (input) child.stdin.write(input);
  if (!keepStdinOpen) child.stdin.end();

  const started = Date.now();
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`mcp-tape still running after ${timeoutMs} ms; stderr: ${Buffer.concat(stderr)}`));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  const elapsedMs = Date.now() - started;
  child.stdin.destroy();

  let files = [];
  let lines = [];
  if (existsSync(out)) {
    files = await readdir(out);
    const jsonl = files.filter((f) => f.endsWith('.jsonl'));
    if (jsonl.length === 1) {
      const text = await readFile(join(out, jsonl[0]), 'utf8');
      lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    }
  }
  return {
    status,
    elapsedMs,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr).toString('utf8'),
    out,
    files,
    lines,
    traceText: lines.length ? await readFile(join(out, files.find((f) => f.endsWith('.jsonl'))), 'utf8') : '',
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const messages = (lines, dir) => lines.filter((l) => l.dir === dir).map((l) => l.raw);
const endLine = (lines) => lines.at(-1);

test('end of input reaches the child, so a server waiting for EOF exits', async () => {
  const r = await runTape(['--', process.execPath, SERVER, 'echo'], {
    input: '{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
  });
  try {
    assert.equal(r.status, 0);
    assert.equal(r.stdout.toString(), '{"echo":{"jsonrpc":"2.0","id":1,"method":"ping"}}\n{"bye":true}');
    assert.equal(r.lines[0].type, 'meta');
    assert.deepEqual(messages(r.lines, 'in'), [{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    assert.deepEqual(messages(r.lines, 'out'), [
      { echo: { jsonrpc: '2.0', id: 1, method: 'ping' } },
      { bye: true },
    ]);
    assert.equal(endLine(r.lines).type, 'end');
    assert.equal(endLine(r.lines).exitCode, 0);
  } finally {
    await r.cleanup();
  }
});

test('the proxy exits when the child exits, even with its own stdin still open', async () => {
  const r = await runTape(['--', process.execPath, SERVER, 'exit-now'], {
    keepStdinOpen: true,
  });
  try {
    assert.equal(r.status, 3);
    assert.equal(r.stdout.toString(), '{"hello":1}\n');
    assert.deepEqual(messages(r.lines, 'out'), [{ hello: 1 }]);
    assert.equal(endLine(r.lines).type, 'end');
    assert.equal(endLine(r.lines).exitCode, 3);
  } finally {
    await r.cleanup();
  }
});

test('a last line without LF is logged in both directions', async () => {
  const r = await runTape(['--', process.execPath, SERVER, 'echo'], {
    input: '{"id":1}\n{"last":true}',
  });
  try {
    assert.equal(r.status, 0);
    // The child never saw an LF after the second message, so it echoes only
    // the first; the bytes themselves were forwarded.
    assert.deepEqual(messages(r.lines, 'in'), [{ id: 1 }, { last: true }]);
    assert.deepEqual(messages(r.lines, 'out'), [{ echo: { id: 1 } }, { bye: true }]);
    assert.equal(endLine(r.lines).type, 'end');
  } finally {
    await r.cleanup();
  }
});

test('a character split across reads is decoded whole', async () => {
  const r = await runTape(['--', process.execPath, SERVER, 'split-utf8']);
  try {
    assert.equal(r.status, 0);
    assert.equal(r.stdout.toString('utf8'), '{"s":"é€😀"}\n');
    assert.deepEqual(messages(r.lines, 'out'), [{ s: 'é€😀' }]);
  } finally {
    await r.cleanup();
  }
});

test('a 2 MB base64 message is logged and forwarded without stalling', async () => {
  // Rules 10 and 11 used to take time proportional to the square of a word's
  // length: hours for this message.
  const r = await runTape(['--', process.execPath, SERVER, 'blob'], { timeoutMs: 30_000 });
  try {
    assert.equal(r.status, 0);
    assert.equal(r.stdout.length, 2 * 1024 * 1024 + '{"data":""}\n{"after":1}\n'.length);
    const out = messages(r.lines, 'out');
    assert.equal(out.length, 2);
    assert.equal(out[0].data.length, 2 * 1024 * 1024);
    assert.deepEqual(out[1], { after: 1 });
  } finally {
    await r.cleanup();
  }
});

test('the command line is redacted in the trace and the label comes from the redacted command', async () => {
  const secret = 'sk-' + 'Z9'.repeat(16);
  const r = await runTape(['--', process.execPath, SERVER, 'args', secret]);
  try {
    assert.equal(r.status, 0);
    // The child still gets the real argument (its echo is redacted in the
    // trace like any other message, but not on the wire).
    assert.equal(r.stdout.toString(), JSON.stringify({ args: [secret] }) + '\n');
    assert.deepEqual(messages(r.lines, 'out'), [{ args: ['[REDACTED]'] }]);
    const meta = r.lines[0];
    assert.equal(meta.command.at(-1), '[REDACTED]');
    assert.equal(r.traceText.includes(secret), false);
    const jsonl = r.files.find((f) => f.endsWith('.jsonl'));
    assert.equal(jsonl.includes('z9z9'), false, jsonl);
    assert.equal(meta.label, '-redacted-');
  } finally {
    await r.cleanup();
  }
});

test('a command that cannot start exits 127 and still leaves a complete trace', async () => {
  const r = await runTape(['--', 'mcp-tape-no-such-command-4f1c'], { keepStdinOpen: true });
  try {
    assert.equal(r.status, 127);
    assert.match(r.stderr, /cannot start mcp-tape-no-such-command-4f1c/);
    assert.equal(r.stdout.length, 0);
    assert.equal(r.lines[0].type, 'meta');
    assert.equal(endLine(r.lines).type, 'end');
    assert.equal(endLine(r.lines).exitCode, 127);
  } finally {
    await r.cleanup();
  }
});

test('an invalid --redact pattern is a usage error and creates nothing', async () => {
  const r = await runTape(['--redact', '(', '--', process.execPath, SERVER, 'args']);
  try {
    assert.equal(r.status, 2);
    assert.equal(r.stdout.length, 0);
    assert.match(r.stderr, /--redact/);
    assert.equal(existsSync(r.out), false);
  } finally {
    await r.cleanup();
  }
});

test('a helper that keeps the server stdout open does not hold the session', async () => {
  const r = await runTape(['--', process.execPath, SERVER, 'helper-holds-stdout'], { timeoutMs: 15_000 });
  const [{ helper } = {}] = messages(r.lines, 'out');
  try {
    assert.equal(r.status, 0);
    assert.ok(r.elapsedMs < 10_000, `took ${r.elapsedMs} ms`);
    assert.equal(typeof helper, 'number');
    assert.equal(endLine(r.lines).type, 'end');
    assert.equal(endLine(r.lines).exitCode, 0);
  } finally {
    if (helper) try { process.kill(helper); } catch {}
    await r.cleanup();
  }
});

test('a message too deeply nested to redact is forwarded, not logged, and the session goes on', async () => {
  const deep = '['.repeat(20_000) + ']'.repeat(20_000);
  const r = await runTape(['--', process.execPath, SERVER, 'echo'], {
    input: `${deep}\n{"id":2}\n`,
  });
  try {
    assert.equal(r.status, 0);
    assert.match(r.stderr, /too deeply nested to redact/);
    // Only the second message is logged in; the deep one never reaches the trace.
    assert.deepEqual(messages(r.lines, 'in'), [{ id: 2 }]);
    assert.equal(endLine(r.lines).type, 'end');
  } finally {
    await r.cleanup();
  }
});

test('members named __proto__ and constructor stay in the trace', async () => {
  const r = await runTape(['--', process.execPath, SERVER, 'echo'], {
    input: '{"id":1,"__proto__":{"x":1},"constructor":"c"}\n',
  });
  try {
    assert.equal(r.status, 0);
    const [raw] = messages(r.lines, 'in');
    assert.deepEqual(Object.keys(raw).sort(), ['__proto__', 'constructor', 'id']);
    assert.deepEqual(raw['__proto__'], { x: 1 });
    assert.equal(raw.constructor, 'c');
  } finally {
    await r.cleanup();
  }
});

test('arguments reach the child exactly', async () => {
  const tricky = ['a b', '', 'q"uote', 'back\\slash\\', 'x&y|z', '%PATH%', '  lead'];
  const r = await runTape(['--', process.execPath, SERVER, 'args', ...tricky]);
  try {
    assert.equal(r.status, 0);
    assert.deepEqual(messages(r.lines, 'out'), [{ args: tricky }]);
  } finally {
    await r.cleanup();
  }
});

test('a signal exit is 128 + the platform signal number', { skip: isWindows && 'POSIX signals' }, async () => {
  const r = await runTape(['--', process.execPath, SERVER, 'signal', 'SIGUSR2']);
  try {
    assert.equal(r.status, 128 + osConstants.signals.SIGUSR2);
    assert.equal(endLine(r.lines).exitCode, 128 + osConstants.signals.SIGUSR2);
  } finally {
    await r.cleanup();
  }
});

test('Windows: a .cmd shim is found on PATH and its arguments arrive', { skip: !isWindows && 'Windows only' }, async () => {
  const bin = await mkdtemp(join(tmpdir(), 'mcp-tape-bin-'));
  try {
    // Like npm's shims: run node on a script and forward every argument with %*.
    await writeFile(join(bin, 'tape-shim.cmd'), `@"${process.execPath}" "${SERVER}" args %*\r\n`);
    const env = { ...process.env, PATH: `${bin};${process.env.PATH}` };
    const args = ['plain', 'a b', 'x&y', 'C:\\Some Dir\\file.txt'];
    const r = await runTape(['--', 'tape-shim', ...args], { env });
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(messages(r.lines, 'out'), [{ args }]);
    } finally {
      await r.cleanup();
    }
  } finally {
    await rm(bin, { recursive: true, force: true });
  }
});
