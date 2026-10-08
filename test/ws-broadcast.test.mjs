import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { WsBroadcaster } from '../dist/ws-broadcast.js';

// Per-socket message queue so that messages arriving before nextMessage() is
// called are not lost (e.g. when two broadcasts arrive in the same I/O tick
// before the second await nextMessage resolves).
const msgQueues = new WeakMap();

function getQueue(ws) {
  if (!msgQueues.has(ws)) {
    const q = { buf: [], waiters: [] };
    msgQueues.set(ws, q);
    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString());
      if (q.waiters.length > 0) {
        q.waiters.shift()(parsed);
      } else {
        q.buf.push(parsed);
      }
    });
    ws.on('error', (err) => {
      for (const w of q.waiters) w(Promise.reject(err));
      q.waiters = [];
    });
  }
  return msgQueues.get(ws);
}

async function nextMessage(ws) {
  const q = getQueue(ws);
  if (q.buf.length > 0) return q.buf.shift();
  return new Promise((resolve) => q.waiters.push(resolve));
}

async function open(url) {
  const ws = new WebSocket(url);
  // Initialise the queue before 'open': the server sends its snapshot frame
  // as soon as the connection is up, and when that frame arrives in the same
  // read as the upgrade response, ws emits it synchronously right after
  // 'open' — before an await continuation could attach a listener. The frame
  // was then lost and the test waited for the 60 s heartbeat instead.
  getQueue(ws);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return ws;
}

// Unified cleanup helper. We force-close clients via `terminate()` rather
// than `close()` because the graceful WebSocket close handshake races with
// the broadcaster's `terminate()` of its subscribers — leaving the client
// socket in CLOSING for up to 30s and blocking `node --test` from exiting.
// Registered via `t.after()` so it runs regardless of test pass/fail; a
// leaked WSS / heartbeat interval previously hung the self-hosted Pi runner
// for 1h 40min under W7-2/4 load.
function registerCleanup(t, b, ws) {
  t.after(async () => {
    if (ws) {
      try { ws.terminate(); } catch {}
    }
    try { await b.close(); } catch {}
  });
}

test('snapshot frame on connect contains pre-buffered frames with seq numbers', async (t) => {
  const b = await WsBroadcaster.listen({ port: 0, host: '127.0.0.1', heartbeatMs: 60_000 });
  b.broadcast({ type: 'meta', label: 'fs' });
  b.broadcast({ t: '2026-05-13T00:00:00.000Z', dir: 'in', raw: { id: 1 } });

  const ws = await open(`ws://127.0.0.1:${b.port}/`);
  registerCleanup(t, b, ws);
  const snap = await nextMessage(ws);
  assert.equal(snap.type, 'snapshot');
  assert.equal(snap.lines.length, 2);
  assert.equal(snap.lastSeq, 1);
  assert.equal(snap.lines[0]._seq, 0);
  assert.equal(snap.lines[1]._seq, 1);
});

test('append frames sent after connect carry monotonic seq', async (t) => {
  const b = await WsBroadcaster.listen({ port: 0, host: '127.0.0.1', heartbeatMs: 60_000 });
  const ws = await open(`ws://127.0.0.1:${b.port}/`);
  registerCleanup(t, b, ws);
  await nextMessage(ws); // snapshot (empty)
  b.broadcast({ t: '2026-05-13T00:00:01.000Z', dir: 'in', raw: { id: 1 } });
  b.broadcast({ t: '2026-05-13T00:00:02.000Z', dir: 'out', raw: { id: 1, result: {} } });
  const a1 = await nextMessage(ws);
  const a2 = await nextMessage(ws);
  assert.equal(a1.type, 'append');
  assert.equal(a1.line._seq, 0);
  assert.equal(a2.type, 'append');
  assert.equal(a2.line._seq, 1);
});

test('heartbeat fires on the configured interval', async (t) => {
  const b = await WsBroadcaster.listen({ port: 0, host: '127.0.0.1', heartbeatMs: 50 });
  const ws = await open(`ws://127.0.0.1:${b.port}/`);
  registerCleanup(t, b, ws);
  await nextMessage(ws); // snapshot
  const hb = await nextMessage(ws);
  assert.equal(hb.type, 'heartbeat');
});

