# DESIGN

## Product shape

- `just-pi` is a browser-native coding cockpit with one focused surface per route.
- The app is fully client-side. Agent, shell, storage, and UI all live in the browser.
- Persistence is intentionally split: OPFS holds workspace files; `localStorage` holds config, transcript, and UI memory.

## Surface model

- The shell has two primary product surfaces: **Session** and **Files**.
- **Setup** remains a route, but it behaves like a utility surface rather than a peer in the primary hierarchy.
- The app is a hash-routed SPA. Each surface owns its own location instead of sharing one crowded canvas.
- Header/status and primary navigation stay persistent; the main view swaps to the active surface.
- The default route is **Session**.
- The command lane and transcript live in the same **Session** surface: plain text goes to the agent, `!` goes to shell.

## Interaction model

- **Setup** configures the system, then collapses into a compact summary with an explicit expand action. It stays available as a utility, not the main starting point.
- **Session** is the primary action surface. It combines prompt entry, transcript, streaming state, and raw traces into one continuous runtime view.
- **Session** uses the full available height because it behaves like an active conversation/work log, not a short utility card.
- **Files** is a working editor, not a passive preview. It is the only full workbench surface.
- Onboarding points into **Session** instead of splitting compose and history across separate tabs.

## Runtime map

- `src/App.tsx`: shell orchestrator; owns state, persistence wiring, hash-route state, and cross-surface flow.
- `src/AssistantCommandBar.tsx`: prompt entry, mode switch, suggestions, attachments, stop/send controls.
- `src/AssistantReviewPane.tsx`: transcript rendering, streaming state, and tool-card display inside Session.
- `src/assistant-attachments.ts`: text attachment adapter.
- `src/agent-session.ts` + `src/agent-session-ui.ts`: agent creation, model/runtime config, stream formatting, starter state.
- `src/shell.ts`: serialized `just-bash` runtime over the same workspace.
- `src/opfs.ts`: OPFS-backed filesystem, tree/search helpers, path normalization.
- `wouter` hash location: route state for **Session**, **Files**, and utility **Setup**.
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
- Keep composing and reviewing in the same place when they describe the same runtime.
- Keep the workspace visually quiet so file hierarchy and edit state stand out.
- Preserve identical surface names and route roles across desktop and mobile.
- Keep the primary hierarchy honest: Session first, Files second, Setup as utility.
- Reduce repeated explanatory copy; keep the shell compact and serious.
- Session acts as the source of truth for runtime activity; Files holds the working set.
