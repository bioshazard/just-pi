import "./style.css";

import type { Agent } from "@mariozechner/pi-agent-core";

import {
  OPENROUTER_MODELS,
  createBrowserAgentSession,
  formatAssistantDelta,
  formatToolEvent,
  getDefaultModelId,
  getStarterWorkspaceFile,
  restoreMessages,
  shouldCloseAssistantBlock,
  shouldOpenAssistantBlock,
  updateAgentConfiguration,
} from "./agent-session";
import { OpfsWorkspace, basename, type WorkspaceTreeEntry } from "./opfs";
import { ShellRuntime } from "./shell";

const STORAGE_KEYS = {
  apiKey: "just-pi.api-key",
  modelId: "just-pi.model-id",
  terminal: "just-pi.terminal",
  activity: "just-pi.activity",
  review: "just-pi.review",
  mobileView: "just-pi.mobile-view",
  shellCwd: "just-pi.shell-cwd",
} as const;

type MobileView = "settings" | "command" | "console" | "workspace";
type ReviewEntry =
  | { id: string; kind: "user" | "assistant"; text: string }
  | { id: string; kind: "shell"; source: "user"; command: string; output: string; exitCode: number | null; pending: boolean }
  | { id: string; kind: "notice"; text: string; tone: "info" | "error" };

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`App failed to mount: missing ${selector}`);
  }
  return element;
}

const appEl = requireElement<HTMLDivElement>("#app");
const terminalEl = requireElement<HTMLPreElement>("#terminal");
const activityEl = requireElement<HTMLPreElement>("#activity-log");
const reviewLogEl = requireElement<HTMLDivElement>("#review-log");
const workspaceTreeEl = requireElement<HTMLDivElement>("#workspace-tree");
const fileTitleEl = requireElement<HTMLHeadingElement>("#file-title");
const fileSubtitleEl = requireElement<HTMLParagraphElement>("#file-subtitle");
const fileEditorEl = requireElement<HTMLTextAreaElement>("#file-editor");
const fileSaveButton = requireElement<HTMLButtonElement>("#file-save");
const fileReloadButton = requireElement<HTMLButtonElement>("#file-reload");
const statusChipEl = requireElement<HTMLSpanElement>("#status-chip");
const cwdChipEl = requireElement<HTMLSpanElement>("#cwd-chip");
const apiKeyInput = requireElement<HTMLInputElement>("#api-key");
const modelIdInput = requireElement<HTMLInputElement>("#model-id");
const modelOptionsEl = requireElement<HTMLDataListElement>("#model-options");
const onboardingPanelEl = requireElement<HTMLElement>("#onboarding-panel");
const onboardingTitleEl = requireElement<HTMLHeadingElement>("#onboarding-title");
const onboardingTextEl = requireElement<HTMLParagraphElement>("#onboarding-text");
const promptForm = requireElement<HTMLFormElement>("#prompt-form");
const promptInput = requireElement<HTMLTextAreaElement>("#prompt-input");
const promptSubmit = requireElement<HTMLButtonElement>("#prompt-submit");
const promptStop = requireElement<HTMLButtonElement>("#prompt-stop");
const commandModeEl = requireElement<HTMLSpanElement>("#command-mode");
const saveSettingsButton = requireElement<HTMLButtonElement>("#save-settings");
const clearTranscriptButton = requireElement<HTMLButtonElement>("#clear-transcript");
const resetWorkspaceButton = requireElement<HTMLButtonElement>("#reset-workspace");
const refreshWorkspaceButton = requireElement<HTMLButtonElement>("#refresh-workspace");
const mobileTabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-mobile-target]"));

const workspace = new OpfsWorkspace();
const shell = new ShellRuntime(workspace, STORAGE_KEYS.shellCwd);

let agent: Agent | undefined;
let assistantBlockOpen = false;
let activeFilePath: string | undefined;
let fileEditorDirty = false;
let workspaceEntries: WorkspaceTreeEntry[] = [];
let reviewEntries: ReviewEntry[] = [];
let activeAssistantReviewId: string | undefined;

