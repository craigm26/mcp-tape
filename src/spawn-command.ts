import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Start a command the way a shell would find it, without letting a shell
// re-split its arguments.
//
// POSIX: plain spawn; execvp does the PATH search.
//
// Windows: spawn on its own only finds .exe and .com files, so `npx` (a .cmd
// shim) fails with ENOENT. `shell: true` finds it, but then cmd.exe re-splits
// every argument on spaces and drops empty ones, so `--root "C:\My Docs"`
// reached the server as two arguments. Instead: look the command up the way
// cmd.exe does (current directory, then PATH, trying each PATHEXT extension),
// run programs directly so their arguments arrive exactly, and run anything
// else (.cmd, .bat) through `cmd.exe /d /s /c` with each argument quoted and
// escaped (https://qntm.org/cmd, the scheme cross-spawn uses).
export function spawnCommand(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  if (process.platform !== 'win32') return spawn(command, args, options);

  const env = options.env ?? process.env;
  const cwd =
    typeof options.cwd === 'string'
      ? options.cwd
      : options.cwd
        ? fileURLToPath(options.cwd)
        : process.cwd();
  const resolved = resolveWindowsCommand(command, env, cwd);
  if (resolved === null || /\.(exe|com)$/i.test(resolved)) {
    // Not found: spawn the name as given and let it fail with ENOENT, which
    // the caller reports as status 127.
    return spawn(resolved ?? command, args, options);
  }
  const comspec = envGet(env, 'ComSpec') ?? 'cmd.exe';
  return spawn(comspec, ['/d', '/s', '/c', `"${cmdLine(resolved, args)}"`], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

/**
 * Find `command` the way cmd.exe does. A name with a directory part is
 * resolved against `cwd`; a bare name is looked for in `cwd` (unless
 * NoDefaultCurrentDirectoryInExePath is set) and then in each PATH directory.
 * A name without an extension is tried with each PATHEXT extension in turn;
 * a name with one is looked for as given. Returns the file's full path, or
 * null when there is no such file.
 */
export function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string | null {
  if (command === '') return null;
  const names = extname(command) !== '' ? [command] : pathExts(env).map((e) => command + e);
  const hasDir = /[\\/]/.test(command) || /^[A-Za-z]:/.test(command);
  const dirs = hasDir
    ? [cwd]
    : [...(envGet(env, 'NoDefaultCurrentDirectoryInExePath') === undefined ? [cwd] : []), ...pathDirs(env)];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = hasDir ? resolve(dir, name) : join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The text cmd.exe runs for `file args...`. Every cmd.exe metacharacter is
 * escaped with `^`, and each argument is first quoted for the program's own
 * argument parser (the Microsoft C runtime rules). A batch file that passes
 * `%*` on to another program (as npm's shims do) has its arguments parsed by
 * cmd.exe a second time, so for those the metacharacters are escaped twice.
 */
export function cmdLine(file: string, args: readonly string[], forwardsArgs = batchForwardsArgs(file)): string {
  return [escapeMeta(file), ...args.map((a) => quoteArg(a, forwardsArgs))].join(' ');
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeMeta(s: string): string {
  return s.replace(CMD_META, '^$1');
}

function quoteArg(arg: string, twice: boolean): string {
  // Backslashes before a quote are doubled and the quote escaped; backslashes
  // at the end are doubled because a closing quote follows them.
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  quoted = escapeMeta(`"${quoted}"`);
  return twice ? escapeMeta(quoted) : quoted;
}

function batchForwardsArgs(file: string): boolean {
  try {
    return readFileSync(file, 'latin1').includes('%*');
  } catch {
    return false;
  }
}

function pathExts(env: NodeJS.ProcessEnv): string[] {
  const raw = envGet(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD';
  return raw.split(';').map((s) => s.trim()).filter((s) => s.startsWith('.'));
}

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  return (envGet(env, 'PATH') ?? '')
    .split(';')
    .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
    .filter((s) => s.length > 0);
}

// Windows environment names are case-insensitive (`Path`, `PATH`), but a
// copied env object is a plain one.
function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === lower && v !== undefined) return v;
  }
  return undefined;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
