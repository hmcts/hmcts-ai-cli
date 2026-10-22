export const LIST_FLAG = "--list";
export const HOOK_COMMAND = "hook";
export const NAME_FLAG = "--name";

const END_OF_OPTIONS = "--";
const SESSION_FLAGS = new Set(["-r", "--resume", "-c", "--continue"]);
const SESSION_PREFIXES = ["--resume=", "--continue="];

/**
 * `hai` has no arguments of its own because `claude` owns the subcommand namespace and
 * every one of them has to reach it untouched. `hair` is a different binary, so it is not
 * in that namespace and may have its own — but only in the leading position, and never
 * for the bare form: `hair -r x --foo` forwards all three words verbatim. The flags below
 * can therefore not leak into the forwarded argv, which is what
 * `src/claude/args.test.ts` guards on hai's side.
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
 * Argv that already says which conversation to open. `hair -r abc` is a natural typo of
 * `hai -r abc`, and `hair -c` an equally natural one: without this, `hair` would claim an
 * unrelated conversation, emit `-r <claimed> -r abc`, open `abc` because claude takes the
 * last, and leave the claimed one held by a live pid so no other terminal could have it.
 * Nothing to claim, so `hair` is just `hai` with the arguments as typed.
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
