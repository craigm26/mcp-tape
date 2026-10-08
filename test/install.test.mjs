import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, copyFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installToConfig, uninstallFromConfig, isWrapped } from '../dist/install.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function tempConfig() {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-tape-inst-'));
  const target = join(dir, 'claude.json');
  await copyFile(join(__dirname, 'fixtures/configs/claude.json'), target);
  return { dir, target };
}

test('install wraps every mcpServers entry', async () => {
  const { dir, target } = await tempConfig();
  await installToConfig(target, { mcpTapeBin: 'mcp-tape' });
  const after = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(after.mcpServers.filesystem.command, 'mcp-tape');
  assert.equal(after.mcpServers.github.command, 'mcp-tape');
  assert.ok(isWrapped(after.mcpServers.filesystem));
  assert.ok(isWrapped(after.mcpServers.github));
  assert.deepEqual(after.mcpServers.github.env, { GITHUB_TOKEN: 'ghp_xxx' });
  await rm(dir, { recursive: true });
});

test('install is idempotent', async () => {
  const { dir, target } = await tempConfig();
  await installToConfig(target, { mcpTapeBin: 'mcp-tape' });
  const after1 = await readFile(target, 'utf8');
  const result = await installToConfig(target, { mcpTapeBin: 'mcp-tape' });
  const after2 = await readFile(target, 'utf8');
  assert.equal(after1, after2);
  assert.equal(result.wrapped, 0);
  assert.equal(result.refreshed, 0);
  assert.equal(result.alreadyWrapped, 2);
  await rm(dir, { recursive: true });
});

test('install creates .bak only once', async () => {
  const { dir, target } = await tempConfig();
  await installToConfig(target, { mcpTapeBin: 'mcp-tape' });
  const bak1 = await readFile(target + '.mcp-tape.bak', 'utf8');
  const cfg = JSON.parse(await readFile(target, 'utf8'));
  cfg.mcpServers.added = { command: 'mcp-tape', args: ['--', 'node', 'x.js'], _mcpTape: { wrapped: true, originalCommand: 'node', originalArgs: ['x.js'] } };
  await writeFile(target, JSON.stringify(cfg, null, 2));
  await installToConfig(target, { mcpTapeBin: 'mcp-tape' });
  const bak2 = await readFile(target + '.mcp-tape.bak', 'utf8');
  assert.equal(bak1, bak2);
  await rm(dir, { recursive: true });
});

test('uninstall restores original commands', async () => {
  const { dir, target } = await tempConfig();
  await installToConfig(target, { mcpTapeBin: 'mcp-tape' });
  await uninstallFromConfig(target);
  const after = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(after.mcpServers.filesystem.command, 'npx');
  assert.deepEqual(after.mcpServers.filesystem.args, ['-y', '@modelcontextprotocol/server-filesystem', '/home/me']);
  assert.equal(after.mcpServers.github.command, 'node');
  assert.deepEqual(after.mcpServers.github.env, { GITHUB_TOKEN: 'ghp_xxx' });
  assert.equal(after.mcpServers.filesystem._mcpTape, undefined);
  await rm(dir, { recursive: true });
});

test('uninstall is no-op when nothing wrapped', async () => {
  const { dir, target } = await tempConfig();
  const result = await uninstallFromConfig(target);
  assert.equal(result.unwrapped, 0);
  await rm(dir, { recursive: true });
});

import { discoverTargets } from '../dist/install-targets.js';
import { writeFile as fsWriteFile } from 'node:fs/promises';

test('discoverTargets identifies claude-code config at $HOME/.claude.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-tape-disc-'));
  await fsWriteFile(join(dir, '.claude.json'), '{"mcpServers":{}}');
  const targets = await discoverTargets({ home: dir });
  const names = targets.map((t) => t.name);
  assert.ok(names.includes('claude-code'));
  await rm(dir, { recursive: true });
});

test('discoverTargets returns empty array when no configs present', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-tape-disc-empty-'));
  // An empty env too: on Windows the Claude Desktop path comes from %APPDATA%,
  // which would otherwise point at the real profile of whoever runs the tests.
  const targets = await discoverTargets({ home: dir, env: {} });
  assert.deepEqual(targets, []);
  await rm(dir, { recursive: true });
});

import { unlink as fsUnlink } from 'node:fs/promises';

