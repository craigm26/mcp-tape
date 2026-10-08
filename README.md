# mcp-tape

Stdio proxy for [Model Context Protocol](https://modelcontextprotocol.io) servers. Sits between any MCP client (Claude Code, Cursor, any future host) and any MCP server, forwards JSON-RPC byte-for-byte in both directions, and writes every message to a replayable `.jsonl` trace file.

Pairs with the [mcpreplay.dev](https://mcpreplay.dev) renderer to give you time-travel debugging for agent tool calls. The trace format is open — anything can produce or consume it.

`mcp-tape` (this) and [`mcp-replay`](https://github.com/craigm26/mcp-replay) are free and open source. The JSONL trace format is deliberately [open and stable](https://mcpreplay.dev/docs/format) — anyone can write a producer or consumer; we don't have to be the only ones. The [Roadmap](#roadmap) section below tracks what's shipped and what's planned.

## Install

```bash
npm i -g mcp-tape
mcp-tape install
```

Or try it without installing globally:

```bash
npx mcp-tape install --target=claude-code
```

> Prefer `-g` for daily use — it puts a stable `mcp-tape` on your PATH, so the wrapped path in your config survives upgrades. If you install via `npx`, re-run `install` after upgrading.

Requires Node.js 20 or newer.

## Try it end-to-end

The fastest path to "is this useful to me?" is recording and replaying a real Claude Code session in five steps.

**1. Install everywhere (one command):**

```bash
mcp-tape install
```

This walks every detected MCP client config and wraps every entry in `mcpServers`. Supported targets, with the file each one lives in:

| Target | Config file |
|---|---|
| `claude-code` | `~/.claude.json` |
| `claude-desktop` (per-OS — see below) | Windows: `%APPDATA%\Claude\claude_desktop_config.json` · macOS: `~/Library/Application Support/Claude/claude_desktop_config.json` · Linux: `~/.config/Claude/claude_desktop_config.json` |
| `antigravity` (Google Antigravity IDE) | `~/.gemini/antigravity/mcp_config.json` |
| `gemini-cli` (Google Gemini CLI) | `~/.gemini/settings.json` |

> Pre-1.0 mcp-tape installs on Linux wrote to `~/.config/claude/` (lowercase). `install` and `uninstall` still detect that path if it exists, so older configs aren't orphaned by the upgrade.

`install` auto-discovers whichever of these files already exist on disk. Your config is backed up to `<file>.mcp-tape.bak` before any change. The command is idempotent — running it again is a no-op unless the binary path changes (after an upgrade). Add `--dry-run` to preview, `--target=antigravity,gemini-cli` to scope to specific clients, `--force` to refresh the backup with the current state.

> On Windows, `~` is `C:\Users\<you>` — `mcp-tape install` resolves it natively, no path adjustment needed. Antigravity / Gemini CLI write their MCP config lazily, so if you haven't added a server through their UI yet, the file may not exist and that target will simply be skipped.

**2. Restart your MCP client** (Claude Code / Claude Desktop). The wrapped servers will be invoked through `mcp-tape` instead of directly.

**3. Use the client normally.** Every MCP server you talk to writes a JSONL trace to `./mcp-traces/` (relative to wherever the server's working dir is). One file per session per server, named like `2026-05-13T15-30-00-000Z-<label>.jsonl`.

**4. Open a trace:** go to [mcpreplay.dev](https://mcpreplay.dev), click **Open local trace…** and pick the `.jsonl` file. (Or drag-and-drop it onto the page.) The trace never leaves your browser. Drag **multiple** `.jsonl` files at once to merge sessions across servers (e.g. a filesystem server + a GitHub server interleaved by timestamp).

**5. Share a trace:** send the `.jsonl` file to a collaborator. They drag it into mcpreplay.dev. Done — no public URL, no server staging. Or run `mcp-tape share <file>` to get a redacted public link — see [Share](#share).

**Roll back when done:**

```bash
mcp-tape uninstall
```

Per-entry, in place. Any unwrapped entries you added manually after `install` are preserved. The `.mcp-tape.bak` is removed after a successful restore.

## Usage (single server, no auto-install)

If you don't want to wrap your whole config — for one-off experiments or non-Claude clients — call `mcp-tape` directly with `--` separating its flags from the server command:

```bash
mcp-tape -- npx -y @modelcontextprotocol/server-filesystem /home/me
mcp-tape --out ~/.mcp-traces --label fs -- node my-server.js
```

The proxy is transparent — JSON-RPC traffic is forwarded byte-for-byte. The trace file is the only side-effect.

## Long sessions: rotation + size caps

Trace files rotate when they exceed `--max-bytes` (default 50 MB). The newest is `<name>.jsonl`, then `.1`, `.2`, … up to `--max-files` (default 4). Oldest is evicted. A multi-hour session caps at roughly 200 MB total.

```bash
mcp-tape --max-bytes 104857600 --max-files 8 -- node my-server.js   # 100 MB × 8
```

Env vars `MCP_TAPE_MAX_BYTES` and `MCP_TAPE_MAX_FILES` work the same way; the CLI flag overrides the env var. To merge rotated files in the viewer, drag the active file plus its `.1`/`.2`/… companions onto mcpreplay.dev together.

## Live mode

Stream a session to mcpreplay.dev while it's still running:

```bash
mcp-tape --serve -- npx -y @modelcontextprotocol/server-filesystem /home/me
```

This starts a localhost websocket on port 7777 (override with `--serve 9001` or
`MCP_TAPE_SERVE=9001`). In POSIX shells the `--` separates mcp-tape's flags
from the server command; PowerShell's native-command shim strips `--` from
argv, so on Windows you can drop it (`mcp-tape --serve npx -y …`) — mcp-tape
will see the bare `npx` and start the wrapped command from there.

Open the URL printed on stderr:

```
mcp-tape: live mode on ws://127.0.0.1:7777/  (open https://mcpreplay.dev/?live=ws://127.0.0.1:7777)
```

If the requested port is already in use — a previous Claude session that
didn't shut down cleanly, another wrapped server holding it — mcp-tape scans
a small range above the requested port and then asks the OS for any free
port. The stderr line tells you which port it actually bound:

```
mcp-tape: port 7777 was unavailable — bound 7778 instead
mcp-tape: live mode on ws://127.0.0.1:7778/  (open https://mcpreplay.dev/?live=ws://127.0.0.1:7778)
```

New subscribers get a snapshot of everything-so-far on connect, then live
appends as each frame is written. Reconnect-resume is automatic via
`?since=<lastSeq>` so a flaky network or refreshed browser tab doesn't lose
frames.

The websocket is bound to `127.0.0.1` only — there is no auth, no TLS, and no
remote-access path. mcp-replay refuses to connect to any host other than
`localhost` / `127.0.0.1`.

### `--no-file`: serve-only mode

For short debug sessions where you don't want a `.jsonl` file to clean up
afterwards, add `--no-file`:

```bash
mcp-tape --serve --no-file -- node my-server.js
```

This streams every frame to the websocket but writes nothing to disk.
`--no-file` requires `--serve`. If the websocket fails to bind entirely
(extremely rare), mcp-tape automatically reverts to writing a `.jsonl` so the
session isn't silently lost.

Full live-mode walkthrough lives in the renderer repo at
[mcp-replay/docs/live-mode.md](https://github.com/craigm26/mcp-replay/blob/main/docs/live-mode.md).

## Secret redaction

`mcp-tape` redacts common secret shapes from the **logged trace** by default. It does not alter messages forwarded between client and server. Even with redaction on, treat traces as sensitive — no regex is exhaustive.

**Default field-name redaction** (case-insensitive substring match on the JSON key):
`password`, `secret`, `token`, `apiKey` / `api_key`, `authorization`, `bearer`, `privateKey` / `private_key`, `accessKey` / `access_key`.

**Default value patterns:**
- AWS access key id (`AKIA…`)
- `sk-*` API keys (OpenAI/Anthropic shape)
- GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`)
- JWTs (three base64url segments separated by `.`)
- `Authorization:` / `Bearer …` header values appearing in any string
- File paths matching `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`, or `.env*`

The server command line gets the same value patterns before it is written to the trace, and the
default label (which becomes part of the trace file name) is taken from the redacted command, so a
token passed as an argument doesn't end up in a file name.

Inspect or add to these:

```bash
mcp-tape --redact-defaults                                # print the built-in list
mcp-tape --redact 'MYCO_[A-Z0-9]{20}' -- node my-server.js
mcp-tape --no-redact-defaults --redact '...' -- node my-server.js
```

### Custom redaction config

For project-specific rules — especially nested fields — create `~/.config/mcp-tape/redact.json`:

```json
{
  "extends": "default",
  "rules": [
    { "type": "path", "path": "$.params.arguments.api_key" },
    { "type": "path", "path": "$..customer_id" },
    { "type": "regex", "pattern": "MYCO-[A-Z0-9]{20}" }
  ]
}
```

The file is auto-loaded at startup. `extends: "default"` merges with built-in rules; set it to `null` to replace them entirely. Path rules use a JSONPath subset (`$`, `.field`, `[i]`, `[*]`, `..field`). Override the path with `--redact-file PATH` or env `MCP_TAPE_REDACT`.

## Trace format

One JSON object per line. First line is a `meta` header, last line is an `end` marker, everything in between is one protocol message per line.

```jsonl
{"v":1,"type":"meta","startedAt":"2026-05-12T23:00:00.000Z","label":"fs","command":["npx","-y","@modelcontextprotocol/server-filesystem","/home/me"],"mcpTapVersion":"0.1.0"}
{"t":"2026-05-12T23:00:00.123Z","dir":"in","raw":{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}}
{"t":"2026-05-12T23:00:00.245Z","dir":"out","raw":{"jsonrpc":"2.0","id":1,"result":{}}}
{"t":"2026-05-12T23:00:30.000Z","type":"end","exitCode":0,"durationMs":30000}
```

- `dir: "in"` — client → server (data the proxy received on stdin)
- `dir: "out"` — server → client (data the proxy received from the server's stdout)
- `raw` — verbatim JSON-RPC message, post-redaction
- `t` — ISO-8601 with millisecond precision
- `command` — the server command line, redacted with the same string rules as messages

### Shutdown and exit status

When the client closes mcp-tape's stdin, mcp-tape closes the server's stdin, which is how an MCP
client asks a stdio server to shut down. When the server exits, mcp-tape writes the `end` line
and exits with the server's status, even if the client still has its end open: 128 + the signal
number if the server was killed by a signal, and 127 if the command could not be started.

The full spec lives at [mcpreplay.dev/docs/format](https://mcpreplay.dev/docs/format).

## Share

Upload a **redacted** copy of a trace and get an unlisted public link anyone
can open — no account needed:

```bash
mcp-tape share ./mcp-traces/fs.jsonl
```

```
Shared (redacted): https://mcpreplay.dev/?trace=1f0e2d3c-...

  Anyone with this link can view the trace. It was redacted
  client-side before upload and re-redacted by the server.

  Expires: 2026-08-14T00:12:34.000Z (30 day auto-expiry)
  Delete:  mcp-tape share --delete 1f0e2d3c-... --token 4a5b6c...
```

Files must be JSONL and at most 10MB. The service accepts 5 shares/hour
(20/day) per IP.

**Security notes:**

- **The link is public.** Anyone who has the URL can view the trace. Links
  are unlisted (random UUID, not indexed, `X-Robots-Tag: noindex`) but not
  access-controlled — treat the URL itself as the secret.
- **Redaction is applied twice and cannot be turned off for `share`** —
  once client-side by the CLI before anything leaves your machine, and
  again server-side on ingest (defense in depth). Your custom redact config
  (`~/.config/mcp-tape/redact.json`, `--redact`, `--redact-file`) adds
  rules *on top of* the built-in defaults; it can never replace them here,
  and `--no-redact-defaults` is rejected for this subcommand. Redaction is
  pattern-based: skim the trace before sharing if it may contain secrets
  the [default rules](#redaction) don't know about.
- **Shares auto-expire after 30 days.** To remove one sooner, run the
  `mcp-tape share --delete <id> --token <token>` command printed at share
  time (keep the token — it is shown exactly once).
- Found something in a shared trace that shouldn't be public? Use the
  takedown page at [mcpreplay.dev/takedown](https://mcpreplay.dev/takedown).

Maintainer note: setting `MCP_TAPE_SELF=1` in your environment makes the
CLI send an `X-MCP-Tape-Self: 1` header so the project's own test shares
are excluded from adoption metrics.

Prefer not to upload at all? Sharing the `.jsonl` file directly (step 5
above) still works: the recipient drags it into mcpreplay.dev and nothing
leaves their browser.

## Roadmap

**Shipped (0.4.0):**
- Anonymous share links — `mcp-tape share <file>` uploads a redacted copy
  and prints a public `mcpreplay.dev` URL, no account needed. See
  [Share](#share).

**Shipped (v0.2.0 / v0.3.0):**
- Hosted uploads — `mcp-tape login` / `upload` / `--upload-on-exit`, with
  `--public` for a world-readable-by-UUID link. See
  [Optional: hosted uploads](#optional-hosted-uploads-platatlas) below.

**Shipped (v0.1.0 — stable):**
- Stdio proxy + JSONL trace + signal forwarding
- `install` / `uninstall` subcommands for Claude Code, Claude Desktop, Antigravity, and Gemini CLI configs (per-OS path resolution for Claude Desktop)
- Trace rotation with `--max-bytes` / `--max-files` (and `MCP_TAPE_MAX_*` env vars)
- File-based redaction config at `~/.config/mcp-tape/redact.json` with JSONPath + regex rules, layered on the legacy defaults
- Live mode — `mcp-tape --serve <port>` exposes a localhost websocket with snapshot + append + reconnect-resume; renderer connects via `?live=ws://127.0.0.1:7777`. Port-conflict fallback if 7777 is busy. `--no-file` for serve-only sessions.
- In-trace search by tool-call name + argument pattern (in the renderer)
- Trace diff view in the renderer (`mcpreplay.dev/?diff=a.jsonl;b.jsonl`)

**Planned:**
- HTTP / SSE transport (currently stdio-only)
- Frame drop-count surfaced to subscribers when the broadcaster's ring buffer evicts

## Optional: hosted uploads (PlatAtlas)

If your team runs a [PlatAtlas](https://platatlas.com) org, mcp-tape can push
traces to it: `mcp-tape login --subdomain <slug>` (GitHub device-flow auth),
then `mcp-tape upload <file>` or `--upload-on-exit` on the proxy. Add
`--public` to make the uploaded trace world-readable by UUID and get a
ready-to-paste `mcpreplay.dev/?trace=…` URL. Entirely optional — everything
else in this README works with local files only.

## License

MIT
