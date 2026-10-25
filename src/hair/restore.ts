import { containerRunning, pidAlive } from "../container/lock.js";
import type { Fs } from "../system/fs.js";
import type { Runner } from "../system/runner.js";
import { keptRecords, retired, type SessionRecord } from "./registry.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Pure over the three things worth knowing about a registered session: whether anything
 * closed it, whether the directory it belongs to is still there, and whether the process
 * that owned it is still running. First match wins, the same shape as `lockDecision` in
 * src/container/lock.ts.
 *
 * A live pid is *not* a restore candidate. `claude -r` on a running session forks a copy
 * of the conversation rather than attaching to it, so resuming one would hand the
 * engineer a duplicate instead of the session they lost. An unanswerable pid is left
 * alone too — the same rule the transcript lock follows, for the same reason.
 */
export function restoreDecision(input: { record: SessionRecord; now: number; cwdExists: boolean; alive: boolean | null }): RestoreOutcome {
  if (input.record.state !== "open") {
    return { action: "skip", reason: "the session was closed cleanly" };
  }
  if (retired(input.record, input.now)) {
    // Ahead of the probes, and the reason nothing probed it: a retired record costs no
    // `ps` and no `stat`. `claude -r` still finds the conversation; this only stops `hair`
    // offering it unasked.
    return { action: "skip", reason: `nothing has touched it for ${days(input.now - input.record.at)} days, so it is not a conversation to hand back` };
  }
  if (!input.cwdExists) {
    // Decided here, before any claim is taken. `process.chdir` throws on a missing
    // directory, and a worktree or a clone being deleted under a registered conversation
    // is routine — so a claim taken first and a chdir that then throws would end `hair`
    // with the claim held, and the next run would reclaim the same record and fail again,
    // for every conversation, until someone hand-edited the registry.
    return { action: "skip", reason: `its directory ${input.record.cwd} is gone, so there is nowhere to resume it` };
  }
  if (input.alive === true) {
    return { action: "skip", reason: `pid ${input.record.pid} is still running, so the session is live` };
  }
  if (input.alive === null) {
    return { action: "skip", reason: `whether pid ${input.record.pid} is alive cannot be told, so the session is left alone` };
  }
  return { action: "restore", reason: `pid ${input.record.pid} is gone but the session was never closed` };
}

/**
 * Exact cwd match first, then most recent first. Most of the engineer's terminals share a
 * directory, so cwd is a preference and not a filter: a restored terminal takes a waiting
 * conversation whatever directory it belongs to, rather than starting a fresh session and
 * leaving one stranded.
 *
 * Within that, the newest goes first, because nothing retires an open record. A
 * conversation stepped out of with an interactive `/resume` stays open by design (see
 * `CONVERSATION_OVER_REASONS`), and one abandoned three weeks ago was never cleanly ended
 * either, so the pile of candidates drifts above the number of terminals and never
 * shrinks. Oldest-first handed each terminal the stalest thing in it — an engineer with
 * ten tabs got ten conversations from weeks ago while the ten they actually had open sat
 * unclaimed behind them, which is the opposite of giving back what was open. Newest-first
 * hands back the conversations that were live most recently, which are overwhelmingly the
 * ones that were on screen, and lets the stale ones sink to the bottom where they cost
 * nothing.
 */
export function restoreCandidates(input: {
  records: SessionRecord[];
  cwd: string;
  now: number;
  liveness: Map<string, boolean | null>;
  existingDirs: Set<string>;
}): {
  candidates: SessionRecord[];
  skipped: Skipped[];
} {
  const candidates: SessionRecord[] = [];
  const skipped: Skipped[] = [];
  for (const record of input.records) {
    const outcome = restoreDecision({
      record,
      now: input.now,
      cwdExists: input.existingDirs.has(record.cwd),
      alive: input.liveness.get(record.sessionId) ?? null
    });
    if (outcome.action === "restore") {
      candidates.push(record);
    } else {
      skipped.push({ record, reason: outcome.reason });
    }
  }
  return { candidates: candidates.sort((a, b) => rank(a, input.cwd) - rank(b, input.cwd) || b.at - a.at || compare(a.sessionId, b.sessionId)), skipped };
}

export function describeCandidate(record: SessionRecord, cwd: string): string {
  const here = record.cwd === cwd ? "this directory" : record.cwd;
  return `${record.sessionId}  ${record.name ?? "(unnamed)"}  ${here}`;
}

