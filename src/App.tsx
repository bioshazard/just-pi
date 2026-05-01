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
import { useHashLocation } from "wouter/use-hash-location";
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
  shellCwd: "just-pi.shell-cwd",
} as const;

type StatusTone = "idle" | "busy" | "error";
type AppRoute = "/setup" | "/drive" | "/review" | "/files";
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

const APP_ROUTES = ["/setup", "/drive", "/review", "/files"] as const satisfies readonly AppRoute[];
const DEFAULT_TERMINAL_TEXT = "just-pi ready.\n";
const DEFAULT_ACTIVITY_TEXT = "Tool stream ready.\n";

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

function isAppRoute(path: string): path is AppRoute {
  return APP_ROUTES.includes(path as AppRoute);
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
  const [route, setRoute] = useHashLocation();

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
  const [isSetupExpanded, setIsSetupExpanded] = useState(() => savedApiKeyInitial.trim().length === 0);
  const [pendingDriveText, setPendingDriveText] = useState<string>();

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

  const hasSavedApiKey = savedApiKey.trim().length > 0;
  const defaultRoute: AppRoute = hasSavedApiKey ? "/drive" : "/setup";
  const currentRoute: AppRoute = isAppRoute(route) ? route : defaultRoute;

  useEffect(() => {
    if (route !== currentRoute) {
      setRoute(currentRoute);
    }
  }, [currentRoute, route, setRoute]);

  const navigate = useCallback(
    (nextRoute: AppRoute) => {
      setRoute(nextRoute);
    },
    [setRoute],
  );

  const focusPromptInput = useCallback(() => {
    commandBarRef.current?.focus();
  }, []);

  useEffect(() => {
    if (currentRoute !== "/drive" || !pendingDriveText) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      commandBarRef.current?.setText(pendingDriveText);
      commandBarRef.current?.focus();
      setPendingDriveText(undefined);
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [currentRoute, pendingDriveText]);

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
      navigate("/files");
      await loadWorkspaceFile(path);
    },
    [loadWorkspaceFile, navigate],
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
            navigate("/review");
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
    [appendActivity, getOrCreateAgent, getShell, navigate, refreshWorkspaceTree, setStatus],
  );

  const saveSettings = useCallback(async () => {
    const nextApiKey = apiKeyInput.trim();
    const nextModelId = modelIdInput.trim() || getDefaultModelId();
    localStorage.setItem(STORAGE_KEYS.apiKey, nextApiKey);
    localStorage.setItem(STORAGE_KEYS.modelId, nextModelId);
    setSavedApiKey(nextApiKey);
    setSavedModelId(nextModelId);
    setIsSetupExpanded(nextApiKey.length === 0);

    if (agentRef.current) {
      const shell = await getShell();
      const { updateAgentConfiguration } = await import("./agent-session");
      await updateAgentConfiguration(agentRef.current, nextModelId, shell);
    }

    appendTerminal("\n[settings] saved OpenRouter credentials and model selection.\n");
    navigate(nextApiKey ? "/drive" : "/setup");
    if (nextApiKey) {
      window.requestAnimationFrame(() => {
        focusPromptInput();
      });
    }
  }, [apiKeyInput, appendTerminal, focusPromptInput, getShell, modelIdInput, navigate]);

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
    navigate("/setup");
  }, [addReviewNotice, appendActivity, navigate, setStatus]);

  const handleMissingShellCommand = useCallback(() => {
    appendTerminal("\n[error] Enter a shell command after !.\n");
    setStatus("Missing command", "error");
  }, [appendTerminal, setStatus]);

  const handleBeforeAgentSubmit = useCallback(
    (prompt: string) => {
      navigate("/review");
      appendActivity(`\nuser> ${prompt}\n`);
    },
    [appendActivity, navigate],
  );

  const handleShellSubmit = useCallback(
    async (command: string) => {
      navigate("/review");
      await runManualShell(command);
    },
    [navigate, runManualShell],
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
        current || DEFAULT_TERMINAL_TEXT,
      );
      setActivityText((current) => current || DEFAULT_ACTIVITY_TEXT);

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

  const setupCopy = hasSavedApiKey
    ? "Key and model stay in this browser."
    : "Save a key to unlock agent prompts. Shell commands already work.";
  const appDataState = hasSavedApiKey ? "ready" : "setup";
  const hasShellTrace = terminalText.trim() !== DEFAULT_TERMINAL_TEXT.trim();
  const hasToolTrace = activityText.trim() !== DEFAULT_ACTIVITY_TEXT.trim();

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
      <div className="app" id="app" data-route={currentRoute}>
        <header className="hero">
          <div className="brand-lockup">
            <h1>just-pi</h1>
            <p className="hero-copy">Browser-native coding cockpit.</p>
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

        <nav className="surface-nav" aria-label="Primary surfaces">
          {([
            ["/setup", "Setup"],
            ["/drive", "Drive"],
            ["/review", "Review"],
            ["/files", "Files"],
          ] as const).map(([path, label]) => (
            <button
              key={path}
              type="button"
              className={`surface-link${currentRoute === path ? " is-active" : ""}`}
              data-route-target={path}
              aria-pressed={currentRoute === path}
              onClick={() => {
                navigate(path);
                if (path === "/drive") {
                  window.requestAnimationFrame(() => {
                    focusPromptInput();
                  });
                }
              }}
            >
              {label}
            </button>
          ))}
        </nav>

        <main className="route-shell" data-route={currentRoute}>
          {currentRoute === "/setup" ? (
            <section className="panel controls" data-state={appDataState} data-expanded={isSetupExpanded ? "true" : "false"}>
              <div className="panel-header surface-header controls-header">
                <div>
                  <h2>Setup</h2>
                  <p className="panel-copy">{setupCopy}</p>
                </div>
                {hasSavedApiKey ? (
                  <button
                    id="toggle-setup"
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setIsSetupExpanded((current) => !current);
                    }}
                  >
                    {isSetupExpanded ? "Hide setup" : "Edit setup"}
                  </button>
                ) : null}
              </div>

              {hasSavedApiKey && !isSetupExpanded ? (
                <p className="setup-summary">Drive from the prompt lane. Review records prompts, tools, and shell output.</p>
              ) : (
                <>
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
                    <button id="clear-transcript" type="button" className="secondary-button" onClick={clearTranscript}>
                      Clear transcript
                    </button>
                    <button id="reset-workspace" type="button" className="secondary-button" onClick={() => void resetWorkspace()}>
                      Reset workspace
                    </button>
                    <button id="refresh-workspace" type="button" className="secondary-button" onClick={() => void refreshWorkspaceTree()}>
                      Refresh files
                    </button>
                  </div>

                  {hasSavedApiKey ? (
                    <p className="setup-summary">Drive from the prompt lane. Review records prompts, tools, and shell output.</p>
                  ) : (
                    <section id="onboarding-panel" className="onboarding-panel" data-state={appDataState}>
                      <div>
                        <h3 id="onboarding-title">Quick start</h3>
                        <p id="onboarding-text" className="panel-copy">
                          Save a key for agent prompts, or start now with <code>!</code> in Drive.
                        </p>
                      </div>
                      <div className="button-row onboarding-actions">
                        {QUICK_ACTIONS.map((action) => (
                          <button
                            key={action.label}
                            type="button"
                            className="secondary-button"
                            onClick={() => {
                              navigate("/drive");
                              setPendingDriveText(action.value);
                            }}
                          >
                            {action.label}
                          </button>
                        ))}
                      </div>
                    </section>
                  )}
                </>
              )}
            </section>
          ) : null}

          {currentRoute === "/drive" ? (
            <section className="route-drive">
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
          ) : null}

          {currentRoute === "/review" ? (
            <section className="panel console-panel">
              <div className="panel-header surface-header">
                <div>
                  <h2>Review</h2>
                  <p className="panel-copy">Transcript first; raw traces stay collapsed.</p>
                </div>
              </div>

              <div className="review-stack">
                <AssistantReviewPane
                  storageKey={STORAGE_KEYS.assistantThread}
                  reviewLogId="review-log"
                  viewportRef={reviewLogRef}
                  supplementalCount={reviewEntries.length}
                  emptyState={
                    <div className="review-empty-state">
                      <p className="review-empty-title">{hasSavedApiKey ? "Drive to begin." : "Review is waiting on Drive."}</p>
                      <p className="review-empty-copy">
                        {hasSavedApiKey ? (
                          <>Review records prompts, tools, and shell output.</>
                        ) : (
                          <>Shell commands already land here. Save a key to add agent prompts.</>
                        )}
                      </p>
                    </div>
                  }
                  supplementalEntries={reviewEntries.map((entry) => (
                    <ReviewEntryView key={entry.id} entry={entry} />
                  ))}
                />

                {hasShellTrace || hasToolTrace ? (
                  <section className="review-traces" aria-label="Raw traces">
                    {hasShellTrace ? (
                      <details className="review-trace">
                        <summary className="review-trace-summary">Shell trace</summary>
                        <pre ref={terminalRef} id="terminal" className="terminal" aria-live="polite">
                          {terminalText}
                        </pre>
                      </details>
                    ) : null}
                    {hasToolTrace ? (
                      <details className="review-trace">
                        <summary className="review-trace-summary">Tool trace</summary>
                        <pre ref={activityRef} id="activity-log" className="terminal activity-log" aria-live="polite">
                          {activityText}
                        </pre>
                      </details>
                    ) : null}
                  </section>
                ) : null}
              </div>
            </section>
          ) : null}

          {currentRoute === "/files" ? (
            <aside className="panel workspace-panel">
              <div className="panel-header surface-header">
                <div>
                  <h2>Files</h2>
                  <p className="panel-copy">Working set in OPFS.</p>
                </div>
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
                      <h3 id="file-title">{activeFilePath ? `${basename(activeFilePath)}${fileEditorDirty ? " *" : ""}` : "Working set"}</h3>
                      <p id="file-subtitle" className="file-subtitle">
                        {activeFilePath ? activeFilePath : "Open a file to inspect or edit the working set."}
                      </p>
                    </div>

                    <div className="button-row file-actions">
                      <button
                        id="file-reload"
                        type="button"
                        className="secondary-button"
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
                    placeholder="Open a file from the working set to inspect or edit it."
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
          ) : null}
        </main>
      </div>
    </AssistantRuntimeScope>
  );
}
