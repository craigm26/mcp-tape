# Launch gates (pre-registered)

Pre-registered evaluation gates for the public launch of **mcp-tape** +
**mcp-replay**. This file is committed BEFORE any launch post. The
thresholds below are fixed as of the commit that introduced them — no
goalpost-moving after launch day.

## Launch day

Launch day = the date of the **first public channel post** (any channel in
the log below).

**Launch day: `____-__-__` (stamp at launch)**

Gates are evaluated once, at **T+30 days** after launch day.

## PASS gate

Both of the following must hold within 30 days of launch day:

- **>= 10 non-self shares** (shares created via `POST /api/share`)
- **>= 25 shared-trace views** (fetches of `GET /api/trace/<id>`)

## KILL gate

Below **either** threshold at T+30 => **park the project and write
VERDICT.md.** No goalpost-moving, no "one more month", no swapping in a
friendlier metric after the fact.

## Definition: "non-self"

A **non-self share** is a share request that **lacks the `X-MCP-Tape-Self`
header**. Craig sets `MCP_TAPE_SELF=1` in his shells, which makes the CLI
send `X-MCP-Tape-Self: 1` so his own shares are excluded from the count.

Residual risk (recorded up front): the exclusion depends on Craig
remembering the env var. A forgotten `MCP_TAPE_SELF=1` in a new shell,
CI job, or one-off machine **inflates the non-self count**. A pass that
is within a handful of shares of the threshold should be cross-checked
against memory of untagged self-shares before being declared a PASS.

## Secondary color metrics (non-gating)

Explicitly **NON-GATING** — these add color to the T+30 review but cannot
pass or fail the launch on their own:

- npm weekly downloads of `mcp-tape`, read against the **~124/month
  mirror/scanner noise floor** observed pre-launch (raw download counts
  below or near that floor mean nothing)
- GitHub stars on the public repos

## Channel-reach log

Filled in at launch, +24h, and +72h per channel. Reach = points/upvotes/
impressions as the channel natively reports them.

| channel | post URL | reach (points/upvotes/impressions) | timestamp |
|---|---|---|---|
| Show HN — at launch | | | |
| Show HN — +24h | | | |
| Show HN — +72h | | | |
| r/mcp — at launch | | | |
| r/mcp — +24h | | | |
| r/mcp — +72h | | | |
| MCP Discord — at launch | | | |
| MCP Discord — +24h | | | |
| MCP Discord — +72h | | | |
| lobste.rs — at launch | | | |
| lobste.rs — +24h | | | |
| lobste.rs — +72h | | | |
