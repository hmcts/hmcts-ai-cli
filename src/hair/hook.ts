import type { Logger } from "../log/logger.js";
import type { Clock } from "../system/clock.js";
import type { Env } from "../system/env.js";
import type { Fs } from "../system/fs.js";
import { releaseClaim } from "./claim.js";
import { appendRecord, compactRegistry, keptRecords, readRegistry, type SessionRecord, shouldCompact } from "./registry.js";
import { readCustomTitle, transcriptSlug } from "./title.js";

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
 * The `SessionEnd` reasons that mean the conversation itself is over, so its id is no
 * longer one to hand a terminal. Every other reason leaves the entry open.
 *
 * Measured on Claude Code 2.1.304: `SessionEnd` fires on a kill as well as on an exit,
 * reporting `other` — the same reason a finished `-p` run gives. Deregistering on every
 * reason therefore closed the entry of every session that was *killed*, which is exactly
 * the set the registry exists to hold: closing the editor stops the devcontainer, which
 * SIGTERMs every session in it, and after a restart `hair --list` reported "the session
 * was closed cleanly" about every conversation the engineer had had open.
 *
 * The reason field is a closed enum in 2.1.304 — `clear`, `resume`, `logout`,
 * `prompt_input_exit`, `other`, which is both what the hooks reference documents and what
 * the installed binary validates against. `bypass_permissions_disabled` was a sixth and
 * was removed in 2.1.234. Of the five:
 *
 * - `prompt_input_exit` (`/exit`) and `clear` (`/clear`) are the person finishing with
 *   that id — `/clear` ends it and starts a new one, so the old id is not a conversation
 *   to hand anyone.
 * - `other` is a kill, and also a finished `-p` run and a `claude stop` on a background
 *   one. Ignoring it costs nothing for those two, because neither ever registers — hai
 *   gates registration on `CLAUDE_CODE_SESSION_ATTENDED` — so there is no entry of theirs
 *   to leave behind.
 * - `logout` is **not** on the list, and the argument that it should be is the one to
 *   watch for, because it is nearly right: signing out is deliberate, so surely it is the
 *   person ending the session. It is deliberate about *credentials*. The conversation is
 *   untouched and entirely resumable, so an engineer who logs out and straight back in
 *   would find it tombstoned with nothing saying it had ever existed — the exact
 *   asymmetric loss the allow-list is for. Deliberateness is not the test; "done with this
 *   id" is, and `/logout` does not mean it.
 * - `resume` is not on it either, for the same distinction. An interactive `/resume` switch
 *   is deliberate but does not *end* the conversation it leaves; that conversation is still
 *   a real one worth handing back, and while its process lives `restoreDecision` keeps it
 *   out of the way anyway. What it costs is a candidate per switch, which `RESTORE_WINDOW_MS`
 *   is what retires.
 *
 * It is an allow-list rather than a deny-list of `other` because the two mistakes are not
 * symmetrical. A reason wrongly left open costs one stale line the next `hair` offers and
 * the engineer passes over; a reason wrongly deregistered costs the conversation, with no
 * trace that it ever existed. So a sixth reason a later Claude Code invents stays
 * recoverable until someone measures it.
 */
export const CONVERSATION_OVER_REASONS: readonly string[] = ["prompt_input_exit", "clear"];

/**
 * How stale a record's `at` has to be before a prompt restamps it. `at` is *last
 * activity*, not registration time, and this is the throttle that keeps it affordable.
 *
 * It had to become last-activity because the candidate order depends on it. Registration
 * time ranks the wrong conversation first in the ordinary case: A registered at 09:00 and
 * worked in all day, B registered at 16:30 with one question and left idle, both killed at
 * 17:30 — newest-registration-first hands back the one-question conversation and leaves
 * the day's work second, which is the opposite of handing back what was on screen.
 *
 * Restamping on *every* prompt would be a line per prompt, which `COMPACTION_THRESHOLD`
 * would then have to absorb, so it is throttled. Fifteen minutes is the trade: the
 * ordering can be wrong by at most the interval, which is far finer than the gaps it
 * exists to resolve (an hour, in the case above), and a session driven all day costs of
 * the order of thirty lines instead of one per prompt. Shorter buys precision nobody can
 * perceive at the price of running the one risky operation here more often; longer starts
 * losing the idle-versus-active distinction that is the whole point of ordering by
 * recency.
 */
export const ACTIVITY_REFRESH_MS = 15 * 60 * 1000;

