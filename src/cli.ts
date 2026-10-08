#!/usr/bin/env node
import { parseArgs } from './args.js';
import { runProxy } from './proxy.js';
import { describeDefaults } from './redact.js';
import { VERSION } from './version.js';

async function main(): Promise<void> {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`mcp-tape: ${(err as Error).message}\n`);
    process.stderr.write(`run \`mcp-tape --help\` for usage.\n`);
    process.exit(2);
  }

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.showVersion) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }

  if (args.showRedactDefaults) {
    process.stdout.write(describeDefaults() + '\n');
    process.exit(0);
  }

  if (args.subcommand === 'login') {
    const { runDeviceLogin, writeSession } = await import('./auth.js');
    try {
      const session = await runDeviceLogin({
        subdomain: args.subdomain!,
        ...(args.workerBaseUrl !== null ? { workerBaseUrl: args.workerBaseUrl } : {}),
      });
      await writeSession(session);
      process.stdout.write(
        `\nLogged in as ${session.subject} for ${session.subdomain}.\n` +
          `Session valid until ${new Date(session.expires_at * 1000).toISOString()}.\n`,
      );
    } catch (e) {
      process.stderr.write(`mcp-tape login: ${(e as Error).message}\n`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (args.subcommand === 'logout') {
    const { deleteSession, sessionFilePath } = await import('./auth.js');
    await deleteSession();
    process.stdout.write(`Cleared ${sessionFilePath()}\n`);
    process.exit(0);
  }

  if (args.subcommand === 'upload') {
    const { uploadTrace } = await import('./upload.js');
    const { readSession } = await import('./auth.js');
    try {
      const r = await uploadTrace({
        file: args.uploadFile!,
        public: args.public,
        ...(args.workerBaseUrl !== null ? { workerBaseUrl: args.workerBaseUrl } : {}),
      });
      process.stdout.write(
        `Uploaded ${args.uploadFile} → ${r.id} (${r.byte_size} bytes, ingested ${r.ingested_at})\n`,
      );
      if (args.public) {
        // The session file remembers the subdomain the upload was
        // signed against, so we can hand back a ready-to-paste viewer
        // URL without an extra round-trip. workerBaseUrl override is
        // a dev/testing flag; in that mode skip the URL echo because
        // the override is rarely the same host the viewer would hit.
        const session = await readSession();
        if (session && args.workerBaseUrl === null) {
          process.stdout.write(
            `View at https://mcpreplay.dev/?trace=https://${session.subdomain}.platatlas.com/api/traces/${r.id}\n`,
          );
        }
      }
    } catch (e) {
      process.stderr.write(`mcp-tape upload: ${(e as Error).message}\n`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (args.subcommand === 'share') {
    const { shareTrace, deleteShare } = await import('./share.js');
    try {
      if (args.shareDelete !== null) {
        await deleteShare({
          id: args.shareDelete,
          token: args.shareToken!,
          ...(args.shareBaseUrl !== null ? { baseUrl: args.shareBaseUrl } : {}),
        });
        process.stdout.write(`Deleted share ${args.shareDelete}.\n`);
      } else {
        const r = await shareTrace({
          file: args.shareFile!,
          extraPatterns: args.redactPatterns,
          ...(args.redactFile !== null ? { userRedactPath: args.redactFile } : {}),
          ...(args.shareBaseUrl !== null ? { baseUrl: args.shareBaseUrl } : {}),
        });
        process.stdout.write(
          `\nShared (redacted): ${r.url}\n\n` +
            `  Anyone with this link can view the trace. It was redacted\n` +
            `  client-side before upload and re-redacted by the server.\n\n` +
            `  Expires: ${r.expiresAt} (30 day auto-expiry)\n` +
            `  Delete:  mcp-tape share --delete ${r.id} --token ${r.deleteToken}\n`,
        );
      }
    } catch (e) {
      process.stderr.write(`mcp-tape share: ${(e as Error).message}\n`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (args.subcommand === 'install' || args.subcommand === 'uninstall' || args.subcommand === 'unwrap') {
    const { discoverTargets } = await import('./install-targets.js');
    const { installToConfig, uninstallFromConfig, unwrapFromConfig } = await import('./install.js');
    const found = await discoverTargets();
    const targets = args.installTargets
      ? found.filter((t) => args.installTargets!.includes(t.name))
      : found;
    if (targets.length === 0) {
      process.stderr.write('mcp-tape: no config targets found.\n');
      process.exit(2);
    }
    const { resolveMcpTapeBin } = await import('./install-bin.js');
    const mcpTapeBin = await resolveMcpTapeBin();
    for (const t of targets) {
      if (args.dryRun) {
        process.stdout.write(`would ${args.subcommand} ${t.name} at ${t.path}\n`);
        continue;
      }
      if (args.subcommand === 'install') {
        const r = await installToConfig(t.path, { mcpTapeBin, force: args.force });
        const skipped = r.skippedRemote > 0 ? `, skipped-remote ${r.skippedRemote}` : '';
        process.stdout.write(`${t.name}: wrapped ${r.wrapped}, refreshed ${r.refreshed}, already-wrapped ${r.alreadyWrapped}${skipped}\n`);
        for (const hint of r.npxHints) {
          // Resolved hints to stdout (informational); unresolved hints to
          // stderr so they stand out — they're actionable suggestions.
          const stream = hint.resolved ? process.stdout : process.stderr;
          stream.write(`  ${hint.server}: ${hint.message}\n`);
        }
      } else if (args.subcommand === 'unwrap') {
        const r = await unwrapFromConfig(t.path);
        process.stdout.write(`${t.name}: unwrapped ${r.unwrapped}\n`);
      } else {
        const r = await uninstallFromConfig(t.path);
        if (r.restoredFromBak) {
          process.stderr.write(
            `${t.name}: no markers found at ${t.path}; restored entire file from ${t.path}.mcp-tape.bak — any post-install manual edits to this file have been replaced.\n`,
          );
        } else {
          process.stdout.write(`${t.name}: unwrapped ${r.unwrapped}\n`);
        }
      }
    }
    process.exit(0);
  }

  if (args.command.length === 0) {
    process.stderr.write(
      'mcp-tape: missing server command. Use `--` to separate flags from the command.\n',
    );
    process.stderr.write('run `mcp-tape --help` for usage.\n');
    process.exit(2);
  }

  const code = await runProxy(args);
  process.exit(code);
}

function printHelp(): void {
  process.stdout.write(`mcp-tape ${VERSION} — stdio proxy that logs MCP JSON-RPC traffic.

Usage:
  mcp-tape [options] -- <server-command> [server-args...]
  mcp-tape install [--target=<list>] [--dry-run] [--force]
  mcp-tape uninstall [--target=<list>] [--dry-run]
  mcp-tape unwrap [--target=<list>] [--dry-run]
  mcp-tape login --subdomain <slug>
  mcp-tape logout
  mcp-tape upload <file> [--public]
  mcp-tape share <trace.jsonl> [--redact PATTERN]... [--redact-file PATH]
  mcp-tape share --delete <id> --token <token>

Known install/uninstall targets (default: all auto-detected on disk):
  claude-code      ~/.claude.json
  claude-desktop   per-OS:
                     Windows  %APPDATA%\\Claude\\claude_desktop_config.json
                     macOS    ~/Library/Application Support/Claude/claude_desktop_config.json
                     Linux    ~/.config/Claude/claude_desktop_config.json
  antigravity      ~/.gemini/antigravity/mcp_config.json
  gemini-cli       ~/.gemini/settings.json

Options:
  --out DIR             Directory for trace files (default: ./mcp-traces)
  --label NAME          Trace label (default: derived from command)
  --redact PATTERN      Extra regex to redact from logged strings. May be passed
                        multiple times. Built-in patterns also apply unless
                        --no-redact-defaults is given.
  --redact-file PATH    Load redaction rules from a JSON file (default:
                        ~/.config/mcp-tape/redact.json if present).
                        Env: MCP_TAPE_REDACT (CLI flag overrides).
  --no-redact-defaults  Disable built-in redaction patterns AND skip auto-loading
                        of ~/.config/mcp-tape/redact.json.
  --redact-defaults     Print the built-in redaction patterns and exit.
  --max-bytes N         Rotate the trace file when it exceeds N bytes (default: 52428800).
                        Env: MCP_TAPE_MAX_BYTES (CLI flag overrides).
  --max-files N         Keep at most N rotated files (.1 ... .N), oldest evicted (default: 4).
                        Env: MCP_TAPE_MAX_FILES (CLI flag overrides).
  --serve [PORT]        Start a localhost websocket on PORT (default 7777) that
                        streams every JSONL frame as it's written. Open the
                        session in mcp-replay with \`?live=ws://127.0.0.1:<port>\`.
                        If the requested port is already in use, mcp-tape will
                        scan a small range above it (and then ask the OS for any
                        free port) and print the bound port on stderr.
                        Env: MCP_TAPE_SERVE (a port number).
  --no-file             Stream over the websocket only; do not write a .jsonl
                        trace to disk. Requires --serve. Useful for short
                        debug sessions where you don't want a file to clean up.
  --public              When used with --upload-on-exit (or \`mcp-tape upload\`),
                        flag the uploaded trace as world-readable by UUID. Anyone
                        with the UUID can fetch it (e.g. via mcp-replay). Cannot
                        be reverted from the CLI — to remove, delete via PlatAtlas
                        admin or re-upload privately and discard the old UUID.
                        Default: private (session-cookie required to read back).
  --upload-on-exit      After the wrapped server exits, upload the final trace
                        to PlatAtlas. Requires a session minted by
                        \`mcp-tape login\`. Best-effort: failures land on stderr
                        but don't change the proxy exit code.
  --subdomain SLUG      Org slug for the PlatAtlas upload subcommands.
  --worker-base-url URL Override the Worker URL (default: derived from
                        --subdomain). Internal / testing flag.
  --version, -v         Print version and exit.
  --help, -h            Show this help.

Share (anonymous, public):
  \`mcp-tape share <file>\` uploads a REDACTED copy of a JSONL trace to
  mcpreplay.dev and prints an unlisted public link (no account needed).
  Redaction cannot be disabled on this path — custom rules (--redact,
  --redact-file, ~/.config/mcp-tape/redact.json) are applied IN ADDITION
  to the built-in defaults, and the server re-redacts on ingest. Shares
  auto-expire after 30 days; delete sooner with the printed
  \`mcp-tape share --delete <id> --token <token>\` command.
  Env: MCP_TAPE_SELF=1 adds an \`X-MCP-Tape-Self: 1\` header so the
  maintainer's own shares are excluded from adoption metrics.

Examples:
  mcp-tape -- npx -y @modelcontextprotocol/server-filesystem /home/me
  mcp-tape --out ~/.mcp-traces --label fs -- node my-server.js
  mcp-tape --redact 'MYCO_[A-Z0-9]{20}' -- node my-server.js
  mcp-tape share ./mcp-traces/fs.jsonl

Trace files are JSONL; open them at https://mcpreplay.dev/?trace=<url>.
`);
}

main().catch((err) => {
  process.stderr.write(`mcp-tape: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