test('uninstall deletes .bak after successful restore', async () => {
  const { dir, target } = await tempConfig();
  await installToConfig(target, { mcpTapeBin: 'mcp-tape' });
  // .bak was created by install
  await access(target + '.mcp-tape.bak');
  const result = await uninstallFromConfig(target);
  assert.equal(result.unwrapped, 2);
  assert.equal(result.restoredFromBak, false);
  // .bak should be gone now
  await assert.rejects(access(target + '.mcp-tape.bak'));
  await rm(dir, { recursive: true });
});

test('uninstall falls back to .bak when no markers present', async () => {
  const { dir, target } = await tempConfig();
  const original = await readFile(target, 'utf8');
  await installToConfig(target, { mcpTapeBin: 'mcp-tape' });
  // Strip markers manually so per-entry uninstall has nothing to do.
  const wrapped = JSON.parse(await readFile(target, 'utf8'));
  for (const entry of Object.values(wrapped.mcpServers)) {
    delete entry._mcpTape;
  }
  await writeFile(target, JSON.stringify(wrapped, null, 2));
  // .bak still exists from install. Uninstall should restore from it.
  const result = await uninstallFromConfig(target);
  assert.equal(result.unwrapped, 0);
  assert.equal(result.restoredFromBak, true);
  const restored = await readFile(target, 'utf8');
  assert.equal(restored, original);
  // .bak should be cleaned up after the fallback restore.
  await assert.rejects(access(target + '.mcp-tape.bak'));
  await rm(dir, { recursive: true });
});

test('uninstall via marker preserves manually-added entries (acceptance #4)', async () => {
  const { dir, target } = await tempConfig();
  await installToConfig(target, { mcpTapeBin: 'mcp-tape' });
  // After install, manually add a new unwrapped server (simulating user editing config).
  const cfg = JSON.parse(await readFile(target, 'utf8'));
  cfg.mcpServers.manual = { command: 'python', args: ['custom.py'] };
  await writeFile(target, JSON.stringify(cfg, null, 2));
  // Uninstall should unwrap the two markered entries but leave 'manual' untouched.
  const result = await uninstallFromConfig(target);
  assert.equal(result.unwrapped, 2);
  assert.equal(result.restoredFromBak, false);
  const after = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(after.mcpServers.filesystem.command, 'npx');
  assert.equal(after.mcpServers.github.command, 'node');
  // 'manual' must be preserved exactly as added.
  assert.deepEqual(after.mcpServers.manual, { command: 'python', args: ['custom.py'] });
  await rm(dir, { recursive: true });
});

test('--force overwrites existing .bak with current state', async () => {
  const { dir, target } = await tempConfig();
  await installToConfig(target, { mcpTapeBin: 'mcp-tape' });
  const bak1 = await readFile(target + '.mcp-tape.bak', 'utf8');
  // Mutate the live target so it differs from bak1.
  const cfg = JSON.parse(await readFile(target, 'utf8'));
  cfg.mcpServers.added = { command: 'sh', args: ['-c', 'echo hi'] };
  await writeFile(target, JSON.stringify(cfg, null, 2));
  // Force-install: backup should be refreshed to the post-mutation state.
  await installToConfig(target, { mcpTapeBin: 'mcp-tape', force: true });
  const bak2 = await readFile(target + '.mcp-tape.bak', 'utf8');
  assert.notEqual(bak1, bak2);
  assert.ok(bak2.includes('"added"'));
  await rm(dir, { recursive: true });
});

test('discoverTargets identifies claude-desktop config path (linux legacy lowercase)', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'mcp-tape-disc-desk-'));
  // Pre-1.0 mcp-tape installs and some distro packages wrote to the lowercase
  // ~/.config/claude/ directory. Make sure we still pick it up on linux when
  // the canonical capital-C path is missing.
  const desktopRel = '.config/claude/claude_desktop_config.json';
  const desktopFull = join(homeDir, desktopRel);
  const { mkdir: mkdirP } = await import('node:fs/promises');
  await mkdirP(dirname(desktopFull), { recursive: true });
  await writeFile(desktopFull, '{"mcpServers":{}}');
  const targets = await discoverTargets({ home: homeDir, platform: 'linux', env: {} });
  const names = targets.map((t) => t.name);
  assert.ok(names.includes('claude-desktop'));
  await rm(homeDir, { recursive: true });
});

test('discoverTargets resolves claude-desktop canonical path on linux', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'mcp-tape-disc-desk-canon-'));
  const desktopFull = join(homeDir, '.config', 'Claude', 'claude_desktop_config.json');
  const { mkdir: mkdirP } = await import('node:fs/promises');
  await mkdirP(dirname(desktopFull), { recursive: true });
  await writeFile(desktopFull, '{"mcpServers":{}}');
  const targets = await discoverTargets({ home: homeDir, platform: 'linux', env: {} });
  const desktop = targets.find((t) => t.name === 'claude-desktop');
  assert.ok(desktop, 'claude-desktop not discovered');
  assert.equal(desktop.path, desktopFull);
  await rm(homeDir, { recursive: true });
});