test('since=<seq> resumes from seq+1 when frames still in memory', async (t) => {
  const b = await WsBroadcaster.listen({ port: 0, host: '127.0.0.1', heartbeatMs: 60_000 });
  b.broadcast({ a: 1 });
  b.broadcast({ a: 2 });
  b.broadcast({ a: 3 });
  const ws = await open(`ws://127.0.0.1:${b.port}/?since=0`);
  registerCleanup(t, b, ws);
  const m1 = await nextMessage(ws);
  const m2 = await nextMessage(ws);
  assert.equal(m1.type, 'append');
  assert.equal(m1.line._seq, 1);
  assert.equal(m2.type, 'append');
  assert.equal(m2.line._seq, 2);
});

test('frames broadcast between connect and snapshot are captured in the snapshot (no gap)', async (t) => {
  const b = await WsBroadcaster.listen({ port: 0, host: '127.0.0.1', heartbeatMs: 60_000 });
  // Pre-connect frame.
  b.broadcast({ marker: 'pre' });
  // Open a client. The connection event fires and a setTimeout(0) is queued
  // to deliver the snapshot. Before that timeout runs, we synchronously fire
  // another broadcast which lands in this.frames but should reach the new
  // subscriber via the snapshot path, not as an append.
  const ws = new (await import('ws')).WebSocket(`ws://127.0.0.1:${b.port}/`);
  registerCleanup(t, b, ws);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  // The 'open' event fires in the same poll as the server's 'connection'.
  // Broadcast synchronously here — the snapshot has not yet been sent.
  b.broadcast({ marker: 'gap' });

  // First message MUST be a snapshot containing both frames.
  const first = await new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    ws.once('error', reject);
  });
  assert.equal(first.type, 'snapshot');
  // Both markers must appear in the snapshot.
  const markers = first.lines.map((l) => l.marker);
  assert.ok(markers.includes('pre'), 'pre-connect frame missing from snapshot');
  assert.ok(markers.includes('gap'), 'race-window frame missing from snapshot');
});

test('frames buffer evicts oldest when maxFrames exceeded', async (t) => {
  const b = await WsBroadcaster.listen({ port: 0, host: '127.0.0.1', heartbeatMs: 60_000, maxFrames: 3 });
  b.broadcast({ a: 1 });
  b.broadcast({ a: 2 });
  b.broadcast({ a: 3 });
  b.broadcast({ a: 4 }); // evicts seq 0
  const ws = await open(`ws://127.0.0.1:${b.port}/`);
  registerCleanup(t, b, ws);
  const snap = await nextMessage(ws);
  assert.equal(snap.type, 'snapshot');
  assert.equal(snap.lines.length, 3);
  assert.equal(snap.lines[0]._seq, 1);
  assert.equal(snap.lines[2]._seq, 3);
  assert.equal(snap.lastSeq, 3);
});

test('since-resume after eviction falls back to snapshot', async (t) => {
  const b = await WsBroadcaster.listen({ port: 0, host: '127.0.0.1', heartbeatMs: 60_000, maxFrames: 2 });
  b.broadcast({ a: 1 });
  b.broadcast({ a: 2 });
  b.broadcast({ a: 3 }); // evicts seq 0
  const ws = await open(`ws://127.0.0.1:${b.port}/?since=0`);
  registerCleanup(t, b, ws);
  const first = await nextMessage(ws);
  assert.equal(first.type, 'snapshot');
});

test('listen falls back to next port when requested port is busy', async () => {
  // Hold the requested port with a first broadcaster, then start a second one
  // asking for the same port: it must end up on a different port (the next
  // free one in the scan range) instead of throwing.
  let a = null;
  let b = null;
  try {
    a = await WsBroadcaster.listen({ port: 0, host: '127.0.0.1', heartbeatMs: 60_000 });
    const requested = a.port;
    b = await WsBroadcaster.listen({ port: requested, host: '127.0.0.1', heartbeatMs: 60_000, portFallbackRange: 8 });
    assert.notEqual(b.port, requested);
    // The fallback should bind somewhere — either within the explicit range
    // requested..requested+7, or an OS-assigned port if the whole range was
    // already in use on the test host. Either case is a successful fallback.
  } finally {
    if (a) await a.close();
    if (b) await b.close();
  }
});

