import {
  AssistantRuntimeProvider,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useLocalRuntime,
  type MessageState,
  type ChatModelAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  type ReactNode,
  type Ref,
} from "react";

export interface AssistantReviewPaneHandle {
  sendPrompt(prompt: string): void;
}

interface AssistantReviewPaneProps {
  adapter: ChatModelAdapter;
  storageKey: string;
  reviewLogId: string;
  agentEnabled: boolean;
  supplementalCount: number;
  supplementalEntries: ReactNode;
  emptyState: ReactNode;
  viewportRef?: Ref<HTMLDivElement>;
}

function readStoredMessages(storageKey: string): readonly ThreadMessageLike[] {
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

function getMessageText(message: Pick<MessageState, "content">): string {
  return message.content
    .filter((part): part is Extract<MessageState["content"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function toCountLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function AssistantReviewSummary({
  agentEnabled,
  supplementalCount,
}: Pick<AssistantReviewPaneProps, "agentEnabled" | "supplementalCount">) {
  const messages = useAuiState((state) => state.thread.messages);
  const isRunning = useAuiState((state) => state.thread.isRunning);

  const userCount = messages.filter((message) => message.role === "user").length;
  const assistantCount = messages.filter((message) => message.role === "assistant").length;
  const latestPrompt = [...messages]
    .reverse()
    .find((message) => message.role === "user" && getMessageText(message).length > 0);

  const state = !agentEnabled ? "locked" : isRunning ? "running" : messages.length > 0 ? "active" : "idle";

  const title =
    state === "locked"
      ? "Agent mode is locked."
      : state === "running"
        ? "Assistant is responding."
        : state === "active"
          ? "Assistant conversation is live."
          : "Review is ready.";

  const copy =
    state === "locked"
      ? "Save an OpenRouter API key to turn plain-text prompts into assistant runs. Commands that start with ! still land here as inline command cards."
      : state === "running"
        ? latestPrompt
          ? `Streaming the latest reply to: "${getMessageText(latestPrompt)}"`
          : "Streaming the latest reply now."
        : state === "active"
          ? "Plain-text prompts stay in the assistant thread here, while ! commands keep their separate inline cards."
          : "Plain-text prompts stream through assistant-ui here. Commands that start with ! stay inline as command cards.";

  return (
    <header className="assistant-review-summary" data-state={state}>
      <div className="assistant-review-summary-copy">
        <p className="assistant-review-summary-kicker">assistant-ui review</p>
        <h3 className="assistant-review-summary-title">{title}</h3>
        <p className="assistant-review-summary-text">{copy}</p>
      </div>
      <div className="assistant-review-summary-badges" aria-label="Review activity summary">
        <span className="assistant-review-badge">{toCountLabel(userCount, "prompt")}</span>
        <span className="assistant-review-badge">{toCountLabel(assistantCount, "reply", "replies")}</span>
        {supplementalCount > 0 ? (
          <span className="assistant-review-badge">{toCountLabel(supplementalCount, "card")}</span>
        ) : null}
        <span className="assistant-review-badge assistant-review-badge-state" data-state={state}>
          {state === "locked" ? "key needed" : state === "running" ? "live" : state === "active" ? "history" : "ready"}
        </span>
      </div>
    </header>
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
          }}
        />
      </div>
      {messageError ? <div className="assistant-review-error">{messageError}</div> : null}
    </MessagePrimitive.Root>
  );
}

function AssistantReviewPaneInner({
  storageKey,
  reviewLogId,
  agentEnabled,
  supplementalCount,
  supplementalEntries,
  emptyState,
  viewportRef,
  forwardedRef,
}: Omit<AssistantReviewPaneProps, "adapter"> & { forwardedRef: Ref<AssistantReviewPaneHandle> }) {
  const aui = useAui();
  const messages = useAuiState((state) => state.thread.messages);

  useImperativeHandle(
    forwardedRef,
    () => ({
      sendPrompt(prompt: string) {
        aui.thread().append({
          role: "user",
          content: [{ type: "text", text: prompt }],
        });
      },
    }),
    [aui],
  );

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(messages));
  }, [messages, storageKey]);

  return (
    <ThreadPrimitive.Root className="assistant-review-root">
      <AssistantReviewSummary agentEnabled={agentEnabled} supplementalCount={supplementalCount} />
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

export const AssistantReviewPane = forwardRef<AssistantReviewPaneHandle, AssistantReviewPaneProps>(function AssistantReviewPane(
  { adapter, storageKey, reviewLogId, agentEnabled, supplementalCount, supplementalEntries, emptyState, viewportRef },
  ref,
) {
  const initialMessages = useMemo(() => readStoredMessages(storageKey), [storageKey]);
  const runtime = useLocalRuntime(adapter, { initialMessages });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AssistantReviewPaneInner
        forwardedRef={ref}
        storageKey={storageKey}
        reviewLogId={reviewLogId}
        agentEnabled={agentEnabled}
        supplementalCount={supplementalCount}
        supplementalEntries={supplementalEntries}
        emptyState={emptyState}
        viewportRef={viewportRef}
      />
    </AssistantRuntimeProvider>
  );
});
