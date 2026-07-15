import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../dist/args.js';

test('parses out + label + command after --', () => {
  const a = parseArgs(['--out', '/tmp/t', '--label', 'fs', '--', 'node', 'server.js']);
  assert.equal(a.out, '/tmp/t');
  assert.equal(a.label, 'fs');
  assert.deepEqual(a.command, ['node', 'server.js']);
  assert.equal(a.useRedactDefaults, true);
});

test('--redact accumulates and keeps defaults', () => {
  const a = parseArgs(['--redact', 'AAA', '--redact', 'BBB', '--', 'x']);
  assert.deepEqual(a.redactPatterns, ['AAA', 'BBB']);
  assert.equal(a.useRedactDefaults, true);
});

test('--no-redact-defaults disables built-ins', () => {
  const a = parseArgs(['--no-redact-defaults', '--', 'x']);
  assert.equal(a.useRedactDefaults, false);
});

test('command without -- is still captured', () => {
  const a = parseArgs(['node', 'server.js']);
  assert.deepEqual(a.command, ['node', 'server.js']);
});

test('login --subdomain parses', () => {
  const a = parseArgs(['login', '--subdomain', 'PlatAtlas']);
  assert.equal(a.subcommand, 'login');
  assert.equal(a.subdomain, 'PlatAtlas');
});

test('login --subdomain=PlatAtlas (=) also parses', () => {
  const a = parseArgs(['login', '--subdomain=PlatAtlas']);
  assert.equal(a.subcommand, 'login');
  assert.equal(a.subdomain, 'PlatAtlas');
});

test('login requires --subdomain', () => {
  assert.throws(
    () => parseArgs(['login']),
    /login requires --subdomain/,
  );
});

test('logout takes no args', () => {
  const a = parseArgs(['logout']);
  assert.equal(a.subcommand, 'logout');
});

test('upload requires a file', () => {
  assert.throws(
    () => parseArgs(['upload']),
    /upload requires a file/,
  );
});

test('upload <file> parses', () => {
  const a = parseArgs(['upload', '/tmp/trace.jsonl']);
  assert.equal(a.subcommand, 'upload');
  assert.equal(a.uploadFile, '/tmp/trace.jsonl');
});

test('upload <file> --worker-base-url override', () => {
  const a = parseArgs([
    'upload',
    '/tmp/trace.jsonl',
    '--worker-base-url',
    'http://127.0.0.1:8788',
  ]);
  assert.equal(a.uploadFile, '/tmp/trace.jsonl');
  assert.equal(a.workerBaseUrl, 'http://127.0.0.1:8788');
});

test('--upload-on-exit proxy flag', () => {
  const a = parseArgs(['--upload-on-exit', '--', 'node', 'server.js']);
  assert.equal(a.uploadOnExit, true);
  assert.deepEqual(a.command, ['node', 'server.js']);
});

test('unknown flag throws', () => {
  assert.throws(() => parseArgs(['--frobulate']));
});

test('missing value after flag throws', () => {
  assert.throws(() => parseArgs(['--out']));
});

test('--help sets flag', () => {
  const a = parseArgs(['--help']);
  assert.equal(a.help, true);
});

test('--version sets flag', () => {
  const a = parseArgs(['-v']);
  assert.equal(a.showVersion, true);
});

test('empty argv defaults are sane', () => {
  const a = parseArgs([]);
  assert.equal(a.out, './mcp-traces');
  assert.equal(a.label, null);
  assert.deepEqual(a.command, []);
});

test('--max-bytes parses', () => {
  const a = parseArgs(['--max-bytes', '1024', '--', 'x']);
  assert.equal(a.maxBytes, 1024);
});

test('--max-files parses', () => {
  const a = parseArgs(['--max-files', '7', '--', 'x']);
  assert.equal(a.maxFiles, 7);
});

test('--max-bytes rejects non-positive', () => {
  assert.throws(() => parseArgs(['--max-bytes', '0']));
  assert.throws(() => parseArgs(['--max-bytes', 'abc']));
});

test('--max-files rejects non-integer', () => {
  assert.throws(() => parseArgs(['--max-files', '1.5']));
  assert.throws(() => parseArgs(['--max-files', '0']));
});

test('rotation defaults are sane', () => {
  const a = parseArgs(['--', 'x']);
  assert.equal(a.maxBytes, 52428800);
  assert.equal(a.maxFiles, 4);
});

test('MCP_TAPE_MAX_BYTES env var sets maxBytes when no CLI flag', () => {
  const prev = process.env.MCP_TAPE_MAX_BYTES;
  process.env.MCP_TAPE_MAX_BYTES = '99999';
  try {
    const a = parseArgs(['--', 'x']);
    assert.equal(a.maxBytes, 99999);
  } finally {
    if (prev === undefined) delete process.env.MCP_TAPE_MAX_BYTES;
    else process.env.MCP_TAPE_MAX_BYTES = prev;
  }
});

