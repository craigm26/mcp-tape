import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TraceWriter } from './writer.js';
import { buildConfig, redact, type RedactConfig } from './redact.js';
import { loadRedactConfig, redactWithConfig, type CompiledRedact } from './redact-config.js';
import type { CliArgs } from './args.js';
import type { WsBroadcaster } from './ws-broadcast.js';

const VERSION = '0.3.0';

export async function runProxy(args: CliArgs): Promise<number> {
  if (!args.noFile) await mkdir(args.out, { recursive: true });

  const label = args.label ?? deriveLabel(args.command);
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
    command: args.command,
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

  // On Windows, `spawn('npx', ...)` etc. fail with ENOENT because npx is a
  // .cmd batch shim, not a bare executable. `shell: true` routes through
  // cmd.exe which resolves PATHEXT correctly. No-op on POSIX where the
  // executable can be found directly.
  const child: ChildProcess = spawn(args.command[0]!, args.command.slice(1), {
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  });

  const inDone = pipeWithLog(process.stdin, child.stdin!, 'in', writer, legacyCfg, fileCfg);
  const outDone = pipeWithLog(child.stdout!, process.stdout, 'out', writer, legacyCfg, fileCfg);

  // Signal forwarding so SIGINT/SIGTERM reach the child cleanly.
  const fwd = (sig: NodeJS.Signals) => () => {
    if (!child.killed) child.kill(sig);
  };
  process.on('SIGINT', fwd('SIGINT'));
  process.on('SIGTERM', fwd('SIGTERM'));

  const exitCode = await new Promise<number>((resolve) => {
    child.on('exit', (code, signal) => {
      const ec = code ?? (signal ? 128 + signalNumber(signal) : 0);
      resolve(ec);
    });
  });

  // Drain pipes so any final line gets logged before close.
  await Promise.allSettled([inDone, outDone]);

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

function pipeWithLog(
  src: NodeJS.ReadableStream,
  dst: NodeJS.WritableStream,
  dir: 'in' | 'out',
  writer: TraceWriter,
  legacyCfg: RedactConfig,
  fileCfg: CompiledRedact | null,
): Promise<void> {
  return new Promise((resolve) => {
    let buffer = '';
    src.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      // Forward the raw bytes downstream unchanged — redaction only affects the trace.
      dst.write(chunk);
      buffer += text;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line) as unknown;
          const stage1 = fileCfg ? redactWithConfig(raw, fileCfg) : raw;
          const redacted = redact(stage1, legacyCfg);
          // Fire-and-forget; ordering preserved by writer's internal queueing model
          // (FileHandle.write resolves in order on a single handle).
          void writer.logMessage(dir, redacted);
        } catch {
          // Non-JSON line — not protocol data, skip logging.
        }
      }
    });
    src.on('end', () => resolve());
    src.on('error', () => resolve());
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
    const last = c.split('/').pop() ?? c;
    const cleaned = last.replace(/[^A-Za-z0-9-]/g, '-').toLowerCase();
    if (cleaned) return cleaned.slice(0, 32);
  }
  return 'mcp';
}

function signalNumber(sig: string): number {
  // POSIX-ish defaults; good enough for an informative exit code.
  const map: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
  return map[sig] ?? 0;
}

function defaultRedactPath(): string {
  const home = process.env.HOME ?? homedir();
  const xdg = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
  return join(xdg, 'mcp-tape', 'redact.json');
}

async function pathIfExists(p: string): Promise<string | null> {
  try { await access(p); return p; } catch { return null; }
}
