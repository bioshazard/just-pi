import {
  AssistantRuntimeProvider,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useLocalRuntime,
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
  hasSupplementalEntries: boolean;
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

function AssistantReviewMessage() {
  const role = useAuiState((state) => state.message.role);
  const label = role === "user" ? "You" : role === "assistant" ? "Assistant" : "System";

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
    </MessagePrimitive.Root>
  );
}

function AssistantReviewPaneInner({
  storageKey,
  reviewLogId,
  hasSupplementalEntries,
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
      <ThreadPrimitive.Viewport
        id={reviewLogId}
        ref={viewportRef}
        className="review-log assistant-review-log"
        autoScroll
      >
        {messages.length === 0 && !hasSupplementalEntries ? emptyState : null}
        <ThreadPrimitive.Messages>{() => <AssistantReviewMessage />}</ThreadPrimitive.Messages>
        {supplementalEntries}
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

export const AssistantReviewPane = forwardRef<AssistantReviewPaneHandle, AssistantReviewPaneProps>(function AssistantReviewPane(
  { adapter, storageKey, reviewLogId, hasSupplementalEntries, supplementalEntries, emptyState, viewportRef },
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
        hasSupplementalEntries={hasSupplementalEntries}
        supplementalEntries={supplementalEntries}
        emptyState={emptyState}
        viewportRef={viewportRef}
      />
    </AssistantRuntimeProvider>
  );
});
