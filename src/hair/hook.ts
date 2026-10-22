import type { Logger } from "../log/logger.js";
import type { Clock } from "../system/clock.js";
import type { Env } from "../system/env.js";
import type { Fs } from "../system/fs.js";
import { releaseClaim } from "./claim.js";
import { appendRecord, COMPACTION_THRESHOLD, compactRegistry, readRegistry, type SessionRecord } from "./registry.js";

export const USER_PROMPT_SUBMIT = "UserPromptSubmit";
export const SESSION_END = "SessionEnd";

/**
 * Measured on Claude Code 2.1.304: the hook's inherited environment is the only thing
 * that tells a conversation a human is driving from a script run. Nothing in the
 * `UserPromptSubmit` payload does — a `claude -p` run and an interactive session submit
 * byte-identical payloads — and `CLAUDE_CODE_ENTRYPOINT` does not either, because a
 * `--bg` session reports `cli` just as an attended one does. This variable was `1` for
 * the interactive session and `0` for both the `-p` and the `--bg` run.
 */
export const ATTENDED_ENV = "CLAUDE_CODE_SESSION_ATTENDED";

/** The owning `claude` process, not the hook's own: the hook is a short-lived child of it. */
export const OWNER_PID_ENV = "CLAUDE_PID";

/**
 * The container hai started for this session, set as a `--env` in `src/container/run.ts`.
 * A pid recorded in there cannot be asked about from the host, but the container can, so
 * this is what a `hair` on the host reads a crashed container session from.
 */
export const CONTAINER_ENV = "HAI_CONTAINER_NAME";

/**
 * Pure over the payload, the environment and what the registry already says. First match
 * wins.
 *
 * Registration is on the first `UserPromptSubmit`, not on `SessionStart`. After a reboot
 * every entry looks stale-open, so the registry is only useful if it holds conversations
 * a human actually drove — `SessionStart` fires for every subagent sweep, every `-p`
 * script run and every background job, including the one cft-workspace starts from a
 * `SessionStart` hook on every session, and a registry full of those is a registry nobody
 * can restore from. Deregistration is on `SessionEnd`, and the asymmetry is the point: a
 * clean exit removes its own entry, a reboot cannot, so "still marked open" is the crash
 * signal.
 */
export function hookDecision(input: {
  event: string;
  payload: HookPayload | null;
  env: Env;
  name?: string;
  host: string;
  now: number;
  records: SessionRecord[];
}): HookOutcome {
  const { payload } = input;
  if (payload === null || payload.session_id === undefined || payload.session_id === "" || payload.cwd === undefined) {
    return { action: "ignore", reason: "the payload carried no session" };
  }
  if (input.event === SESSION_END) {
    // Whatever the reason. `/clear` ends the old id and starts a new one, `/exit` reports
    // `prompt_input_exit` and a finished `-p` run reports `other` — in every case that id
    // is not a conversation a terminal should be told to pick up.
    return { action: "deregister", reason: `the session ended (${payload.reason ?? "no reason given"})`, record: closed(input.now, payload) };
  }
  if (input.event !== USER_PROMPT_SUBMIT) {
    return { action: "ignore", reason: `${input.event === "" ? "no event" : input.event} is not an event hair maintains the registry from` };
  }
  if (input.env[ATTENDED_ENV] !== "1") {
    return { action: "ignore", reason: `${ATTENDED_ENV} is not 1, so nobody is sitting in front of this session` };
  }
  const existing = input.records.find((record) => record.sessionId === payload.session_id);
  const pid = Number(input.env[OWNER_PID_ENV]) || 0;
  if (existing !== undefined && existing.state === "open" && existing.pid === pid && existing.cwd === payload.cwd) {
    // Every prompt fires this hook, and a subagent handing its report back fires it too.
    // The registry only has to hold one line per conversation.
    return { action: "ignore", reason: "the session is already registered" };
  }
  return {
    action: "register",
    reason: existing === undefined ? "a human drove this session for the first time" : "the session moved to a new process or directory",
    record: {
      sessionId: payload.session_id,
      cwd: payload.cwd,
      state: "open",
      at: input.now,
      pid,
      // The namespace the pid is meaningful in. Without these, `hair` on the host would
      // read a container pid as if it were one of its own.
      ...field("name", input.name),
      ...field("host", input.host),
      ...field("container", input.env[CONTAINER_ENV])
    }
  };
}

/**
 * A hook runs under a timeout and must never be what breaks a session, so every path
 * here swallows its error and returns: `hair hook` exits 0 whatever happened. A lost
 * registration costs the engineer one `claude -r` typed by hand; a hook that throws costs
 * them the prompt they were submitting.
 */
export async function runHook(
  deps: { fs: Fs; clock: Clock; env: Env; logger: Logger; hostname: string; pid: number; stdin(): Promise<string> },
  input: { event: string; name?: string }
): Promise<void> {
  try {
    const payload = parsePayload(await deps.stdin());
    const { records, lines } = await readRegistry(deps);
    const outcome = hookDecision({
      event: input.event,
      payload,
      env: deps.env,
      name: input.name,
      host: deps.hostname,
      now: deps.clock.now(),
      records
    });
    deps.logger.verbose(`hair hook ${input.event}: ${outcome.reason}`);
    if (outcome.action === "ignore") {
      return;
    }
    await appendRecord(deps, outcome.record);
    if (outcome.action === "deregister") {
      await releaseClaim(deps, outcome.record.sessionId);
    }
    if (lines >= COMPACTION_THRESHOLD) {
      await compactRegistry(deps, [...records.filter((record) => record.sessionId !== outcome.record.sessionId), outcome.record]);
    }
  } catch (err) {
    deps.logger.verbose(`hair hook ${input.event} did nothing: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function parsePayload(text: string): HookPayload | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as HookPayload) : null;
  } catch {
    return null;
  }
}

function closed(now: number, payload: HookPayload): SessionRecord {
  return { sessionId: payload.session_id!, cwd: payload.cwd!, state: "closed", at: now, pid: 0 };
}

/** Absent rather than empty, so a record carries no field it could not fill. */
function field<K extends string>(key: K, value: string | undefined): Record<K, string> | Record<string, never> {
  return value === undefined || value === "" ? {} : ({ [key]: value } as Record<K, string>);
}

/**
 * The fields Claude Code 2.1.304 actually sends, measured. `UserPromptSubmit` carries
 * `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`,
 * `hook_event_name` and `prompt`; `SessionEnd` carries `session_id`, `transcript_path`,
 * `cwd`, `prompt_id`, `hook_event_name` and `reason`. Neither carries the session's
 * `-n/--name`, which is why hai puts it on the hook's command line.
 */
export interface HookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  /** `prompt_input_exit` on `/exit`, `clear` on `/clear`, `other` otherwise. */
  reason?: string;
}

export type HookOutcome =
  | { action: "ignore"; reason: string }
  | { action: "register"; reason: string; record: SessionRecord }
  | { action: "deregister"; reason: string; record: SessionRecord };
