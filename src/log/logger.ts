import { redact } from "./redact.js";

const PREFIX = "hai: ";

export function createLogger(deps: { write: (text: string) => void; isVerbose: boolean }): Logger {
  const say = (message: string) => {
    deps.write(`${PREFIX}${redact(message)}\n`);
  };
  return {
    say,
    verbose(message) {
      if (deps.isVerbose) {
        say(message);
      }
    }
  };
}

export interface Logger {
  say(message: string): void;
  verbose(message: string): void;
}
