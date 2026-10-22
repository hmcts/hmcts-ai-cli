export const LIST_FLAG = "--list";
export const HOOK_COMMAND = "hook";
export const NAME_FLAG = "--name";

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

function nameOption(options: string[]): string | undefined {
  const at = options.indexOf(NAME_FLAG);
  return at === -1 ? undefined : options[at + 1];
}

export type HairMode =
  | { kind: "list" }
  /** The event is whatever `claude` was told to pass; an unknown one is ignored, not an error. */
  | { kind: "hook"; event: string; name?: string }
  | { kind: "resume"; forward: string[] };
