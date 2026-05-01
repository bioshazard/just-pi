# DESIGN

## Product shape

- `just-pi` is a browser-native coding cockpit with one focused surface per route.
- The app is fully client-side. Agent, shell, storage, and UI all live in the browser.
- Persistence is intentionally split: OPFS holds workspace files; `localStorage` holds config, transcript, and UI memory.

## Surface model

- The shell has four named surfaces: **Setup**, **Drive**, **Review**, **Files**.
- The app is a hash-routed SPA. Each surface owns its own location instead of sharing one crowded canvas.
- Header/status and route navigation stay persistent; the main view swaps to the active surface.
- The default route is **Setup** until a key exists, then **Drive**.
- The command lane lives on **Drive**: plain text goes to the agent, `!` goes to shell.

## Interaction model

- **Setup** configures the system, then collapses into a compact summary with an explicit expand action.
- **Drive** is the primary action surface.
- **Review** is the canonical timeline of what happened. Prompts and shell runs navigate here; raw shell and tool traces stay secondary and collapsible.
- **Files** is a working editor, not a passive preview.
- Onboarding points into **Drive** instead of duplicating every other surface at once.

## Runtime map

- `src/App.tsx`: shell orchestrator; owns state, persistence wiring, hash-route state, and cross-surface flow.
- `src/AssistantCommandBar.tsx`: prompt entry, mode switch, suggestions, attachments, stop/send controls.
- `src/AssistantReviewPane.tsx`: assistant-thread rendering and tool-card display.
- `src/assistant-attachments.ts`: text attachment adapter.
- `src/agent-session.ts` + `src/agent-session-ui.ts`: agent creation, model/runtime config, stream formatting, starter state.
- `src/shell.ts`: serialized `just-bash` runtime over the same workspace.
- `src/opfs.ts`: OPFS-backed filesystem, tree/search helpers, path normalization.
- `wouter` hash location: route state for **Setup**, **Drive**, **Review**, and **Files**.
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
- Let the route itself provide focus; avoid showing unrelated controls in the same view.
- Let the review transcript explain system behavior; avoid duplicating the same event across multiple primary panes.
- Keep the workspace visually quiet so file hierarchy and edit state stand out.
- Preserve identical surface names and route roles across desktop and mobile.
- Reduce repeated explanatory copy; keep the shell compact and serious.
- Review acts as the source of truth; Files holds the working set.
