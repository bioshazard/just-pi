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
import { OpfsWorkspace } from "./opfs";
import { ShellRuntime } from "./shell";

const STORAGE_KEYS = {
  apiKey: "just-pi.api-key",
  modelId: "just-pi.model-id",
  terminal: "just-pi.terminal",
  shellCwd: "just-pi.shell-cwd",
} as const;

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`App failed to mount: missing ${selector}`);
  }
  return element;
}

const terminalEl = requireElement<HTMLPreElement>("#terminal");
const workspaceTreeEl = requireElement<HTMLPreElement>("#workspace-tree");
const statusChipEl = requireElement<HTMLSpanElement>("#status-chip");
const cwdChipEl = requireElement<HTMLSpanElement>("#cwd-chip");
const apiKeyInput = requireElement<HTMLInputElement>("#api-key");
const modelIdInput = requireElement<HTMLInputElement>("#model-id");
const modelOptionsEl = requireElement<HTMLDataListElement>("#model-options");
const promptForm = requireElement<HTMLFormElement>("#prompt-form");
const promptInput = requireElement<HTMLTextAreaElement>("#prompt-input");
const promptSubmit = requireElement<HTMLButtonElement>("#prompt-submit");
const promptStop = requireElement<HTMLButtonElement>("#prompt-stop");
const shellForm = requireElement<HTMLFormElement>("#shell-form");
const shellInput = requireElement<HTMLInputElement>("#shell-input");
const saveSettingsButton = requireElement<HTMLButtonElement>("#save-settings");
const clearTranscriptButton = requireElement<HTMLButtonElement>("#clear-transcript");
const resetWorkspaceButton = requireElement<HTMLButtonElement>("#reset-workspace");
const refreshWorkspaceButton = requireElement<HTMLButtonElement>("#refresh-workspace");

const workspace = new OpfsWorkspace();
const shell = new ShellRuntime(workspace, STORAGE_KEYS.shellCwd);

let agent: Agent | undefined;
let assistantBlockOpen = false;

function readApiKey(): string {
  return localStorage.getItem(STORAGE_KEYS.apiKey) ?? "";
}

function readModelId(): string {
  return localStorage.getItem(STORAGE_KEYS.modelId) ?? getDefaultModelId();
}

function persistTerminal(content: string): void {
  localStorage.setItem(STORAGE_KEYS.terminal, content);
}

function setStatus(label: string, tone: "idle" | "busy" | "error" = "idle"): void {
  statusChipEl.textContent = label;
  statusChipEl.dataset.tone = tone;
  cwdChipEl.textContent = shell.getCwd();
}

function setBusy(isBusy: boolean): void {
  promptSubmit.disabled = isBusy;
  promptInput.disabled = isBusy;
  shellInput.disabled = isBusy;
  promptStop.disabled = !isBusy;
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

async function refreshWorkspaceTree(): Promise<void> {
  workspaceTreeEl.textContent = await workspace.renderTree();
  cwdChipEl.textContent = shell.getCwd();
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
}

async function runManualShell(command: string): Promise<void> {
  appendTerminal(`\n$ ${command}\n`);
  try {
    const result = await shell.execute(command);
    if (result.stdout) {
      appendTerminal(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
    }
    if (result.stderr) {
      appendTerminal(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
    }
    if (result.exitCode !== 0) {
      appendTerminal(`[exit ${result.exitCode}]\n`);
    }
  } catch (error) {
    appendTerminal(`[shell error] ${error instanceof Error ? error.message : String(error)}\n`);
  }
  await refreshWorkspaceTree();
}

function wireAgent(agentInstance: Agent): void {
  agentInstance.subscribe(async (event) => {
    const toolText = formatToolEvent(event);
    if (toolText) {
      appendTerminal(toolText);
    }

    if (shouldOpenAssistantBlock(event)) {
      assistantBlockOpen = true;
      appendTerminal("\nassistant> ");
    }

    const delta = formatAssistantDelta(event);
    if (delta) {
      appendTerminal(delta);
    }

    if (shouldCloseAssistantBlock(event) && assistantBlockOpen) {
      assistantBlockOpen = false;
      appendTerminal("\n");
    }

    if (event.type === "agent_start") {
      setStatus("Running", "busy");
      setBusy(true);
    }

    if (event.type === "agent_end") {
      setStatus("Idle", "idle");
      setBusy(false);
      await refreshWorkspaceTree();
    }
  });
}

async function submitPrompt(): Promise<void> {
  const prompt = promptInput.value.trim();
  if (!prompt || !agent) {
    return;
  }
  if (!readApiKey()) {
    appendTerminal("\n[error] Save an OpenRouter API key before sending a prompt.\n");
    setStatus("Missing API key", "error");
    return;
  }

  updateAgentConfiguration(agent, readModelId(), shell);
  appendTerminal(`\nuser> ${prompt}\n`);
  promptInput.value = "";

  try {
    await agent.prompt(prompt);
  } catch (error) {
    appendTerminal(`[agent error] ${error instanceof Error ? error.message : String(error)}\n`);
    setStatus("Agent error", "error");
    setBusy(false);
  }
}

async function bootstrap(): Promise<void> {
  await workspace.ready();
  await ensureStarterWorkspace();

  apiKeyInput.value = readApiKey();
  populateModelOptions();
  resetTerminal(localStorage.getItem(STORAGE_KEYS.terminal) ?? "");
  if (!terminalEl.textContent) {
    appendTerminal("just-pi ready. Configure an OpenRouter key, inspect the workspace, then prompt the agent.\n");
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
  await refreshWorkspaceTree();
}

saveSettingsButton.addEventListener("click", () => {
  saveSettings();
});

clearTranscriptButton.addEventListener("click", () => {
  if (agent) {
    agent.reset();
  }
  localStorage.removeItem("just-pi.messages");
  resetTerminal("Transcript cleared.\n");
  setStatus("Idle", "idle");
});

resetWorkspaceButton.addEventListener("click", async () => {
  if (!window.confirm("Reset the OPFS workspace? This removes all files created in just-pi.")) {
    return;
  }
  await workspace.clear();
  await ensureStarterWorkspace();
  appendTerminal("\n[workspace] reset complete.\n");
  await refreshWorkspaceTree();
});

refreshWorkspaceButton.addEventListener("click", async () => {
  await refreshWorkspaceTree();
});

promptForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitPrompt();
});

promptStop.addEventListener("click", () => {
  agent?.abort();
  appendTerminal("\n[agent] abort requested.\n");
});

shellForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const command = shellInput.value.trim();
  if (!command) {
    return;
  }
  shellInput.value = "";
  await runManualShell(command);
});

void bootstrap();
