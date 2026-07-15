import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type InstallTargetName = 'claude-code' | 'claude-desktop' | 'antigravity' | 'gemini-cli';

export interface InstallTarget {
  name: InstallTargetName;
  path: string;
}

interface DiscoverOpts {
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

// Claude Desktop stores its config under an OS-specific directory; the other
// three targets (claude-code, antigravity, gemini-cli) all live under $HOME
// regardless of platform, so they share a single resolver. `platform` and
// `env` are injectable so tests can simulate Windows/macOS layouts without
// having to actually run on those OSes.
function claudeDesktopPath(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === 'win32') {
    // %APPDATA% is typically C:\Users\<you>\AppData\Roaming; fall back to a
    // constructed path if it's unset (unusual but possible in stripped envs).
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return join(appData, 'Claude', 'claude_desktop_config.json');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  // Linux + everything else. The directory is `Claude` (capital C) on the
  // upstream installer; we also accept the lowercase variant for back-compat
  // with installs created by earlier mcp-tape versions and by some distro
  // repackagings (see resolveOrExists below).
  return join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

// Resolve a target's path, preferring the canonical location but falling back
// to a legacy one if it exists on disk and the canonical one doesn't.
async function resolveOrExists(canonical: string, legacy: string | null): Promise<string> {
  if (legacy && !(await exists(canonical)) && (await exists(legacy))) return legacy;
  return canonical;
}

export async function discoverTargets(opts: DiscoverOpts = {}): Promise<InstallTarget[]> {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;

  const candidates: Array<{ name: InstallTargetName; path: string; legacy?: string }> = [
    { name: 'claude-code', path: join(home, '.claude.json') },
    {
      name: 'claude-desktop',
      path: claudeDesktopPath(home, platform, env),
      // Earlier mcp-tape releases (and some Linux installs) wrote to the
      // lowercase ~/.config/claude/ directory; surface it if the new path
      // doesn't exist but the old one does.
      legacy: platform === 'linux'
        ? join(home, '.config', 'claude', 'claude_desktop_config.json')
        : undefined,
    },
    { name: 'antigravity', path: join(home, '.gemini', 'antigravity', 'mcp_config.json') },
    { name: 'gemini-cli', path: join(home, '.gemini', 'settings.json') },
  ];

  const out: InstallTarget[] = [];
  for (const c of candidates) {
    const resolved = await resolveOrExists(c.path, c.legacy ?? null);
    if (await exists(resolved)) out.push({ name: c.name, path: resolved });
  }
  return out;
}

// Exported so `--help` text and the README generator can describe the four
// canonical config locations without duplicating the per-OS logic above.
export function describeTargetPaths(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv): Record<InstallTargetName, string> {
  const p = platform ?? process.platform;
  const e = env ?? process.env;
  const home = p === 'win32' ? '%USERPROFILE%' : '~';
  const desktop = p === 'win32'
    ? `${e.APPDATA ? '%APPDATA%' : `${home}\\AppData\\Roaming`}\\Claude\\claude_desktop_config.json`
    : p === 'darwin'
      ? `${home}/Library/Application Support/Claude/claude_desktop_config.json`
      : `${home}/.config/Claude/claude_desktop_config.json`;
  return {
    'claude-code': `${home}/.claude.json`,
    'claude-desktop': desktop,
    'antigravity': `${home}/.gemini/antigravity/mcp_config.json`,
    'gemini-cli': `${home}/.gemini/settings.json`,
  };
}
