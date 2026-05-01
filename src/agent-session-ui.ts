import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";

const DEFAULT_MODEL = "openrouter/free";

function ensureTextAssistant(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant";
}

function serializeArgs(args: unknown): string {
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

export function getDefaultModelId(): string {
  return DEFAULT_MODEL;
}

export function restoreMessages(): AgentMessage[] {
  const raw = localStorage.getItem("just-pi.messages");
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AgentMessage[]) : [];
  } catch {
    return [];
  }
}

export function formatToolEvent(event: AgentEvent): string | null {
  switch (event.type) {
    case "tool_execution_start":
      return `\n[tool:${event.toolName}] ${serializeArgs(event.args)}\n`;
    case "tool_execution_update": {
      const first = event.partialResult?.content?.[0];
      return first?.type === "text" ? first.text : null;
    }
    case "tool_execution_end":
      return event.toolName === "bash" ? `\n[tool:${event.toolName}] complete\n` : null;
    default:
      return null;
  }
}

export function formatAssistantDelta(event: AgentEvent): string | null {
  if (event.type !== "message_update") {
    return null;
  }
  if (!ensureTextAssistant(event.message)) {
    return null;
  }
  if (event.assistantMessageEvent.type === "text_delta") {
    return event.assistantMessageEvent.delta;
  }
  return null;
}

export function shouldOpenAssistantBlock(event: AgentEvent): boolean {
  return event.type === "message_start" && ensureTextAssistant(event.message);
}

export function shouldCloseAssistantBlock(event: AgentEvent): boolean {
  return event.type === "message_end" && ensureTextAssistant(event.message);
}

export function getStarterWorkspaceFile(): { path: string; content: string } {
  return {
    path: "/README.md",
    content: `# just-pi workspace

This workspace lives in the browser's Origin Private File System (OPFS).

Try:

- \`ls\`
- \`cat README.md\`
- asking the agent to create a small project
`,
  };
}
