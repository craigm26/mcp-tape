// PlatAtlas authentication — session file management + GitHub device flow.
//
// Session is stored at `~/.config/mcp-tape/session.json` (XDG-compliant)
// with mode 0600. The session contains a signed-cookie value minted by
// the PlatAtlas Worker; the Worker is the one place that knows the
// SESSION_KEY needed to verify it. mcp-tape never sees the signing key.
//
// Wire shape of the file (matches Worker's `/auth/github/device-exchange`
// response + the subdomain we minted for, so re-using the session against
// a different subdomain is explicit, not implicit):
//   {
//     "cookie":       "<44-char base64 HMAC><JSON SessionClaims>",
//     "subject":      "github:craigm26",
//     "display_name": "Craig",
//     "expires_at":   1751731200,
//     "subdomain":    "PlatAtlas"
//   }

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Session {
  cookie: string;
  subject: string;
  display_name: string;
  /** Unix seconds. */
  expires_at: number;
  /** The org slug this session was minted for. Defending against
   *  cross-subdomain replay isn't strictly necessary — the Worker
   *  verifies the same cookie on every subdomain — but locking the
   *  session to a slug forces an explicit re-login if the operator
   *  wants to switch orgs. */
  subdomain: string;
}

/** XDG-compliant session file path. Honors `XDG_CONFIG_HOME` if set;
 *  falls back to `~/.config/mcp-tape/session.json`. On Windows the
 *  Node user info conventions (`%USERPROFILE%`) put `~` at the right
 *  place; if we ever ship a Windows installer that prefers
 *  `%APPDATA%`, that's a small follow-up. */
export function sessionFilePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, 'mcp-tape', 'session.json');
}

export async function readSession(): Promise<Session | null> {
  let text: string;
  try {
    text = await readFile(sessionFilePath(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  let session: Session;
  try {
    session = JSON.parse(text) as Session;
  } catch {
    return null;
  }
  // Validate shape — older formats / hand-edits shouldn't crash callers.
  if (
    typeof session.cookie !== 'string' ||
    typeof session.subject !== 'string' ||
    typeof session.expires_at !== 'number' ||
    typeof session.subdomain !== 'string'
  ) {
    return null;
  }
  if (session.expires_at < Math.floor(Date.now() / 1000)) return null;
  return session;
}

export async function writeSession(session: Session): Promise<void> {
  const filePath = sessionFilePath();
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, JSON.stringify(session, null, 2) + '\n', {
    mode: 0o600,
  });
}

export async function deleteSession(): Promise<void> {
  try {
    await unlink(sessionFilePath());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
}

// ---------------------------------------------------- device-flow client

export interface DeviceLoginOpts {
  /** Org subdomain — e.g. `PlatAtlas`. Used to build the Worker URL. */
  subdomain: string;
  /** Worker base URL override. Default:
   *  `https://<subdomain>.platatlas.com`. Tests + dev installs
   *  pass `http://127.0.0.1:8788`. */
  workerBaseUrl?: string;
  /** Status messages — defaults to stderr. Inject a noop for quiet
   *  callers; inject a custom logger for the test harness. */
  log?: (msg: string) => void;
  /** Override the global `fetch` for testing. Production passes
   *  nothing; tests pass a stub that resolves `https://github.com/...`
   *  and the Worker URL deterministically. */
  fetchFn?: typeof fetch;
}

interface DeviceConfigResponse {
  client_id: string;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface PollResponseSuccess {
  access_token: string;
}

interface PollResponseError {
  error: string;
  error_description?: string;
}

interface ExchangeResponse {
  cookie: string;
  subject: string;
  display_name: string;
  expires_at: number;
}

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

export async function runDeviceLogin(opts: DeviceLoginOpts): Promise<Session> {
  const baseUrl =
    opts.workerBaseUrl ?? `https://${opts.subdomain}.platatlas.com`;
  const log = opts.log ?? ((m) => process.stderr.write(m + '\n'));
  const f = opts.fetchFn ?? fetch;

  // (1) Discover the GitHub OAuth client_id from the Worker. This is
  // a public bootstrap — no auth required.
  log(`Fetching OAuth config from ${baseUrl}…`);
  const cfgResp = await f(`${baseUrl}/auth/github/device-config`);
  if (!cfgResp.ok) {
    throw new Error(
      `device-config failed (${cfgResp.status}): ${await cfgResp.text()}`,
    );
  }
  const cfg = (await cfgResp.json()) as DeviceConfigResponse;

  // (2) Ask GitHub for a device + user code.
  log(`Starting GitHub device flow…`);
  const codeResp = await f(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: cfg.client_id,
      scope: 'read:user',
    }).toString(),
  });
  if (!codeResp.ok) {
    throw new Error(
      `device code request failed (${codeResp.status}): ${await codeResp.text()}`,
    );
  }
  const codeData = (await codeResp.json()) as DeviceCodeResponse;

  // (3) Prompt the user.
  log('');
  log(`  Open ${codeData.verification_uri}`);
  log(`  Enter code: ${codeData.user_code}`);
  log('');
  log(
    `Waiting for authorization (expires in ${Math.floor(codeData.expires_in / 60)}m)…`,
  );

  // (4) Poll GitHub at the recommended interval. The spec says we
  // start with `interval` seconds and bump it by 5s every time GitHub
  // says `slow_down`.
  const deadline = Date.now() + codeData.expires_in * 1000;
  // Nullish-coalesce rather than `||` so a test script can pass
  // `interval: 0` to skip the wait between polls. RFC 8628 says
  // servers return a positive interval; this fallback covers a
  // misbehaving server.
  let interval = codeData.interval ?? 5;
  let accessToken: string | null = null;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const pollResp = await f(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: cfg.client_id,
        device_code: codeData.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
    });
    if (!pollResp.ok) {
      throw new Error(
        `device poll http error (${pollResp.status}): ${await pollResp.text()}`,
      );
    }
    const data = (await pollResp.json()) as
      | PollResponseSuccess
      | PollResponseError;
    if ('access_token' in data) {
      accessToken = data.access_token;
      break;
    }
    const err = (data as PollResponseError).error;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') {
      interval += 5;
      continue;
    }
    if (err === 'expired_token') {
      throw new Error('Device code expired before authorization — try again');
    }
    if (err === 'access_denied') {
      throw new Error('Authorization denied');
    }
    throw new Error(
      `device flow error: ${err}${
        (data as PollResponseError).error_description
          ? ' — ' + (data as PollResponseError).error_description
          : ''
      }`,
    );
  }
  if (!accessToken) {
    throw new Error('Device flow timed out without authorization');
  }

  // (5) Trade the GitHub token for a PlatAtlas session cookie.
  log(`Got GitHub token; exchanging for PlatAtlas session…`);
  const exResp = await f(`${baseUrl}/auth/github/device-exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ access_token: accessToken }),
  });
  if (!exResp.ok) {
    throw new Error(
      `device-exchange failed (${exResp.status}): ${await exResp.text()}`,
    );
  }
  const ex = (await exResp.json()) as ExchangeResponse;
  return {
    cookie: ex.cookie,
    subject: ex.subject,
    display_name: ex.display_name,
    expires_at: ex.expires_at,
    subdomain: opts.subdomain,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
