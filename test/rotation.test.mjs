import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RotatingWriter } from '../dist/rotation.js';

async function tempDir() {
  return await mkdtemp(join(tmpdir(), 'mcp-tape-rot-'));
}

test('writes single file when under cap', async () => {
  const dir = await tempDir();
  const path = join(dir, 'trace.jsonl');
  const w = await RotatingWriter.open({ path, maxBytes: 1024, maxFiles: 3 });
  await w.writeLine('hello\n');
  await w.close();
  const text = await readFile(path, 'utf8');
  assert.equal(text, 'hello\n');
  const files = await readdir(dir);
  assert.deepEqual(files.sort(), ['trace.jsonl']);
  await rm(dir, { recursive: true });
});

test('rotates to .1 when maxBytes exceeded', async () => {
  const dir = await tempDir();
  const path = join(dir, 'trace.jsonl');
  const w = await RotatingWriter.open({ path, maxBytes: 10, maxFiles: 3 });
  await w.writeLine('aaaaaaaaaa\n'); // 11 bytes — exceeds 10
  await w.writeLine('after\n');
  await w.close();
  const main = await readFile(path, 'utf8');
  const rot1 = await readFile(path + '.1', 'utf8');
  assert.equal(rot1, 'aaaaaaaaaa\n');
  assert.equal(main, 'after\n');
  await rm(dir, { recursive: true });
});

test('evicts oldest when more than maxFiles rotations needed', async () => {
  const dir = await tempDir();
  const path = join(dir, 'trace.jsonl');
  const w = await RotatingWriter.open({ path, maxBytes: 5, maxFiles: 2 });
  await w.writeLine('aaaaa\n');
  await w.writeLine('bbbbb\n');
  await w.writeLine('ccccc\n');
  await w.writeLine('final\n');
  await w.close();
  const files = (await readdir(dir)).sort();
  assert.deepEqual(files, ['trace.jsonl', 'trace.jsonl.1', 'trace.jsonl.2']);
  assert.equal(await readFile(path, 'utf8'), 'final\n');
  assert.equal(await readFile(path + '.1', 'utf8'), 'ccccc\n');
  assert.equal(await readFile(path + '.2', 'utf8'), 'bbbbb\n');
  await rm(dir, { recursive: true });
});

test('orphaned writer (no close) leaves complete lines intact on disk', async () => {
  const dir = await tempDir();
  const path = join(dir, 'trace.jsonl');
  const w = await RotatingWriter.open({ path, maxBytes: 1000, maxFiles: 3 });
  await w.writeLine('{"id":1,"complete":true}\n');
  await w.writeLine('{"id":2,"complete":true}\n');
  // Simulate crash: do NOT call w.close(). The process "dies" with the writer mid-flight.
  // The two completed line writes are awaited so their bytes are flushed to the kernel,
  // but the writer's orderly close (sync + close) never runs.
  const text = await readFile(path, 'utf8');
  const lines = text.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 2);
  for (const line of lines) JSON.parse(line);
  // After "crash" — a fresh RotatingWriter on the same path should resume cleanly,
  // observing the existing 50 bytes of pre-crash content.
  const w2 = await RotatingWriter.open({ path, maxBytes: 1000, maxFiles: 3 });
  await w2.writeLine('{"id":3,"complete":true}\n');
  await w2.close();
  const after = (await readFile(path, 'utf8'))
    .split('\n')
    .filter((l) => l.length > 0);
  assert.equal(after.length, 3);
  for (const line of after) JSON.parse(line);
  await rm(dir, { recursive: true });
});

test('crash mid-line leaves preceding lines parseable', async () => {
  const dir = await tempDir();
  const path = join(dir, 'trace.jsonl');
  // Append a complete line plus a partial line via raw writes to simulate a crash.
  const fh = await open(path, 'a');
  await fh.write('{"id":1,"complete":true}\n');
  await fh.write('{"id":2,"partial');  // no closing brace, no newline
  await fh.close();  // simulated crash: handle goes away mid-line

  // The file should still be readable on disk — the complete first line is intact.
  const textBefore = await readFile(path, 'utf8');
  // Split on newlines: first element should be parseable JSON.
  const linesBefore = textBefore.split('\n');
  assert.ok(linesBefore.length >= 1, 'file should have content');
  JSON.parse(linesBefore[0]); // first complete line must be valid JSON

  // Re-open via RotatingWriter and ensure the writer is still functional.
  const w = await RotatingWriter.open({ path, maxBytes: 10000, maxFiles: 3 });
  await w.writeLine('{"id":3,"complete":true}\n');
  await w.close();

  // Writer operated without throwing — crash-recovery path is functional.
  const textAfter = await readFile(path, 'utf8');
  assert.ok(textAfter.length > textBefore.length, 'new data should be appended');
  await rm(dir, { recursive: true });
});

test('serializes concurrent writes that trigger rotation', async () => {
  const dir = await tempDir();
  const path = join(dir, 'trace.jsonl');
  const w = await RotatingWriter.open({ path, maxBytes: 10, maxFiles: 20 });
  // Fire 20 writes without awaiting each — simulates pipeWithLog's fire-and-forget.
  const ps = [];
  for (let i = 0; i < 20; i++) {
    ps.push(w.writeLine(`line-${i}\n`));
  }
  await Promise.all(ps);
  await w.close();
  // No crashes. Files exist. Total written lines = 20 across active + rotated.
  const files = (await readdir(dir)).sort();
  assert.ok(files.length >= 1);
  let total = 0;
  for (const f of files) {
    const text = await readFile(join(dir, f), 'utf8');
    total += text.split('\n').filter((l) => l.length > 0).length;
  }
  assert.equal(total, 20);
  await rm(dir, { recursive: true });
});
