# AGENTS.md

## Browser automation discipline

Use `agent-browser` sparingly in this repo. Prefer the cheapest validation that can answer the question:

1. `npm run build`, typechecks, and static inspection first
2. `web_fetch` / HTML asset inspection for deployed Pages verification
3. `agent-browser` only for layout, runtime behavior, or interactive flows

## Reusing browser sessions

- Prefer **one long-lived `agent-browser` session per task** with `--session <name>`.
- Reuse that same session across `open`, `fill`, `click`, `snapshot`, `get`, and `eval` commands instead of starting fresh sessions.
- If persistent auth or browser state matters across runs, prefer:
  - `--session-name <name>` to auto-save/restore cookies and localStorage
  - `--profile <name|path>` when a real Chrome profile must be reused
  - `--auto-connect` only when intentionally attaching to an already-running Chrome

## What to avoid

- Do **not** open parallel `agent-browser` sessions unless absolutely necessary.
- Do **not** keep spawning new Chrome instances for small checks.
- Do **not** use browser automation for bundle-size checks, asset verification, or simple text assertions that `web_fetch`, `view`, or build output can prove.
- Do **not** leave stale browser sessions around after finishing a validation pass.

## Session and cleanup rules

- Check active sessions with `agent-browser session list`.
- Close the current session with `agent-browser close`.
- Close all stale sessions with `agent-browser close --all`.
- If daemon/session state looks corrupted or stuck, run `agent-browser doctor`.
- Reserve `agent-browser doctor --fix` for actual repair cases because it can perform destructive cleanup.

## Practical repo guidance

- For local UI testing, keep one named session alive for the whole pass and reuse it.
- For GitHub Pages verification, prefer `web_fetch` to confirm deployed asset names before opening a browser.
- If a browser check is still needed, open one session, do one focused flow, then close it.
- Avoid opening extra tabs unless the task specifically requires multi-tab behavior.
