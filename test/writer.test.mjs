import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceWriter } from '../dist/writer.js';
import { VERSION } from '../dist/version.js';

test('messages logged after close starts do not follow the end line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-tape-writer-'));
  try {
    const w = await TraceWriter.open({
      dir, label: 't', command: ['node', 's.js'], version: VERSION, maxBytes: 1 << 20, maxFiles: 2,
    });
    void w.logMessage('in', { id: 1 });
    const closing = w.close(0);
    void w.logMessage('in', { id: 2 }); // e.g. the client writing after the server exited
    await closing;
    await w.close(0); // a second close is a no-op
    const [file] = await readdir(dir);
    const lines = (await readFile(join(dir, file), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.type ?? l.dir), ['meta', 'in', 'end']);
    assert.deepEqual(lines[1].raw, { id: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('VERSION is the package version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
});
