import type { InstallTargetName } from './install-targets.js';

const KNOWN_TARGETS: readonly InstallTargetName[] = [
  'claude-code',
  'claude-desktop',
  'antigravity',
  'gemini-cli',
];

export interface CliArgs {
  out: string;
  label: string | null;
  redactPatterns: string[];
  useRedactDefaults: boolean;
  showRedactDefaults: boolean;
  showVersion: boolean;
  help: boolean;
  command: string[];
  maxBytes: number;
  maxFiles: number;
  subcommand:
    | 'install'
    | 'uninstall'
    | 'unwrap'
    | 'login'
    | 'logout'
    | 'upload'
    | 'share'
    | null;
  installTargets: InstallTargetName[] | null;
  dryRun: boolean;
  force: boolean;
  redactFile: string | null;
  serve: number | null;
  noFile: boolean;
  /** Org subdomain for PlatAtlas upload (`login`, `upload`,
   *  `--upload-on-exit`). Required for those commands. */
  subdomain: string | null;
  /** Worker base URL override — defaults to
   *  `https://<subdomain>.platatlas.com`. Internal / testing flag. */
  workerBaseUrl: string | null;
  /** Positional argument for `upload <file>`. */
  uploadFile: string | null;
  /** Positional argument for `share <file>`. */
  shareFile: string | null;
  /** `share --delete <id>` — share id (UUID) to delete. */
  shareDelete: string | null;
  /** `share --token <t>` — delete token for `share --delete`. */
  shareToken: string | null;
  /** Share service base URL override (`share --base-url`). Internal /
   *  testing flag; also the escape hatch if the mcpreplay.dev zone
   *  route misbehaves (https://mcp-share.craigm26.workers.dev). */
  shareBaseUrl: string | null;
  /** Proxy-mode flag: on graceful exit, upload the final trace to
   *  PlatAtlas. Requires a session minted by `mcp-tape login`. */
  uploadOnExit: boolean;
  /** Mark the uploaded trace as world-readable by UUID. Anyone with
   *  the UUID can fetch the JSONL (e.g. via mcp-replay). Default false
   *  (private — session cookie required to read back). Applies to both
   *  `mcp-tape upload --public` and `mcp-tape ... --upload-on-exit --public`. */
  public: boolean;
}

const DEFAULTS: CliArgs = {
  out: './mcp-traces',
  label: null,
  redactPatterns: [],
  useRedactDefaults: true,
  showRedactDefaults: false,
  showVersion: false,
  help: false,
  command: [],
  maxBytes: 50 * 1024 * 1024,
  maxFiles: 4,
  subcommand: null,
  installTargets: null,
  dryRun: false,
  force: false,
  redactFile: null,
  serve: null,
  noFile: false,
  subdomain: null,
  workerBaseUrl: null,
  uploadFile: null,
  shareFile: null,
  shareDelete: null,
  shareToken: null,
  shareBaseUrl: null,
  uploadOnExit: false,
  public: false,
};

export function parseArgs(argv: readonly string[]): CliArgs {
  const envBytes = readEnvInt(process.env.MCP_TAPE_MAX_BYTES, 'MCP_TAPE_MAX_BYTES', { allowFloat: true, min: 1 });
  const envFiles = readEnvInt(process.env.MCP_TAPE_MAX_FILES, 'MCP_TAPE_MAX_FILES', { allowFloat: false, min: 1 });
  const envServe = readEnvInt(process.env.MCP_TAPE_SERVE, 'MCP_TAPE_SERVE', { allowFloat: false, min: 1, max: 65535 });
  const args: CliArgs = {
    ...DEFAULTS,
    redactPatterns: [],
    command: [],
    maxBytes: envBytes !== null ? Math.floor(envBytes) : DEFAULTS.maxBytes,
    maxFiles: envFiles ?? DEFAULTS.maxFiles,
    serve: envServe ?? DEFAULTS.serve,
  };

  if (argv.length > 0 && (argv[0] === 'install' || argv[0] === 'uninstall' || argv[0] === 'unwrap')) {
    args.subcommand = argv[0];
    return parseSubcommandArgs(args, argv.slice(1));
  }
  if (argv.length > 0 && (argv[0] === 'login' || argv[0] === 'logout' || argv[0] === 'upload')) {
    args.subcommand = argv[0];
    return parsePlatatlasArgs(args, argv.slice(1));
  }
  if (argv.length > 0 && argv[0] === 'share') {
    args.subcommand = 'share';
    return parseShareArgs(args, argv.slice(1));
  }

  parseProxyArgs(args, argv);
  if (args.noFile && args.serve == null) {
    throw new Error('--no-file requires --serve: serve-only mode has no other output path.');
  }
  return args;
}

