import { type ChildProcess } from 'node:child_process';
import { mkdir, access } from 'node:fs/promises';
import { constants as osConstants, homedir } from 'node:os';
import { join } from 'node:path';
import { TraceWriter } from './writer.js';
import { buildConfig, redact, type RedactConfig } from './redact.js';
import {
  loadRedactConfig,
  redactStringWithConfig,
  redactWithConfig,
  type CompiledRedact,
} from './redact-config.js';
import { spawnCommand } from './spawn-command.js';
import { VERSION } from './version.js';
import type { CliArgs } from './args.js';
import type { WsBroadcaster } from './ws-broadcast.js';

// After the child exits, how long to keep reading its stdout. The pipe normally
// closes at once; it stays open only if another process inherited it (a helper
// the server started in the background), and that must not hold the session open.
const STDOUT_DRAIN_LIMIT_MS = 2_000;

// After the child's stdout has ended, how long to wait for its last output to
// reach a client that has stopped reading, before exiting anyway.
const STDOUT_FLUSH_LIMIT_MS = 5_000;

export async function runProxy(args: CliArgs): Promise<number> {
  if (!args.noFile) await mkdir(args.out, { recursive: true });

  const overridePath =
    args.redactFile
    ?? process.env.MCP_TAPE_REDACT
    ?? (args.useRedactDefaults ? await pathIfExists(defaultRedactPath()) : null);
  const fileCfg: CompiledRedact | null = args.useRedactDefaults || overridePath
    ? await loadRedactConfig({ overridePath })
    : null;
  const legacyCfg = buildConfig({
    extraPatterns: args.redactPatterns,
    useDefaults: args.useRedactDefaults,
  });

  // The command line lands in the trace (meta.command) and, through the
  // label, in the file name, so it gets the same string rules as message
  // values, and the label is derived from the redacted arguments.
  const redactedCommand = redactCommand(args.command, legacyCfg, fileCfg);
  const label = args.label ?? deriveLabel(redactedCommand);

  let broadcaster: WsBroadcaster | null = null;
  let serveOnly = args.noFile;
  if (args.serve != null) {
    const { WsBroadcaster: WBClass } = await import('./ws-broadcast.js');
    try {
      broadcaster = await WBClass.listen({
        port: args.serve,
        host: '127.0.0.1',
        heartbeatMs: 15_000,
      });
      if (broadcaster.port !== args.serve) {
        process.stderr.write(`mcp-tape: port ${args.serve} was unavailable — bound ${broadcaster.port} instead\n`);
      }
      process.stderr.write(`mcp-tape: live mode on ws://127.0.0.1:${broadcaster.port}/  (open https://mcpreplay.dev/?live=ws://127.0.0.1:${broadcaster.port})\n`);
    } catch (err) {
      // The websocket couldn't bind at all (every fallback port refused). The
      // user asked for live mode, so we mention the failure prominently — but
      // we don't abort the proxy: a trace file is still better than nothing.
      // --no-file callers don't get that consolation; we force file-on so
      // the session isn't silently lost.
      process.stderr.write(`mcp-tape: failed to open websocket for --serve: ${(err as Error).message}\n`);
      if (serveOnly) {
        process.stderr.write(`mcp-tape: --no-file requires a working websocket; falling back to file-only mode.\n`);
        await mkdir(args.out, { recursive: true });
        serveOnly = false;
      } else {
        process.stderr.write(`mcp-tape: continuing in file-only mode.\n`);
      }
    }
  }

  const writer = await TraceWriter.open({
    dir: args.out,
    label,
    command: redactedCommand,
    version: VERSION,
    maxBytes: args.maxBytes,
    maxFiles: args.maxFiles,
    onFrame: broadcaster ? (line) => broadcaster!.broadcast(line) : undefined,
    noFile: serveOnly,
  });
  if (writer.path) {
    process.stderr.write(`mcp-tape: tracing to ${writer.path}\n`);
  } else {
    process.stderr.write(`mcp-tape: --no-file: streaming over websocket only, no trace file on disk\n`);
  }

  // On Windows this finds `.cmd` shims such as `npx` without handing the
  // arguments to a shell that would re-split them (see spawn-command.ts).
  const child: ChildProcess = spawnCommand(args.command[0]!, args.command.slice(1), {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  // Set once the child has exited or failed to start. From then on nothing
  // more is forwarded to its stdin, and nothing more read from ours is logged.
  let childGone = false;
  pipeWithLog(process.stdin, child.stdin!, 'in', writer, legacyCfg, fileCfg, {
    // The end of our input is the end of the child's input: closing the
    // server's stdin is how an MCP client starts a clean shutdown.
    endDst: true,
    active: () => !childGone,
  });
  const outDone = pipeWithLog(child.stdout!, process.stdout, 'out', writer, legacyCfg, fileCfg, {
    endDst: false,
    active: () => true,
  });

  // Signal forwarding so SIGINT/SIGTERM reach the child cleanly.
  const fwd = (sig: NodeJS.Signals) => () => {
    if (!child.killed) child.kill(sig);
  };
  process.on('SIGINT', fwd('SIGINT'));
  process.on('SIGTERM', fwd('SIGTERM'));

  const exitCode = await new Promise<number>((resolve) => {
    child.on('error', (err) => {
      // An 'error' while the child has no pid means it never started (no
      // such program, not executable). Shells report that as 127; the trace
      // is still finished below. Later errors (a failed kill) don't end the
      // session.
      if (child.pid !== undefined) return;
      process.stderr.write(`mcp-tape: cannot start ${args.command[0]}: ${err.message}\n`);
      resolve(127);
    });
    child.on('exit', (code, signal) => {
      resolve(code ?? (signal ? 128 + signalNumber(signal) : 0));
    });
  });
  childGone = true;

  // Drain the child's stdout so its last line is forwarded and logged. Our own
  // stdin may still be open (a client waiting for the server to go away), so
  // the session ends here, not when the client closes it.
  let drainTimer: NodeJS.Timeout | undefined;
  await Promise.race([
    outDone,
    new Promise<void>((resolve) => {
      drainTimer = setTimeout(resolve, STDOUT_DRAIN_LIMIT_MS);
    }),
  ]);
  clearTimeout(drainTimer);
  // Still open after the limit: something else holds the pipe. Stop reading,
  // which ends the 'out' direction (its last partial line is still logged).
  child.stdout?.destroy();
  await outDone;

  await writer.close(exitCode);
  if (writer.path) {
    process.stderr.write(`mcp-tape: trace saved to ${writer.path}\n`);
  }
  if (broadcaster) await broadcaster.close();

  // `--upload-on-exit`: best-effort PlatAtlas upload of the final trace.
  // Silent skip when no session is set up — offline / no-login use stays
  // unchanged. Errors land on stderr but don't change the proxy exit code:
  // the recording itself succeeded; the upload is a courtesy.
  if (args.uploadOnExit && writer.path) {
    try {
      const { readSession } = await import('./auth.js');
      const session = await readSession();
      if (!session) {
        process.stderr.write(
          `mcp-tape: --upload-on-exit set but no session found; run \`mcp-tape login\` to enable.\n`,
        );
      } else {
        const { uploadTrace } = await import('./upload.js');
        const tracePath = writer.path;
        const r = await uploadTrace({
          file: tracePath,
          public: args.public,
          ...(args.workerBaseUrl !== null ? { workerBaseUrl: args.workerBaseUrl } : {}),
        });
        process.stderr.write(
          `mcp-tape: uploaded to PlatAtlas → ${r.id} (${r.byte_size} bytes)\n`,
        );
        if (args.public && args.workerBaseUrl === null) {
          process.stderr.write(
            `mcp-tape: view at https://mcpreplay.dev/?trace=https://${session.subdomain}.platatlas.com/api/traces/${r.id}\n`,
          );
        }
      }
    } catch (e) {
      process.stderr.write(
        `mcp-tape: upload-on-exit failed: ${(e as Error).message}\n`,
      );
    }
  }

  return exitCode;
}

interface PipeOpts {
  /** End `dst` when `src` ends (client → child: the child sees end of file). */
  endDst: boolean;
  /** While this returns false, chunks are neither forwarded nor logged. */
  active: () => boolean;
}

/**
 * Forward `src` to `dst` byte for byte and log each complete JSON line.
 * Resolves once `src` has ended and its last line has been handled (and, for
 * a destination that stays open, once the forwarded bytes have been flushed).
 */
function pipeWithLog(
  src: NodeJS.ReadableStream,
  dst: NodeJS.WritableStream,
  dir: 'in' | 'out',
  writer: TraceWriter,
  legacyCfg: RedactConfig,
  fileCfg: CompiledRedact | null,
  opts: PipeOpts,
): Promise<void> {
  // A destination that goes away (the child exited, the client closed its
  // end) reports EPIPE as an 'error' event. Without a listener that would
  // crash the proxy before the trace is finished.
  dst.on('error', () => {});

  const logLine = (bytes: Buffer): void => {
    if (!opts.active()) return;
    // Decode the whole line at once: a multi-byte character split across two
    // reads must not turn into two replacement characters.
    const line = bytes.toString('utf8');
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return; // Non-JSON line — not protocol data, skip logging.
    }
    let redacted: unknown;
    try {
      const stage1 = fileCfg ? redactWithConfig(raw, fileCfg) : raw;
      redacted = redact(stage1, legacyCfg);
    } catch {
      // Redaction walks the value recursively, so JSON nested a few thousand
      // levels deep exhausts the stack. Such a message is forwarded but not
      // logged: an unredacted copy must never reach the trace.
      process.stderr.write(`mcp-tape: a message too deeply nested to redact was forwarded but not logged\n`);
      return;
    }
    // Fire-and-forget; the writer queues lines in call order. A failed write
    // (disk full, say) is reported rather than left as an unhandled rejection,
    // which would end the proxy and the client's session with it.
    writer.logMessage(dir, redacted).catch((err: unknown) => {
      process.stderr.write(`mcp-tape: could not write to the trace: ${(err as Error).message}\n`);
    });
  };

  return new Promise((resolve) => {
    // Bytes after the last LF seen so far, kept undecoded until the line is
    // complete. Only the new chunk is searched for LF, so a long line arriving
    // in many chunks costs time proportional to its length.
    let pending: Buffer[] = [];
    src.on('data', (chunk: Buffer | string) => {
      if (!opts.active()) return;
      // Forward the raw bytes downstream unchanged — redaction only affects the trace.
      dst.write(chunk);
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      let start = 0;
      let idx: number;
      while ((idx = buf.indexOf(0x0a, start)) !== -1) {
        pending.push(buf.subarray(start, idx));
        const line = pending.length === 1 ? pending[0]! : Buffer.concat(pending);
        pending = [];
        logLine(line);
        start = idx + 1;
      }
      if (start < buf.length) pending.push(buf.subarray(start));
    });

    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      // Bytes after the last LF are one more line.
      if (pending.length > 0) {
        logLine(Buffer.concat(pending));
        pending = [];
      }
      if (opts.endDst) {
        dst.end();
        resolve();
        return;
      }
      // Wait until what was forwarded has left the process, so exiting right
      // after this doesn't cut off the child's last output. An empty write's
      // callback runs after every earlier write has completed (or failed).
      const timer = setTimeout(resolve, STDOUT_FLUSH_LIMIT_MS);
      dst.write('', () => {
        clearTimeout(timer);
        resolve();
      });
    };
    src.on('end', finish);
    src.on('close', finish);
    src.on('error', finish);
  });
}

