# DESIGN

## Product shape

- `just-pi` is a browser-native coding cockpit: configure once, drive from one prompt lane, inspect results, edit files in place.
- The app is fully client-side. Agent, shell, storage, and UI all live in the browser.
- Persistence is intentionally split: OPFS holds workspace files; `localStorage` holds config, transcript, and UI memory.

## Surface model

- The shell has four named surfaces: **Setup**, **Drive**, **Review**, **Files**.
- Desktop shows them as one continuous workspace: header/status, setup strip, split main area, command lane.
- Mobile keeps the same surfaces but shows one at a time behind a 4-tab switcher.
- The command lane is the center of gravity: plain text goes to the agent, `!` goes to shell.
- Setup compresses into a quieter strip after configuration so Drive and Review read as primary.

## Interaction model

- **Setup** exists to unlock and tune the system, then get out of the way.
- **Drive** is the primary action surface.
- **Review** is the canonical timeline of what happened: prompts, tool calls, shell output, notices, stream state.
- **Files** is a working editor, not a passive preview.
- Onboarding makes the first useful move obvious without hiding power features.

## Runtime map

- `src/App.tsx`: shell orchestrator; owns state, persistence wiring, and cross-surface flow.
- `src/AssistantCommandBar.tsx`: prompt entry, mode switch, suggestions, attachments, stop/send controls.
- `src/AssistantReviewPane.tsx`: assistant-thread rendering and tool-card display.
- `src/assistant-attachments.ts`: text attachment adapter.
- `src/agent-session.ts` + `src/agent-session-ui.ts`: agent creation, model/runtime config, stream formatting, starter state.
- `src/shell.ts`: serialized `just-bash` runtime over the same workspace.
- `src/opfs.ts`: OPFS-backed filesystem, tree/search helpers, path normalization.
- `src/main.tsx`: bootstraps the shell and global CSS.

## Visual grammar

- Tone: dark, dense, calm, tool-like.
- Field: soft gradient backdrop; panels float as subdued glass cards.
- Typography split is functional: sans for chrome, mono for working surfaces.
- Primitive set is intentionally small: panel, chip, bubble, button row, tree row.
- Color is semantic, not decorative: blue = active/agent, green = shell/ready, red = error.
- Hierarchy comes from grouping, spacing, and state accents more than heavy borders or ornament.
- The header keeps status and cwd visible but lightweight.

## Quality bar

- Prefer fewer, stronger primitives over one-off variants.
- Keep labels short and operational.
- Let the review lane explain system behavior; avoid duplicating that explanation elsewhere.
- Keep the workspace visually quiet so file hierarchy and edit state stand out.
- Preserve identical surface names and roles across desktop and mobile.
- Reduce repeated explanatory copy; keep the shell compact and serious.
- Review acts as the source of truth; Files holds the working set.