test('listen falls back to OS-assigned port when the whole range is busy', async () => {
  // Saturate a contiguous block: requested + 0..2 (range=3 means we try those
  // three then port 0). All three holders are kept open while we ask for the
  // requested port; listen must reach the port-0 fallback and succeed.
  const holders = [];
  let b = null;
  try {
    const base = await WsBroadcaster.listen({ port: 0, host: '127.0.0.1', heartbeatMs: 60_000 });
    const requested = base.port;
    holders.push(base);
    // It is possible (though unlikely on a quiet test host) that requested+1/+2
    // are already taken by something else; that is fine — what matters for this
    // test is that listen finds *some* port when the scan range is exhausted.
    let p = requested + 1;
    let attempts = 0;
    while (holders.length < 3 && attempts < 20) {
      try {
        const h = await WsBroadcaster.listen({ port: p, host: '127.0.0.1', heartbeatMs: 60_000, portFallbackRange: 1 });
        holders.push(h);
      } catch {}
      p++;
      attempts++;
    }
    b = await WsBroadcaster.listen({ port: requested, host: '127.0.0.1', heartbeatMs: 60_000, portFallbackRange: holders.length });
    // The new broadcaster must have bound somewhere — either via the scan range
    // or via the port-0 OS fallback. We don't assert a specific port; we just
    // assert that listen succeeded without throwing and bound to a free port.
    assert.ok(b.port > 0, 'fallback broadcaster did not bind a port');
  } finally {
    for (const h of holders) {
      try { await h.close(); } catch {}
    }
    if (b) await b.close();
  }
});

test('listen at the top of the port range falls back to port 0 instead of overflowing past 65535', async () => {
  // Requesting port 65530 with a fallback range of 8 would queue 65530..65537;
  // 65536+ are invalid and would abort the scan with a non-EADDRINUSE error.
  // The fallback walk must clamp at 65535 and then ask the OS for any port.
  let holder = null;
  let b = null;
  try {
    // Try to bind 65535 first as a holder so the requested port is genuinely
    // busy. If the OS won't let us bind that high (privileged or already
    // taken), the test still validates the no-throw behavior — we just won't
    // exercise the clamp path. Skip silently in that case.
    try {
      holder = await WsBroadcaster.listen({ port: 65535, host: '127.0.0.1', heartbeatMs: 60_000 });
    } catch {
      return;
    }
    b = await WsBroadcaster.listen({ port: 65535, host: '127.0.0.1', heartbeatMs: 60_000, portFallbackRange: 8 });
    assert.ok(b.port > 0 && b.port <= 65535, `fallback port should be valid, got ${b.port}`);
    assert.notEqual(b.port, 65535);
  } finally {
    if (holder) await holder.close();
    if (b) await b.close();
  }
});

test('slow subscriber whose buffer exceeds cap gets dropped', async (t) => {
  // Use a 4MB cap so the kernel loopback buffer is reliably exceeded.
  // We flood with ~10 MB of data (1000 × ~10 KB) to fill the socket's
  // userspace writableLength above the cap.
  const b = await WsBroadcaster.listen({
    port: 0, host: '127.0.0.1', heartbeatMs: 60_000,
    maxBufferedBytes: 4_000_000,
  });
  const ws = await open(`ws://127.0.0.1:${b.port}/`);
  registerCleanup(t, b, ws);
  await nextMessage(ws);
  ws.pause();
  const big = 'x'.repeat(10_000);
  for (let i = 0; i < 1000; i++) {
    b.broadcast({ data: big, seq: i });
  }
  await new Promise((r) => setTimeout(r, 200));
  // The broadcaster drops the subscriber once bufferedAmount exceeds the cap.
  // ws.readyState stays OPEN on the paused client side (it can't read the RST
  // while paused), so we verify the server-side drop instead.
  assert.equal(b.subscribers.size, 0);
  // Resume to drain. Wait for the actual `close` event (with a generous
  // timeout) rather than a fixed sleep — under load the kernel can take
  // longer to deliver the RST on loopback than a 100ms wait allows.
  const closePromise = new Promise((resolve) => {
    if (ws.readyState === ws.CLOSED) return resolve();
    ws.once('close', resolve);
  });
  ws.resume();
  await Promise.race([
    closePromise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('client socket did not close within 2s')),
        2000,
      ),
    ),
  ]);
  assert.equal(
    ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING,
    true,
  );
});