test('discoverTargets resolves claude-desktop on macOS to ~/Library/Application Support', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'mcp-tape-disc-desk-mac-'));
  const desktopFull = join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  const { mkdir: mkdirP } = await import('node:fs/promises');
  await mkdirP(dirname(desktopFull), { recursive: true });
  await writeFile(desktopFull, '{"mcpServers":{}}');
  const targets = await discoverTargets({ home: homeDir, platform: 'darwin', env: {} });
  const desktop = targets.find((t) => t.name === 'claude-desktop');
  assert.ok(desktop, 'claude-desktop not discovered on darwin');
  assert.equal(desktop.path, desktopFull);
  await rm(homeDir, { recursive: true });
});

test('discoverTargets resolves claude-desktop on win32 via %APPDATA%', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'mcp-tape-disc-desk-win-'));
  const appData = join(homeDir, 'AppData', 'Roaming');
  const desktopFull = join(appData, 'Claude', 'claude_desktop_config.json');
  const { mkdir: mkdirP } = await import('node:fs/promises');
  await mkdirP(dirname(desktopFull), { recursive: true });
  await writeFile(desktopFull, '{"mcpServers":{}}');
  const targets = await discoverTargets({ home: homeDir, platform: 'win32', env: { APPDATA: appData } });
  const desktop = targets.find((t) => t.name === 'claude-desktop');
  assert.ok(desktop, 'claude-desktop not discovered on win32');
  assert.equal(desktop.path, desktopFull);
  await rm(homeDir, { recursive: true });
});

test('discoverTargets prefers canonical claude-desktop over legacy when both exist (linux)', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'mcp-tape-disc-desk-both-'));
  const canonical = join(homeDir, '.config', 'Claude', 'claude_desktop_config.json');
  const legacy = join(homeDir, '.config', 'claude', 'claude_desktop_config.json');
  const { mkdir: mkdirP } = await import('node:fs/promises');
  await mkdirP(dirname(canonical), { recursive: true });
  await mkdirP(dirname(legacy), { recursive: true });
  await writeFile(canonical, '{"mcpServers":{}}');
  await writeFile(legacy, '{"mcpServers":{}}');
  const targets = await discoverTargets({ home: homeDir, platform: 'linux', env: {} });
  const desktop = targets.find((t) => t.name === 'claude-desktop');
  assert.equal(desktop.path, canonical);
  await rm(homeDir, { recursive: true });
});

test('install refreshes wrapped entries when bin path changes', async () => {
  const { dir, target } = await tempConfig();
  await installToConfig(target, { mcpTapeBin: '/old/path/mcp-tape' });
  // Now invoke with a different bin — should refresh, not no-op.
  const result = await installToConfig(target, { mcpTapeBin: '/new/path/mcp-tape' });
  assert.equal(result.wrapped, 0);
  assert.equal(result.refreshed, 2);
  assert.equal(result.alreadyWrapped, 0);
  const after = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(after.mcpServers.filesystem.command, '/new/path/mcp-tape');
  // Marker stays pointing at the original command, not the previous bin.
  assert.equal(after.mcpServers.filesystem._mcpTape.originalCommand, 'npx');
  await rm(dir, { recursive: true });
});

test('install second-run with same bin is a true no-op', async () => {
  const { dir, target } = await tempConfig();
  await installToConfig(target, { mcpTapeBin: 'mcp-tape' });
  const result = await installToConfig(target, { mcpTapeBin: 'mcp-tape' });
  assert.equal(result.wrapped, 0);
  assert.equal(result.refreshed, 0);
  assert.equal(result.alreadyWrapped, 2);
  await rm(dir, { recursive: true });
});

test('discoverTargets identifies antigravity at ~/.gemini/antigravity/mcp_config.json', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcp-tape-antigravity-'));
  const { mkdir: mkdirP } = await import('node:fs/promises');
  const rel = '.gemini/antigravity/mcp_config.json';
  const full = join(home, rel);
  await mkdirP(dirname(full), { recursive: true });
  await writeFile(full, '{"mcpServers":{}}');
  const targets = await discoverTargets({ home });
  assert.ok(targets.some((t) => t.name === 'antigravity'));
  assert.ok(targets.find((t) => t.name === 'antigravity').path.endsWith(join(...rel.split('/'))));
  await rm(home, { recursive: true });
});