function readApiKey(): string {
  return localStorage.getItem(STORAGE_KEYS.apiKey) ?? "";
}

function readModelId(): string {
  return localStorage.getItem(STORAGE_KEYS.modelId) ?? getDefaultModelId();
}

function hasSavedApiKey(): boolean {
  return readApiKey().trim().length > 0;
}

function isGitHubPagesHost(): boolean {
  return window.location.hostname.endsWith(".github.io");
}

function isMobileViewport(): boolean {
  return window.matchMedia("(max-width: 980px)").matches;
}

function readMobileView(): MobileView {
  const stored = localStorage.getItem(STORAGE_KEYS.mobileView);
  if (stored === "settings" || stored === "command" || stored === "console" || stored === "workspace") {
    return stored;
  }
  return hasSavedApiKey() ? "command" : "settings";
}

function persistTerminal(content: string): void {
  localStorage.setItem(STORAGE_KEYS.terminal, content);
}

function persistActivity(content: string): void {
  localStorage.setItem(STORAGE_KEYS.activity, content);
}

function persistReviewEntries(entries: ReviewEntry[]): void {
  localStorage.setItem(STORAGE_KEYS.review, JSON.stringify(entries));
}

function restoreReviewEntries(): ReviewEntry[] {
  const raw = localStorage.getItem(STORAGE_KEYS.review);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ReviewEntry[]) : [];
  } catch {
    return [];
  }
}

function setStatus(label: string, tone: "idle" | "busy" | "error" = "idle"): void {
  statusChipEl.textContent = label;
  statusChipEl.dataset.tone = tone;
  cwdChipEl.textContent = shell.getCwd();
}

function setBusy(isBusy: boolean): void {
  promptSubmit.disabled = isBusy;
  promptInput.disabled = isBusy;
  promptStop.disabled = !isBusy;
}

function updateCommandBarState(): void {
  const trimmed = promptInput.value.trim();
  const isShellCommand = trimmed.startsWith("!");

  commandModeEl.dataset.mode = isShellCommand ? "shell" : "agent";
  commandModeEl.textContent = isShellCommand ? "Shell mode" : "Agent mode";
  promptSubmit.textContent = isShellCommand ? "Run command" : "Send prompt";
}

function updateOnboardingState(): void {
  const ready = hasSavedApiKey();
  onboardingPanelEl.dataset.state = ready ? "ready" : "setup";
  onboardingTitleEl.textContent = ready ? "Ready to build" : "Quick start";

  if (ready) {
    onboardingTextEl.innerHTML =
      "Agent mode is enabled. Use plain text for the agent, start with <code>!</code> for shell commands, and remember that files persist in this browser.";
    return;
  }

  onboardingTextEl.innerHTML = isGitHubPagesHost()
    ? "This GitHub Pages app runs entirely in your browser. Save an OpenRouter key to unlock agent mode; <code>!</code> shell commands already work without one."
    : "This app runs entirely in your browser. Save an OpenRouter key to unlock agent mode; <code>!</code> shell commands already work without one.";
}

