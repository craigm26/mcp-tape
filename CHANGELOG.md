# Changelog

## Unreleased

Fixes found by rebuilding mcp-tape from a written specification
([regen-mcp-tape](https://github.com/craigm26/regen-mcp-tape); the D-numbers
are its decision records).

- **Shutdown no longer hangs.** When the client closes mcp-tape's stdin, the
  server's stdin is now closed too, so a server that waits for end of input
  (the first step of MCP's stdio shutdown) exits instead of waiting forever
  (D-002). When the server exits, mcp-tape finishes the trace and exits with
  its status even if the client keeps its end open (D-003). Messages the
  client sends after that are no longer appended after the trace's `end` line.
- **Large messages no longer stall the proxy.** Two default redaction rules
  (`.env` paths and SSH key paths) took time proportional to the square of a
  word's length (measured on one machine: 1 s for a 20,000-character base64
  word, 4 s for 40,000, 16 s for 80,000; a 2 MB base64 image would take
  hours), on the same thread that forwards bytes. They now start only where a
  word starts, which runs in linear time (about 30 ms for 2 MB) and redacts
  exactly the same text (D-010).
- A last line without a trailing newline is now logged (D-004), and a
  multi-byte character split across two reads is no longer logged as two
  replacement characters (D-005).
- The server command line is redacted before it is written to `meta.command`,
  and the default label (and so the trace file name) is derived from the
  redacted command (D-011). Windows paths label like POSIX ones:
  `C:\srv\files.mjs` gives `files-mjs` (D-012).
- A command that cannot be started now exits 127 with a complete trace instead
  of crashing (D-014). A server ended by a signal gives 128 + the platform's
  signal number (SIGUSR1 used to give 128) (D-013).
- An invalid `--redact` pattern is a usage error (status 2) and creates nothing
  (D-015).
- Windows: commands are no longer started through `cmd.exe`, which re-split
  arguments containing spaces and dropped empty ones. Programs are started
  directly; `.cmd`/`.bat` shims such as `npx` are found on `PATH` (with
  `PATHEXT`) and run with their arguments quoted (D-017).
- A message member named `__proto__` is kept in the trace instead of being
  dropped by redaction (D-025).
- `--version` and the trace's `mcpTapVersion` now come from `package.json`
  (they said 0.3.0 in the 0.4.0 release).
- The build no longer needs `chmod`, so `npm test` runs on Windows; CI runs
  the tests on Linux, Windows and macOS.

## 0.4.0 — 2026-07-15

- New `mcp-tape share <trace>` command: anonymous, redaction-forced upload
  that returns a shareable replay link at mcpreplay.dev (30-day expiry,
  delete token, no account). `share --delete <id> --token <t>` removes a
  share early.
- Redaction ruleset extended: Slack tokens (`xox[baprs]-`), Stripe live keys
  (`rk_live_`/`sk_live_`), connection-string passwords (`://user:pass@`),
  and `Authorization: Bearer` values.
- Repository is now public: https://github.com/craigm26/mcp-tape

## 0.3.0 and earlier

Private development history (stdio proxy, trace recording, redaction,
install/uninstall wrapping, live mode, hosted uploads).
