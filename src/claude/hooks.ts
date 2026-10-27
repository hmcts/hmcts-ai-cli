import { fileURLToPath } from "node:url";
import { HOOK_COMMAND, NAME_FLAG } from "../hair/args.js";
import { SESSION_END, USER_PROMPT_SUBMIT } from "../hair/hook.js";
import type { Logger } from "../log/logger.js";

export const HAIR_BIN = "hair";
export const HAI_BIN = "hai";
export const HOOK_EVENTS = [USER_PROMPT_SUBMIT, SESSION_END] as const;

const END_OF_OPTIONS = "--";
const NAME_FLAGS = new Set(["-n", NAME_FLAG]);

/** Argv that starts no conversation anyone would resume: a `-p` run is a script and a `--bg` one is a job. */
const NOT_A_CONVERSATION = new Set(["-p", "--print", "--bg", "--background"]);

export const REGISTRATION_HOOK_OVERRIDE_WARNING =
  "your --settings replaces the session-registry hooks hai generated, so this conversation will not be recorded in ~/.claude/sessions.jsonl and `hair` will not offer it after a reboot";

export function shouldRegisterSession(argv: string[]): boolean {
  for (const arg of argv) {
    if (arg === END_OF_OPTIONS) {
      // Everything after a bare `--` is prompt text rather than flags.
      return true;
    }
    if (NOT_A_CONVERSATION.has(arg)) {
      return false;
    }
  }
  return true;
}

/** No hook payload carries the session's display name, so hai reads it off the argv it is forwarding. */
export function sessionDisplayName(argv: string[]): string | undefined {
  for (const [index, arg] of argv.entries()) {
    if (arg === END_OF_OPTIONS) {
      return undefined;
    }
    if (NAME_FLAGS.has(arg)) {
      return argv[index + 1];
    }
    if (arg.startsWith(`${NAME_FLAG}=`)) {
      return arg.slice(NAME_FLAG.length + 1);
    }
  }
  return undefined;
}

/** Claude Code runs a hook command through `/bin/sh -c`, so a display name with a space or a quote in it has to be quoted here. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function hookCommand(input: { bin: string[]; event: string; name?: string }): string {
  const parts = [...input.bin.map(shellQuote), HOOK_COMMAND, input.event];
  if (input.name !== undefined && input.name !== "") {
    parts.push(NAME_FLAG, shellQuote(input.name));
  }
  return parts.join(" ");
}

/** The two events the registry is maintained from. */
export function registrationHooks(input: { bin: string[]; name?: string }): HookSettings {
  return Object.fromEntries(HOOK_EVENTS.map((event) => [event, [{ hooks: [{ type: "command", command: hookCommand({ ...input, event }) }] }]])) as HookSettings;
}

/** A sibling bin, resolved from the realpath'd `import.meta.url`; `process.argv[1]` is the bin symlink for a global install. */
export function binPath(bin: string): string {
  return fileURLToPath(new URL(`../bin/${bin}.js`, import.meta.url));
}

/**
 * In place, this interpreter and the absolute path of the release that injected the hook.
 * In container mode hai's install is a host path the container cannot see, so `hair` on PATH.
 */
export function hairCommand(input: { execPath: string; forContainer: boolean }): string[] {
  return input.forContainer ? [HAIR_BIN] : [input.execPath, binPath(HAIR_BIN)];
}

/** The hooks that keep `~/.claude/sessions.jsonl`; undefined for argv that starts no conversation worth resuming. */
export function sessionRegistryHooks(
  deps: { logger: Logger; execPath: string },
  input: { forwarded: string[]; forContainer: boolean }
): HookSettings | undefined {
  if (!shouldRegisterSession(input.forwarded)) {
    deps.logger.verbose("this argv starts no conversation worth resuming, so no session-registry hooks are added");
    return undefined;
  }
  return registrationHooks({
    bin: hairCommand({ execPath: deps.execPath, forContainer: input.forContainer }),
    name: sessionDisplayName(input.forwarded)
  });
}

/**
 * `hai`'s own entrypoint, for `hair` to hand `launch` as the script a self-update re-execs.
 * Re-execing `hair` there would claim a second conversation and emit `-r <new> -r <old>`.
 */
export function haiScriptPath(): string {
  return binPath(HAI_BIN);
}

export interface HookEntry {
  type: string;
  command: string;
}

export type HookSettings = Record<string, { hooks: HookEntry[] }[]>;
