import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Model, TextContent } from "@mariozechner/pi-ai";
import { Static, Type } from "typebox";

import { OpfsWorkspace, basename, dirname, normalizePath } from "./opfs";
import { ShellRuntime } from "./shell";
import { getDefaultModelId, restoreMessages } from "./agent-session-ui";

function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text", text }] satisfies TextContent[],
    details,
  };
}

function lineNumberedSlice(content: string, offset = 0, limit?: number): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const start = Math.max(0, offset);
  const end = typeof limit === "number" ? Math.min(lines.length, start + limit) : lines.length;
  const body = lines
    .slice(start, end)
    .map((line, index) => `${start + index + 1}. ${line}`)
    .join("\n");
  const truncated = end < lines.length ? `\n... (${lines.length - end} more lines)` : "";
  return `${body}${truncated}`.trimEnd();
}

function applyEdits(content: string, edits: Array<{ oldText: string; newText: string }>): string {
  let next = content;
  for (const edit of edits) {
    const index = next.indexOf(edit.oldText);
    if (index === -1) {
      throw new Error(`Could not find text to replace: ${edit.oldText}`);
    }
    next = `${next.slice(0, index)}${edit.newText}${next.slice(index + edit.oldText.length)}`;
  }
  return next;
}

async function readAgentsInstructions(workspace: OpfsWorkspace, cwd: string): Promise<string[]> {
  const instructionPaths: string[] = [];
  let current = normalizePath(cwd);
  while (true) {
    const candidate = current === "/" ? "/AGENTS.md" : normalizePath(`${current}/AGENTS.md`);
    instructionPaths.push(candidate);
    if (current === "/") {
      break;
    }
    current = dirname(current);
  }

  const sections: string[] = [];
  for (const path of instructionPaths.reverse()) {
    if (!(await workspace.exists(path))) {
      continue;
    }
    const content = (await workspace.readText(path)).trim();
    if (!content) {
      continue;
    }
    sections.push(`Instructions from ${path}:\n${content}`);
  }
  return sections;
}

async function buildSystemPrompt(workspace: OpfsWorkspace, cwd: string): Promise<string> {
  const basePrompt = [
    "You are Browser-Native Systems Engineer.",
    "You are running inside a browser-hosted coding workspace backed by the Origin Private File System (OPFS).",
    "All file reads, writes, searches, and bash commands operate on the same persistent workspace.",
    `Current working directory: ${cwd}`,
    "Use tools instead of guessing file contents. Keep responses concise and implementation-focused.",
  ].join("\n");
  const agentsInstructions = await readAgentsInstructions(workspace, cwd);
  if (agentsInstructions.length === 0) {
    return basePrompt;
  }
  return [basePrompt, ...agentsInstructions].join("\n\n");
}

export interface BrowserAgentSessionOptions {
  workspace: OpfsWorkspace;
  shell: ShellRuntime;
  readApiKey: () => string;
  readModelId: () => string;
}

