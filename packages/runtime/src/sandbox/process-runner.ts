export interface CommandExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly stdin?: string | Uint8Array;
}

export interface CommandExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
}

export interface CommandSpawnHandle {
  readonly pid: number;
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  readonly stdin: {
    readonly write: (data: string) => Promise<void>;
    readonly end: () => Promise<void>;
  };
  readonly wait: () => Promise<number>;
  readonly kill: (signal?: NodeJS.Signals | number) => Promise<void>;
}

export interface CommandRunner {
  exec(
    command: string,
    args: readonly string[],
    options?: CommandExecOptions,
  ): Promise<CommandExecResult>;
  spawn(
    command: string,
    args: readonly string[],
    options?: CommandExecOptions,
  ): Promise<CommandSpawnHandle>;
}

async function* decodeStream(stream: ReadableStream<Uint8Array> | null): AsyncIterable<string> {
  if (!stream) {
    return;
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const text = decoder.decode(value, { stream: true });
      if (text.length > 0) {
        yield text;
      }
    }
    const trailing = decoder.decode();
    if (trailing.length > 0) {
      yield trailing;
    }
  } finally {
    reader.releaseLock();
  }
}

function buildProcessEnv(
  override: Readonly<Record<string, string>>,
): Record<string, string | undefined> {
  return {
    ...process.env,
    ...override,
  };
}

export const bunCommandRunner: CommandRunner = {
  async exec(
    command: string,
    args: readonly string[],
    options?: CommandExecOptions,
  ): Promise<CommandExecResult> {
    const stdinData =
      options?.stdin !== undefined
        ? typeof options.stdin === "string"
          ? new TextEncoder().encode(options.stdin)
          : options.stdin
        : undefined;

    const spawnOpts: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdin: "ignore" | Uint8Array;
      stdout: "pipe";
      stderr: "pipe";
    } = {
      stdin: stdinData !== undefined ? stdinData : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    };
    if (options?.cwd !== undefined) {
      spawnOpts.cwd = options.cwd;
    }
    if (options?.env !== undefined) {
      spawnOpts.env = buildProcessEnv(options.env);
    }

    const proc = Bun.spawn([command, ...args], spawnOpts);

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      proc.kill("SIGKILL");
    };

    if (options?.signal) {
      if (options.signal.aborted) {
        proc.kill("SIGKILL");
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, options.timeoutMs);
    }

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return {
        exitCode: timedOut ? 124 : exitCode,
        stdout,
        stderr,
        timedOut,
      };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      options?.signal?.removeEventListener("abort", onAbort);
    }
  },

  async spawn(
    command: string,
    args: readonly string[],
    options?: CommandExecOptions,
  ): Promise<CommandSpawnHandle> {
    const spawnOpts: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdin: "pipe";
      stdout: "pipe";
      stderr: "pipe";
    } = {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    };
    if (options?.cwd !== undefined) {
      spawnOpts.cwd = options.cwd;
    }
    if (options?.env !== undefined) {
      spawnOpts.env = buildProcessEnv(options.env);
    }

    const proc = Bun.spawn([command, ...args], spawnOpts);

    const onAbort = () => {
      proc.kill("SIGKILL");
    };
    if (options?.signal) {
      if (options.signal.aborted) {
        proc.kill("SIGKILL");
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const exited = proc.exited.finally(() => {
      options?.signal?.removeEventListener("abort", onAbort);
    });

    return {
      pid: proc.pid,
      stdout: decodeStream(proc.stdout),
      stderr: decodeStream(proc.stderr),
      stdin: {
        async write(data: string) {
          await proc.stdin.write(data);
          await proc.stdin.flush();
        },
        async end() {
          await proc.stdin.end();
        },
      },
      async wait() {
        return exited;
      },
      async kill(signal?: NodeJS.Signals | number) {
        proc.kill(signal ?? "SIGTERM");
      },
    };
  },
};
