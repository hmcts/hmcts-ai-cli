import { containerRunning, pidAlive } from "../container/lock.js";
import type { Fs } from "../system/fs.js";
import type { Runner } from "../system/runner.js";
import type { SessionRecord } from "./registry.js";

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
export function restoreDecision(input: { record: SessionRecord; cwdExists: boolean; alive: boolean | null }): RestoreOutcome {
  if (input.record.state !== "open") {
    return { action: "skip", reason: "the session was closed cleanly" };
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
 * Exact cwd match first, then FIFO. Most of the engineer's terminals share a directory,
 * so cwd is a preference and not a filter: a restored terminal takes the oldest unclaimed
 * conversation whatever directory it belongs to, rather than starting a fresh session and
 * leaving one stranded.
 */
export function restoreCandidates(input: { records: SessionRecord[]; cwd: string; liveness: Map<string, boolean | null>; existingDirs: Set<string> }): {
  candidates: SessionRecord[];
  skipped: Skipped[];
} {
  const candidates: SessionRecord[] = [];
  const skipped: Skipped[] = [];
  for (const record of input.records) {
    const outcome = restoreDecision({
      record,
      cwdExists: input.existingDirs.has(record.cwd),
      alive: input.liveness.get(record.sessionId) ?? null
    });
    if (outcome.action === "restore") {
      candidates.push(record);
    } else {
      skipped.push({ record, reason: outcome.reason });
    }
  }
  return { candidates: candidates.sort((a, b) => rank(a, input.cwd) - rank(b, input.cwd) || a.at - b.at || compare(a.sessionId, b.sessionId)), skipped };
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
 * Only the open records: a tombstone's pid is never asked about, and `restoreDecision`
 * discards them first anyway. One sequential `ps` per record adds up — compaction only
 * rewrites the registry at 500 lines — and these are answers that would be thrown away.
 */
export async function probeLiveness(
  deps: { runner: Runner; logger: { verbose(message: string): void }; host: string | undefined },
  records: SessionRecord[]
): Promise<Map<string, boolean | null>> {
  const liveness = new Map<string, boolean | null>();
  for (const record of records.filter((candidate) => candidate.state === "open")) {
    const plan = livenessPlan({ record, host: deps.host });
    deps.logger.verbose(`${record.sessionId}: ${plan.reason}`);
    liveness.set(record.sessionId, await answer(deps, record, plan));
  }
  return liveness;
}

/** The distinct directories of the open records, so a deleted one is a skip and not a throw. */
export async function probeDirs(deps: { fs: Fs }, records: SessionRecord[]): Promise<Set<string>> {
  const existing = new Set<string>();
  for (const dir of new Set(records.filter((record) => record.state === "open").map((record) => record.cwd))) {
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