test('MCP_TAPE_MAX_FILES env var sets maxFiles when no CLI flag', () => {
  const prev = process.env.MCP_TAPE_MAX_FILES;
  process.env.MCP_TAPE_MAX_FILES = '12';
  try {
    const a = parseArgs(['--', 'x']);
    assert.equal(a.maxFiles, 12);
  } finally {
    if (prev === undefined) delete process.env.MCP_TAPE_MAX_FILES;
    else process.env.MCP_TAPE_MAX_FILES = prev;
  }
});

test('CLI --max-bytes overrides MCP_TAPE_MAX_BYTES env var', () => {
  const prev = process.env.MCP_TAPE_MAX_BYTES;
  process.env.MCP_TAPE_MAX_BYTES = '99999';
  try {
    const a = parseArgs(['--max-bytes', '2048', '--', 'x']);
    assert.equal(a.maxBytes, 2048);
  } finally {
    if (prev === undefined) delete process.env.MCP_TAPE_MAX_BYTES;
    else process.env.MCP_TAPE_MAX_BYTES = prev;
  }
});

test('MCP_TAPE_MAX_FILES rejects non-integer', () => {
  const prev = process.env.MCP_TAPE_MAX_FILES;
  process.env.MCP_TAPE_MAX_FILES = '1.5';
  try {
    assert.throws(() => parseArgs(['--', 'x']));
  } finally {
    if (prev === undefined) delete process.env.MCP_TAPE_MAX_FILES;
    else process.env.MCP_TAPE_MAX_FILES = prev;
  }
});

test('MCP_TAPE_MAX_BYTES rejects non-positive', () => {
  const prev = process.env.MCP_TAPE_MAX_BYTES;
  process.env.MCP_TAPE_MAX_BYTES = '0';
  try {
    assert.throws(() => parseArgs(['--', 'x']));
  } finally {
    if (prev === undefined) delete process.env.MCP_TAPE_MAX_BYTES;
    else process.env.MCP_TAPE_MAX_BYTES = prev;
  }
});

test('install subcommand parses', () => {
  const a = parseArgs(['install']);
  assert.equal(a.subcommand, 'install');
});

test('install --target parses', () => {
  const a = parseArgs(['install', '--target', 'claude-code']);
  assert.deepEqual(a.installTargets, ['claude-code']);
});

test('install --target rejects unknown', () => {
  assert.throws(() => parseArgs(['install', '--target', 'cursor']));
});

test('uninstall subcommand parses', () => {
  const a = parseArgs(['uninstall']);
  assert.equal(a.subcommand, 'uninstall');
});

test('install --dry-run + --force', () => {
  const a = parseArgs(['install', '--dry-run', '--force']);
  assert.equal(a.dryRun, true);
  assert.equal(a.force, true);
});

test('--redact-file parses', () => {
  const a = parseArgs(['--redact-file', '/tmp/r.json', '--', 'x']);
  assert.equal(a.redactFile, '/tmp/r.json');
});

test('install --target accepts antigravity', () => {
  const a = parseArgs(['install', '--target', 'antigravity']);
  assert.deepEqual(a.installTargets, ['antigravity']);
});

test('install --target accepts gemini-cli', () => {
  const a = parseArgs(['install', '--target', 'gemini-cli']);
  assert.deepEqual(a.installTargets, ['gemini-cli']);
});

test('install --target accepts comma-separated mix', () => {
  const a = parseArgs(['install', '--target', 'antigravity,gemini-cli']);
  assert.deepEqual(a.installTargets, ['antigravity', 'gemini-cli']);
});

test('--serve with no value defaults to 7777', () => {
  const a = parseArgs(['--serve', '--', 'node', 'x.js']);
  assert.equal(a.serve, 7777);
});

test('--serve with explicit port parses', () => {
  const a = parseArgs(['--serve', '9001', '--', 'node', 'x.js']);
  assert.equal(a.serve, 9001);
});

test('--serve rejects out-of-range port', () => {
  assert.throws(() => parseArgs(['--serve', '70000', '--', 'x']));
  assert.throws(() => parseArgs(['--serve', '-1', '--', 'x']));
});