/**
 * How a record's pid can be asked about at all, pure over where it was written and where
 * we are standing. A pid only means something in its own PID namespace, and the two
 * halves of this feature are routinely in different ones: the hook runs inside the
 * container session and records its `CLAUDE_PID`, while `hair` may run on the host, where
 * `buildDockerArgs` passes no `--pid=host`. Both directions of that mistake bite. A
 * container pid that happens to exist on the host — low pids are kernel threads, and
 * after a reboot they are exactly the numbers that come back — hides a crashed
 * conversation for good; a container pid absent on the host reads as gone, so `hair`
 * claims a *live* session and `claude -r` forks it, which is the one outcome this whole
 * design exists to prevent.
 *
 * So: the pid is probed only when the record was written where we are standing.
 * Otherwise, a record that names the hai container it ran in can still be answered
 * definitively through Docker — a container that is gone took its session with it, which
 * is what makes the bare-host flow work at all, since a reboot removes every one of them.
 * Anything else is unanswerable, and `restoreDecision` already leaves those alone.
 */
export function livenessPlan(input: { record: SessionRecord; host: string | undefined }): LivenessPlan {
  if (input.record.pid === 0) {
    // A registration hai could not read a CLAUDE_PID for. Nothing to ask, and "no pid" is
    // not "no process": the session may well be the one running in this very terminal.
    return { probe: "none", reason: "the registration recorded no owning pid" };
  }
  if (input.record.host !== undefined && input.record.host === input.host) {
    return { probe: "pid", reason: `pid ${input.record.pid} is in this namespace (${input.host})` };
  }
  if (input.record.container !== undefined) {
    return { probe: "container", reason: `pid ${input.record.pid} belongs to the ${input.record.container} container` };
  }
  return { probe: "none", reason: `pid ${input.record.pid} was recorded on ${input.record.host ?? "an unnamed host"}, which cannot be compared with this one` };
}

/**
 * Only the records `keptRecords` says are worth anything: a tombstone's pid is never asked
 * about, nor a retired record's, and `restoreDecision` discards both ahead of liveness
 * anyway. One sequential `ps` per record adds up, and bounding this list is most of why
 * open records are retired at all — without it the probe count is every conversation the
 * engineer has ever had, for ever, on every `hair --list`.
 */
export async function probeLiveness(
  deps: { runner: Runner; logger: { verbose(message: string): void }; host: string | undefined; now: number },
  records: SessionRecord[]
): Promise<Map<string, boolean | null>> {
  const liveness = new Map<string, boolean | null>();
  for (const record of keptRecords(records, deps.now)) {
    const plan = livenessPlan({ record, host: deps.host });
    deps.logger.verbose(`${record.sessionId}: ${plan.reason}`);
    liveness.set(record.sessionId, await answer(deps, record, plan));
  }
  return liveness;
}

/** The distinct directories of the kept records, so a deleted one is a skip and not a throw. */
export async function probeDirs(deps: { fs: Fs; now: number }, records: SessionRecord[]): Promise<Set<string>> {
  const existing = new Set<string>();
  for (const dir of new Set(keptRecords(records, deps.now).map((record) => record.cwd))) {
    if (await deps.fs.exists(dir)) {
      existing.add(dir);
    }
  }
  return existing;
}

async function answer(deps: { runner: Runner }, record: SessionRecord, plan: LivenessPlan): Promise<boolean | null> {
  if (plan.probe === "pid") {
    return await pidAlive(deps, record.pid);
  }
  if (plan.probe === "container") {
    // False only when Docker said "no such object": a container that is gone is a session
    // that is gone. True or unanswerable both leave the conversation alone.
    return (await containerRunning(deps, record.container!)) === false ? false : null;
  }
  return null;
}

function rank(record: SessionRecord, cwd: string): number {
  return record.cwd === cwd ? 0 : 1;
}

/** Whole days, because the window is a week and "7.3" says nothing "7" does not. */
function days(elapsed: number): number {
  return Math.floor(elapsed / MS_PER_DAY);
}

/** Only to break a tie, so two terminals walk the candidates in the same order. */
function compare(a: string, b: string): number {
  return a.localeCompare(b);
}

export interface LivenessPlan {
  probe: "pid" | "container" | "none";
  reason: string;
}

export interface RestoreOutcome {
  action: "restore" | "skip";
  reason: string;
}

export interface Skipped {
  record: SessionRecord;
  reason: string;
}
