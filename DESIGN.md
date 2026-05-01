# DESIGN

## Shape

- Single-page, browser-only IDE shell: setup, drive, review, files.
- No backend boundary in the app layer; runtime, storage, shell, and agent all live client-side.
- Persistence is split by concern: OPFS for workspace files, `localStorage` for session/config/UI state.

## Code map

- `src/main.tsx`: bootstraps React and the global stylesheet.
- `src/App.tsx`: owns the shell, long-lived state, persistence wiring, and cross-panel orchestration.
- `src/AssistantCommandBar.tsx`: prompt entry, `!` shell switch, suggestions, attachments, stop/send controls.
- `src/AssistantReviewPane.tsx`: assistant thread renderer, tool-call cards, stored review hydration.
- `src/assistant-attachments.ts`: text-file attachment adapter for assistant-ui.
- `src/agent-session.ts`: Pi agent creation, model selection, browser tool surface.
- `src/agent-session-ui.ts`: stream formatting, message restore helpers, starter workspace seed.
- `src/shell.ts`: serialized `just-bash` runtime over the same OPFS-backed workspace.
- `src/opfs.ts`: filesystem abstraction, path normalization, tree/index/search helpers.

## Layout

- Desktop is a four-band stack: header, setup controls, main work area, command bar.
- The main work area is two columns:
  - left: review stream over terminal/activity
  - right: file tree beside editor
- Mobile collapses into one active view at a time behind a 4-tab switcher: Setup, Drive, Review, Files.
- The command model is intentionally unified: plain text targets the agent; `!` routes to shell.

## Style

- Dense dark UI with a soft gradient page background and glass-like panels.
- App chrome uses sans-serif; file/content surfaces use monospace.
- Repeated primitives carry the design: rounded panels, pill chips, chat bubbles, compact action rows.
- Color meaning is semantic, not decorative: blue for active/agent, green for shell/ready, red for failure.
- Review output is one visual family with small variants for user, assistant, shell, notice, and tool states.
- Workspace UI stays minimal: hierarchy and selection do the work instead of heavy explorer chrome.
- Copy is short, operational, and onboarding-oriented; the interface tries to keep first action obvious.
