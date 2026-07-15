import { readFile, writeFile, copyFile, access, unlink } from 'node:fs/promises';
import { join, win32 as pathWin32, posix as pathPosix } from 'node:path';
import { resolveNpxInvocation } from './npx-resolver.js';

interface InstallOpts {
  mcpTapeBin: string;
  force?: boolean;
  // Test seam: override platform / env / FS check so tests can simulate Windows
  // path resolution without actually being on Windows.
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => Promise<boolean>;
}

interface ServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  serverUrl?: string;
  _mcpTape?: {
    wrapped: true;
    originalCommand: string;
    originalArgs: string[];
  };
  [k: string]: unknown;
}

interface ConfigShape {
  mcpServers?: Record<string, ServerEntry>;
  [k: string]: unknown;
}

export function isWrapped(entry: ServerEntry): boolean {
  return entry._mcpTape?.wrapped === true;
}

// Remote/HTTP MCP servers are addressed by URL and have no stdio child to
// proxy. Wrapping them produces invalid config (both transports specified)
// and a bogus `args` array with a null in it (issue #2, bug 1).
export function isRemoteEntry(entry: ServerEntry): boolean {
  return typeof entry.serverUrl === 'string' && entry.serverUrl.length > 0;
}

// Pure-Node `which` that respects Windows PATHEXT. Returns the absolute path
// of the first match, or null if the command can't be resolved.
//
// On Windows, an MCP host (e.g. Antigravity) may launch mcp-tape with a child
// environment whose PATH doesn't include the directory containing the wrapped
// command — and even when it does, Node's spawn(cmd) won't resolve `.bat`/
// `.cmd` shims without `shell: true`. By baking an absolute path into the
// wrapped `args` at install time we sidestep both the PATH-stripping issue
// and the PATHEXT resolution path entirely (issue #2, bug 2).
export async function resolveCommandPath(
  cmd: string,
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; exists?: (p: string) => Promise<boolean> } = {},
): Promise<string | null> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const fileExists = opts.exists ?? defaultExists;

  // Already an absolute or relative path with a separator — accept as-is if
  // it exists. The install caller will fall back to the unresolved command
  // string if we return null, so we don't try to invent a path here.
  if (cmd.includes('/') || cmd.includes('\\')) {
    return (await fileExists(cmd)) ? cmd : null;
  }

  const isWin = platform === 'win32';
  const sep = isWin ? ';' : ':';
  const pathEnv = env.PATH ?? env.Path ?? '';
  const dirs = pathEnv.split(sep).filter((d) => d.length > 0);
  // PATHEXT is Windows-only; on POSIX we look for the bare name with no
  // extension (the empty string in the extension list).
  const exts = isWin
    ? ((env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e.length > 0))
    : [''];

  // Use the platform-specific joiner so simulated Windows paths join with
  // backslashes even when the host is POSIX (the test seam fails otherwise).
  // On real Windows `pathJoin === path.join`, so production behavior is
  // unchanged.
  const pathJoin = isWin ? pathWin32.join : pathPosix.join;
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = pathJoin(dir, cmd + ext);
      if (await fileExists(candidate)) return candidate;
    }
  }
  return null;
}

async function defaultExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export function wrapEntry(
  entry: ServerEntry,
  mcpTapeBin: string,
  opts: { resolvedCommand?: string } = {},
): ServerEntry {
  if (isWrapped(entry)) {
    // Refresh the wrapped command if the requested mcp-tape bin differs from
    // what was previously baked in (e.g. the user reinstalled mcp-tape via a
    // different path). The marker is the source of truth for the original;
    // we use `resolvedCommand` ?? originalCommand to update the spawn target.
    if (entry.command === mcpTapeBin && !opts.resolvedCommand) return entry;
    const marker = entry._mcpTape!;
    const cmdToSpawn = opts.resolvedCommand ?? marker.originalCommand;
    return {
      ...entry,
      command: mcpTapeBin,
      args: ['--', cmdToSpawn, ...marker.originalArgs],
    };
  }
  // Defensive: callers should have filtered these out before reaching wrap,
  // but if a malformed entry slips through, surface a clear error rather
  // than silently producing `["--", undefined, ...]` (issue #2, bug 1).
  if (typeof entry.command !== 'string' || entry.command.length === 0) {
    throw new Error('wrapEntry: entry has no command to wrap (remote-only / serverUrl entries must be skipped)');
  }
  const originalCommand = entry.command;
  const originalArgs = entry.args ?? [];
  const cmdToSpawn = opts.resolvedCommand ?? originalCommand;
  return {
    ...entry,
    command: mcpTapeBin,
    args: ['--', cmdToSpawn, ...originalArgs],
    _mcpTape: { wrapped: true, originalCommand, originalArgs },
  };
}