function redactCommand(
  command: readonly string[],
  legacyCfg: RedactConfig,
  fileCfg: CompiledRedact | null,
): string[] {
  // String rules only: key-based rules need an object member to look at.
  return command.map((arg) => {
    const stage1 = fileCfg ? redactStringWithConfig(arg, fileCfg) : arg;
    return redact(stage1, legacyCfg) as string;
  });
}

export function deriveLabel(command: readonly string[]): string {
  const skip = new Set(['npx', '-y', '--yes', 'node', 'bun', 'deno', 'run', '--']);
  for (let i = command.length - 1; i >= 0; i--) {
    const c = command[i]!;
    if (c.startsWith('-') || skip.has(c)) continue;
    // Skip args containing whitespace — they're typically header values,
    // env-var payloads, or other secret-bearing strings that would leak
    // sensitive content into the trace filename (and the stderr banner).
    if (/\s/.test(c)) continue;
    // Windows paths use `\` as well as `/`.
    const last = c.split(/[\\/]/).pop() ?? c;
    const cleaned = last.replace(/[^A-Za-z0-9-]/g, '-').toLowerCase();
    if (cleaned) return cleaned.slice(0, 32);
  }
  return 'mcp';
}

// The platform's number for the signal (SIGUSR1 is 10 on Linux, 30 on macOS),
// so a signal exit is 128 + n as a shell would report it.
export function signalNumber(sig: string): number {
  return (osConstants.signals as Record<string, number | undefined>)[sig] ?? 0;
}

function defaultRedactPath(): string {
  const home = process.env.HOME ?? homedir();
  const xdg = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
  return join(xdg, 'mcp-tape', 'redact.json');
}

async function pathIfExists(p: string): Promise<string | null> {
  try { await access(p); return p; } catch { return null; }
}
