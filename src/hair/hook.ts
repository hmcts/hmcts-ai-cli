import type { Logger } from "../log/logger.js";
import type { Clock } from "../system/clock.js";
import type { Env } from "../system/env.js";
import type { Fs } from "../system/fs.js";
import { releaseClaim } from "./claim.js";
import { appendRecord, compactRegistry, keptRecords, readRegistry, type SessionRecord, shouldCompact } from "./registry.js";
import { transcriptSlug } from "./title.js";

export const USER_PROMPT_SUBMIT = "UserPromptSubmit";
export const SESSION_END = "SessionEnd";

/**
 * The only signal that tells a human-driven conversation from a script run: nothing in the
 * `UserPromptSubmit` payload does, and `CLAUDE_CODE_ENTRYPOINT` reports `cli` for `--bg` too.
 */
export const ATTENDED_ENV = "CLAUDE_CODE_SESSION_ATTENDED";

/** The owning `claude` process, not the hook's own: the hook is a short-lived child of it. */
export const OWNER_PID_ENV = "CLAUDE_PID";

/**
 * The container hai started for this session, set as a `--env` in `src/container/run.ts`. A
 * pid recorded in there cannot be asked about from the host, but the container can.
 */
export const CONTAINER_ENV = "HAI_CONTAINER_NAME";

/**
 * The `SessionEnd` reasons that mean the conversation itself is over, so its id is no longer
 * one to hand a terminal. Every other reason leaves the entry open, `SessionEnd` firing on a
 * kill too and reporting `other`. An allow-list, so a reason nobody has measured stays
 * restorable: the test is "done with this id", not "deliberate".
 */
export const CONVERSATION_OVER_REASONS: readonly string[] = ["prompt_input_exit", "clear"];

/**
 * How stale a record's `at` has to be before a prompt restamps it. `at` is *last activity*
 * rather than registration time, because the candidate order is by recency; the throttle is
 * what keeps that from costing a registry line per prompt.
 */
export const ACTIVITY_REFRESH_MS = 15 * 60 * 1000;

/**
 * Pure over the payload, the environment and what the registry already says. First match
 * wins. Registration is on an attended `UserPromptSubmit` rather than `SessionStart`, which
 * also fires for subagent sweeps, `-p` runs and background jobs; deregistration is on a
 * `CONVERSATION_OVER_REASONS` `SessionEnd` alone, so "still marked open" is the crash signal.
 * The hook reads no title: `name` is the argv `-n/--name`, and `resolveName` re-reads the
 * conversation's own transcript at restore time anyway.
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
    const reason = payload.reason ?? "";
    if (!CONVERSATION_OVER_REASONS.includes(reason)) {
      return {
        action: "interrupted",
        reason: `the session ended with ${reason === "" ? "no reason given" : reason}, which is also what a terminated session reports, so its entry stays restorable`,
        sessionId: payload.session_id
      };
    }
    return { action: "deregister", reason: `the person ended the conversation (${reason})`, record: closed(input.now, payload) };
  }
  if (input.event !== USER_PROMPT_SUBMIT) {
    return { action: "ignore", reason: `${input.event === "" ? "no event" : input.event} is not an event hair maintains the registry from` };
  }
  if (input.env[ATTENDED_ENV] !== "1") {
    return { action: "ignore", reason: `${ATTENDED_ENV} is not 1, so nobody is sitting in front of this session` };
  }
  const existing = input.records.find((record) => record.sessionId === payload.session_id);
  const pid = Number(input.env[OWNER_PID_ENV]) || 0;
  const record = registration(input, payload, pid);
  if (existing !== undefined && existing.state === "open" && existing.pid === pid && existing.cwd === payload.cwd) {
    if (input.now - existing.at < ACTIVITY_REFRESH_MS) {
      // Every prompt fires this hook, and a subagent handing its report back fires it too.
      // The registry only has to hold one line per conversation.
      return { action: "ignore", reason: "the session is already registered and was active recently enough" };
    }
    return { action: "register", reason: "the session is still being driven, so when it was last active moves on", record };
  }
  return {
    action: "register",
    reason: existing === undefined ? "a human drove this session for the first time" : "the session moved to a new process or directory",
    record
  };
}

/**
 * A hook must never be what breaks a session, so every path here swallows its error and
 * returns: `hair hook` exits 0 whatever happened.
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
    if (outcome.action === "interrupted") {
      // Nothing is written: the entry stays exactly as it was, which is the crash signal.
      // The claim goes, because the terminal holding it has ended too.
      await releaseClaim(deps, outcome.sessionId);
      return;
    }
    await appendRecord(deps, outcome.record);
    if (outcome.action === "deregister") {
      await releaseClaim(deps, outcome.record.sessionId);
    }
    const next = [...records.filter((record) => record.sessionId !== outcome.record.sessionId), outcome.record];
    if (shouldCompact({ lines, keeping: keptRecords(next, deps.clock.now()).length })) {
      await compactRegistry(deps, next);
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

function registration(input: { env: Env; name?: string; host: string; now: number }, payload: HookPayload, pid: number): SessionRecord {
  return {
    sessionId: payload.session_id!,
    cwd: payload.cwd!,
    state: "open",
    at: input.now,
    pid,
    // The namespace the pid is meaningful in. Without these, `hair` on the host would
    // read a container pid as if it were one of its own.
    ...field("name", input.name),
    ...field("host", input.host),
    ...field("container", input.env[CONTAINER_ENV]),
    // Recorded so `resolveName` can find the transcript at restore time without deriving
    // the slug from a `cwd` that may have moved since.
    ...field("slug", transcriptSlug(payload.transcript_path))
  };
}

/** Absent rather than empty, so a record carries no field it could not fill. */
function field<K extends string>(key: K, value: string | undefined): Record<K, string> | Record<string, never> {
  return value === undefined || value === "" ? {} : ({ [key]: value } as Record<K, string>);
}

/**
 * A *description* of the fields Claude Code sends rather than a check on them:
 * `parsePayload` casts, having established only that the JSON was a non-array object, so
 * anything reading a field here has to guard its own type. No payload carries the session's
 * `-n/--name`, which is why hai puts it on the hook's command line.
 */
export interface HookPayload {
  session_id?: string;
  cwd?: string;
  /**
   * `<…>/projects/<slug>/<session-id>.jsonl`, and so the one authoritative statement of
   * which project directory Claude Code filed this conversation under. `transcriptSlug`
   * takes the slug out of it; nothing here reads the file.
   */
  transcript_path?: string;
  hook_event_name?: string;
  /**
   * Typed as a plain string rather than the enum, because a later version may add to the
   * set and the point of the allow-list is that a reason it has never heard of still parses.
   */
  reason?: string;
}

/**
 * `interrupted` is "the session is over but the conversation is not": the entry is left
 * untouched and only the claim is released, so it carries the session id and not a record.
 */
export type HookOutcome =
  | { action: "ignore"; reason: string }
  | { action: "register"; reason: string; record: SessionRecord }
  | { action: "deregister"; reason: string; record: SessionRecord }
  | { action: "interrupted"; reason: string; sessionId: string };
