import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Agent, AgentEvent } from "@mariozechner/pi-agent-core";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type ChatModelAdapter,
  type ChatModelRunResult,
  type LocalRuntimeOptions,
  type ThreadMessage,
} from "@assistant-ui/react";
import type { ShellRuntime } from "./shell";

import { AssistantCommandBar, type AssistantCommandBarHandle } from "./AssistantCommandBar";
import { AssistantReviewPane, readStoredAssistantMessages } from "./AssistantReviewPane";
import { TEXT_ATTACHMENT_ACCEPT, WorkspaceTextAttachmentAdapter } from "./assistant-attachments";
import {
  formatAssistantDelta,
  formatToolEvent,
  getDefaultModelId,
  getStarterWorkspaceFile,
  shouldCloseAssistantBlock,
  shouldOpenAssistantBlock,
} from "./agent-session-ui";
import { OpfsWorkspace, basename, type WorkspaceTreeEntry } from "./opfs";

const STORAGE_KEYS = {
  apiKey: "just-pi.api-key",
  modelId: "just-pi.model-id",
  terminal: "just-pi.terminal",
  activity: "just-pi.activity",
  review: "just-pi.review",
  assistantThread: "just-pi.assistant-thread",
  mobileView: "just-pi.mobile-view",
  shellCwd: "just-pi.shell-cwd",
} as const;

type StatusTone = "idle" | "busy" | "error";
type MobileView = "settings" | "command" | "console" | "workspace";
type ReviewEntry =
  | { id: string; kind: "user" | "assistant"; text: string }
  | { id: string; kind: "shell"; source: "user"; command: string; output: string; exitCode: number | null; pending: boolean }
  | { id: string; kind: "notice"; text: string; tone: "info" | "error" };

interface ReviewEntryViewProps {
  entry: ReviewEntry;
}

interface AssistantRuntimeScopeProps {
  adapter: ChatModelAdapter;
  storageKey: string;
  runtimeOptions?: Omit<LocalRuntimeOptions, "initialMessages">;
  children: ReactNode;
}

type AssistantContentPart = NonNullable<ChatModelRunResult["content"]>[number];

function getLatestUserPrompt(messages: readonly ThreadMessage[]): string {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
  if (!lastUserMessage) {
    return "";
  }
  return lastUserMessage.content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "file") {
        const fileName = part.filename || "attachment";
        return `<attachment name="${fileName}" mime="${part.mimeType}">\n${part.data}\n</attachment>`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function stringifyToolValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function appendAssistantTextPart(parts: readonly AssistantContentPart[], delta: string): AssistantContentPart[] {
  if (!delta) {
    return [...parts];
  }
  const lastPart = parts[parts.length - 1];
  if (lastPart?.type === "text") {
    return [...parts.slice(0, -1), { ...lastPart, text: lastPart.text + delta }];
  }
  return [...parts, { type: "text", text: delta }];
}

function upsertToolCallPart(parts: readonly AssistantContentPart[], event: Extract<AgentEvent, { type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }>): AssistantContentPart[] {
  const existingPart = parts.find((part) => part.type === "tool-call" && part.toolCallId === event.toolCallId);
  const args = "args" in event ? event.args : existingPart?.type === "tool-call" ? existingPart.args : {};
  const nextPart: Extract<AssistantContentPart, { type: "tool-call" }> = {
    type: "tool-call",
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    args,
    argsText: stringifyToolValue(args),
    ...(event.type === "tool_execution_update"
      ? { result: event.partialResult }
      : event.type === "tool_execution_end"
        ? { result: event.result, isError: event.isError }
        : {}),
  };

  const nextParts = [...parts];
  const existingIndex = nextParts.findIndex((part) => part.type === "tool-call" && part.toolCallId === nextPart.toolCallId);
  if (existingIndex === -1) {
    nextParts.push(nextPart);
  } else {
    nextParts[existingIndex] = nextPart;
  }
  return nextParts;
}

const QUICK_ACTIONS = [
  { label: "Try !ls", value: "!ls" },
  { label: "Summarize workspace", value: "Summarize the current workspace and explain what I can do here." },
  { label: "Scaffold starter project", value: "Create a tiny HTML, CSS, and JavaScript starter project in this workspace." },
] as const;

function readStorageText(key: string, fallback = ""): string {
  return localStorage.getItem(key) ?? fallback;
}

function readStorageJson<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  if (!raw) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed as T;
  } catch {
    return fallback;
  }
}

function readSupplementalReviewEntries(): ReviewEntry[] {
  return readStorageJson<ReviewEntry[]>(STORAGE_KEYS.review, []).filter(
    (entry) => entry.kind === "shell" || entry.kind === "notice",
  );
}

