export const LIST_FLAG = "--list";
export const HOOK_COMMAND = "hook";
export const NAME_FLAG = "--name";

const END_OF_OPTIONS = "--";
const SESSION_FLAGS = new Set(["-r", "--resume", "-c", "--continue"]);
const SESSION_PREFIXES = ["--resume=", "--continue="];

/**
 * Splits the three `hair` surfaces. Flags are read in the leading position only, and never
 * for the bare form, so nothing `hair` parses can leak into the argv forwarded to `claude`.
 */
export function parseHairArgs(processArgv: string[]): HairMode {
  const args = processArgv.slice(2);
  const [first, ...rest] = args;
  if (first === HOOK_COMMAND) {
    const [event, ...options] = rest;
    return { kind: "hook", event: event ?? "", name: nameOption(options) };
  }
  if (first === LIST_FLAG) {
    return { kind: "list" };
  }
  return { kind: "resume", forward: args };
}

/**
 * Argv that already says which conversation to open: there is nothing for `hair` to claim,
 * so it is just `hai` with the arguments as typed.
 */
export function forwardsItsOwnSession(argv: string[]): boolean {
  for (const arg of argv) {
    if (arg === END_OF_OPTIONS) {
      // Everything after a bare `--` is prompt text rather than flags.
      return false;
    }
    if (SESSION_FLAGS.has(arg) || SESSION_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
      return true;
    }
  }
  return false;
}

function nameOption(options: string[]): string | undefined {
  const at = options.indexOf(NAME_FLAG);
  return at === -1 ? undefined : options[at + 1];
}

export type HairMode =
  | { kind: "list" }
  /** The event is whatever `claude` was told to pass; an unknown one is ignored, not an error. */
  | { kind: "hook"; event: string; name?: string }
  | { kind: "resume"; forward: string[] };
