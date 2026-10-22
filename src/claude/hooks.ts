import { HOOK_COMMAND, NAME_FLAG } from "../hair/args.js";
import { SESSION_END, USER_PROMPT_SUBMIT } from "../hair/hook.js";
import type { Logger } from "../log/logger.js";

export const HAIR_BIN = "hair";
export const HAI_BIN = "hai";
export const HOOK_EVENTS = [USER_PROMPT_SUBMIT, SESSION_END] as const;

const END_OF_OPTIONS = "--";
const NAME_FLAGS = new Set(["-n", NAME_FLAG]);

/**
 * Argv that starts no conversation anyone would resume. A `-p` run is a script and a
 * `--bg` one is a job, and both fire `UserPromptSubmit` — measured — so they would
 * otherwise fill the registry with entries no terminal should ever pick up. The hook also
 * refuses them on `CLAUDE_CODE_SESSION_ATTENDED`, which is what covers the sessions hai
 * never saw the argv of; this is the half that keeps hai from writing a registration hook
 * into a settings file it knows will not need one.
 */
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

/**
 * Claude Code runs a hook command through `/bin/sh -c` — measured, the hook's parent is
 * `/bin/sh -c <command>` — so a display name with a space or a quote in it has to be
 * quoted here. hai itself still never uses a shell; this is a string handed to a shell
 * hai does not run, and the quoting is what keeps the name from being read as more argv.
 */
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

/**
 * The two events the registry is maintained from. They go into the settings hai already
 * passes as its single `--settings`, so the engineer never hand-wires
 * `.claude/settings.json` for this.
 */
export function registrationHooks(input: { bin: string[]; name?: string }): HookSettings {
  return Object.fromEntries(HOOK_EVENTS.map((event) => [event, [{ hooks: [{ type: "command", command: hookCommand({ ...input, event }) }] }]])) as HookSettings;
}

/**
 * `hair` is resolved differently per launch path, which is the one place this feature is
 * not watertight. In-place, hai and hair ship in the same `dist/bin`, so the command is
 * this interpreter and the absolute path of the very release that injected it — no PATH
 * lookup and no execute bit needed. In container mode hai's own install is a host path
 * the container cannot see, so the command falls back to `hair` on PATH inside the image;
 * if it is not installed there the hook simply fails, which Claude Code ignores
 * (measured: a `command not found` hook leaves the session's output and exit status
 * untouched) and the conversation goes unregistered.
 */
export function hairCommand(input: { execPath: string; scriptPath: string; forContainer: boolean }): string[] {
  const at = input.scriptPath.lastIndexOf("/");
  if (input.forContainer || at === -1 || !input.scriptPath.endsWith(".js")) {
    return [HAIR_BIN];
  }
  return [input.execPath, `${input.scriptPath.slice(0, at)}/${HAIR_BIN}.js`];
}

/**
 * The `UserPromptSubmit` and `SessionEnd` hooks that keep `~/.claude/sessions.jsonl`, so
 * `hair` has something to restore after a reboot and the engineer never hand-wires
 * `.claude/settings.json` for it. Undefined for argv that starts no conversation anyone
 * would resume, which is also the only honest thing to return when there is nothing to
 * register.
 */
export function sessionRegistryHooks(
  deps: { logger: Logger; execPath: string; scriptPath: string },
  input: { forwarded: string[]; forContainer: boolean }
): HookSettings | undefined {
  if (!shouldRegisterSession(input.forwarded)) {
    deps.logger.verbose("this argv starts no conversation worth resuming, so no session-registry hooks are added");
    return undefined;
  }
  return registrationHooks({
    bin: hairCommand({ execPath: deps.execPath, scriptPath: deps.scriptPath, forContainer: input.forContainer }),
    name: sessionDisplayName(input.forwarded)
  });
}

/**
 * `hair`'s sibling in the same `dist/bin`. A self-update inside `launch` re-execs
 * `scriptPath` with the arguments it was given, and those arguments are by then
 * `-r <id>`: re-entering `hair` there would send the new release off to claim a *second*
 * conversation. Unrecognisable paths are left alone, since the claim already taken makes
 * that case a conversation left unrestored rather than one resumed twice.
 */
export function haiScriptPath(scriptPath: string): string {
  return scriptPath.endsWith(`/${HAIR_BIN}.js`) ? `${scriptPath.slice(0, -`${HAIR_BIN}.js`.length)}${HAI_BIN}.js` : scriptPath;
}

export interface HookEntry {
  type: string;
  command: string;
}

export type HookSettings = Record<string, { hooks: HookEntry[] }[]>;
