import { hostname } from "node:os";
import { createLogger, type Logger } from "../log/logger.js";
import { type Clock, createClock } from "./clock.js";
import { createEnv, type Env, isEnabled } from "./env.js";
import { createFs, type Fs } from "./fs.js";
import { createHiddenInput, type HiddenInput } from "./hidden-input.js";
import { createNet, type Net } from "./net.js";
import { createRunner, type Runner } from "./runner.js";

export function createSeams(): Seams {
  const env = createEnv();
  return {
    runner: createRunner(),
    fs: createFs(),
    clock: createClock(),
    net: createNet(),
    hiddenInput: createHiddenInput(),
    env,
    platform: process.platform,
    hostname: hostname(),
    cwd: process.cwd(),
    execPath: process.execPath,
    // hai always runs as a script through its bin shim, so argv[1] is its own path.
    scriptPath: process.argv[1]!,
    pid: process.pid,
    exit: (code) => process.exit(code),
    chdir: (dir) => {
      process.chdir(dir);
    },
    stdin: readAllStdin,
    stdout: (text) => {
      process.stdout.write(text);
    },
    logger: createLogger({ write: (text) => process.stderr.write(text), isVerbose: isEnabled(env, "HAI_VERBOSE") })
  };
}

async function readAllStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  return text;
}

export interface Seams {
  runner: Runner;
  fs: Fs;
  clock: Clock;
  net: Net;
  hiddenInput: HiddenInput;
  env: Env;
  platform: string;
  /**
   * Which machine — or which container — this process is on. The session registry records
   * it beside each pid, because a pid means nothing outside its own PID namespace and the
   * hook that writes a record is routinely in a different one from the `hair` that reads
   * it. Same hostname is the cheap, no-plumbing test for "the same namespace".
   */
  hostname: string;
  cwd: string;
  execPath: string;
  scriptPath: string;
  /** Recorded in the transcript lock, so a stale one can be told from a live one. */
  pid: number;
  exit(code: number): never;
  /**
   * `hair` resumes a conversation that belongs to a directory, and resume-by-id is not
   * cwd-scoped: resuming from the wrong one rebinds project settings, hooks and CLAUDE.md
   * discovery to wherever the terminal happened to be. The handover is an exec, so the
   * process cwd is what the resumed session inherits.
   */
  chdir(dir: string): void;
  /** A Claude Code hook is handed its payload on stdin and nothing else. */
  stdin(): Promise<string>;
  stdout(text: string): void;
  logger: Logger;
}
