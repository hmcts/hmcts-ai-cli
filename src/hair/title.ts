import { join } from "node:path";
import { projectSlug } from "../container/session.js";
import type { Logger } from "../log/logger.js";
import { type Env, isSet } from "../system/env.js";
import type { Fs } from "../system/fs.js";
import { registryDir } from "./registry.js";

/** Claude Code's own per-conversation store, a sibling of the transcripts. */
export const PROJECTS_DIR = "projects";
export const CUSTOM_TITLE_FILE = "custom-title.json";

/**
 * Claude Code's own opt-out. Read as "set at all" rather than as `=1`, which is the rule
 * for an `HAI_*` flag: the variable is not hai's, so the grammar of its values is not
 * hai's to define, and the only safe reading of somebody else's opt-out is that any value
 * they set means they meant it.
 */
export const DISABLE_TITLE_ENV = "CLAUDE_CODE_DISABLE_TERMINAL_TITLE";

/**
 * `ESC ] 0 ; <text> BEL` — the OSC 0 sequence, BEL-terminated, which is what Claude Code
 * itself writes and what the terminal emulators in use here accept. Captured from a live
 * session under a pty on Claude Code 2.1.304.
 */
export const OSC_TITLE_PREFIX = "\u001b]0;";
export const BEL = "\u0007";

/**
 * Where Claude Code keeps the name `/rename` set: one file per conversation under the
 * project slug, `{"customTitle":"..."}`. `projectSlug` is the same transform
 * `src/container/session.ts` uses for the transcript directory, and it has to be
 * byte-identical to Claude Code's or every lookup silently misses — verified against the
 * directories on this machine, including a path with a dot in it
 * (`/home/linus/Work/eco-rewards/ecorewards.co.uk` →
 * `-home-linus-Work-eco-rewards-ecorewards-co-uk`) and a worktree path carrying both a dot
 * and dashes.
 *
 * Read-only. hai never creates or edits one of these: it is Claude Code's private store,
 * and writing into it would make a format change hai's bug to own.
 */
export function customTitlePath(env: Env, input: { cwd?: string; sessionId?: string }): string | null {
  const dir = registryDir(env);
  if (dir === null || input.cwd === undefined || input.sessionId === undefined) {
    return null;
  }
  return join(dir, PROJECTS_DIR, projectSlug(input.cwd), input.sessionId, CUSTOM_TITLE_FILE);
}

/**
 * Pure. A file that is absent, unparseable or carries no usable `customTitle` is a silent
 * no-name rather than an error: this is read from a hook, and a hook never breaks a
 * session.
 */
export function parseCustomTitle(text: string | null): string | undefined {
  if (text === null) {
    return undefined;
  }
  try {
    const { customTitle } = JSON.parse(text) as { customTitle?: unknown };
    return typeof customTitle === "string" && customTitle !== "" ? customTitle : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pure: whether the terminal title is hai's to write, and the exact bytes if it is.
 *
 * Three suppressions, and each of them is a case where writing would be worse than not:
 * a name that is empty after cleaning would *clear* the title rather than restore one, so
 * the terminal keeps what it had; the engineer's own `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`
 * is an instruction to Claude Code that hai must not go round on its behalf; and a stdout
 * that is not a terminal is a pipe or a captured log, where an escape sequence is noise at
 * best — `hair --list | grep` must come back with lines and nothing else.
 */
export function titleDecision(input: { name?: string; isTty: boolean; env: Env }): TitleOutcome {
  const name = cleaned(input.name ?? "");
  if (name === "") {
    return { action: "skip", reason: "the conversation has no name, so the terminal keeps the title it already had" };
  }
  if (isSet(input.env, DISABLE_TITLE_ENV)) {
    return { action: "skip", reason: `${DISABLE_TITLE_ENV} is set, so the terminal title is not hai's to write` };
  }
  if (!input.isTty) {
    return { action: "skip", reason: "stdout is not a terminal, so the escape sequence would be bytes in whatever is reading it" };
  }
  return { action: "write", reason: `the terminal title is now ${name}`, sequence: `${OSC_TITLE_PREFIX}${name}${BEL}` };
}

/**
 * The stored title for a conversation, or undefined for every way of not having one.
 * `Fs.readText` answers null rather than throwing for an absent or unreadable file, so
 * this is one read that cannot fail.
 */
export async function readCustomTitle(deps: { fs: Fs; env: Env }, input: { cwd?: string; sessionId?: string }): Promise<string | undefined> {
  const path = customTitlePath(deps.env, input);
  return path === null ? undefined : parseCustomTitle(await deps.fs.readText(path));
}

/**
 * Written straight to stdout rather than through the logger. `createLogger` applies
 * `redact()`, prepends `hai: ` and appends a newline, and every one of those would corrupt
 * an escape sequence — this is not a log line, and the repo's rule that every log line is
 * redacted is exactly why it must not pretend to be one. `Seams.stdout` is a verbatim
 * `process.stdout.write`, which is the raw write this needs; the fact that was missing is
 * `stdoutIsTty`, so the gate and the destination are the same stream.
 */
export function writeTerminalTitle(deps: { stdout(text: string): void; stdoutIsTty: boolean; env: Env; logger: Logger }, name: string | undefined): void {
  const outcome = titleDecision({ name, isTty: deps.stdoutIsTty, env: deps.env });
  deps.logger.verbose(outcome.reason);
  if (outcome.action === "write") {
    deps.stdout(outcome.sequence);
  }
}

/**
 * An OSC string runs until its terminator, so a control character inside the name cuts the
 * sequence short and leaves the rest of it as input to the terminal. A title is one line of
 * text; anything below `0x20`, plus `DEL`, is dropped rather than escaped.
 */
function cleaned(name: string): string {
  return [...name]
    .filter((character) => character >= " " && character !== "\u007f")
    .join("")
    .trim();
}

export type TitleOutcome = { action: "write"; reason: string; sequence: string } | { action: "skip"; reason: string };
