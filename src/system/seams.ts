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
    cwd: process.cwd(),
    execPath: process.execPath,
    // hai always runs as a script through its bin shim, so argv[1] is its own path.
    scriptPath: process.argv[1]!,
    exit: (code) => process.exit(code),
    stdout: (text) => {
      process.stdout.write(text);
    },
    logger: createLogger({ write: (text) => process.stderr.write(text), isVerbose: isEnabled(env, "HAI_VERBOSE") })
  };
}

export interface Seams {
  runner: Runner;
  fs: Fs;
  clock: Clock;
  net: Net;
  hiddenInput: HiddenInput;
  env: Env;
  platform: string;
  cwd: string;
  execPath: string;
  scriptPath: string;
  exit(code: number): never;
  stdout(text: string): void;
  logger: Logger;
}
