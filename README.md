# just-pi

Browser-native coding sandbox with:

- **Pi agent loop** running in the client
- **OpenRouter BYOK** stored in `localStorage`
- **OPFS** for persistent files across refreshes
- **just-bash** wired to the same workspace state as the agent tools

## Run locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Deploy to GitHub Pages

This repo includes a GitHub Actions workflow that builds `dist/` and deploys it to GitHub Pages on every push to `master`.

If the site does not publish on the first run, set the repository's **Pages** source to **GitHub Actions** in GitHub settings, then rerun the workflow.

## Usage

1. Open the app in a modern browser with OPFS support.
2. Paste an OpenRouter API key into the settings panel and save it.
3. Pick or type an OpenRouter model ID.
4. Use the **Quick start** callout or the **Command bar** for both workflows: start with `!` to run a just-bash command, or enter plain text to send a prompt to the Browser-Native Systems Engineer.

## Notes

- Files persist in the browser's origin-private storage until you reset the workspace or clear site data.
- The API key is never hardcoded; it is read from `localStorage` at runtime.
- This scaffold uses the Pi agent core and Pi AI packages directly so the browser bundle stays compatible while preserving the coding-agent-style tool surface.
