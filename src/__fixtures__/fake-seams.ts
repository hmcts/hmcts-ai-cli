import { packagedRuntimeDir, RUNTIME_SCRIPTS } from "../container/runtime-staging.js";
import type { Logger } from "../log/logger.js";
import { createLogger } from "../log/logger.js";
import type { DirEntry, Fs } from "../system/fs.js";
import type { HiddenInput } from "../system/hidden-input.js";
import type { Runner, RunOptions, RunResult } from "../system/runner.js";
import type { Seams } from "../system/seams.js";

export const FIXED_NOW = Date.parse("2026-10-21T09:00:00Z");

export function createFakeRunner(respond: RunResponder = () => undefined): FakeRunner {
  const calls: RunnerCall[] = [];
  const execCalls: RunnerCall[] = [];
  const interactiveCalls: RunnerCall[] = [];
  return {
    calls,
    execCalls,
    interactiveCalls,
    async interactive(argv, opts = {}) {
      interactiveCalls.push({ argv, opts });
      const scripted = respond(argv);
      return scripted instanceof Error || scripted === undefined ? 0 : (scripted.code ?? 0);
    },
    async run(argv, opts = {}) {
      calls.push({ argv, opts });
      const scripted = respond(argv);
      if (scripted === undefined) {
        return { code: 127, stdout: "", stderr: `fake runner has no answer for ${argv.join(" ")}` };
      }
      if (scripted instanceof Error) {
        throw scripted;
      }
      return { code: 0, stdout: "", stderr: "", ...scripted };
    },
    async exec(argv, opts = {}) {
      execCalls.push({ argv, opts });
      return undefined as never;
    }
  };
}

export function createFakeFs(files: Record<string, string> = {}): FakeFs {
  const store = new Map<string, string>(Object.entries(files));
  const modes = new Map<string, number>();
  const dirs = new Set<string>();
  const unwritable = new Set<string>();
  return {
    store,
    modes,
    dirs,
    unwritable,
    async readText(path) {
      return store.get(path) ?? null;
    },
    async writeText(path, content, opts = {}) {
      store.set(path, content);
      if (opts.mode !== undefined) {
        modes.set(path, opts.mode);
      }
    },
    async mkdirp(path, opts = {}) {
      dirs.add(path);
      if (opts.mode !== undefined) {
        modes.set(path, opts.mode);
      }
    },

    async rename(from, to) {
      const content = store.get(from);
      if (content === undefined) {
        throw new Error(`no such file ${from}`);
      }
      store.delete(from);
      store.set(to, content);
      const mode = modes.get(from);
      if (mode !== undefined) {
        modes.delete(from);
        modes.set(to, mode);
      }
    },

    async remove(path) {
      store.delete(path);
      dirs.delete(path);
      modes.delete(path);
    },
    async exists(path) {
      return store.has(path) || dirs.has(path);
    },
    async isWritable(path) {
      return !unwritable.has(path);
    },

    async listDir(path) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const entries = new Map<string, DirEntry>();
      for (const key of store.keys()) {
        if (!key.startsWith(prefix)) {
          continue;
        }
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        const name = slash === -1 ? rest : rest.slice(0, slash);
        entries.set(name, { name, isDirectory: slash !== -1 });
      }
      return [...entries.values()];
    }
  };
}

export function createFakeHiddenInput(answers: string[] = [], isTty = true): HiddenInput {
  const queue = [...answers];
  return {
    isTty,
    async readHidden() {
      const answer = queue.shift();
      if (answer === undefined) {
        throw new Error("no input given");
      }
      return answer;
    }
  };
}

export function createFakeSeams(
  overrides: Partial<Seams> & { files?: Record<string, string>; respond?: RunResponder; fetch?: Seams["net"]["fetch"]; portsInUse?: number[] } = {}
): FakeSeams {
  const { files, respond, fetch, portsInUse, ...rest } = overrides;
  const lines: string[] = [];
  const out: string[] = [];
  const env = rest.env ?? {};
  const logger: Logger = rest.logger ?? createLogger({ write: (text) => lines.push(text), isVerbose: env.HAI_VERBOSE === "1" });
  const seams: Seams = {
    runner: rest.runner ?? createFakeRunner(respond),
    fs: rest.fs ?? createFakeFs(files),
    clock: rest.clock ?? { now: () => FIXED_NOW, sleep: async () => undefined },
    net: rest.net ?? {
      fetch: fetch ?? (async () => new Response("{}", { status: 404 })),
      isPortFree: async (port) => !(portsInUse ?? []).includes(port)
    },
    hiddenInput: rest.hiddenInput ?? createFakeHiddenInput(),
    env,
    platform: rest.platform ?? "linux",
    cwd: rest.cwd ?? "/work",
    execPath: rest.execPath ?? "/usr/local/bin/node",
    scriptPath: rest.scriptPath ?? "/usr/local/lib/node_modules/@hmcts-cft/hai-cli/dist/bin/hai.js",
    pid: rest.pid ?? 4242,
    exit:
      rest.exit ??
      ((code) => {
        throw exitSignal(code);
      }),
    stdout: rest.stdout ?? ((text) => out.push(text)),
    logger
  };
  return { ...seams, runner: seams.runner as FakeRunner, fs: seams.fs as FakeFs, lines, out };
}

/** The runtime scripts as the package ships them, for any test that reaches container mode. */
export function packagedRuntime(): Record<string, string> {
  return Object.fromEntries(RUNTIME_SCRIPTS.map((name) => [`${packagedRuntimeDir()}${name}`, `# ${name}\n`]));
}

export function exitSignal(code: number): ExitSignal {
  return Object.assign(new Error(`exit ${code}`), { exitCode: code });
}

export function exitCodeOf(err: unknown): number | undefined {
  return (err as ExitSignal | undefined)?.exitCode;
}

export type RunResponder = (argv: string[]) => Partial<RunResult> | Error | undefined;

export interface RunnerCall {
  argv: string[];
  opts: RunOptions;
}

export interface FakeRunner extends Runner {
  calls: RunnerCall[];
  execCalls: RunnerCall[];
  interactiveCalls: RunnerCall[];
}

export interface FakeFs extends Fs {
  store: Map<string, string>;
  modes: Map<string, number>;
  dirs: Set<string>;
  unwritable: Set<string>;
}

export interface FakeSeams extends Omit<Seams, "runner" | "fs"> {
  runner: FakeRunner;
  fs: FakeFs;
  /** Every line the logger wrote, prefix and newline included. */
  lines: string[];
  out: string[];
}

export type ExitSignal = Error & { exitCode: number };