test('--serve followed by command (no --) defaults to 7777 and captures command', () => {
  // PowerShell on Windows strips `--` from native-command argv, so the
  // documented invocation `mcp-tape --serve -- npx ...` arrives here as
  // ['--serve', 'npx', '-y', '...']. Treat the non-numeric next token as the
  // start of the wrapped command and use the default port.
  const a = parseArgs(['--serve', 'npx', '-y', '@modelcontextprotocol/server-filesystem', '/home/me']);
  assert.equal(a.serve, 7777);
  assert.deepEqual(a.command, ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/home/me']);
});

test('--serve followed by a flag still defaults to 7777', () => {
  const a = parseArgs(['--serve', '--out', '/tmp/t', '--', 'node', 'x.js']);
  assert.equal(a.serve, 7777);
  assert.equal(a.out, '/tmp/t');
  assert.deepEqual(a.command, ['node', 'x.js']);
});

test('without --serve, serve is null', () => {
  const a = parseArgs(['--', 'node', 'x.js']);
  assert.equal(a.serve, null);
});

test('MCP_TAPE_SERVE env var enables --serve at default port', () => {
  const prev = process.env.MCP_TAPE_SERVE;
  process.env.MCP_TAPE_SERVE = '8080';
  try {
    const a = parseArgs(['--', 'node', 'x.js']);
    assert.equal(a.serve, 8080);
  } finally {
    if (prev === undefined) delete process.env.MCP_TAPE_SERVE;
    else process.env.MCP_TAPE_SERVE = prev;
  }
});

test('--no-file requires --serve', () => {
  assert.throws(() => parseArgs(['--no-file', '--', 'node', 'x.js']), /requires --serve/);
});

test('--no-file with --serve parses', () => {
  const a = parseArgs(['--serve', '--no-file', '--', 'node', 'x.js']);
  assert.equal(a.noFile, true);
  assert.equal(a.serve, 7777);
});

test('--no-file with --serve and explicit port', () => {
  const a = parseArgs(['--serve', '9001', '--no-file', '--', 'node', 'x.js']);
  assert.equal(a.noFile, true);
  assert.equal(a.serve, 9001);
});

test('default noFile is false', () => {
  const a = parseArgs(['--', 'node', 'x.js']);
  assert.equal(a.noFile, false);
});

// ---------------------------------------------------------------------------
// Issue #2: `unwrap` subcommand parsing.
// ---------------------------------------------------------------------------

test('parses "unwrap" as a distinct subcommand', () => {
  const a = parseArgs(['unwrap']);
  assert.equal(a.subcommand, 'unwrap');
  assert.equal(a.installTargets, null);
  assert.equal(a.dryRun, false);
});

test('parses "unwrap --target=antigravity"', () => {
  const a = parseArgs(['unwrap', '--target', 'antigravity']);
  assert.equal(a.subcommand, 'unwrap');
  assert.deepEqual(a.installTargets, ['antigravity']);
});

test('parses "unwrap --dry-run"', () => {
  const a = parseArgs(['unwrap', '--dry-run']);
  assert.equal(a.subcommand, 'unwrap');
  assert.equal(a.dryRun, true);
});

test('parses "unwrap --target=a,b" comma-list', () => {
  const a = parseArgs(['unwrap', '--target', 'antigravity,gemini-cli']);
  assert.equal(a.subcommand, 'unwrap');
  assert.deepEqual(a.installTargets, ['antigravity', 'gemini-cli']);
});

test('unknown flag on unwrap throws with subcommand name in error', () => {
  assert.throws(() => parseArgs(['unwrap', '--frobulate']), /unwrap/);
});

test('parses "install --target=antigravity" (equals form)', () => {
  const a = parseArgs(['install', '--target=antigravity']);
  assert.equal(a.subcommand, 'install');
  assert.deepEqual(a.installTargets, ['antigravity']);
});

test('parses "unwrap --target=antigravity,gemini-cli" comma-list equals form', () => {
  const a = parseArgs(['unwrap', '--target=antigravity,gemini-cli']);
  assert.equal(a.subcommand, 'unwrap');
  assert.deepEqual(a.installTargets, ['antigravity', 'gemini-cli']);
});

test('--target= with empty value throws', () => {
  assert.throws(() => parseArgs(['install', '--target=']), /--target/);
});

test('--target=,, with no real names throws', () => {
  assert.throws(() => parseArgs(['install', '--target=,,']), /--target requires at least one target name/);
});

test('upload subcommand accepts --public flag', () => {
  const args = parseArgs(['upload', 'trace.jsonl', '--public']);
  assert.equal(args.subcommand, 'upload');
  assert.equal(args.uploadFile, 'trace.jsonl');
  assert.equal(args.public, true);
});

test('upload subcommand defaults public=false', () => {
  const args = parseArgs(['upload', 'trace.jsonl']);
  assert.equal(args.public, false);
});

test('--upload-on-exit + --public are both parsed in proxy mode', () => {
  const args = parseArgs(['--upload-on-exit', '--public', '--', 'node', 'srv.js']);
  assert.equal(args.uploadOnExit, true);
  assert.equal(args.public, true);
  assert.deepEqual(args.command, ['node', 'srv.js']);
});
