import {
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useMessagePartFile,
  type ThreadMessageLike,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { useEffect, type ReactNode, type Ref } from "react";

interface AssistantReviewPaneProps {
  storageKey: string;
  reviewLogId: string;
  supplementalCount: number;
  supplementalEntries: ReactNode;
  emptyState: ReactNode;
  viewportRef?: Ref<HTMLDivElement>;
}

export function readStoredAssistantMessages(storageKey: string): readonly ThreadMessageLike[] {
  const raw = localStorage.getItem(storageKey);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? (parsed as Array<ThreadMessageLike & { createdAt?: string | Date }>).map((message) => ({
          ...message,
          createdAt:
            typeof message.createdAt === "string" ? new Date(message.createdAt) : message.createdAt,
        }))
      : [];
  } catch {
    return [];
  }
}

function formatToolValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function AssistantToolPart({ toolName, argsText, result, isError, status }: ToolCallMessagePartProps) {
  const toolStatus = isError ? "error" : status.type === "running" ? "running" : result === undefined ? "queued" : "complete";

  return (
    <section className="assistant-tool-card" data-status={toolStatus}>
      <div className="assistant-tool-header">
        <span className="assistant-tool-name">{toolName}</span>
        <span className="assistant-tool-status" data-status={toolStatus}>
          {toolStatus}
        </span>
      </div>
      <div className="assistant-tool-section">
        <span className="assistant-tool-label">args</span>
        <pre className="assistant-tool-body">{argsText}</pre>
      </div>
      {result !== undefined ? (
        <div className="assistant-tool-section">
          <span className="assistant-tool-label">{isError ? "error" : "result"}</span>
          <pre className="assistant-tool-body">{formatToolValue(result)}</pre>
        </div>
      ) : null}
    </section>
  );
}

function AssistantFilePart() {
  const file = useMessagePartFile();

  return (
    <div className="assistant-file-part">
      <span className="assistant-file-name">{file.filename || "attachment"}</span>
      <span className="assistant-file-meta">{file.mimeType || "file"}</span>
    </div>
  );
}

function AssistantReviewStreaming() {
  const isRunning = useAuiState((state) => state.thread.isRunning);

  if (!isRunning) {
    return null;
  }

  return (
    <div className="review-entry review-entry-assistant review-entry-streaming" aria-live="polite">
      <div className="review-entry-meta">Assistant</div>
      <div className="review-bubble assistant-review-bubble assistant-review-streaming">
        <span className="assistant-review-streaming-dot" aria-hidden="true" />
        Streaming response...
      </div>
    </div>
  );
}

function AssistantReviewMessage() {
  const role = useAuiState((state) => state.message.role);
  const label = role === "user" ? "You" : role === "assistant" ? "Assistant" : "System";
  const messageError = useAuiState((state) =>
    state.message.status?.type === "incomplete" && state.message.status.reason === "error"
      ? String(state.message.status.error ?? "Response failed.")
      : undefined,
  );

  return (
    <MessagePrimitive.Root className={`review-entry review-entry-${role === "user" ? "user" : "assistant"}`}>
      <div className="review-entry-meta">{label}</div>
      <div className="review-bubble assistant-review-bubble">
        <MessagePrimitive.Parts
          components={{
            Text: () => <MessagePartPrimitive.Text component="span" smooth />,
            File: AssistantFilePart,
            tools: {
              Fallback: AssistantToolPart,
            },
          }}
        />
      </div>
      {messageError ? <div className="assistant-review-error">{messageError}</div> : null}
    </MessagePrimitive.Root>
  );
}

export function AssistantReviewPane({
  storageKey,
  reviewLogId,
  supplementalCount,
  supplementalEntries,
  emptyState,
  viewportRef,
}: AssistantReviewPaneProps) {
  const messages = useAuiState((state) => state.thread.messages);

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(messages));
  }, [messages, storageKey]);

  return (
    <ThreadPrimitive.Root className="assistant-review-root">
      <ThreadPrimitive.Viewport
        id={reviewLogId}
        ref={viewportRef}
        className="review-log assistant-review-log"
        autoScroll
      >
        {messages.length === 0 && supplementalCount === 0 ? emptyState : null}
        <ThreadPrimitive.Messages>{() => <AssistantReviewMessage />}</ThreadPrimitive.Messages>
        <AssistantReviewStreaming />
        {supplementalEntries}
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}