test('discoverTargets identifies gemini-cli at ~/.gemini/settings.json', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcp-tape-gemini-'));
  const { mkdir: mkdirP } = await import('node:fs/promises');
  await mkdirP(join(home, '.gemini'), { recursive: true });
  await writeFile(join(home, '.gemini/settings.json'), '{"mcpServers":{}}');
  const targets = await discoverTargets({ home });
  assert.ok(targets.some((t) => t.name === 'gemini-cli'));
  await rm(home, { recursive: true });
});

test('install wraps gemini-cli settings while preserving non-MCP keys', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcp-tape-gemini-preserve-'));
  const { mkdir: mkdirP } = await import('node:fs/promises');
  const path = join(home, '.gemini/settings.json');
  await mkdirP(dirname(path), { recursive: true });
  const original = {
    theme: 'dark',
    autoApprove: ['some-tool'],
    mcpServers: {
      sqlite: { command: 'uvx', args: ['mcp-server-sqlite'] },
    },
  };
  await writeFile(path, JSON.stringify(original));
  await installToConfig(path, { mcpTapeBin: 'mcp-tape' });
  const after = JSON.parse(await readFile(path, 'utf8'));
  // Non-MCP keys preserved
  assert.equal(after.theme, 'dark');
  assert.deepEqual(after.autoApprove, ['some-tool']);
  // MCP server wrapped
  assert.equal(after.mcpServers.sqlite.command, 'mcp-tape');
  assert.equal(after.mcpServers.sqlite._mcpTape.originalCommand, 'uvx');
  await rm(home, { recursive: true });
});

// ---------------------------------------------------------------------------
// Issue #2 fixes: skip remote entries, resolve absolute paths on Windows,
// dedicated `unwrap` API (doesn't touch .bak).
// ---------------------------------------------------------------------------

import { installToConfig as installToConfigForBug, unwrapFromConfig, resolveCommandPath, isRemoteEntry } from '../dist/install.js';

async function tempConfigFrom(servers) {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-tape-inst2-'));
  const target = join(dir, 'cfg.json');
  await writeFile(target, JSON.stringify({ mcpServers: servers }, null, 2));
  return { dir, target };
}

test('install skips serverUrl-only (remote/HTTP) entries — no null args, no dual transport', async () => {
  const { dir, target } = await tempConfigFrom({
    supabase: { serverUrl: 'https://mcp.supabase.com/mcp' },
    local: { command: 'node', args: ['x.js'] },
  });
  const r = await installToConfigForBug(target, { mcpTapeBin: 'mcp-tape' });
  const after = JSON.parse(await readFile(target, 'utf8'));
  // supabase preserved as-is, no command/args injected, no _mcpTape marker.
  assert.equal(after.mcpServers.supabase.serverUrl, 'https://mcp.supabase.com/mcp');
  assert.equal(after.mcpServers.supabase.command, undefined);
  assert.equal(after.mcpServers.supabase.args, undefined);
  assert.equal(after.mcpServers.supabase._mcpTape, undefined);
  // local entry still gets wrapped normally.
  assert.equal(after.mcpServers.local.command, 'mcp-tape');
  assert.ok(isWrapped(after.mcpServers.local));
  assert.equal(r.skippedRemote, 1);
  assert.equal(r.wrapped, 1);
  await rm(dir, { recursive: true });
});

test('install skips entries with no command (defensive)', async () => {
  const { dir, target } = await tempConfigFrom({
    broken: { args: ['just-args-no-command'] },
    valid: { command: 'node', args: ['s.js'] },
  });
  const r = await installToConfigForBug(target, { mcpTapeBin: 'mcp-tape' });
  const after = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(after.mcpServers.broken.command, undefined);
  assert.equal(after.mcpServers.broken._mcpTape, undefined);
  assert.equal(r.skippedRemote, 1);
  assert.equal(r.wrapped, 1);
  await rm(dir, { recursive: true });
});

test('isRemoteEntry returns true only when serverUrl is a non-empty string', () => {
  assert.equal(isRemoteEntry({ serverUrl: 'https://x' }), true);
  assert.equal(isRemoteEntry({ serverUrl: '' }), false);
  assert.equal(isRemoteEntry({ command: 'node' }), false);
  assert.equal(isRemoteEntry({}), false);
});

