// Anonymous share: upload a REDACTED copy of a trace to the public
// share service at mcpreplay.dev and get back an unlisted URL anyone
// can open — no login, no PlatAtlas coupling.
//
// Redaction on this path is NON-SKIPPABLE by design. The server
// re-redacts on ingest, but the client-side pass here is the one that
// keeps secrets off the wire in the first place (defense in depth):
//   1. built-in rules from default-redact.json — ALWAYS applied;
//   2. the user's redact config (auto-loaded / --redact-file /
//      MCP_TAPE_REDACT) — applied IN ADDITION to the defaults. Even a
//      config with `extends: null` only adds rules here, it never
//      replaces the built-ins;
//   3. the legacy field-name pass (password/token/secret/... keys) —
//      always applied, extra --redact patterns included.
// There is deliberately no --no-redact-defaults equivalent for share.

import { access, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { buildConfig, redact } from './redact.js';
import { loadRedactConfig, redactWithConfig, type CompiledRedact } from './redact-config.js';

export const SHARE_BASE_URL = 'https://mcpreplay.dev';

/** Cap matches the share Worker's server-side limit (10MB).
 *  Checking client-side gives a faster error than waiting for the
 *  413 round-trip; the server-side check stays load-bearing. */
const MAX_BYTES = 10 * 1024 * 1024;

export interface ShareResult {
  url: string;
  id: string;
  deleteToken: string;
  expiresAt: string;
}

export interface ShareOpts {
  /** Path to a JSONL trace file. */
  file: string;
  /** Share service base URL override. Default: https://mcpreplay.dev.
   *  Fallback host if the zone route misbehaves:
   *  https://mcp-share.craigm26.workers.dev (same paths). */
  baseUrl?: string;
  /** Extra regexes redacted IN ADDITION to the defaults. */
  extraPatterns?: readonly string[];
  /** User redact config path — applied IN ADDITION to the defaults.
   *  `undefined` = auto-discover (MCP_TAPE_REDACT env, then
   *  ~/.config/mcp-tape/redact.json); `null` = skip auto-discovery
   *  (defaults still always apply). */
  userRedactPath?: string | null;
  /** Environment (injectable for tests). Default: process.env.
   *  MCP_TAPE_SELF=1 adds the `X-MCP-Tape-Self: 1` header so the
   *  maintainer's own shares are excluded from adoption metrics. */
  env?: NodeJS.ProcessEnv;
  /** Override the global `fetch` for testing. */
  fetchFn?: typeof fetch;
}

export async function shareTrace(opts: ShareOpts): Promise<ShareResult> {
  const env = opts.env ?? process.env;
  const baseUrl = opts.baseUrl ?? SHARE_BASE_URL;

  let fileStat;
  try {
    fileStat = await stat(opts.file);
  } catch {
    throw new Error(`no such file: ${opts.file}`);
  }
  if (!fileStat.isFile()) {
    throw new Error(`not a file: ${opts.file}`);
  }
  if (fileStat.size === 0) {
    throw new Error(`empty file: ${opts.file}`);
  }
  if (fileStat.size > MAX_BYTES) {
    throw new Error(
      `${basename(opts.file)} is ${fileStat.size} bytes; the share service accepts at most ${MAX_BYTES} bytes (10MB)`,
    );
  }

  const text = await readFile(opts.file, 'utf8');
  const body = await redactJsonlForShare(text, opts);

  const headers: Record<string, string> = {
    'content-type': 'application/jsonl',
  };
  if (env.MCP_TAPE_SELF === '1') {
    headers['X-MCP-Tape-Self'] = '1';
  }

  const f = opts.fetchFn ?? fetch;
  const resp = await f(`${baseUrl}/api/share`, {
    method: 'POST',
    headers,
    body,
  });

  if (resp.status === 413) {
    throw new Error('share rejected (413): trace exceeds the 10MB limit');
  }
  if (resp.status === 422) {
    throw new Error(
      `share rejected (422): the server did not accept the file as JSONL — ${await resp.text()}`,
    );
  }
  if (resp.status === 429) {
    const retryAfter = resp.headers?.get?.('Retry-After');
    const wait = retryAfter ? ` — retry in ${formatRetryAfter(retryAfter)}` : '';
    throw new Error(
      `share rejected (429): rate limited (5 accepted shares/hour, 20/day per IP)${wait}`,
    );
  }
  if (!resp.ok) {
    throw new Error(`share failed (${resp.status}): ${await resp.text()}`);
  }
  return (await resp.json()) as ShareResult;
}

export interface DeleteShareOpts {
  /** Share id (the UUID from the share URL). */
  id: string;
  /** Delete token printed when the share was created. */
  token: string;
  /** Share service base URL override. Default: https://mcpreplay.dev. */
  baseUrl?: string;
  /** Override the global `fetch` for testing. */
  fetchFn?: typeof fetch;
}

export async function deleteShare(opts: DeleteShareOpts): Promise<void> {
  const baseUrl = opts.baseUrl ?? SHARE_BASE_URL;
  const f = opts.fetchFn ?? fetch;
  const resp = await f(`${baseUrl}/api/trace/${opts.id}`, {
    method: 'DELETE',
    headers: { 'X-Delete-Token': opts.token },
  });
  if (resp.status === 204) return;
  if (resp.status === 404) {
    throw new Error(`share ${opts.id} not found — already deleted or expired?`);
  }
  if (resp.status === 403 || resp.status === 401) {
    throw new Error('delete token rejected — check the token printed when the share was created');
  }
  throw new Error(`delete failed (${resp.status}): ${await resp.text()}`);
}

/** Parse-validate every non-empty line as JSON, run the full redaction
 *  stack over each parsed value, and re-serialize. Throws on the first
 *  line that does not parse (the file is not JSONL). */
async function redactJsonlForShare(text: string, opts: ShareOpts): Promise<string> {
  const defaults = await loadRedactConfig({ overridePath: null });
  const userPath =
    opts.userRedactPath !== undefined
      ? opts.userRedactPath
      : ((opts.env ?? process.env).MCP_TAPE_REDACT ?? (await pathIfExists(userRedactConfigPath())));
  // If the user config sets `extends: null` this compiles to user rules
  // only — but `defaults` above is applied unconditionally first, so the
  // effective rule set is always defaults ∪ user.
  const userCfg: CompiledRedact | null = userPath
    ? await loadRedactConfig({ overridePath: userPath })
    : null;
  const legacyCfg = buildConfig({
    extraPatterns: opts.extraPatterns ?? [],
    useDefaults: true,
  });

  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(
        `not a JSONL file: line ${i + 1} does not parse as JSON. Traces written by mcp-tape are always JSONL.`,
      );
    }
    const stage1 = redactWithConfig(raw, defaults);
    const stage2 = userCfg ? redactWithConfig(stage1, userCfg) : stage1;
    out.push(JSON.stringify(redact(stage2, legacyCfg)));
  }
  if (out.length === 0) {
    throw new Error('file contains no JSON lines — nothing to share');
  }
  return out.join('\n') + '\n';
}

function userRedactConfigPath(): string {
  const home = process.env.HOME ?? homedir();
  const xdg = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
  return join(xdg, 'mcp-tape', 'redact.json');
}

async function pathIfExists(p: string): Promise<string | null> {
  try {
    await access(p);
    return p;
  } catch {
    return null;
  }
}

function formatRetryAfter(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v; // HTTP-date form — show verbatim
  if (n >= 3600) return `${Math.ceil(n / 3600)}h`;
  if (n >= 60) return `${Math.ceil(n / 60)}m`;
  return `${n}s`;
}