function setMobileView(view: MobileView): void {
  appEl.dataset.mobileView = view;
  localStorage.setItem(STORAGE_KEYS.mobileView, view);

  for (const button of mobileTabButtons) {
    const active = button.dataset.mobileTarget === view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

function focusPromptInput(): void {
  promptInput.focus();
  promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
}

function renderReviewLog(): void {
  reviewLogEl.replaceChildren();

  if (reviewEntries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "review-empty";
    empty.textContent = "Review timeline will appear here.";
    reviewLogEl.append(empty);
    return;
  }

  for (const entry of reviewEntries) {
    const card = document.createElement("article");
    card.className = `review-entry review-entry-${entry.kind}`;

    const meta = document.createElement("div");
    meta.className = "review-entry-meta";

    if (entry.kind === "user" || entry.kind === "assistant") {
      meta.textContent = entry.kind === "user" ? "You" : "Assistant";
      const bubble = document.createElement("div");
      bubble.className = "review-bubble";
      bubble.textContent = entry.text || (entry.kind === "assistant" ? "…" : "");
      card.append(meta, bubble);
    } else if (entry.kind === "shell") {
      meta.textContent = "Command";

      const command = document.createElement("pre");
      command.className = "review-shell-command";
      command.textContent = `$ ${entry.command}`;

      const output = document.createElement("pre");
      output.className = "review-shell-output";
      if (entry.pending) {
        output.textContent = entry.output || "(running...)";
      } else {
        output.textContent = entry.output || "(no output)";
      }

      card.append(meta, command, output);

      if (entry.exitCode !== null && entry.exitCode !== 0) {
        const badge = document.createElement("span");
        badge.className = "review-status";
        badge.textContent = `exit ${entry.exitCode}`;
        card.append(badge);
      }
    } else if (entry.kind === "notice") {
      meta.textContent = entry.tone === "error" ? "Error" : "Notice";
      card.dataset.tone = entry.tone;
      const bubble = document.createElement("div");
      bubble.className = "review-bubble";
      bubble.textContent = entry.text;
      card.append(meta, bubble);
    }

    reviewLogEl.append(card);
  }

  reviewLogEl.scrollTop = reviewLogEl.scrollHeight;
}

function syncReviewLog(): void {
  persistReviewEntries(reviewEntries);
  renderReviewLog();
}

function addReviewEntry(entry: ReviewEntry): string {
  reviewEntries.push(entry);
  syncReviewLog();
  return entry.id;
}

function addReviewMessage(kind: "user" | "assistant", text: string): string {
  return addReviewEntry({
    id: crypto.randomUUID(),
    kind,
    text,
  });
}

function addReviewNotice(text: string, tone: "info" | "error" = "info"): string {
  return addReviewEntry({
    id: crypto.randomUUID(),
    kind: "notice",
    text,
    tone,
  });
}

function addReviewShell(command: string): string {
  return addReviewEntry({
    id: crypto.randomUUID(),
    kind: "shell",
    source: "user",
    command,
    output: "",
    exitCode: null,
    pending: true,
  });
}

function updateReviewEntry(id: string, update: (entry: ReviewEntry) => void): void {
  const entry = reviewEntries.find((candidate) => candidate.id === id);
  if (!entry) {
    return;
  }
  update(entry);
  syncReviewLog();
}

function resetReviewLog(entries: ReviewEntry[] = []): void {
  reviewEntries = entries;
  syncReviewLog();
}

function appendTerminal(text: string): void {
  terminalEl.textContent += text;
  persistTerminal(terminalEl.textContent);
  terminalEl.scrollTop = terminalEl.scrollHeight;
}

function resetTerminal(text = ""): void {
  terminalEl.textContent = text;
  persistTerminal(text);
}

function appendActivity(text: string): void {
  activityEl.textContent += text;
  persistActivity(activityEl.textContent);
  activityEl.scrollTop = activityEl.scrollHeight;
}

function resetActivity(text = ""): void {
  activityEl.textContent = text;
  persistActivity(text);
}

function setFileViewerState(): void {
  if (!activeFilePath) {
    fileTitleEl.textContent = "No file selected";
    fileSubtitleEl.textContent = "Choose a file from the workspace to view or edit it.";
    fileEditorEl.value = "";
    fileEditorEl.disabled = true;
    fileReloadButton.disabled = true;
    fileSaveButton.disabled = true;
    return;
  }

  fileTitleEl.textContent = `${basename(activeFilePath)}${fileEditorDirty ? " *" : ""}`;
  fileSubtitleEl.textContent = activeFilePath;
  fileEditorEl.disabled = false;
  fileReloadButton.disabled = false;
  fileSaveButton.disabled = !fileEditorDirty;
}

async function loadWorkspaceFile(path: string): Promise<void> {
  fileEditorEl.value = await workspace.readText(path);
  activeFilePath = path;
  fileEditorDirty = false;
  setFileViewerState();
}

async function openWorkspaceFile(path: string, options: { skipDirtyCheck?: boolean } = {}): Promise<void> {
  if (!options.skipDirtyCheck && fileEditorDirty) {
    const shouldDiscard = window.confirm("Discard unsaved file changes?");
    if (!shouldDiscard) {
      return;
    }
  }

  if (isMobileViewport()) {
    setMobileView("workspace");
  }
  await loadWorkspaceFile(path);
  renderWorkspaceTree();
}

function renderWorkspaceTree(): void {
  workspaceTreeEl.replaceChildren();

  for (const entry of workspaceEntries) {
    if (entry.kind === "directory") {
      const row = document.createElement("div");
      row.className = "workspace-node workspace-node-directory";
      row.style.setProperty("--depth", String(entry.depth));
      row.textContent = `▾ ${entry.name}`;
      workspaceTreeEl.append(row);
      continue;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-node";
    if (entry.path === activeFilePath) {
      button.classList.add("is-active");
    }
    button.style.setProperty("--depth", String(entry.depth));
    button.textContent = entry.name;
    button.addEventListener("click", async () => {
      await openWorkspaceFile(entry.path);
    });
    workspaceTreeEl.append(button);
  }
}

async function refreshWorkspaceTree(): Promise<void> {
  workspaceEntries = await workspace.listTreeEntries();
  cwdChipEl.textContent = shell.getCwd();

  const filePaths = workspaceEntries.filter((entry) => entry.kind === "file").map((entry) => entry.path);
  if (activeFilePath && !filePaths.includes(activeFilePath)) {
    activeFilePath = undefined;
    fileEditorDirty = false;
  }

  renderWorkspaceTree();

  const nextPath = activeFilePath ?? filePaths[0];
  if (!nextPath) {
    setFileViewerState();
    return;
  }

  if (!activeFilePath) {
    await loadWorkspaceFile(nextPath);
    renderWorkspaceTree();
    return;
  }

  if (!fileEditorDirty) {
    await loadWorkspaceFile(nextPath);
    renderWorkspaceTree();
  } else {
    setFileViewerState();
  }
}

async function saveActiveFile(): Promise<void> {
  if (!activeFilePath) {
    return;
  }

  await workspace.writeFile(activeFilePath, fileEditorEl.value);
  fileEditorDirty = false;
  setFileViewerState();
  appendTerminal(`\n[workspace] saved ${activeFilePath}\n`);
  await refreshWorkspaceTree();
}

async function ensureStarterWorkspace(): Promise<void> {
  if ((await workspace.readdir("/")).length > 0) {
    return;
  }
  const starter = getStarterWorkspaceFile();
  await workspace.writeFile(starter.path, starter.content);
}

function populateModelOptions(): void {
  modelOptionsEl.innerHTML = OPENROUTER_MODELS.map((modelId) => `<option value="${modelId}"></option>`).join("");
  modelIdInput.value = readModelId();
}

function saveSettings(): void {
  localStorage.setItem(STORAGE_KEYS.apiKey, apiKeyInput.value.trim());
  localStorage.setItem(STORAGE_KEYS.modelId, modelIdInput.value.trim() || getDefaultModelId());
  if (agent) {
    updateAgentConfiguration(agent, readModelId(), shell);
  }
  appendTerminal("\n[settings] saved OpenRouter credentials and model selection.\n");
  updateOnboardingState();
  if (isMobileViewport()) {
    setMobileView(hasSavedApiKey() ? "command" : "settings");
    if (hasSavedApiKey()) {
      focusPromptInput();
    }
  }
}

async function runManualShell(command: string): Promise<void> {
  setStatus("Shell", "busy");
  setBusy(true);
  appendTerminal(`\n$ ${command}\n`);
  const reviewEntryId = addReviewShell(command);
  let reviewOutput = "";
  let reviewExitCode: number | null = null;
  try {
    const result = await shell.execute(command);
    if (result.stdout) {
      appendTerminal(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
      reviewOutput += result.stdout;
    }
    if (result.stderr) {
      appendTerminal(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
      reviewOutput += `${reviewOutput ? "\n" : ""}${result.stderr}`;
    }
    if (result.exitCode !== 0) {
      appendTerminal(`[exit ${result.exitCode}]\n`);
    }
    reviewExitCode = result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendTerminal(`[shell error] ${message}\n`);
    setStatus("Shell error", "error");
    reviewOutput = message;
    reviewExitCode = 1;
  } finally {
    setBusy(false);
  }
  updateReviewEntry(reviewEntryId, (entry) => {
    if (entry.kind !== "shell") {
      return;
    }
    entry.output = reviewOutput;
    entry.exitCode = reviewExitCode;
    entry.pending = false;
  });
  await refreshWorkspaceTree();
  setStatus("Idle", "idle");
}

function wireAgent(agentInstance: Agent): void {
  agentInstance.subscribe(async (event) => {
    const toolText = formatToolEvent(event);
    if (toolText) {
      appendActivity(toolText);
    }

    if (shouldOpenAssistantBlock(event)) {
      assistantBlockOpen = true;
      activeAssistantReviewId = addReviewMessage("assistant", "");
      appendActivity("\nassistant> ");
    }

    const delta = formatAssistantDelta(event);
    if (delta) {
      appendActivity(delta);
      if (activeAssistantReviewId) {
        updateReviewEntry(activeAssistantReviewId, (entry) => {
          if (entry.kind === "assistant") {
            entry.text += delta;
          }
        });
      }
    }

    if (shouldCloseAssistantBlock(event) && assistantBlockOpen) {
      assistantBlockOpen = false;
      activeAssistantReviewId = undefined;
      appendActivity("\n");
    }

    if (event.type === "agent_start") {
      setStatus("Running", "busy");
      setBusy(true);
      if (isMobileViewport()) {
        setMobileView("console");
      }
    }

    if (event.type === "agent_end") {
      setStatus("Idle", "idle");
      setBusy(false);
      await refreshWorkspaceTree();
    }
  });
}

async function submitPrompt(prompt: string): Promise<void> {
  if (!prompt || !agent) {
    return;
  }
  if (!readApiKey()) {
    addReviewNotice("Save an OpenRouter API key before sending a prompt.", "error");
    appendActivity("\n[error] Save an OpenRouter API key before sending a prompt.\n");
    setStatus("Missing API key", "error");
    if (isMobileViewport()) {
      setMobileView("settings");
    }
    return;
  }

  updateAgentConfiguration(agent, readModelId(), shell);
  if (isMobileViewport()) {
    setMobileView("console");
  }
  addReviewMessage("user", prompt);
  appendActivity(`\nuser> ${prompt}\n`);
  promptInput.value = "";
  updateCommandBarState();

  try {
    await agent.prompt(prompt);
  } catch (error) {
    if (assistantBlockOpen) {
      assistantBlockOpen = false;
      activeAssistantReviewId = undefined;
      appendActivity("\n");
    }
    addReviewNotice(error instanceof Error ? error.message : String(error), "error");
    appendActivity(`[agent error] ${error instanceof Error ? error.message : String(error)}\n`);
    setStatus("Agent error", "error");
    setBusy(false);
  }
}

async function submitCommandBar(): Promise<void> {
  const input = promptInput.value.trim();
  if (!input) {
    return;
  }

  if (input.startsWith("!")) {
    const command = input.slice(1).trim();
    if (!command) {
      appendTerminal("\n[error] Enter a shell command after !.\n");
      setStatus("Missing command", "error");
      return;
    }

    promptInput.value = "";
    updateCommandBarState();
    if (isMobileViewport()) {
      setMobileView("console");
    }
    await runManualShell(command);
    return;
  }

  await submitPrompt(input);
}

async function bootstrap(): Promise<void> {
  await workspace.ready();
  await ensureStarterWorkspace();

  apiKeyInput.value = readApiKey();
  populateModelOptions();
  resetTerminal(localStorage.getItem(STORAGE_KEYS.terminal) ?? "");
  resetActivity(localStorage.getItem(STORAGE_KEYS.activity) ?? "");
  reviewEntries = restoreReviewEntries();
  renderReviewLog();
  if (!terminalEl.textContent) {
    appendTerminal("just-pi ready. Configure an OpenRouter key, inspect the workspace, then prompt the agent.\n");
  }
  if (!activityEl.textContent) {
    appendActivity("Agent activity will appear here.\n");
  }

  agent = createBrowserAgentSession({
    workspace,
    shell,
    readApiKey,
    readModelId,
  });
  agent.state.messages = restoreMessages();
  updateAgentConfiguration(agent, readModelId(), shell);
  wireAgent(agent);
  setStatus("Idle", "idle");
  setBusy(false);
  setMobileView(readMobileView());
  updateCommandBarState();
  updateOnboardingState();
  await refreshWorkspaceTree();
}

fileEditorEl.addEventListener("input", () => {
  if (!activeFilePath) {
    return;
  }
  fileEditorDirty = true;
  setFileViewerState();
});

fileSaveButton.addEventListener("click", async () => {
  await saveActiveFile();
});

fileReloadButton.addEventListener("click", async () => {
  if (!activeFilePath) {
    return;
  }
  if (fileEditorDirty) {
    const shouldDiscard = window.confirm("Reload this file and discard unsaved changes?");
    if (!shouldDiscard) {
      return;
    }
  }
  await loadWorkspaceFile(activeFilePath);
  renderWorkspaceTree();
});

saveSettingsButton.addEventListener("click", () => {
  saveSettings();
});

clearTranscriptButton.addEventListener("click", () => {
  if (agent) {
    agent.reset();
  }
  localStorage.removeItem("just-pi.messages");
  resetTerminal("Transcript cleared.\n");
  resetActivity("Agent activity cleared.\n");
  resetReviewLog();
  setStatus("Idle", "idle");
});

resetWorkspaceButton.addEventListener("click", async () => {
  if (!window.confirm("Reset the OPFS workspace? This removes all files created in just-pi.")) {
    return;
  }
  await workspace.clear();
  await ensureStarterWorkspace();
  activeFilePath = undefined;
  fileEditorDirty = false;
  appendTerminal("\n[workspace] reset complete.\n");
  await refreshWorkspaceTree();
});

refreshWorkspaceButton.addEventListener("click", async () => {
  await refreshWorkspaceTree();
});

promptForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitCommandBar();
});

promptStop.addEventListener("click", () => {
  agent?.abort();
  addReviewNotice("Agent abort requested.");
  appendActivity("\n[agent] abort requested.\n");
});

promptInput.addEventListener("input", () => {
  updateCommandBarState();
});

promptInput.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) {
    return;
  }

  event.preventDefault();
  await submitCommandBar();
});

document.querySelectorAll<HTMLButtonElement>("[data-quick-command]").forEach((button) => {
  button.addEventListener("click", () => {
    const command = button.dataset.quickCommand;
    if (!command) {
      return;
    }
    setMobileView("command");
    promptInput.value = command;
    updateCommandBarState();
    focusPromptInput();
  });
});

for (const button of mobileTabButtons) {
  button.addEventListener("click", () => {
    const view = button.dataset.mobileTarget;
    if (view === "settings" || view === "command" || view === "console" || view === "workspace") {
      setMobileView(view);
      if (view === "command") {
        focusPromptInput();
      }
    }
  });
}

void bootstrap();