test('resolveCommandPath finds binary via PATH + PATHEXT on simulated Windows', async () => {
  // Simulate a Windows env where dart resolves to dart.bat under flutter/bin.
  const fakeFiles = new Set(['C:\\fake\\flutter\\bin\\dart.BAT']);
  const exists = async (p) => fakeFiles.has(p);
  const resolved = await resolveCommandPath('dart', {
    platform: 'win32',
    env: { PATH: 'C:\\fake\\flutter\\bin', PATHEXT: '.EXE;.BAT;.CMD' },
    exists,
  });
  assert.equal(resolved, 'C:\\fake\\flutter\\bin\\dart.BAT');
});

test('resolveCommandPath returns null when not found', async () => {
  const resolved = await resolveCommandPath('does-not-exist-xyz', {
    platform: 'win32',
    env: { PATH: 'C:\\empty', PATHEXT: '.EXE' },
    exists: async () => false,
  });
  assert.equal(resolved, null);
});

test('resolveCommandPath accepts existing absolute paths unchanged', async () => {
  const resolved = await resolveCommandPath('C:\\already\\absolute\\bin.exe', {
    platform: 'win32',
    env: {},
    exists: async () => true,
  });
  assert.equal(resolved, 'C:\\already\\absolute\\bin.exe');
});

test('install bakes resolved absolute path into wrapped args on Windows', async () => {
  const { dir, target } = await tempConfigFrom({
    dart: { command: 'dart', args: ['mcp-server'] },
  });
  // Pretend dart resolves to dart.exe under flutter/bin.
  const fakePath = 'C:\\fake\\flutter\\bin\\dart.EXE';
  const exists = async (p) => p === fakePath;
  await installToConfigForBug(target, {
    mcpTapeBin: 'mcp-tape',
    platform: 'win32',
    env: { PATH: 'C:\\fake\\flutter\\bin', PATHEXT: '.EXE;.BAT' },
    exists,
  });
  const after = JSON.parse(await readFile(target, 'utf8'));
  // Wrapped args contain the resolved absolute path, not the bare "dart".
  assert.equal(after.mcpServers.dart.command, 'mcp-tape');
  assert.deepEqual(after.mcpServers.dart.args, ['--', fakePath, 'mcp-server']);
  // Marker preserves the unresolved original for unwrap.
  assert.equal(after.mcpServers.dart._mcpTape.originalCommand, 'dart');
  await rm(dir, { recursive: true });
});

test('install falls back to unresolved command when resolution fails', async () => {
  const { dir, target } = await tempConfigFrom({
    mystery: { command: 'mystery-bin' },
  });
  await installToConfigForBug(target, {
    mcpTapeBin: 'mcp-tape',
    platform: 'win32',
    env: { PATH: 'C:\\empty', PATHEXT: '.EXE' },
    exists: async () => false,
  });
  const after = JSON.parse(await readFile(target, 'utf8'));
  assert.deepEqual(after.mcpServers.mystery.args, ['--', 'mystery-bin']);
  assert.equal(after.mcpServers.mystery._mcpTape.originalCommand, 'mystery-bin');
  await rm(dir, { recursive: true });
});

test('unwrapFromConfig restores entries and leaves .bak intact', async () => {
  const { dir, target } = await tempConfig();
  await installToConfig(target, { mcpTapeBin: 'mcp-tape' });
  // .bak should have been created by install.
  await access(target + '.mcp-tape.bak');
  const r = await unwrapFromConfig(target);
  assert.equal(r.unwrapped, 2);
  // .bak still exists after unwrap (unlike uninstall which deletes it).
  await access(target + '.mcp-tape.bak');
  const after = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(after.mcpServers.filesystem.command, 'npx');
  assert.equal(after.mcpServers.github.command, 'node');
  assert.equal(after.mcpServers.filesystem._mcpTape, undefined);
  await rm(dir, { recursive: true });
});

test('unwrapFromConfig of a serverUrl-only entry that was wrapped (legacy bug state) cleans it up', async () => {
  // Simulate the malformed state produced by older mcp-tape versions: a
  // serverUrl entry that was wrapped, leaving a null in args and both
  // transports set. unwrap should restore to serverUrl-only.
  const { dir, target } = await tempConfigFrom({
    supabase: {
      serverUrl: 'https://mcp.supabase.com/mcp',
      command: 'mcp-tape',
      args: ['--', null],
      _mcpTape: { wrapped: true, originalArgs: [] },
    },
  });
  await unwrapFromConfig(target);
  const after = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(after.mcpServers.supabase.serverUrl, 'https://mcp.supabase.com/mcp');
  assert.equal(after.mcpServers.supabase.command, undefined);
  assert.equal(after.mcpServers.supabase.args, undefined);
  assert.equal(after.mcpServers.supabase._mcpTape, undefined);
  await rm(dir, { recursive: true });
});
