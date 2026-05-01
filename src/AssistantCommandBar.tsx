import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { forwardRef, useCallback, useImperativeHandle, useRef, type ChangeEvent, type KeyboardEvent, type Ref } from "react";

export interface AssistantCommandBarHandle {
  focus(): void;
  setText(text: string): void;
}

interface AssistantCommandBarProps {
  isReady: boolean;
  isBusy: boolean;
  agentEnabled: boolean;
  fallbackSuggestions: readonly string[];
  onRunShell(command: string): Promise<void>;
  onMissingAgentKey(): void;
  onMissingShellCommand(): void;
  onBeforeAgentSubmit(prompt: string): void;
  onAbortAgent(): void;
  onAttachmentError(message: string): void;
  attachmentAccept: string;
}

export const AssistantCommandBar = forwardRef<AssistantCommandBarHandle, AssistantCommandBarProps>(function AssistantCommandBar(
    {
      isReady,
      isBusy,
      agentEnabled,
      fallbackSuggestions,
      onRunShell,
      onMissingAgentKey,
      onMissingShellCommand,
    onBeforeAgentSubmit,
    onAbortAgent,
    onAttachmentError,
    attachmentAccept,
  },
  ref,
) {
  const aui = useAui();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptValue = useAuiState((state) => state.composer.text);
  const attachments = useAuiState((state) => state.composer.attachments);
  const isAgentRunning = useAuiState((state) => state.thread.isRunning);
  const suggestions = useAuiState((state) => state.thread.suggestions);
  const visibleSuggestions = suggestions.length > 0 ? suggestions.map((suggestion) => suggestion.prompt) : fallbackSuggestions;

  const commandMode = promptValue.trim().startsWith("!") ? "shell" : "agent";
  const promptSubmitLabel = commandMode === "shell" ? "Run command" : "Send prompt";
  const inputDisabled = !isReady || isBusy;
  const hasAttachmentConflict = commandMode === "shell" && attachments.length > 0;

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        const element = inputRef.current;
        if (!element) {
          return;
        }
        element.focus();
        const end = element.value.length;
        element.setSelectionRange(end, end);
      },
      setText(text: string) {
        aui.composer().setText(text);
        const element = inputRef.current;
        if (!element) {
          return;
        }
        element.focus();
        const end = text.length;
        element.setSelectionRange(end, end);
      },
    }),
    [aui],
  );

  const addAttachments = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      for (const file of files) {
        try {
          await aui.composer().addAttachment(file);
        } catch (error) {
          onAttachmentError(error instanceof Error ? error.message : String(error));
        }
      }
    },
    [aui, onAttachmentError],
  );

  const submit = useCallback(async () => {
    const input = promptValue.trim();
    if (!input) {
      return;
    }

    if (input.startsWith("!")) {
      const command = input.slice(1).trim();
      if (!command) {
        onMissingShellCommand();
        return;
      }
      if (attachments.length > 0) {
        onAttachmentError("Attachments only apply to assistant prompts. Remove them before running a shell command.");
        return;
      }
      aui.composer().setText("");
      await onRunShell(command);
      return;
    }

    if (!agentEnabled) {
      onMissingAgentKey();
      return;
    }

    onBeforeAgentSubmit(input);
    aui.composer().send();
  }, [agentEnabled, attachments.length, aui, onAttachmentError, onBeforeAgentSubmit, onMissingAgentKey, onMissingShellCommand, onRunShell, promptValue]);

  return (
    <form
      id="prompt-form"
      className="panel input-panel"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="panel-header input-panel-header">
        <div>
          <h2>Command bar</h2>
          <p className="panel-copy">
            Start with <code>!</code> to run just-bash. Plain text goes through assistant-ui&apos;s composer.
          </p>
        </div>
        <span id="command-mode" className="mode-chip" data-mode={commandMode}>
          {commandMode === "shell" ? "Shell mode" : "Agent mode"}
        </span>
      </div>

      <ComposerPrimitive.Input
        ref={inputRef}
        id="prompt-input"
        rows={4}
        minRows={4}
        maxRows={10}
        submitMode="none"
        placeholder="Ask the agent something, or run !ls -la against the OPFS workspace."
        disabled={inputDisabled}
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
          if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey) || event.shiftKey) {
            return;
          }
          event.preventDefault();
          void submit();
        }}
      />

      <div className="command-attachments-row">
        <input
          ref={fileInputRef}
          id="prompt-attachments"
          type="file"
          hidden
          multiple
          accept={attachmentAccept}
          onChange={(event) => {
            void addAttachments(event);
          }}
        />
        <button
          type="button"
          className="secondary-button attachment-button"
          disabled={inputDisabled}
          onClick={() => {
            fileInputRef.current?.click();
          }}
        >
          Attach text file
        </button>
        {attachments.length > 0 ? (
          <div className="command-attachments" aria-label="Attached files">
            {attachments.map((attachment, index) => (
              <span key={attachment.id} className="command-attachment-chip" data-status={attachment.status.type}>
                <span className="command-attachment-name">{attachment.name}</span>
                <button
                  type="button"
                  className="command-attachment-remove"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() => {
                    void aui.composer().attachment({ index }).remove();
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {visibleSuggestions.length > 0 ? (
        <div className="command-suggestions" aria-label="Prompt suggestions">
          {visibleSuggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="secondary-button command-suggestion"
              onClick={() => {
                aui.composer().setText(suggestion);
                inputRef.current?.focus();
              }}
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}

      <div className="input-footer">
        <div className="input-hints">
          <p className="input-hint">Press Ctrl+Enter or Cmd+Enter to submit.</p>
          {!agentEnabled && commandMode === "agent" ? (
            <p className="input-hint input-hint-warning">Save an OpenRouter key to send assistant prompts.</p>
          ) : null}
          {hasAttachmentConflict ? (
            <p className="input-hint input-hint-warning">Attachments only go with assistant prompts. Remove them before running a shell command.</p>
          ) : null}
        </div>
        <div className="button-row">
          <button id="prompt-submit" type="submit" disabled={inputDisabled || !promptValue.trim() || hasAttachmentConflict}>
            {promptSubmitLabel}
          </button>
          <button id="prompt-stop" type="button" disabled={!isAgentRunning} onClick={onAbortAgent}>
            Stop
          </button>
        </div>
      </div>
    </form>
  );
});