function parseProxyArgs(args: CliArgs, argv: readonly string[]): void {
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;

    if (arg === '--') {
      args.command = argv.slice(i + 1) as string[];
      return;
    }

    if (arg === '--help' || arg === '-h') {
      args.help = true;
      i++;
    } else if (arg === '--version' || arg === '-v') {
      args.showVersion = true;
      i++;
    } else if (arg === '--no-redact-defaults') {
      args.useRedactDefaults = false;
      i++;
    } else if (arg === '--redact-defaults') {
      args.showRedactDefaults = true;
      i++;
    } else if (arg === '--out') {
      args.out = needValue(argv, ++i, '--out');
      i++;
    } else if (arg === '--label') {
      args.label = needValue(argv, ++i, '--label');
      i++;
    } else if (arg === '--redact') {
      args.redactPatterns.push(needPattern(argv, ++i, '--redact'));
      i++;
    } else if (arg === '--redact-file') {
      args.redactFile = needValue(argv, ++i, '--redact-file');
      i++;
    } else if (arg === '--serve') {
      // If the next token looks like a port number, parse + validate it.
      // Anything else (a flag, --, missing, or the first token of the wrapped
      // command — which is what PowerShell's native-command shim leaves us
      // with after stripping `--`) defaults to port 7777 and is reprocessed by
      // the next loop iteration. That keeps `mcp-tape --serve -- npx ...`
      // working in bash AND `mcp-tape --serve npx ...` working in PowerShell.
      const peek = argv[i + 1];
      const peekIsNumber = peek !== undefined && /^-?\d+$/.test(peek);
      if (peekIsNumber) {
        const n = Number(peek);
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          throw new Error(`--serve port must be an integer in 1..65535, got ${peek}`);
        }
        args.serve = n;
        i += 2;
      } else {
        args.serve = 7777;
        i++;
      }
    } else if (arg === '--no-file') {
      args.noFile = true;
      i++;
    } else if (arg === '--upload-on-exit') {
      args.uploadOnExit = true;
      i++;
    } else if (arg === '--public') {
      args.public = true;
      i++;
    } else if (arg === '--subdomain' || arg.startsWith('--subdomain=')) {
      args.subdomain = arg.startsWith('--subdomain=')
        ? arg.slice('--subdomain='.length)
        : needValue(argv, ++i, '--subdomain');
      if (args.subdomain.length === 0) {
        throw new Error('--subdomain requires a value');
      }
      i++;
    } else if (arg === '--worker-base-url' || arg.startsWith('--worker-base-url=')) {
      args.workerBaseUrl = arg.startsWith('--worker-base-url=')
        ? arg.slice('--worker-base-url='.length)
        : needValue(argv, ++i, '--worker-base-url');
      i++;
    } else if (arg === '--max-bytes') {
      const v = needValue(argv, ++i, '--max-bytes');
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`--max-bytes must be a positive number, got ${v}`);
      args.maxBytes = Math.floor(n);
      i++;
    } else if (arg === '--max-files') {
      const v = needValue(argv, ++i, '--max-files');
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--max-files must be a positive integer, got ${v}`);
      args.maxFiles = n;
      i++;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      // First non-flag without preceding `--` separator: treat rest as command.
      args.command = argv.slice(i) as string[];
      return;
    }
  }
}

function needValue(argv: readonly string[], i: number, flag: string): string {
  if (i >= argv.length) throw new Error(`${flag} requires an argument`);
  return argv[i]!;
}

// A pattern that doesn't compile is a usage error (status 2), caught here
// before anything is created, rather than a crash once the proxy is running.
function needPattern(argv: readonly string[], i: number, flag: string): string {
  const pattern = needValue(argv, i, flag);
  try {
    new RegExp(pattern, 'g');
  } catch (err) {
    throw new Error(`${flag}: ${(err as Error).message}`);
  }
  return pattern;
}

function readEnvInt(
  raw: string | undefined,
  name: string,
  opts: { allowFloat: boolean; min: number; max?: number },
): number | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < opts.min) {
    throw new Error(`${name} must be a positive number, got ${raw}`);
  }
  if (!opts.allowFloat && !Number.isInteger(n)) {
    throw new Error(`${name} must be an integer, got ${raw}`);
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new Error(`${name} must be ≤ ${opts.max}, got ${raw}`);
  }
  return n;
}

/** `mcp-tape login | logout | upload [<file>]` — PlatAtlas integration
 *  subcommands. Shape:
 *    login   --subdomain <slug> [--worker-base-url <url>]
 *    logout
 *    upload  <file> [--worker-base-url <url>]
 *  The session file remembers which subdomain it was minted for, so
 *  `upload` reads the slug from there — no `--subdomain` needed at
 *  upload time. `--worker-base-url` is a dev/test override that
 *  bypasses the subdomain → URL derivation. */
function parsePlatatlasArgs(args: CliArgs, rest: readonly string[]): CliArgs {
  let i = 0;
  while (i < rest.length) {
    const arg = rest[i]!;
    if (arg === '--subdomain' || arg.startsWith('--subdomain=')) {
      args.subdomain = arg.startsWith('--subdomain=')
        ? arg.slice('--subdomain='.length)
        : needValue(rest, ++i, '--subdomain');
      if (args.subdomain.length === 0) {
        throw new Error('--subdomain requires a value');
      }
      i++;
    } else if (arg === '--worker-base-url' || arg.startsWith('--worker-base-url=')) {
      args.workerBaseUrl = arg.startsWith('--worker-base-url=')
        ? arg.slice('--worker-base-url='.length)
        : needValue(rest, ++i, '--worker-base-url');
      i++;
    } else if (arg === '--public') {
      args.public = true;
      i++;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
      i++;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown ${args.subcommand} flag: ${arg}`);
    } else if (args.subcommand === 'upload' && args.uploadFile === null) {
      args.uploadFile = arg;
      i++;
    } else {
      throw new Error(
        `unexpected ${args.subcommand} argument: ${arg}`,
      );
    }
  }

  if (args.subcommand === 'login' && !args.subdomain) {
    throw new Error('login requires --subdomain <slug>');
  }
  if (args.subcommand === 'upload' && !args.uploadFile) {
    throw new Error('upload requires a file argument: `mcp-tape upload <file>`');
  }

  return args;
}