export function unwrapEntry(entry: ServerEntry): ServerEntry {
  if (!isWrapped(entry)) return entry;
  const { _mcpTape, ...rest } = entry;
  const restored: ServerEntry = { ...rest };
  if (typeof _mcpTape!.originalCommand === 'string' && _mcpTape!.originalCommand.length > 0) {
    restored.command = _mcpTape!.originalCommand;
    restored.args = _mcpTape!.originalArgs;
  } else {
    // The pre-wrap entry had no command (remote/serverUrl-only). Remove the
    // spawn fields entirely so the unwrap restores a valid remote entry,
    // rather than leaving behind `command: undefined` (issue #2, bug 1
    // cleanup case).
    delete restored.command;
    delete restored.args;
  }
  return restored;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export interface InstallResult {
  wrapped: number;
  alreadyWrapped: number;
  refreshed: number;
  skippedRemote: number;
  /** Per-entry npx pre-resolve hints (resolved or not), keyed by server name. */
  npxHints: Array<{ server: string; resolved: boolean; message: string }>;
}

export async function installToConfig(path: string, opts: InstallOpts): Promise<InstallResult> {
  const text = await readFile(path, 'utf8');
  const cfg = JSON.parse(text) as ConfigShape;
  const servers = cfg.mcpServers ?? {};
  let wrapped = 0;
  let alreadyWrapped = 0;
  let refreshed = 0;
  let skippedRemote = 0;
  const npxHints: InstallResult['npxHints'] = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (isWrapped(entry)) {
      if (entry.command !== opts.mcpTapeBin) {
        servers[name] = wrapEntry(entry, opts.mcpTapeBin);
        refreshed++;
      } else {
        alreadyWrapped++;
      }
      continue;
    }
    if (isRemoteEntry(entry) || typeof entry.command !== 'string' || entry.command.length === 0) {
      // Remote/HTTP server — has serverUrl, no stdio child. Or malformed
      // entry with no command. Either way, skip wrapping (issue #2, bug 1).
      skippedRemote++;
      continue;
    }
    // npx pre-resolve (issue #2, bug 3): if the entry is `npx -y <pkg>` and
    // <pkg> is globally installed, substitute the actual binary path so the
    // runtime spawn skips npx's bootstrap and avoids the host handshake
    // deadline. Emit a hint either way so users know what's happening.
    let entryToWrap: ServerEntry = entry;
    if (entry.command === 'npx' && Array.isArray(entry.args)) {
      const npxRes = await resolveNpxInvocation(entry.command, entry.args, {
        platform: opts.platform,
        exists: opts.exists,
      });
      if (npxRes.kind === 'resolved') {
        // Replace command/args in-place; marker (computed by wrapEntry) will
        // still preserve the original npx invocation for unwrap.
        entryToWrap = { ...entry, command: npxRes.command, args: npxRes.args };
        npxHints.push({
          server: name,
          resolved: true,
          message: `pre-resolved \`npx -y ${npxRes.packageName}\` → ${npxRes.command}`,
        });
      } else if (npxRes.kind === 'unresolved') {
        npxHints.push({ server: name, resolved: false, message: npxRes.hint });
      }
    }
    const resolved = await resolveCommandPath(entryToWrap.command!, {
      platform: opts.platform,
      env: opts.env,
      exists: opts.exists,
    });
    // For npx pre-resolved entries we want the marker's originalCommand to
    // be the ORIGINAL `npx`, not the substituted shim — so unwrap restores
    // the user's intent. Achieve this by wrapping the entry whose
    // command/args we've already substituted, but overriding the marker
    // bookkeeping if a substitution happened.
    if (entryToWrap !== entry) {
      // Substitution path: build the wrap by hand so the marker remembers
      // the original entry (npx + original args), not the substituted shim.
      const originalCommand = entry.command;
      const originalArgs = entry.args ?? [];
      const cmdToSpawn = resolved ?? entryToWrap.command!;
      servers[name] = {
        ...entryToWrap,
        command: opts.mcpTapeBin,
        args: ['--', cmdToSpawn, ...(entryToWrap.args ?? [])],
        _mcpTape: { wrapped: true, originalCommand, originalArgs },
      };
    } else {
      servers[name] = wrapEntry(entryToWrap, opts.mcpTapeBin, { resolvedCommand: resolved ?? undefined });
    }
    wrapped++;
  }
  cfg.mcpServers = servers;
  if (wrapped > 0 || refreshed > 0) {
    const backup = `${path}.mcp-tape.bak`;
    if (opts.force || !(await exists(backup))) {
      await copyFile(path, backup);
    }
    await writeFile(path, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  }
  return { wrapped, alreadyWrapped, refreshed, skippedRemote, npxHints };
}

// Unwrap without touching the .bak backup. This is the read-back-the-marker
// operation: it restores each wrapped entry to its original command/args
// shape, leaving any post-install manual edits to other parts of the file
// intact. Use `uninstall` instead when you want the .bak-fallback safety
// net for files that were edited away from the marker shape.
export async function unwrapFromConfig(path: string): Promise<{ unwrapped: number; skipped: number }> {
  const text = await readFile(path, 'utf8');
  const cfg = JSON.parse(text) as ConfigShape;
  const servers = cfg.mcpServers ?? {};
  let unwrapped = 0;
  let skipped = 0;
  for (const [name, entry] of Object.entries(servers)) {
    if (isWrapped(entry)) {
      servers[name] = unwrapEntry(entry);
      unwrapped++;
    } else {
      skipped++;
    }
  }
  cfg.mcpServers = servers;
  if (unwrapped > 0) {
    await writeFile(path, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  }
  return { unwrapped, skipped };
}

export async function uninstallFromConfig(path: string): Promise<{ unwrapped: number; restoredFromBak: boolean }> {
  const backup = `${path}.mcp-tape.bak`;
  const text = await readFile(path, 'utf8');
  const cfg = JSON.parse(text) as ConfigShape;
  const servers = cfg.mcpServers ?? {};
  let unwrapped = 0;
  for (const [name, entry] of Object.entries(servers)) {
    if (isWrapped(entry)) {
      servers[name] = unwrapEntry(entry);
      unwrapped++;
    }
  }
  cfg.mcpServers = servers;

  if (unwrapped > 0) {
    await writeFile(path, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    await unlink(backup).catch(() => {});
    return { unwrapped, restoredFromBak: false };
  }

  // No markers found. Try .bak fallback.
  if (await exists(backup)) {
    await copyFile(backup, path);
    await unlink(backup).catch(() => {});
    return { unwrapped: 0, restoredFromBak: true };
  }

  return { unwrapped: 0, restoredFromBak: false };
}