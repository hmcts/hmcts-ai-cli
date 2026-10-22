import { spawn } from "node:child_process";
import { redact } from "../log/redact.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const SPAWN_FAILED_CODE = 127;
const KILLED_CODE = 124;
const SIGNALLED_CODE = 128;

export function createRunner({ exit = defaultExit, echo = defaultEcho }: { exit?: (code: number) => never; echo?: (text: string) => void } = {}): Runner {
  return {
    run(argv, opts = {}) {
      return new Promise((resolve) => {
        const forward = opts.echo === true ? echo : null;
        const child = spawn(binary(argv), argv.slice(1), {
          cwd: opts.cwd,
          env: opts.env,
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"]
        });

        let stdout = "";
        let stderr = "";
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
          forward?.(chunk);
        });
        child.stderr?.on("data", (chunk: string) => {
          stderr += chunk;
          forward?.(chunk);
        });

        // A failure to spawn reads as a non-zero exit rather than a rejection: every caller
        // treats "az is missing" and "az said no" the same way, and a probe that throws
        // would have to be wrapped at every call site.
        child.on("error", (err: Error) => {
          resolve({ code: SPAWN_FAILED_CODE, stdout, stderr: err.message });
        });

        child.on("close", (code) => {
          resolve({ code: code ?? KILLED_CODE, stdout, stderr });
        });

        if (opts.stdin !== undefined) {
          child.stdin?.end(opts.stdin);
        } else {
          child.stdin?.end();
        }
      });
    },

    interactive(argv, opts = {}) {
      return new Promise<number>((resolve, reject) => {
        const child = spawn(binary(argv), argv.slice(1), {
          cwd: opts.cwd,
          env: opts.env,
          shell: false,
          stdio: "inherit"
        });
        child.on("error", (err: Error) => {
          reject(err);
        });
        child.on("close", (code) => {
          resolve(code ?? SIGNALLED_CODE);
        });
      });
    },

    exec(argv, opts = {}) {
      return new Promise<never>((_resolve, reject) => {
        const child = spawn(binary(argv), argv.slice(1), {
          cwd: opts.cwd,
          env: opts.env,
          shell: false,
          stdio: "inherit"
        });
        child.on("error", (err: Error) => {
          reject(err);
        });
        child.on("close", (code) => {
          try {
            // Node cannot replace its own process image, so the nearest thing is to
            // wait and leave with the child's status.
            exit(code ?? SIGNALLED_CODE);
          } catch (err) {
            reject(err);
          }
        });
      });
    }
  };
}

function binary(argv: string[]): string {
  const bin = argv[0];
  if (bin === undefined) {
    throw new Error("cannot run an empty argv");
  }
  return bin;
}

function defaultExit(code: number): never {
  process.exit(code);
}

function defaultEcho(text: string): void {
  process.stderr.write(redact(text));
}

export interface RunOptions {
  stdin?: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  /**
   * Also write the child's output onward as it arrives, while still capturing it for the
   * result: a long command has to show that it is doing something, and callers that parse
   * what it said still can. It goes to stderr, because stdout is hai's own parseable
   * output and the terminal is about to be handed over.
   */
  echo?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Runner {
  run(argv: string[], opts?: RunOptions): Promise<RunResult>;
  /**
   * Hands the terminal over the same way `exec` does, but comes back with the child's
   * status instead of leaving: container mode has a container to remove and a lock to
   * release once the session ends.
   */
  interactive(argv: string[], opts?: Pick<RunOptions, "cwd" | "env">): Promise<number>;
  /**
   * Hands the terminal to another process and does not come back: the returned promise
   * only ever rejects, when the process could not be started at all. Node cannot replace
   * its own image the way execve does, so this spawns with inherited stdio and exits with
   * the child's status once it is done.
   */
  exec(argv: string[], opts?: Pick<RunOptions, "cwd" | "env">): Promise<never>;
}