/** `mcp-tape share <file>` — anonymous public share via mcpreplay.dev.
 *  Shape:
 *    share <trace.jsonl> [--redact PATTERN]... [--redact-file PATH]
 *    share --delete <id> --token <t>
 *  Redaction is NON-SKIPPABLE on this path: `--no-redact-defaults` is
 *  rejected outright, and `--redact` / `--redact-file` only ADD rules
 *  on top of the built-in defaults, never replace them. */
function parseShareArgs(args: CliArgs, rest: readonly string[]): CliArgs {
  let i = 0;
  while (i < rest.length) {
    const arg = rest[i]!;
    if (arg === '--delete' || arg.startsWith('--delete=')) {
      args.shareDelete = arg.startsWith('--delete=')
        ? arg.slice('--delete='.length)
        : needValue(rest, ++i, '--delete');
      if (args.shareDelete.length === 0) throw new Error('--delete requires a share id');
      i++;
    } else if (arg === '--token' || arg.startsWith('--token=')) {
      args.shareToken = arg.startsWith('--token=')
        ? arg.slice('--token='.length)
        : needValue(rest, ++i, '--token');
      if (args.shareToken.length === 0) throw new Error('--token requires a value');
      i++;
    } else if (arg === '--redact') {
      args.redactPatterns.push(needPattern(rest, ++i, '--redact'));
      i++;
    } else if (arg === '--redact-file') {
      args.redactFile = needValue(rest, ++i, '--redact-file');
      i++;
    } else if (arg === '--base-url' || arg.startsWith('--base-url=')) {
      args.shareBaseUrl = arg.startsWith('--base-url=')
        ? arg.slice('--base-url='.length)
        : needValue(rest, ++i, '--base-url');
      i++;
    } else if (arg === '--no-redact-defaults') {
      throw new Error(
        'share always redacts: --no-redact-defaults is not supported here. ' +
          'Custom redact rules (--redact, --redact-file) are applied in addition to the defaults.',
      );
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
      i++;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown share flag: ${arg}`);
    } else if (args.shareFile === null) {
      args.shareFile = arg;
      i++;
    } else {
      throw new Error(`unexpected share argument: ${arg}`);
    }
  }

  if (args.help) return args;
  const deleteMode = args.shareDelete !== null || args.shareToken !== null;
  if (deleteMode) {
    if (!args.shareDelete || !args.shareToken) {
      throw new Error('share --delete requires both --delete <id> and --token <t>');
    }
    if (args.shareFile !== null) {
      throw new Error('share --delete does not take a file argument');
    }
  } else if (!args.shareFile) {
    throw new Error('share requires a file argument: `mcp-tape share <trace.jsonl>`');
  }

  return args;
}

function parseSubcommandArgs(args: CliArgs, rest: readonly string[]): CliArgs {
  let i = 0;
  while (i < rest.length) {
    const arg = rest[i]!;
    // Allow both `--target=a,b` and `--target a,b` (README documents the
    // former; the parser previously only accepted the latter).
    if (arg === '--target' || arg.startsWith('--target=')) {
      const v = arg.startsWith('--target=') ? arg.slice('--target='.length) : needValue(rest, ++i, '--target');
      if (v.length === 0) throw new Error('--target requires a value');
      const names = v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      if (names.length === 0) throw new Error('--target requires at least one target name');
      for (const n of names) {
        if (!(KNOWN_TARGETS as readonly string[]).includes(n)) {
          throw new Error(`unknown target: ${n} (known: ${KNOWN_TARGETS.join(', ')})`);
        }
      }
      args.installTargets = names as InstallTargetName[];
      i++;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
      i++;
    } else if (arg === '--force') {
      args.force = true;
      i++;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
      i++;
    } else {
      throw new Error(`unknown ${args.subcommand} flag: ${arg}`);
    }
  }
  return args;
}