function isGitHubPagesHost(): boolean {
  return window.location.hostname.endsWith(".github.io");
}

function isMobileViewport(): boolean {
  return window.matchMedia("(max-width: 980px)").matches;
}

function readInitialMobileView(savedApiKey: string): MobileView {
  const stored = localStorage.getItem(STORAGE_KEYS.mobileView);
  if (stored === "settings" || stored === "command" || stored === "console" || stored === "workspace") {
    return stored;
  }
  return savedApiKey.trim().length > 0 ? "command" : "settings";
}

function ReviewEntryView({ entry }: ReviewEntryViewProps) {
  return (
    <article
      className={`review-entry review-entry-${entry.kind}`}
      data-tone={entry.kind === "notice" ? entry.tone : undefined}
    >
      {entry.kind === "user" || entry.kind === "assistant" ? (
        <>
          <div className="review-entry-meta">{entry.kind === "user" ? "You" : "Assistant"}</div>
          <div className="review-bubble">{entry.text || (entry.kind === "assistant" ? "..." : "")}</div>
        </>
      ) : null}

      {entry.kind === "shell" ? (
        <>
          <div className="review-entry-meta">Command</div>
          <pre className="review-shell-command">{`$ ${entry.command}`}</pre>
          <pre className="review-shell-output">
            {entry.pending ? entry.output || "(running...)" : entry.output || "(no output)"}
          </pre>
          {entry.exitCode !== null && entry.exitCode !== 0 ? <span className="review-status">{`exit ${entry.exitCode}`}</span> : null}
        </>
      ) : null}

      {entry.kind === "notice" ? (
        <>
          <div className="review-entry-meta">{entry.tone === "error" ? "Error" : "Notice"}</div>
          <div className="review-bubble">{entry.text}</div>
        </>
      ) : null}
    </article>
  );
}

