import { containerRunning, pidAlive } from "../container/lock.js";
import type { Env } from "../system/env.js";
import type { Fs } from "../system/fs.js";
import type { Runner } from "../system/runner.js";
import { keptRecords, retired, type SessionRecord } from "./registry.js";
import { readSessionTitle } from "./title.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Pure over the three things worth knowing about a registered session: whether anything
 * closed it, whether the directory it belongs to is still there, and whether the process
 * that owned it is still running. First match wins. A live pid is *not* a candidate, because
 * `claude -r` on a running session forks a copy of it; nor is an unanswerable one.
 */
export function restoreDecision(input: { record: SessionRecord; now: number; cwdExists: boolean; alive: boolean | null }): RestoreOutcome {
  if (input.record.state !== "open") {
    return { action: "skip", reason: "the session was closed cleanly" };
  }
  if (retired(input.record, input.now)) {
    // Ahead of the probes, so a retired record costs no `ps` and no `stat`.
    return { action: "skip", reason: `nothing has touched it for ${days(input.now - input.record.at)} days, so it is not a conversation to hand back` };
  }
  if (!input.cwdExists) {
    // Decided before any claim is taken: `process.chdir` throws on a missing directory, and
    // a claim held by a run that then threw would have every later `hair` reclaim and fail.
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
 * Exact cwd match first, then most recent first. cwd is a preference and not a filter: a
 * restored terminal takes a waiting conversation whatever directory it belongs to, rather
 * than starting fresh and leaving one stranded. Newest-first because only `RESTORE_WINDOW_MS`
 * retires an open record, so the pile of candidates is larger than the number of terminals.
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

/** Pure, and the name is data: `resolveName` has already settled which one it is. */
export function describeCandidate(record: SessionRecord, cwd: string): string {
  const here = record.cwd === cwd ? "this directory" : record.cwd;
  return `${record.sessionId}  ${record.name ?? "(unnamed)"}  ${here}`;
}

/**
 * One record with its name read from the conversation's own transcript, which is where Claude
 * Code keeps it, and from the record's `name` only when there is no transcript to read. The
 * transcript is found by the recorded `slug`, otherwise by scanning the project directories.
 * Read-only: the transcripts are Claude Code's own store and hai never writes them.
 */
export async function resolveName(deps: { fs: Fs; env: Env }, record: SessionRecord): Promise<SessionRecord> {
  const name = (await readSessionTitle(deps, { slug: record.slug, sessionId: record.sessionId })) ?? record.name;
  // Left byte-identical when nothing resolved, rather than given a `name: undefined` the
  // record never carried.
  return name === undefined ? record : { ...record, name };
}

/**
 * Every candidate's name, which is what `hair --list` needs and only `hair --list` — the bare
 * form resolves the claimed record alone, each candidate costing a full streamed transcript
 * pass. Safe either way because the candidate order does not depend on a name.
 */
export async function resolveNames(deps: { fs: Fs; env: Env }, candidates: SessionRecord[]): Promise<SessionRecord[]> {
  const resolved: SessionRecord[] = [];
  for (const record of candidates) {
    resolved.push(await resolveName(deps, record));
  }
  return resolved;
}

/**
 * How a record's pid can be asked about at all, pure over where it was written and where we
 * are standing. A pid means nothing outside its own PID namespace and the hook recording one
 * routinely runs in a different one from the `hair` reading it, so: `ps` only when the record
 * was written here, Docker when it names a hai container, and nothing otherwise.
 */
export function livenessPlan(input: { record: SessionRecord; host: string | undefined }): LivenessPlan {
  if (input.record.pid === 0) {
    // "No pid" is not "no process": the session may be the one running in this very terminal.
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
 * Only the records `keptRecords` says are worth anything: one sequential `ps` per record
 * adds up, and bounding this list is most of why open records are retired at all.
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
