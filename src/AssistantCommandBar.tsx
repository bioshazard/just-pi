import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { forwardRef, useCallback, useImperativeHandle, useRef, type KeyboardEvent, type Ref } from "react";

export interface AssistantCommandBarHandle {
  focus(): void;
  setText(text: string): void;
}

interface AssistantCommandBarProps {
  isReady: boolean;
  isBusy: boolean;
  agentEnabled: boolean;
  onRunShell(command: string): Promise<void>;
  onMissingAgentKey(): void;
  onMissingShellCommand(): void;
  onBeforeAgentSubmit(prompt: string): void;
  onAbortAgent(): void;
}

export const AssistantCommandBar = forwardRef<AssistantCommandBarHandle, AssistantCommandBarProps>(function AssistantCommandBar(
  { isReady, isBusy, agentEnabled, onRunShell, onMissingAgentKey, onMissingShellCommand, onBeforeAgentSubmit, onAbortAgent },
  ref,
) {
  const aui = useAui();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const promptValue = useAuiState((state) => state.composer.text);
  const isAgentRunning = useAuiState((state) => state.thread.isRunning);

  const commandMode = promptValue.trim().startsWith("!") ? "shell" : "agent";
  const promptSubmitLabel = commandMode === "shell" ? "Run command" : "Send prompt";
  const inputDisabled = !isReady || isBusy;

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
  }, [agentEnabled, aui, onBeforeAgentSubmit, onMissingAgentKey, onMissingShellCommand, onRunShell, promptValue]);

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

      <div className="input-footer">
        <div className="input-hints">
          <p className="input-hint">Press Ctrl+Enter or Cmd+Enter to submit.</p>
          {!agentEnabled && commandMode === "agent" ? (
            <p className="input-hint input-hint-warning">Save an OpenRouter key to send assistant prompts.</p>
          ) : null}
        </div>
        <div className="button-row">
          <button id="prompt-submit" type="submit" disabled={inputDisabled || !promptValue.trim()}>
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
