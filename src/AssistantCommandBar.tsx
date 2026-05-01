import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { forwardRef, useCallback, useImperativeHandle, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";

export interface AssistantCommandBarHandle {
  focus(): void;
  setText(text: string): void;
}

interface AssistantCommandBarProps {
  title?: string;
  description?: ReactNode;
  isReady: boolean;
  isBusy: boolean;
  agentEnabled: boolean;
  onRunShell(command: string): Promise<void>;
  onMissingAgentKey(): void;
  onMissingShellCommand(): void;
  onBeforeAgentSubmit(prompt: string): void;
  onAbortAgent(): void;
  onUploadWorkspaceFiles(files: readonly File[]): Promise<void>;
}

export const AssistantCommandBar = forwardRef<AssistantCommandBarHandle, AssistantCommandBarProps>(function AssistantCommandBar(
    {
      title = "Compose",
      description = (
        <>
          Plain text drives the agent. Start with <code>!</code> for shell.
        </>
      ),
      isReady,
      isBusy,
      agentEnabled,
      onRunShell,
      onMissingAgentKey,
      onMissingShellCommand,
      onBeforeAgentSubmit,
      onAbortAgent,
      onUploadWorkspaceFiles,
    },
  ref,
) {
  const aui = useAui();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const [isUploadDropActive, setIsUploadDropActive] = useState(false);
  const promptValue = useAuiState((state) => state.composer.text);
  const isAgentRunning = useAuiState((state) => state.thread.isRunning);

  const commandMode = promptValue.trim().startsWith("!") ? "shell" : "agent";
  const promptSubmitLabel = commandMode === "shell" ? "Run shell" : "Send prompt";
  const inputDisabled = !isReady || isBusy;

  const hasDraggedFiles = useCallback((event: DragEvent<HTMLTextAreaElement>) => {
    return Array.from(event.dataTransfer?.types ?? []).includes("Files");
  }, []);

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

  const handleDragEnter = useCallback(
    (event: DragEvent<HTMLTextAreaElement>) => {
      if (inputDisabled || !hasDraggedFiles(event)) {
        return;
      }
      event.preventDefault();
      setIsUploadDropActive(true);
    },
    [hasDraggedFiles, inputDisabled],
  );

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLTextAreaElement>) => {
      if (inputDisabled || !hasDraggedFiles(event)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      if (!isUploadDropActive) {
        setIsUploadDropActive(true);
      }
    },
    [hasDraggedFiles, inputDisabled, isUploadDropActive],
  );

  const handleDragLeave = useCallback(() => {
    setIsUploadDropActive(false);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLTextAreaElement>) => {
      if (inputDisabled || !hasDraggedFiles(event)) {
        return;
      }
      event.preventDefault();
      setIsUploadDropActive(false);
      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length === 0) {
        return;
      }
      void onUploadWorkspaceFiles(files);
    },
    [hasDraggedFiles, inputDisabled, onUploadWorkspaceFiles],
  );

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
          <h2>{title}</h2>
          <p className="panel-copy">{description}</p>
        </div>
        <span id="command-mode" className="mode-chip" data-mode={commandMode}>
          {commandMode === "shell" ? "Shell" : "Agent"}
        </span>
      </div>

      <ComposerPrimitive.Input
        ref={inputRef}
        id="prompt-input"
        className={`prompt-input${isUploadDropActive ? " is-drop-target" : ""}`}
        rows={4}
        minRows={4}
        maxRows={10}
        submitMode="none"
        placeholder="Prompt the agent, or run !ls against the OPFS working set."
        disabled={inputDisabled}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
          if (event.key === "Tab" && !event.shiftKey && submitButtonRef.current && !submitButtonRef.current.disabled) {
            event.preventDefault();
            submitButtonRef.current.focus();
            return;
          }
          if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey) || event.shiftKey) {
            return;
          }
          event.preventDefault();
          void submit();
        }}
      />
      <div className="input-footer">
        <div className="input-footer-row">
          <div className="button-row input-actions">
            <button
              ref={submitButtonRef}
              id="prompt-submit"
              type="submit"
              disabled={inputDisabled || !promptValue.trim()}
            >
              {promptSubmitLabel}
            </button>
            <button id="prompt-stop" type="button" disabled={!isAgentRunning} onClick={onAbortAgent}>
              Stop
            </button>
          </div>
        </div>
        <div className="input-hints">
          <p className="input-hint">Ctrl+Enter or Cmd+Enter submits.</p>
          <p className="input-hint">Drop files on the prompt box to upload them into Files.</p>
          {!agentEnabled && commandMode === "agent" ? (
            <p className="input-hint input-hint-warning">Save an OpenRouter key to send assistant prompts.</p>
          ) : null}
        </div>
      </div>
    </form>
  );
});
