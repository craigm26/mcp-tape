# VERDICT — pre-registered 30-day verdict protocol

This file is written and committed **before launch**, alongside
[GATES.md](./GATES.md). The thresholds live in GATES.md and are fixed as of
the commit that introduced them. **No goalpost-moving:** no "one more month",
no swapping in a friendlier metric, no re-interpreting a counter after the
fact. If the numbers are below gate on gate day, the verdict is KILL and the
pre-written KILL section below executes as written.

## Gate day

Gate day = **GATES.md launch day + 30 calendar days**, evaluated once.

**Gate day: `____-__-__`** — stamp this the same moment the launch day is
stamped in GATES.md (launch day + 30).

Operator reminder for gate day lives outside this repo at
`~/tasks/gate-day-mcpreplay.md` (its date is re-stamped at launch, since the
launch date isn't known when this protocol is written).

## How to evaluate

1. Confirm the thresholds by reading [GATES.md](./GATES.md) — **>= 10
   non-self shares** and **>= 25 shared-trace views** within 30 days of
   launch day, both required.
2. Pull the counters (operator-only; the token is deliberately **not** in
   this repo — it lives in the local file
   `~/projects/mcp-replay/share-worker/.stats-token.local`):

   ```bash
   TOKEN=$(cat ~/projects/mcp-replay/share-worker/.stats-token.local)
   curl -s -H "Authorization: Bearer $TOKEN" https://mcpreplay.dev/api/stats
   ```

   Counters surfaced: `shares_created`, `share_views`, `deletes`,
   `rate_limited`, `self_shares`.
3. Compute, as **deltas from the launch-day snapshot below** (so pre-launch
   testing and demo traffic don't count toward the gate):
   - non-self shares = `shares_created` − `self_shares`
   - shared-trace views = `share_views`
4. **PASS** iff non-self-share delta >= 10 **and** view delta >= 25.
   Anything else is **KILL** (GATES.md: below either threshold ⇒ park).
5. If a PASS is within a handful of shares of the threshold, apply the
   GATES.md residual-risk check: cross-check memory for self-shares made
   from shells/machines missing `MCP_TAPE_SELF=1` before declaring PASS.
6. Read the GATES.md channel-reach log and the non-gating color metrics
   (npm weekly downloads against the ~124/month scanner noise floor,
   GitHub stars). These inform the post-mortem or the v0.5 ranking — they
   cannot flip the verdict.

**Launch-day snapshot** (fill from `/api/stats` at launch, before the first
post goes up):

| counter | value at launch |
|---|---|
| shares_created | |
| self_shares | |
| share_views | |

## PULL

A PASS means real strangers shared and viewed traces without being asked
twice — the loop works. Continuing investment means:

- **Ship v0.5.** Priorities (placeholder ranking — re-rank against what
  launch feedback actually asked for before starting):
  1. HTTP / SSE transport recording (the most-cited gap; stdio-only today)
  2. Web-form share — upload a redacted trace from the browser without
     installing the CLI
  3. Turnstile escalation on the share endpoint **if** abuse shows up
     (`rate_limited` counter trending up, junk shares, takedown volume)
- Keep the support loop honest: answer issues, fix redaction-rule gaps
  reported from real traces, keep GATES.md-style pre-registration for the
  next milestone.

## KILL

A KILL means the loop didn't close within the pre-registered window. Execute
exactly this — it is written now so future-me doesn't negotiate:

- **Park the repos public-but-archived**: archive `craigm26/mcp-tape` and
  `craigm26/mcp-replay` on GitHub. Code stays readable; the project stops
  pretending to be maintained.
- **Write the post-mortem in this file**, replacing this section's tail:
  what the channel log showed, where the funnel died (installs vs. shares
  vs. views), and what was wrong about the premise.
- **npm package stays published** (never unpublish working software), with
  an "unmaintained — archived, see post-mortem" note added to the top of
  the README and republished as a final patch release.

No partial credit, no quiet relaunch under the same gates. A future revival
needs new pre-registered gates in a new GATES.md.
