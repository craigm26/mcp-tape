import { readFileSync } from 'node:fs';

// The version comes from package.json (one level above dist/), so the
// `--version` output and the trace's `mcpTapVersion` can't drift from the
// published package again.
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();