function createAgentTools(workspace: OpfsWorkspace, shell: ShellRuntime): AgentTool[] {
  const cwd = () => shell.getCwd();

  const readSchema = Type.Object({
    path: Type.String(),
    offset: Type.Optional(Type.Number()),
    limit: Type.Optional(Type.Number()),
  });
  type ReadInput = Static<typeof readSchema>;

  const readTool: AgentTool<typeof readSchema> = {
    name: "read",
    label: "read",
    description: "Read a UTF-8 text file from the persistent OPFS workspace.",
    parameters: readSchema,
    execute: async (_toolCallId, args: ReadInput) => {
      const path = normalizePath(args.path, cwd());
      return textResult(lineNumberedSlice(await workspace.readText(path), args.offset, args.limit), { path });
    },
  };

  const writeSchema = Type.Object({
    path: Type.String(),
    content: Type.String(),
  });
  type WriteInput = Static<typeof writeSchema>;

  const writeTool: AgentTool<typeof writeSchema> = {
    name: "write",
    label: "write",
    description: "Write or overwrite a UTF-8 text file inside the persistent OPFS workspace.",
    parameters: writeSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, args: WriteInput) => {
      const path = normalizePath(args.path, cwd());
      await workspace.mkdir(dirname(path), { recursive: true });
      await workspace.writeFile(path, args.content);
      return textResult(`Wrote ${path}`, { path });
    },
  };

  const editSchema = Type.Object({
    path: Type.String(),
    edits: Type.Array(
      Type.Object({
        oldText: Type.String(),
        newText: Type.String(),
      }),
    ),
  });
  type EditInput = Static<typeof editSchema>;

  const editTool: AgentTool<typeof editSchema> = {
    name: "edit",
    label: "edit",
    description: "Apply exact text replacements to an existing workspace file.",
    parameters: editSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, args: EditInput) => {
      const path = normalizePath(args.path, cwd());
      const current = await workspace.readText(path);
      const next = applyEdits(current, args.edits);
      await workspace.writeFile(path, next);
      return textResult(`Edited ${path}`, { path, edits: args.edits.length });
    },
  };

  const lsSchema = Type.Object({
    path: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Number()),
  });
  type LsInput = Static<typeof lsSchema>;

  const lsTool: AgentTool<typeof lsSchema> = {
    name: "ls",
    label: "ls",
    description: "List files and directories in the current OPFS workspace.",
    parameters: lsSchema,
    execute: async (_toolCallId, args: LsInput) => {
      const path = normalizePath(args.path ?? cwd(), cwd());
      const stat = await workspace.stat(path);
      if (stat.isFile) {
        return textResult(path, { path });
      }
      const entries = await workspace.readdirWithFileTypes(path);
      const limited = entries.slice(0, args.limit ?? 200);
      const lines = limited.map((entry) => `${entry.isDirectory ? "dir " : "file"} ${entry.name}`);
      if (limited.length < entries.length) {
        lines.push(`... (${entries.length - limited.length} more entries)`);
      }
      return textResult(lines.join("\n"), { path });
    },
  };

  const findSchema = Type.Object({
    pattern: Type.String(),
    path: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Number()),
  });
  type FindInput = Static<typeof findSchema>;

  const findTool: AgentTool<typeof findSchema> = {
    name: "find",
    label: "find",
    description: "Find workspace paths that match a glob-style pattern.",
    parameters: findSchema,
    execute: async (_toolCallId, args: FindInput) => {
      const basePath = normalizePath(args.path ?? cwd(), cwd());
      const results = await workspace.findPaths(args.pattern, basePath, args.limit ?? 200);
      return textResult(results.join("\n"), { matches: results.length, path: basePath });
    },
  };

  const grepSchema = Type.Object({
    pattern: Type.String(),
    path: Type.Optional(Type.String()),
    glob: Type.Optional(Type.String()),
    ignoreCase: Type.Optional(Type.Boolean()),
    literal: Type.Optional(Type.Boolean()),
    context: Type.Optional(Type.Number()),
    limit: Type.Optional(Type.Number()),
  });
  type GrepInput = Static<typeof grepSchema>;

  const grepTool: AgentTool<typeof grepSchema> = {
    name: "grep",
    label: "grep",
    description: "Search text across workspace files with optional glob filtering.",
    parameters: grepSchema,
    execute: async (_toolCallId, args: GrepInput) => {
      const output = await workspace.grep({
        pattern: args.pattern,
        path: args.path ? normalizePath(args.path, cwd()) : cwd(),
        glob: args.glob,
        ignoreCase: args.ignoreCase,
        literal: args.literal,
        context: args.context,
        limit: args.limit,
      });
      return textResult(output || "(no matches)", { hasMatches: output.length > 0 });
    },
  };

  const bashSchema = Type.Object({
    command: Type.String(),
    timeout: Type.Optional(Type.Number()),
  });
  type BashInput = Static<typeof bashSchema>;

  const bashTool: AgentTool<typeof bashSchema> = {
    name: "bash",
    label: "bash",
    description: "Run a bash command through just-bash against the same persistent workspace.",
    parameters: bashSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, args: BashInput, signal, onUpdate) => {
      onUpdate?.(textResult(`$ ${args.command}\n`, { phase: "starting" }));
      const result = await shell.execute(args.command, {
        timeoutMs: args.timeout,
        signal,
      });
      const output = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? "\n" : "");
      if (result.exitCode !== 0) {
        throw new Error(output || `Command exited with code ${result.exitCode}`);
      }
      return textResult(output || "(no output)", { exitCode: result.exitCode, cwd: shell.getCwd() });
    },
  };

  return [readTool, writeTool, editTool, lsTool, findTool, grepTool, bashTool];
}

async function loadPiAi() {
  return import("@mariozechner/pi-ai");
}

async function findOpenRouterModel(modelId: string): Promise<Model<string>> {
  const { getModels } = await loadPiAi();
  const models = getModels("openrouter") as Model<string>[];
  const preferredId = modelId.trim() || getDefaultModelId();
  return models.find((candidate) => candidate.id === preferredId) ?? models[0] ?? ({ id: getDefaultModelId() } as Model<string>);
}

export async function listOpenRouterModels(): Promise<string[]> {
  const { getModels } = await loadPiAi();
  const ids = getModels("openrouter").map((model) => model.id);
  return ids.length > 0 ? ids : [getDefaultModelId()];
}

export async function createBrowserAgentSession(options: BrowserAgentSessionOptions): Promise<Agent> {
  const model = await findOpenRouterModel(options.readModelId());
  if (!model) {
    throw new Error("No OpenRouter models available from pi-ai.");
  }

  const { streamSimple } = await loadPiAi();
  const systemPrompt = await buildSystemPrompt(options.workspace, options.shell.getCwd());

  const agent = new Agent({
    initialState: {
      model,
      thinkingLevel: model.reasoning ? "medium" : "off",
      systemPrompt,
      tools: createAgentTools(options.workspace, options.shell),
    },
    toolExecution: "parallel",
    streamFn: (currentModel, context, streamOptions) => {
      return streamSimple(currentModel, context, {
        ...streamOptions,
        apiKey: options.readApiKey().trim(),
        headers: {
          ...(streamOptions?.headers ?? {}),
          "HTTP-Referer": window.location.origin,
          "X-OpenRouter-Title": "just-pi",
        },
      });
    },
    sessionId: localStorage.getItem("just-pi.session-id") ?? crypto.randomUUID(),
  });

  localStorage.setItem("just-pi.session-id", agent.sessionId ?? crypto.randomUUID());
  agent.state.messages = restoreMessages();

  return agent;
}

export async function updateAgentConfiguration(agent: Agent, modelId: string, shell: ShellRuntime, workspace: OpfsWorkspace): Promise<void> {
  const model = await findOpenRouterModel(modelId);
  if (!model) {
    return;
  }
  agent.state.model = model;
  agent.state.thinkingLevel = model.reasoning ? "medium" : "off";
  agent.state.systemPrompt = await buildSystemPrompt(workspace, shell.getCwd());
}
