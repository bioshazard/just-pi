import type { Bash, BashExecResult } from "just-bash/browser";

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
  private readonly workspace: OpfsWorkspace;
  private readonly cwdStorageKey: string;
  private bash?: Bash;
  private bashPromise?: Promise<Bash>;
  private cwd: string;
  private queue: Promise<void> = Promise.resolve();

  public constructor(workspace: OpfsWorkspace, cwdStorageKey: string) {
    const savedCwd = localStorage.getItem(cwdStorageKey) || "/";
    this.workspace = workspace;
    this.cwdStorageKey = cwdStorageKey;
    this.cwd = savedCwd;
  }

  public getCwd(): string {
    return this.bash?.getCwd() ?? this.cwd;
  }

  public async execute(command: string, options: ShellRunOptions = {}): Promise<BashExecResult> {
    const run = async (): Promise<BashExecResult> => {
      const bash = await this.getBash();
      const abortController = new AbortController();
      const externalAbort = () => abortController.abort();
      const timeoutId =
        typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
          ? window.setTimeout(() => abortController.abort(), options.timeoutMs)
          : undefined;

      options.signal?.addEventListener("abort", externalAbort, { once: true });

      try {
        const result = await bash.exec(command, {
          cwd: bash.getCwd(),
          signal: abortController.signal,
        });
        this.cwd = bash.getCwd();
        localStorage.setItem(this.cwdStorageKey, this.cwd);
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

  private async getBash(): Promise<Bash> {
    if (this.bash) {
      return this.bash;
    }
    if (!this.bashPromise) {
      this.bashPromise = (async () => {
        const { Bash } = await import("just-bash/browser");
        const bash = new Bash({
          cwd: this.cwd,
          env: DEFAULT_ENV,
          fs: this.workspace,
        });
        this.bash = bash;
        return bash;
      })();
    }
    return this.bashPromise;
  }
}
