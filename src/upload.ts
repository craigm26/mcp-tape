// Upload a trace file to PlatAtlas. Thin wrapper around the hosted
// `POST /api/traces` endpoint.
// Reads the session minted by `mcp-tape login`; the cookie travels
// verbatim in the `Cookie` header.

import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { readSession, type Session } from './auth.js';

export type Source = 'mcp-tape' | 'claude-code' | 'other';

export interface UploadResult {
  id: string;
  byte_size: number;
  ingested_at: string;
}

export interface UploadOpts {
  /** Path to a JSONL trace file. */
  file: string;
  /** Source type for the `?source=` query param. Default: `mcp-tape`
   *  (this *is* mcp-tape's upload command after all). */
  source?: Source;
  /** Worker base URL override. Default: derived from
   *  `session.subdomain` (`https://<subdomain>.platatlas.com`). */
  workerBaseUrl?: string;
  /** When true, append `&public=1` to the request URL so the Worker
   *  stores the trace as world-readable. Default false (private). */
  public?: boolean;
  /** Pre-loaded session (skip the file read). Production callers
   *  pass nothing; tests inject a synthetic session. */
  session?: Session;
  /** Override the global `fetch` for testing. */
  fetchFn?: typeof fetch;
}

/** Cap matches the hosted Worker's server-side limit.
 *  Checking client-side gives a faster error than waiting for the
 *  413 round-trip; the server-side check stays load-bearing. */
const MAX_BYTES = 50 * 1024 * 1024;

export async function uploadTrace(opts: UploadOpts): Promise<UploadResult> {
  const session = opts.session ?? (await readSession());
  if (!session) {
    throw new Error(
      'not logged in — run `mcp-tape login --subdomain <slug>` first',
    );
  }
  const baseUrl =
    opts.workerBaseUrl ?? `https://${session.subdomain}.platatlas.com`;
  const source: Source = opts.source ?? 'mcp-tape';

  const fileStat = await stat(opts.file);
  if (!fileStat.isFile()) {
    throw new Error(`not a file: ${opts.file}`);
  }
  if (fileStat.size === 0) {
    throw new Error(`empty file: ${opts.file}`);
  }
  if (fileStat.size > MAX_BYTES) {
    throw new Error(
      `${basename(opts.file)} is ${fileStat.size} bytes; max upload is ${MAX_BYTES} bytes`,
    );
  }

  const body = await readFile(opts.file);
  const f = opts.fetchFn ?? fetch;

  const publicSuffix = opts.public ? '&public=1' : '';
  const resp = await f(
    `${baseUrl}/api/traces?source=${encodeURIComponent(source)}${publicSuffix}`,
    {
      method: 'POST',
      headers: {
        cookie: `platatlas_session=${session.cookie}`,
        'content-type': 'application/jsonl',
      },
      body: new Uint8Array(body),
    },
  );

  if (resp.status === 401) {
    throw new Error(
      'session expired or invalid — run `mcp-tape login` to re-auth',
    );
  }
  if (!resp.ok) {
    throw new Error(`upload failed (${resp.status}): ${await resp.text()}`);
  }
  return (await resp.json()) as UploadResult;
}
