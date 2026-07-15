import { access, constants } from 'node:fs/promises';
import { delimiter } from 'node:path';

// Pick the most stable name to embed in claude.json's wrapped command entries.
// Preference order:
//   1. 'mcp-tape' if discoverable on PATH — survives upgrades cleanly.
//   2. process.argv[1] if it isn't an npm-cache path (i.e., a stable install).
//   3. process.argv[1] as last resort (the npx case — caller should re-run `install` after upgrade).
export async function resolveMcpTapeBin(): Promise<string> {
  if (await isOnPath('mcp-tape')) return 'mcp-tape';
  const argv1 = process.argv[1] ?? 'mcp-tape';
  return argv1;
}

async function isOnPath(name: string): Promise<boolean> {
  const PATH = process.env.PATH ?? '';
  for (const dir of PATH.split(delimiter)) {
    if (!dir) continue;
    try {
      const candidate = `${dir}/${name}`;
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // not in this dir; try next
    }
  }
  return false;
}
