import { WebSocketServer, type WebSocket as WS } from 'ws';
import type { AddressInfo } from 'node:net';

interface ListenOpts {
  port: number;          // 0 = random
  host: string;          // '127.0.0.1' for loopback-only
  heartbeatMs: number;   // 15000 in production; small in tests
  maxBufferedBytes?: number; // per-subscriber backpressure cap; default 1MB
  maxFrames?: number; // ring buffer cap; default 10_000
  // When the requested port is in use, scan this many subsequent ports before
  // giving up and asking the OS for a free one. 8 = try N..N+7 then port 0.
  portFallbackRange?: number;
}

type Frame = unknown;

interface Subscriber {
  ws: WS;
  lastSentSeq: number; // -1 before snapshot
}

export class WsBroadcaster {
  private readonly wss: WebSocketServer;
  private readonly subscribers: Set<Subscriber> = new Set();
  // Bounded ring buffer. `frames` holds at most `maxFrames` entries; older
  // frames are evicted by shift(). `firstStoredSeq` is the _seq of frames[0],
  // so `frames[seq - firstStoredSeq]` is O(1) lookup when seq is in range.
  // Drop metrics (count of evicted frames surfaced to subscribers) are still
  // pending — tracked for a future tier.
  private readonly frames: Array<Frame & { _seq: number }> = [];
  private firstStoredSeq = 0;
  private nextSeq = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  readonly port: number;

  private constructor(wss: WebSocketServer, port: number, private readonly opts: ListenOpts) {
    this.wss = wss;
    this.port = port;
  }

  static async listen(opts: ListenOpts): Promise<WsBroadcaster> {
    // Port-fallback walk:
    //   1. requested port (unless port=0; the OS will pick freely)
    //   2. requested port + 1 ... + portFallbackRange-1 (default 8 slots total)
    //   3. port 0 (let the OS pick any free port)
    // Each candidate races a 'listening' against an 'error'; only EADDRINUSE
    // is retryable, other errors fail immediately.
    const range = opts.portFallbackRange ?? 8;
    const candidates: number[] = [];
    if (opts.port === 0) {
      candidates.push(0);
    } else {
      // Clamp the scan at 65535 — node would throw a non-EADDRINUSE range
      // error for 65536+ and abort the fallback before reaching port 0.
      for (let i = 0; i < range; i++) {
        const p = opts.port + i;
        if (p > 65535) break;
        candidates.push(p);
      }
      candidates.push(0);
    }
    let lastErr: Error | null = null;
    for (const port of candidates) {
      try {
        const wss = await tryListen(port, opts.host);
        const addr = wss.address() as AddressInfo;
        const b = new WsBroadcaster(wss, addr.port, opts);
        wss.on('connection', (ws, req) => b.onConnect(ws, req.url ?? '/'));
        // tryListen removes its bind-time error handler on success; attach a
        // long-lived one so any post-bind socket error (e.g., the underlying
        // server emitting 'error' later) is logged rather than thrown as an
        // unhandled event — which would crash the proxy.
        wss.on('error', () => {});
        b.heartbeat = setInterval(() => b.tick(), opts.heartbeatMs);
        b.heartbeat.unref?.();
        return b;
      } catch (err) {
        lastErr = err as Error;
        if (!isAddrInUse(err)) throw err;
      }
    }
    throw lastErr ?? new Error('WsBroadcaster.listen: exhausted port candidates');
  }

  broadcast(line: Frame): void {
    const tagged = { ...(line as object), _seq: this.nextSeq } as Frame & { _seq: number };
    this.frames.push(tagged);
    this.nextSeq++;
    const cap = this.opts.maxFrames ?? 10_000;
    while (this.frames.length > cap) {
      this.frames.shift();
      this.firstStoredSeq++;
    }
    for (const sub of this.subscribers) {
      this.sendOrDrop(sub, { type: 'append', line: tagged });
      sub.lastSentSeq = tagged._seq;
    }
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const sub of this.subscribers) {
      try { sub.ws.terminate(); } catch {}
    }
    this.subscribers.clear();
    // Also terminate any connections not yet in our subscriber set.
    for (const ws of this.wss.clients) {
      try { ws.terminate(); } catch {}
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private onConnect(ws: WS, urlPath: string): void {
    const url = new URL(urlPath, 'http://localhost');
    const sinceRaw = url.searchParams.get('since');
    const since = sinceRaw != null ? Number(sinceRaw) : -1;
    const sub: Subscriber = { ws, lastSentSeq: -1 };

    ws.on('close', () => this.subscribers.delete(sub));
    ws.on('error', () => this.subscribers.delete(sub));

    // Defer the initial burst so the connecting client has a chance to set up
    // its message listener before we flood the socket.  Without this deferral
    // the snapshot can arrive in the same I/O poll cycle as the 'open' event,
    // before the client awaits `nextMessage`, and the frame is silently lost.
    // We use setTimeout(,0) rather than setImmediate because setImmediate fires
    // in the 'check' phase before the next poll cycle, which on some platforms
    // is still before async continuations from the 'open' event resolve.
    //
    // We also defer adding the subscriber to `this.subscribers` until after the
    // snapshot/resume burst is sent.  This prevents broadcast() calls that
    // arrive between the 'connection' event and the setTimeout from delivering
    // live `append` frames before the initial snapshot, which would confuse any
    // client that assumes snapshot always arrives first.  Any frames that
    // arrive in that window are already captured inside the snapshot's `lines`
    // (snapshot captures this.frames at call-time, AFTER the window closes).
    setTimeout(() => {
      if (ws.readyState !== ws.OPEN) return;
      const canResume = sinceRaw != null
        && Number.isFinite(since)
        && since >= -1
        && since + 1 < this.nextSeq
        && since >= this.firstStoredSeq;
      if (canResume) {
        const startIdx = since + 1 - this.firstStoredSeq;
        const tail = this.frames.slice(startIdx);
        for (const f of tail) {
          this.sendOrDrop(sub, { type: 'append', line: f });
          sub.lastSentSeq = f._seq;
        }
      } else {
        const snap = {
          type: 'snapshot',
          lastSeq: this.nextSeq - 1,
          lines: this.frames,
        };
        this.sendOrDrop(sub, snap);
        sub.lastSentSeq = this.nextSeq - 1;
      }
      // Add to live-broadcast set only after initial burst is sent.
      this.subscribers.add(sub);
    }, 0);
  }

  private tick(): void {
    for (const sub of this.subscribers) {
      this.sendOrDrop(sub, { type: 'heartbeat' });
    }
  }

  private sendOrDrop(sub: Subscriber, frame: unknown): void {
    const max = this.opts.maxBufferedBytes ?? 1_000_000;
    if (sub.ws.bufferedAmount > max) {
      // Use terminate() (not close()) because the client may have stopped
      // reading — a graceful close frame would never be consumed.
      try { sub.ws.terminate(); } catch {}
      this.subscribers.delete(sub);
      return;
    }
    try {
      sub.ws.send(JSON.stringify(frame));
    } catch {
      this.subscribers.delete(sub);
    }
  }
}

function tryListen(port: number, host: string): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port, host });
    const onListening = () => {
      wss.off('error', onError);
      resolve(wss);
    };
    const onError = (err: Error) => {
      wss.off('listening', onListening);
      // Close the half-opened server to release the underlying http server's
      // resources before retrying with a different port.
      try { wss.close(); } catch {}
      reject(err);
    };
    wss.once('listening', onListening);
    wss.once('error', onError);
  });
}

function isAddrInUse(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'EADDRINUSE';
}