/**
 * Pure over the payload, the environment and what the registry already says. First match
 * wins.
 *
 * Registration is on the first `UserPromptSubmit`, not on `SessionStart`. After a reboot
 * every entry looks stale-open, so the registry is only useful if it holds conversations
 * a human actually drove — `SessionStart` fires for every subagent sweep, every `-p`
 * script run and every background job, including the one cft-workspace starts from a
 * `SessionStart` hook on every session, and a registry full of those is a registry nobody
 * can restore from.
 *
 * Deregistration is on `SessionEnd` and only for a `CONVERSATION_OVER_REASONS` reason.
 * The asymmetry is the point — an entry the person closed goes, an entry a kill ended
 * stays, so "still marked open" is the crash signal — but it only holds for the reasons
 * that mean the conversation is over, because `SessionEnd` fires on a kill too.
 *
 * `storedName` is the title `/rename` wrote, read off Claude Code's own
 * `custom-title.json`, and it beats the `-n/--name` hai read off the argv. Measured: `-n`
 * persists nothing at all, so for 333 registered conversations the argv name was empty for
 * every one of them and the registry had no name to restore. Stored also has to win rather
 * than merely fill in, because `hair` puts the record's name *back* on the argv when it
 * resumes: with argv first, the name a session was launched under would re-assert itself
 * on every restore and a later `/rename` could never take effect.
 */
export function hookDecision(input: {
  event: string;
  payload: HookPayload | null;
  env: Env;
  name?: string;
  storedName?: string;
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
    // A `/rename` mid-session moves the name the tab should carry, and `at` alone would not
    // catch it: the throttle below would hold the old name for up to fifteen minutes, and a
    // session killed inside that window would be restored under it for ever. The comparison
    // is against the record this hook would write rather than against the resolved name, so
    // a name the registration normalises away cannot read as a change on every prompt.
    const renamed = existing.name !== record.name;
    if (!renamed && input.now - existing.at < ACTIVITY_REFRESH_MS) {
      // Every prompt fires this hook, and a subagent handing its report back fires it too.
      // The registry only has to hold one line per conversation.
      return { action: "ignore", reason: "the session is already registered and was active recently enough" };
    }
    return {
      action: "register",
      reason: renamed
        ? "the conversation has been renamed, and the registry is what the restored tab title comes from"
        : "the session is still being driven, so when it was last active moves on",
      record
    };
  }
  return {
    action: "register",
    reason: existing === undefined ? "a human drove this session for the first time" : "the session moved to a new process or directory",
    record
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
      // Re-read on every hook, not only on a first registration: `/rename` moves the name
      // mid-conversation, and this is one `Fs.readText` that answers null rather than
      // throwing for an absent file. Keyed on the payload's own `transcript_path`, which is
      // where Claude Code filed the conversation, not on a slug derived from `cwd`.
      storedName: await readCustomTitle(deps, {
        slug: transcriptSlug(payload?.transcript_path),
        cwd: payload?.cwd,
        sessionId: payload?.session_id
      }),
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
      // The claim does go, because the terminal that held it has ended too, and a
      // conversation nobody is sitting in should not need a pid read to be offered again.
      // `claimDecision` would reclaim it anyway, but only on `pidAlive` answering false
      // about the pid `hair` itself had — and a devcontainer's PID namespace starts at 1
      // again on every restart, so that is one needless draw against a reused number.
      // Liveness is still the guard that stops a live session being forked: the registry
      // entry carries the session's own pid and `restoreDecision` reads it.
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

function registration(input: { env: Env; name?: string; storedName?: string; host: string; now: number }, payload: HookPayload, pid: number): SessionRecord {
  return {
    sessionId: payload.session_id!,
    cwd: payload.cwd!,
    state: "open",
    at: input.now,
    pid,
    // The namespace the pid is meaningful in. Without these, `hair` on the host would
    // read a container pid as if it were one of its own.
    ...field("name", input.storedName ?? input.name),
    ...field("host", input.host),
    ...field("container", input.env[CONTAINER_ENV]),
    // Recorded so `resolveNames` can find the stored title at restore time without deriving
    // the slug from a `cwd` that may have moved since. Pure: the payload hands it over.
    ...field("slug", transcriptSlug(payload.transcript_path))
  };
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
  /**
   * `<…>/projects/<slug>/<session-id>.jsonl`, and so the one authoritative statement of
   * which project directory Claude Code filed this conversation under. `transcriptSlug`
   * takes the slug out of it; nothing here reads the file.
   */
  transcript_path?: string;
  hook_event_name?: string;
  /**
   * One of `prompt_input_exit`, `clear`, `resume`, `logout` and `other` — the whole enum
   * in 2.1.304. `other` covers a kill as well as a finished `-p` run, which is why
   * `CONVERSATION_OVER_REASONS` and not "any reason at all" decides a deregistration.
   * Typed as a plain string because a later version may add to the set, and the point of
   * the allow-list is that one it has never heard of still parses.
   */
  reason?: string;
}

/**
 * Four verdicts, because `SessionEnd` has two of its own and conflating them is what the
 * bug was. `interrupted` is "the session is over but the conversation is not": the entry
 * is left untouched and only the claim is released, so it carries the session id rather
 * than a record there is nothing to write.
 */
export type HookOutcome =
  | { action: "ignore"; reason: string }
  | { action: "register"; reason: string; record: SessionRecord }
  | { action: "deregister"; reason: string; record: SessionRecord }
  | { action: "interrupted"; reason: string; sessionId: string };