function AssistantRuntimeScope({ adapter, storageKey, runtimeOptions, children }: AssistantRuntimeScopeProps) {
  const initialMessages = useMemo(() => readStoredAssistantMessages(storageKey), [storageKey]);
  const runtime = useLocalRuntime(adapter, { initialMessages, ...runtimeOptions });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

export function App() {
  const savedApiKeyInitial = readStorageText(STORAGE_KEYS.apiKey);
  const savedModelInitial = readStorageText(STORAGE_KEYS.modelId, getDefaultModelId());
  const savedCwdInitial = readStorageText(STORAGE_KEYS.shellCwd, "/");

  const workspace = useMemo(() => new OpfsWorkspace(), []);

  const agentRef = useRef<Agent | undefined>(undefined);
  const savedApiKeyRef = useRef(savedApiKeyInitial);
  const savedModelIdRef = useRef(savedModelInitial);
  const activeFilePathRef = useRef<string | undefined>(undefined);
  const fileEditorDirtyRef = useRef(false);
  const agentLoadPromiseRef = useRef<Promise<Agent> | undefined>(undefined);
  const modelOptionsLoadRef = useRef<Promise<string[]> | undefined>(undefined);
  const shellLoadPromiseRef = useRef<Promise<ShellRuntime> | undefined>(undefined);
  const shellRef = useRef<ShellRuntime | undefined>(undefined);
  const isMountedRef = useRef(true);
  const commandBarRef = useRef<AssistantCommandBarHandle>(null);
  const terminalRef = useRef<HTMLPreElement>(null);
  const activityRef = useRef<HTMLPreElement>(null);
  const reviewLogRef = useRef<HTMLDivElement>(null);

  const [savedApiKey, setSavedApiKey] = useState(savedApiKeyInitial);
  const [savedModelId, setSavedModelId] = useState(savedModelInitial);
  const [modelOptions, setModelOptions] = useState<string[]>(() =>
    Array.from(new Set([getDefaultModelId(), savedModelInitial].filter(Boolean))),
  );
  const [apiKeyInput, setApiKeyInput] = useState(savedApiKeyInitial);
  const [modelIdInput, setModelIdInput] = useState(savedModelInitial);
  const [terminalText, setTerminalText] = useState(() => readStorageText(STORAGE_KEYS.terminal));
  const [activityText, setActivityText] = useState(() => readStorageText(STORAGE_KEYS.activity));
  const [reviewEntries, setReviewEntries] = useState<ReviewEntry[]>(() => readSupplementalReviewEntries());
  const [mobileView, setMobileViewState] = useState<MobileView>(() => readInitialMobileView(savedApiKeyInitial));
  const [statusLabel, setStatusLabel] = useState("Idle");
  const [statusTone, setStatusTone] = useState<StatusTone>("idle");
  const [cwd, setCwd] = useState(savedCwdInitial);
  const [isBusy, setIsBusy] = useState(false);
  const [assistantThreadKey, setAssistantThreadKey] = useState(0);
  const [workspaceEntries, setWorkspaceEntries] = useState<WorkspaceTreeEntry[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string>();
  const [fileEditorContent, setFileEditorContent] = useState("");
  const [fileEditorDirty, setFileEditorDirty] = useState(false);
  const [isReady, setIsReady] = useState(false);

  const suggestionAdapter = useMemo(
    () => ({
      async generate({ messages }: { messages: readonly ThreadMessage[] }) {
        const lastMessage = [...messages].reverse().find((message) => message.role !== "system");
        if (!lastMessage) {
          return QUICK_ACTIONS.map((action) => ({ prompt: action.value }));
        }
        if (lastMessage.role === "assistant") {
          return [
            { prompt: "Apply that in the workspace." },
            { prompt: "Explain which files matter most." },
            { prompt: "What should I do next?" },
          ];
        }
        return [
          { prompt: "Continue." },
          { prompt: "Be more concrete." },
          { prompt: "Summarize the workspace and explain what I can do here." },
        ];
      },
    }),
    [],
  );

  const attachmentAdapter = useMemo(() => new WorkspaceTextAttachmentAdapter(), []);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    savedApiKeyRef.current = savedApiKey;
  }, [savedApiKey]);

  useEffect(() => {
    savedModelIdRef.current = savedModelId;
  }, [savedModelId]);

  useEffect(() => {
    activeFilePathRef.current = activeFilePath;
  }, [activeFilePath]);

  useEffect(() => {
    fileEditorDirtyRef.current = fileEditorDirty;
  }, [fileEditorDirty]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.terminal, terminalText);
  }, [terminalText]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.activity, activityText);
  }, [activityText]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.review, JSON.stringify(reviewEntries));
  }, [reviewEntries]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.mobileView, mobileView);
  }, [mobileView]);

  useEffect(() => {
    terminalRef.current?.scrollTo({ top: terminalRef.current.scrollHeight });
  }, [terminalText]);

  useEffect(() => {
    activityRef.current?.scrollTo({ top: activityRef.current.scrollHeight });
  }, [activityText]);

  useEffect(() => {
    reviewLogRef.current?.scrollTo({ top: reviewLogRef.current.scrollHeight });
  }, [reviewEntries]);

  const readCwd = useCallback(() => shellRef.current?.getCwd() ?? readStorageText(STORAGE_KEYS.shellCwd, "/"), []);

  const setStatus = useCallback(
    (label: string, tone: StatusTone = "idle") => {
      setStatusLabel(label);
      setStatusTone(tone);
      setCwd(readCwd());
    },
    [readCwd],
  );

  const setMobileView = useCallback((view: MobileView) => {
    setMobileViewState(view);
  }, []);

  const focusPromptInput = useCallback(() => {
    commandBarRef.current?.focus();
  }, []);

  const appendTerminal = useCallback((text: string) => {
    setTerminalText((current) => current + text);
  }, []);

  const resetTerminal = useCallback((text = "") => {
    setTerminalText(text);
  }, []);

  const appendActivity = useCallback((text: string) => {
    setActivityText((current) => current + text);
  }, []);

  const resetActivity = useCallback((text = "") => {
    setActivityText(text);
  }, []);

  const addReviewEntry = useCallback((entry: ReviewEntry): string => {
    setReviewEntries((current) => [...current, entry]);
    return entry.id;
  }, []);

  const addReviewNotice = useCallback(
    (text: string, tone: "info" | "error" = "info") =>
      addReviewEntry({
        id: crypto.randomUUID(),
        kind: "notice",
        text,
        tone,
      }),
    [addReviewEntry],
  );

  const addReviewShell = useCallback(
    (command: string) =>
      addReviewEntry({
        id: crypto.randomUUID(),
        kind: "shell",
        source: "user",
        command,
        output: "",
        exitCode: null,
        pending: true,
      }),
    [addReviewEntry],
  );

  const updateReviewEntry = useCallback((entryId: string, updater: (entry: ReviewEntry) => ReviewEntry) => {
    setReviewEntries((current) => current.map((entry) => (entry.id === entryId ? updater(entry) : entry)));
  }, []);

  const resetReviewEntries = useCallback((entries: ReviewEntry[] = []) => {
    setReviewEntries(entries);
  }, []);

  const ensureStarterWorkspace = useCallback(async () => {
    if ((await workspace.readdir("/")).length > 0) {
      return;
    }
    const starter = getStarterWorkspaceFile();
    await workspace.writeFile(starter.path, starter.content);
  }, [workspace]);

  const loadWorkspaceFile = useCallback(
    async (path: string) => {
      const content = await workspace.readText(path);
      setFileEditorContent(content);
      setActiveFilePath(path);
      setFileEditorDirty(false);
    },
    [workspace],
  );

  const refreshWorkspaceTree = useCallback(async () => {
    const entries = await workspace.listTreeEntries();
    setWorkspaceEntries(entries);
    setCwd(readCwd());

    const filePaths = entries.filter((entry) => entry.kind === "file").map((entry) => entry.path);
    const currentActiveFilePath = activeFilePathRef.current;

    if (currentActiveFilePath && !filePaths.includes(currentActiveFilePath)) {
      setActiveFilePath(undefined);
      setFileEditorContent("");
      setFileEditorDirty(false);
    }

    const nextPath = currentActiveFilePath && filePaths.includes(currentActiveFilePath) ? currentActiveFilePath : filePaths[0];
    if (!nextPath) {
      setActiveFilePath(undefined);
      setFileEditorContent("");
      setFileEditorDirty(false);
      return;
    }

    if (!currentActiveFilePath || !fileEditorDirtyRef.current) {
      await loadWorkspaceFile(nextPath);
    }
  }, [loadWorkspaceFile, readCwd, workspace]);

  const openWorkspaceFile = useCallback(
    async (path: string) => {
      if (fileEditorDirtyRef.current) {
        const shouldDiscard = window.confirm("Discard unsaved file changes?");
        if (!shouldDiscard) {
          return;
        }
      }

      if (isMobileViewport()) {
        setMobileView("workspace");
      }
      await loadWorkspaceFile(path);
    },
    [loadWorkspaceFile, setMobileView],
  );

  const saveActiveFile = useCallback(async () => {
    const path = activeFilePathRef.current;
    if (!path) {
      return;
    }

    await workspace.writeFile(path, fileEditorContent);
    setFileEditorDirty(false);
    appendTerminal(`\n[workspace] saved ${path}\n`);
    await refreshWorkspaceTree();
  }, [appendTerminal, fileEditorContent, refreshWorkspaceTree, workspace]);

  const getShell = useCallback(async () => {
    if (shellRef.current) {
      return shellRef.current;
    }
    if (shellLoadPromiseRef.current) {
      return shellLoadPromiseRef.current;
    }

    shellLoadPromiseRef.current = (async () => {
      const { ShellRuntime } = await import("./shell");
      const shell = new ShellRuntime(workspace, STORAGE_KEYS.shellCwd);
      if (isMountedRef.current) {
        shellRef.current = shell;
        setCwd(shell.getCwd());
      }
      return shell;
    })();

    try {
      return await shellLoadPromiseRef.current;
    } finally {
      shellLoadPromiseRef.current = undefined;
    }
  }, [workspace]);

  const loadModelOptions = useCallback(async () => {
    if (modelOptionsLoadRef.current) {
      return modelOptionsLoadRef.current;
    }

    modelOptionsLoadRef.current = (async () => {
      try {
        const { listOpenRouterModels } = await import("./agent-session");
        const nextOptions = Array.from(new Set([getDefaultModelId(), ...(await listOpenRouterModels())]));
        if (isMountedRef.current) {
          setModelOptions(nextOptions);
        }
        return nextOptions;
      } catch {
        const fallback = [getDefaultModelId()];
        if (isMountedRef.current) {
          setModelOptions(fallback);
        }
        return fallback;
      } finally {
        modelOptionsLoadRef.current = undefined;
      }
    })();

    return modelOptionsLoadRef.current;
  }, []);

  const getOrCreateAgent = useCallback(async () => {
    if (agentRef.current) {
      return agentRef.current;
    }
    if (agentLoadPromiseRef.current) {
      return agentLoadPromiseRef.current;
    }

    agentLoadPromiseRef.current = (async () => {
      const shell = await getShell();
      const { createBrowserAgentSession, updateAgentConfiguration } = await import("./agent-session");
      const agent = await createBrowserAgentSession({
        workspace,
        shell,
        readApiKey: () => savedApiKeyRef.current,
        readModelId: () => savedModelIdRef.current,
      });

      await updateAgentConfiguration(agent, savedModelIdRef.current, shell);
      agent.subscribe(async (event) => {
        if (!isMountedRef.current) {
          return;
        }

        if (event.type === "message_end" || event.type === "agent_end") {
          localStorage.setItem("just-pi.messages", JSON.stringify(agent.state.messages));
        }
      });

      if (!isMountedRef.current) {
        agent.abort();
        throw new Error("Agent initialization was interrupted.");
      }

      agentRef.current = agent;
      return agent;
    })();

    try {
      return await agentLoadPromiseRef.current;
    } finally {
      agentLoadPromiseRef.current = undefined;
    }
  }, [getShell, workspace]);

  const assistantAdapter = useMemo<ChatModelAdapter>(
    () => ({
      async *run({ messages }): AsyncGenerator<ChatModelRunResult, void> {
        const prompt = getLatestUserPrompt(messages);
        if (!prompt) {
          return;
        }

        const agent = await getOrCreateAgent();
        const shell = await getShell();
        const { updateAgentConfiguration } = await import("./agent-session");
        await updateAgentConfiguration(agent, savedModelIdRef.current, shell);

        let assistantText = "";
        let assistantParts: AssistantContentPart[] = [];
        let assistantBlockOpen = false;
        let isDone = false;
        let nextResultResolver: ((result: IteratorResult<ChatModelRunResult>) => void) | null = null;
        const queuedResults: ChatModelRunResult[] = [];
        let failure: Error | null = null;

        const pushResult = (result: ChatModelRunResult) => {
          if (nextResultResolver) {
            nextResultResolver({ value: result, done: false });
            nextResultResolver = null;
            return;
          }
          queuedResults.push(result);
        };

        const pushAssistantState = (status: ChatModelRunResult["status"]) => {
          pushResult({
            status,
            ...(assistantParts.length > 0 ? { content: [...assistantParts] } : {}),
          });
        };

        const finish = () => {
          if (isDone) {
            return;
          }
          isDone = true;
          if (nextResultResolver) {
            nextResultResolver({ value: undefined as never, done: true });
            nextResultResolver = null;
          }
        };

        const readNext = async (): Promise<IteratorResult<ChatModelRunResult>> => {
          if (queuedResults.length > 0) {
            return { value: queuedResults.shift() as ChatModelRunResult, done: false };
          }
          if (isDone) {
            return { value: undefined as never, done: true };
          }
          return new Promise<IteratorResult<ChatModelRunResult>>((resolve) => {
            nextResultResolver = resolve;
          });
        };

        const unsubscribe = agent.subscribe(async (event) => {
          if (event.type === "message_end" || event.type === "agent_end") {
            localStorage.setItem("just-pi.messages", JSON.stringify(agent.state.messages));
          }

          const toolText = formatToolEvent(event);
          if (toolText) {
            appendActivity(toolText);
          }

          if (
            event.type === "tool_execution_start" ||
            event.type === "tool_execution_update" ||
            event.type === "tool_execution_end"
          ) {
            assistantParts = upsertToolCallPart(assistantParts, event);
            pushAssistantState({ type: "running" });
          }

          if (shouldOpenAssistantBlock(event)) {
            assistantBlockOpen = true;
            appendActivity("\nassistant> ");
          }

          const delta = formatAssistantDelta(event);
          if (delta) {
            assistantText += delta;
            assistantParts = appendAssistantTextPart(assistantParts, delta);
            appendActivity(delta);
            pushAssistantState({ type: "running" });
          }

          if (shouldCloseAssistantBlock(event) && assistantBlockOpen) {
            assistantBlockOpen = false;
            appendActivity("\n");
          }

          if (event.type === "agent_start") {
            setStatus("Running", "busy");
            setIsBusy(true);
            if (isMobileViewport()) {
              setMobileView("console");
            }
          }

          if (event.type === "agent_end") {
            setStatus("Idle", "idle");
            setIsBusy(false);
            await refreshWorkspaceTree();
            pushAssistantState({ type: "complete", reason: "stop" });
            finish();
          }
        });

        const promptPromise = agent.prompt(prompt).catch((error) => {
          failure = error instanceof Error ? error : new Error(String(error));
          if (assistantBlockOpen) {
            assistantBlockOpen = false;
            appendActivity("\n");
          }
          setStatus("Agent error", "error");
          setIsBusy(false);
          finish();
        });

        try {
          while (true) {
            const next = await readNext();
            if (next.done) {
              break;
            }
            yield next.value;
          }

          await promptPromise;

          if (failure) {
            throw failure;
          }
        } finally {
          unsubscribe();
        }
      },
    }),
    [appendActivity, getOrCreateAgent, getShell, refreshWorkspaceTree, setMobileView, setStatus],
  );

  const saveSettings = useCallback(async () => {
    const nextApiKey = apiKeyInput.trim();
    const nextModelId = modelIdInput.trim() || getDefaultModelId();
    localStorage.setItem(STORAGE_KEYS.apiKey, nextApiKey);
    localStorage.setItem(STORAGE_KEYS.modelId, nextModelId);
    setSavedApiKey(nextApiKey);
    setSavedModelId(nextModelId);

    if (agentRef.current) {
      const shell = await getShell();
      const { updateAgentConfiguration } = await import("./agent-session");
      await updateAgentConfiguration(agentRef.current, nextModelId, shell);
    }

    appendTerminal("\n[settings] saved OpenRouter credentials and model selection.\n");
    if (isMobileViewport()) {
      setMobileView(nextApiKey ? "command" : "settings");
      if (nextApiKey) {
        focusPromptInput();
      }
    }
  }, [apiKeyInput, appendTerminal, focusPromptInput, getShell, modelIdInput, setMobileView]);

  const runManualShell = useCallback(
    async (command: string) => {
      const shell = await getShell();
      setStatus("Shell", "busy");
      setIsBusy(true);
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
        setIsBusy(false);
      }

      updateReviewEntry(reviewEntryId, (entry) =>
        entry.kind === "shell"
          ? {
              ...entry,
              output: reviewOutput,
              exitCode: reviewExitCode,
              pending: false,
            }
          : entry,
      );
      await refreshWorkspaceTree();
      setStatus("Idle", "idle");
    },
    [addReviewShell, appendTerminal, getShell, refreshWorkspaceTree, setStatus, updateReviewEntry],
  );

  const handleMissingAgentKey = useCallback(() => {
    addReviewNotice("Save an OpenRouter API key before sending a prompt.", "error");
    appendActivity("\n[error] Save an OpenRouter API key before sending a prompt.\n");
    setStatus("Missing API key", "error");
    if (isMobileViewport()) {
      setMobileView("settings");
    }
  }, [addReviewNotice, appendActivity, setMobileView, setStatus]);

  const handleMissingShellCommand = useCallback(() => {
    appendTerminal("\n[error] Enter a shell command after !.\n");
    setStatus("Missing command", "error");
  }, [appendTerminal, setStatus]);

  const handleBeforeAgentSubmit = useCallback(
    (prompt: string) => {
      if (isMobileViewport()) {
        setMobileView("console");
      }
      appendActivity(`\nuser> ${prompt}\n`);
    },
    [appendActivity, setMobileView],
  );

  const handleShellSubmit = useCallback(
    async (command: string) => {
      if (isMobileViewport()) {
        setMobileView("console");
      }
      await runManualShell(command);
    },
    [runManualShell, setMobileView],
  );

  const handleAbortAgent = useCallback(() => {
    agentRef.current?.abort();
    addReviewNotice("Agent abort requested.");
    appendActivity("\n[agent] abort requested.\n");
  }, [addReviewNotice, appendActivity]);

  const handleAttachmentError = useCallback(
    (message: string) => {
      addReviewNotice(message, "error");
      appendActivity(`\n[attachment error] ${message}\n`);
      setStatus("Attachment error", "error");
    },
    [addReviewNotice, appendActivity, setStatus],
  );

  const resetWorkspace = useCallback(async () => {
    const confirmed = window.confirm("Reset the OPFS workspace? This removes all files created in just-pi.");
    if (!confirmed) {
      return;
    }
    await workspace.clear();
    await ensureStarterWorkspace();
    setActiveFilePath(undefined);
    setFileEditorContent("");
    setFileEditorDirty(false);
    appendTerminal("\n[workspace] reset complete.\n");
    await refreshWorkspaceTree();
  }, [appendTerminal, ensureStarterWorkspace, refreshWorkspaceTree, workspace]);

  const clearTranscript = useCallback(() => {
    agentRef.current?.reset();
    localStorage.removeItem("just-pi.messages");
    localStorage.removeItem(STORAGE_KEYS.assistantThread);
    resetTerminal("Transcript cleared.\n");
    resetActivity("Agent activity cleared.\n");
    resetReviewEntries();
    setAssistantThreadKey((current) => current + 1);
    setStatus("Idle", "idle");
  }, [resetActivity, resetReviewEntries, resetTerminal, setStatus]);

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      await workspace.ready();
      await ensureStarterWorkspace();
      if (cancelled) {
        return;
      }

      setTerminalText((current) =>
        current || "just-pi ready. Configure an OpenRouter key, inspect the workspace, then prompt the agent.\n",
      );
      setActivityText((current) => current || "Agent activity will appear here.\n");

      setStatus("Idle", "idle");
      setIsBusy(false);
      await refreshWorkspaceTree();
      if (!cancelled) {
        setIsReady(true);
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
      agentRef.current?.abort();
      agentRef.current = undefined;
    };
  }, [ensureStarterWorkspace, refreshWorkspaceTree, setStatus, workspace]);

  const hasSavedApiKey = savedApiKey.trim().length > 0;
  const onboardingTitle = hasSavedApiKey ? "Ready to build" : "Quick start";
  const onboardingText = hasSavedApiKey
    ? "Agent mode is enabled. Use plain text for the agent, start with ! for shell commands, and remember that files persist in this browser."
      : isGitHubPagesHost()
        ? "This GitHub Pages app runs entirely in your browser. Save an OpenRouter key to unlock agent mode; ! shell commands already work without one."
        : "This app runs entirely in your browser. Save an OpenRouter key to unlock agent mode; ! shell commands already work without one.";
  const appDataState = hasSavedApiKey ? "ready" : "setup";

  return (
    <AssistantRuntimeScope
      key={`${assistantThreadKey}`}
      adapter={assistantAdapter}
      storageKey={STORAGE_KEYS.assistantThread}
      runtimeOptions={{
        adapters: {
          suggestion: suggestionAdapter,
          attachments: attachmentAdapter,
        },
      }}
    >
      <div className="app" id="app" data-mobile-view={mobileView}>
        <header className="hero">
          <div className="brand-lockup">
            <h1>just-pi</h1>
            <p className="hero-copy">Zero-infra AI IDE for Pi agenting, OPFS files, and just-bash.</p>
          </div>
          <div className="hero-side">
            <div className="status-card">
              <span className="status-chip" id="status-chip" data-tone={statusTone}>
                {statusLabel}
              </span>
              <span className="cwd-chip" id="cwd-chip">
                {cwd}
              </span>
            </div>
            <a className="repo-link" href="https://github.com/bioshazard/just-pi" target="_blank" rel="noreferrer">
              GitHub
            </a>
          </div>
        </header>

        <section className="panel controls">
          <div className="control-grid">
            <label className="field">
              <span>OpenRouter API key</span>
              <input
                id="api-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-or-v1-..."
                value={apiKeyInput}
                onChange={(event) => setApiKeyInput(event.target.value)}
              />
              <span className="field-note">Stored only in this browser via localStorage.</span>
            </label>

            <label className="field">
              <span>Model</span>
              <input
                id="model-id"
                type="text"
                list="model-options"
                spellCheck={false}
                placeholder="openrouter/free"
                value={modelIdInput}
                onChange={(event) => setModelIdInput(event.target.value)}
                onFocus={() => {
                  void loadModelOptions();
                }}
              />
              <datalist id="model-options">
                {modelOptions.map((modelId) => (
                  <option key={modelId} value={modelId} />
                ))}
              </datalist>
              <span className="field-note">
                Defaults to <code>openrouter/free</code>.
              </span>
            </label>
          </div>

          <div className="button-row">
            <button id="save-settings" type="button" onClick={() => void saveSettings()}>
              Save settings
            </button>
            <button id="clear-transcript" type="button" onClick={clearTranscript}>
              Clear transcript
            </button>
            <button id="reset-workspace" type="button" onClick={() => void resetWorkspace()}>
              Reset workspace
            </button>
            <button id="refresh-workspace" type="button" onClick={() => void refreshWorkspaceTree()}>
              Refresh workspace
            </button>
          </div>

          <section id="onboarding-panel" className="onboarding-panel" data-state={appDataState}>
            <div>
              <h3 id="onboarding-title">{onboardingTitle}</h3>
              <p id="onboarding-text" className="panel-copy">
                {onboardingText.split("<code>").length > 1 ? null : onboardingText}
                {onboardingText.includes("<code>") ? (
                  <>
                    {onboardingText.split("<code>")[0]}
                    <code>{onboardingText.split("<code>")[1]?.split("</code>")[0] ?? ""}</code>
                    {onboardingText.split("</code>")[1] ?? ""}
                  </>
                ) : null}
              </p>
            </div>
            <div className="button-row onboarding-actions">
              {QUICK_ACTIONS.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setMobileView("command");
                    commandBarRef.current?.setText(action.value);
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </section>
        </section>

        <nav className="mobile-nav" aria-label="Quick view switcher">
          {([
            ["settings", "Setup"],
            ["command", "Drive"],
            ["console", "Review"],
            ["workspace", "Files"],
          ] as const).map(([view, label]) => (
            <button
              key={view}
              type="button"
              className={`mobile-tab${mobileView === view ? " is-active" : ""}`}
              data-mobile-target={view}
              aria-pressed={mobileView === view}
              onClick={() => {
                setMobileView(view);
                if (view === "command") {
                  focusPromptInput();
                }
              }}
            >
              {label}
            </button>
          ))}
        </nav>

        <main className="main-grid">
          <section className="panel console-panel">
            <div className="panel-header">
              <h2>Console</h2>
            </div>

            <div className="console-stack">
              <AssistantReviewPane
                storageKey={STORAGE_KEYS.assistantThread}
                reviewLogId="review-log"
                viewportRef={reviewLogRef}
                supplementalCount={reviewEntries.length}
                emptyState={
                  <div className="review-empty-state">
                    <p className="review-empty-title">{hasSavedApiKey ? "Review is ready." : "Save a key to unlock assistant review."}</p>
                    <p className="review-empty-copy">
                      {hasSavedApiKey ? (
                        <>
                          Plain-text prompts stream through assistant-ui here. Commands that start with <code>!</code> stay inline as command cards.
                        </>
                      ) : (
                        <>
                          Plain-text prompts need an OpenRouter API key first. Commands that start with <code>!</code> already stay inline here as command cards.
                        </>
                      )}
                    </p>
                  </div>
                }
                supplementalEntries={reviewEntries.map((entry) => (
                  <ReviewEntryView key={entry.id} entry={entry} />
                ))}
              />

              <div className="console-grid">
                <section className="console-section console-section-terminal">
                  <div className="console-section-header">
                    <h3>Terminal</h3>
                  </div>
                  <pre ref={terminalRef} id="terminal" className="terminal" aria-live="polite">
                    {terminalText}
                  </pre>
                </section>

                <section className="console-section console-section-activity">
                  <div className="console-section-header">
                    <h3>Agent activity</h3>
                  </div>
                  <pre ref={activityRef} id="activity-log" className="terminal activity-log" aria-live="polite">
                    {activityText}
                  </pre>
                </section>
              </div>
            </div>
          </section>

          <aside className="panel workspace-panel">
            <div className="panel-header">
              <h2>Workspace</h2>
            </div>
            <div className="workspace-browser">
              <div id="workspace-tree" className="workspace-tree" aria-label="Workspace files">
                {workspaceEntries.map((entry) =>
                  entry.kind === "directory" ? (
                    <div
                      key={entry.path}
                      className="workspace-node workspace-node-directory"
                      style={{ ["--depth" as string]: String(entry.depth) }}
                    >
                      {`▾ ${entry.name}`}
                    </div>
                  ) : (
                    <button
                      key={entry.path}
                      type="button"
                      className={`workspace-node${entry.path === activeFilePath ? " is-active" : ""}`}
                      style={{ ["--depth" as string]: String(entry.depth) }}
                      onClick={() => void openWorkspaceFile(entry.path)}
                    >
                      {entry.name}
                    </button>
                  ),
                )}
              </div>

              <section className="file-viewer">
                <div className="file-viewer-header">
                  <div>
                    <h3 id="file-title">{activeFilePath ? `${basename(activeFilePath)}${fileEditorDirty ? " *" : ""}` : "No file selected"}</h3>
                    <p id="file-subtitle" className="file-subtitle">
                      {activeFilePath ? activeFilePath : "Choose a file from the workspace to view or edit it."}
                    </p>
                  </div>

                  <div className="button-row file-actions">
                    <button
                      id="file-reload"
                      type="button"
                      disabled={!activeFilePath}
                      onClick={async () => {
                        if (!activeFilePathRef.current) {
                          return;
                        }
                        if (fileEditorDirtyRef.current) {
                          const shouldDiscard = window.confirm("Reload this file and discard unsaved changes?");
                          if (!shouldDiscard) {
                            return;
                          }
                        }
                        await loadWorkspaceFile(activeFilePathRef.current);
                      }}
                    >
                      Reload file
                    </button>
                    <button id="file-save" type="button" disabled={!activeFilePath || !fileEditorDirty} onClick={() => void saveActiveFile()}>
                      Save file
                    </button>
                  </div>
                </div>

                <textarea
                  id="file-editor"
                  className="file-editor"
                  spellCheck={false}
                  placeholder="Open a file from the workspace to inspect or edit it."
                  disabled={!activeFilePath}
                  value={fileEditorContent}
                  onChange={(event) => {
                    setFileEditorContent(event.target.value);
                    if (activeFilePath) {
                      setFileEditorDirty(true);
                    }
                  }}
                />
              </section>
            </div>
          </aside>
        </main>

        <section className="input-grid">
          <AssistantCommandBar
            ref={commandBarRef}
            isReady={isReady}
            isBusy={isBusy}
            agentEnabled={hasSavedApiKey}
            fallbackSuggestions={QUICK_ACTIONS.map((action) => ({
              label: action.label,
              prompt: action.value,
            }))}
            onRunShell={handleShellSubmit}
            onMissingAgentKey={handleMissingAgentKey}
            onMissingShellCommand={handleMissingShellCommand}
            onBeforeAgentSubmit={handleBeforeAgentSubmit}
            onAbortAgent={handleAbortAgent}
            onAttachmentError={handleAttachmentError}
            attachmentAccept={TEXT_ATTACHMENT_ACCEPT}
          />
        </section>
      </div>
    </AssistantRuntimeScope>
  );
}
