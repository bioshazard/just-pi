import { Bash, type BashExecResult } from "just-bash/browser";

import type { OpfsWorkspace } from "./opfs";

const DEFAULT_ENV = {
  HOME: "/",
  PWD: "/",
  TERM: "xterm-color",
};

export interface ShellRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class ShellRuntime {
  private readonly bash: Bash;
  private readonly cwdStorageKey: string;
  private queue: Promise<void> = Promise.resolve();

  public constructor(workspace: OpfsWorkspace, cwdStorageKey: string) {
    const savedCwd = localStorage.getItem(cwdStorageKey) || "/";
    this.cwdStorageKey = cwdStorageKey;
    this.bash = new Bash({
      cwd: savedCwd,
      env: DEFAULT_ENV,
      fs: workspace,
    });
  }

  public getCwd(): string {
    return this.bash.getCwd();
  }

  public async execute(command: string, options: ShellRunOptions = {}): Promise<BashExecResult> {
    const run = async (): Promise<BashExecResult> => {
      const abortController = new AbortController();
      const externalAbort = () => abortController.abort();
      const timeoutId =
        typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
          ? window.setTimeout(() => abortController.abort(), options.timeoutMs)
          : undefined;

      options.signal?.addEventListener("abort", externalAbort, { once: true });

      try {
        const result = await this.bash.exec(command, {
          cwd: this.bash.getCwd(),
          signal: abortController.signal,
        });
        localStorage.setItem(this.cwdStorageKey, this.bash.getCwd());
        return result;
      } finally {
        if (timeoutId !== undefined) {
          window.clearTimeout(timeoutId);
        }
        options.signal?.removeEventListener("abort", externalAbort);
      }
    };

    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
