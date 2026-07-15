# Changelog

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
