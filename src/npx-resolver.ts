import { readFile as fsReadFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, posix, win32 } from 'node:path';

const execFileP = promisify(execFile);

/**
 * Detects `npx [-y|--package=pkg] <pkg>[@spec] [subcmd...]` invocations and
 * tries to substitute the package's globally-installed binary, so the runtime
 * spawn skips npx's bootstrap entirely.
 *
 * Issue #2, bug 3: when Antigravity launches `mcp-tape -- npx -y
 * firebase-tools@latest mcp`, cold-cache npx can take 10–30s to download +
 * resolve, which exceeds Antigravity's MCP initialize deadline (~5s). If the
 * user has `npm install -g`'d the package, we can call the actual binary
 * directly and start in <1s.
 *
 * Returns one of three shapes:
 *   - { kind: 'not-npx' }           — the command isn't `npx`, do nothing
 *   - { kind: 'resolved', ... }     — substitute command + args
 *   - { kind: 'unresolved', hint }  — looks like npx but couldn't resolve;
 *                                     `hint` is a one-line install suggestion
 */
export type NpxResolution =
  | { kind: 'not-npx' }
  | { kind: 'resolved'; command: string; args: string[]; packageName: string; binName: string }
  | { kind: 'unresolved'; packageName: string; hint: string };

export interface NpxResolverOpts {
  platform?: NodeJS.Platform;
  /** Override the global npm root for tests. */
  globalRoot?: string;
  /** Override the global npm prefix (parent of node_modules) for tests. */
  globalPrefix?: string;
  exists?: (p: string) => Promise<boolean>;
  readFile?: typeof fsReadFile;
}

async function defaultExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function getNpmGlobalRoot(): Promise<string> {
  const { stdout } = await execFileP('npm', ['root', '-g'], { shell: process.platform === 'win32' });
  return stdout.trim();
}

async function getNpmGlobalPrefix(): Promise<string> {
  const { stdout } = await execFileP('npm', ['config', 'get', 'prefix'], { shell: process.platform === 'win32' });
  return stdout.trim();
}

// Strip `@version`, `@^1.x`, etc. — but keep scoped names intact (@scope/name).
export function stripVersionSpec(spec: string): string {
  // Scoped package: @scope/name[@version]
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/');
    if (slash === -1) return spec; // malformed but pass through
    const at = spec.indexOf('@', slash);
    return at === -1 ? spec : spec.slice(0, at);
  }
  // Unscoped: name[@version]
  const at = spec.indexOf('@');
  return at === -1 ? spec : spec.slice(0, at);
}

interface ParsedNpx {
  packageName: string;
  subcommandArgs: string[];
}

// Parse `npx` args: skip npx-own flags (-y/--yes, --package=X, -p X, --, etc.),
// take the first positional as the package spec, treat everything after as
// subcommand args. Returns null if no package can be identified.
export function parseNpxArgs(args: readonly string[]): ParsedNpx | null {
  let i = 0;
  let pkg: string | null = null;
  while (i < args.length) {
    const a = args[i]!;
    if (a === '--') { i++; continue; }
    if (a === '-y' || a === '--yes') { i++; continue; }
    if (a === '--no-install' || a === '--ignore-existing' || a === '--call' || a === '-c') { i++; continue; }
    if (a === '-p' || a === '--package') { i += 2; continue; }
    if (a.startsWith('--package=') || a.startsWith('-p=')) { i++; continue; }
    if (a.startsWith('-')) { i++; continue; } // any other npx flag
    pkg = a;
    i++;
    break;
  }
  if (!pkg) return null;
  return { packageName: pkg, subcommandArgs: args.slice(i) as string[] };
}

export async function resolveNpxInvocation(
  command: string,
  args: readonly string[],
  opts: NpxResolverOpts = {},
): Promise<NpxResolution> {
  if (command !== 'npx' && command !== 'npx.cmd' && command !== 'npx.CMD') {
    return { kind: 'not-npx' };
  }
  const parsed = parseNpxArgs(args);
  if (!parsed) return { kind: 'not-npx' };
  const packageName = stripVersionSpec(parsed.packageName);

  const platform = opts.platform ?? process.platform;
  const fileExists = opts.exists ?? defaultExists;
  const reader = opts.readFile ?? fsReadFile;

  let globalRoot: string;
  let globalPrefix: string;
  try {
    globalRoot = opts.globalRoot ?? await getNpmGlobalRoot();
    globalPrefix = opts.globalPrefix ?? await getNpmGlobalPrefix();
  } catch {
    return {
      kind: 'unresolved',
      packageName,
      hint: `unable to query npm global root; install ${packageName} globally and re-run install to skip the npx bootstrap`,
    };
  }

  const j = platform === 'win32' ? win32.join : posix.join;
  const pkgJsonPath = j(globalRoot, packageName, 'package.json');
  if (!(await fileExists(pkgJsonPath))) {
    return {
      kind: 'unresolved',
      packageName,
      hint: `${packageName} not installed globally; \`npm install -g ${packageName}\` to avoid npx cold-start (faster init, avoids host-side handshake timeouts)`,
    };
  }

  let pkgJson: { name?: string; bin?: string | Record<string, string> };
  try {
    pkgJson = JSON.parse(await reader(pkgJsonPath, 'utf8')) as typeof pkgJson;
  } catch {
    return {
      kind: 'unresolved',
      packageName,
      hint: `${packageName}/package.json could not be parsed; falling back to npx`,
    };
  }

  // Resolve bin name from the package.json `bin` field.
  let binName: string;
  if (typeof pkgJson.bin === 'string') {
    // Single binary; npm names the shim after the package's `name` field
    // (with scope stripped). Use that to match what `npm install -g` actually
    // generates on disk.
    const n = pkgJson.name ?? packageName;
    binName = n.startsWith('@') ? n.slice(n.indexOf('/') + 1) : n;
  } else if (pkgJson.bin && typeof pkgJson.bin === 'object') {
    const keys = Object.keys(pkgJson.bin);
    if (keys.length === 0) {
      return {
        kind: 'unresolved',
        packageName,
        hint: `${packageName} has no bin entries; falling back to npx`,
      };
    }
    if (keys.length > 1) {
      return {
        kind: 'unresolved',
        packageName,
        hint: `${packageName} ships multiple binaries (${keys.join(', ')}); ambiguous — falling back to npx`,
      };
    }
    binName = keys[0]!;
  } else {
    return {
      kind: 'unresolved',
      packageName,
      hint: `${packageName} has no bin field; falling back to npx`,
    };
  }

  // Locate the shim. On Windows npm puts `<binName>.cmd` directly under prefix.
  // On POSIX, it's `<prefix>/bin/<binName>`.
  const shimPath = platform === 'win32'
    ? j(globalPrefix, binName + '.cmd')
    : j(globalPrefix, 'bin', binName);

  if (!(await fileExists(shimPath))) {
    return {
      kind: 'unresolved',
      packageName,
      hint: `${packageName} has a global install but no shim at ${shimPath}; falling back to npx`,
    };
  }

  return {
    kind: 'resolved',
    command: shimPath,
    args: parsed.subcommandArgs,
    packageName,
    binName,
  };
}