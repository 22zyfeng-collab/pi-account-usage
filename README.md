# pi-account-usage

A small [Pi](https://github.com/earendil-works/pi) usage extension that tracks how much the logged-in Pi account (`openai-codex` provider) has been used, across all sessions on the machine.

## What you get

- **Status line** (footer): `▣ Pi 用量 6615次 · 52.9M tokens · 1052.87` — always visible, updates after every assistant reply.
- **Expandable details button** (Pi Web): a small `用量明细` button next to the status line in the footer shelf. Click it to expand a scrollable panel with:
  - total requests / tokens / cost, plus input, output, cache-read, cache-write breakdown
  - today's usage
  - top 5 models by cost
  - the last 7 days
- **`/usage` command**: shows the same details as a notification; works in the terminal too, where there is no button.

Only `openai-codex` traffic is counted. Other providers, proxies, and accounts are intentionally ignored.

## Install

```bash
pi install git:github.com/22zyfeng-collab/pi-account-usage
```

Reload Pi afterwards:

```text
/reload
```

## How it works

- On session start it scans `PI_CODING_AGENT_DIR/sessions/**/*.jsonl` for assistant messages from the `openai-codex` provider and aggregates their usage (deduplicated by `responseId`).
- Each new assistant reply is aggregated live and appended to `PI_CODING_AGENT_DIR/state/account-usage.jsonl` as a durable fallback log.
- All aggregation happens locally. Nothing is sent anywhere; no credentials are involved.

## Files

- `extensions/account-usage.ts` — the whole extension (single file, no dependencies).
