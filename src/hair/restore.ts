import { pidAlive } from "../container/lock.js";
import type { Runner } from "../system/runner.js";
import type { SessionRecord } from "./registry.js";

/**
 * Pure over the two things worth knowing about a registered session: whether anything
 * closed it, and whether the process that owned it is still there. First match wins,
 * the same shape as `lockDecision` in src/container/lock.ts.
 *
 * A live pid is *not* a restore candidate. `claude -r` on a running session forks a copy
 * of the conversation rather than attaching to it, so resuming one would hand the
 * engineer a duplicate instead of the session they lost. An unanswerable pid is left
 * alone too — the same rule the transcript lock follows, for the same reason.
 */
export function restoreDecision(input: { record: SessionRecord; alive: boolean | null }): RestoreOutcome {
  if (input.record.state !== "open") {
    return { action: "skip", reason: "the session was closed cleanly" };
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
export function restoreCandidates(input: { records: SessionRecord[]; cwd: string; liveness: Map<string, boolean | null> }): {
  candidates: SessionRecord[];
  skipped: Skipped[];
} {
  const candidates: SessionRecord[] = [];
  const skipped: Skipped[] = [];
  for (const record of input.records) {
    const outcome = restoreDecision({ record, alive: input.liveness.get(record.sessionId) ?? null });
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
 * Liveness, through the same `pidAlive` the transcript lock uses: whether the process
 * that owned the conversation is still there. Liveness beats comparing a recorded boot
 * time because it answers the question that matters and the code already exists — at the
 * cost of a pid the kernel reused after a reboot reading as "still running", which leaves
 * that conversation to be reopened by hand. That is the right way round: the opposite
 * mistake resumes a live session, and `claude -r` forks one rather than attaching.
 */
export async function probeLiveness(deps: { runner: Runner }, records: SessionRecord[]): Promise<Map<string, boolean | null>> {
  const liveness = new Map<string, boolean | null>();
  for (const record of records) {
    // A record with no pid is a registration hai could not read a CLAUDE_PID for, and a
    // session no process owns is a session nobody is running.
    liveness.set(record.sessionId, record.pid === 0 ? false : await pidAlive(deps, record.pid));
  }
  return liveness;
}

function rank(record: SessionRecord, cwd: string): number {
  return record.cwd === cwd ? 0 : 1;
}

/** Only to break a tie, so two terminals walk the candidates in the same order. */
function compare(a: string, b: string): number {
  return a.localeCompare(b);
}

export interface RestoreOutcome {
  action: "restore" | "skip";
  reason: string;
}

export interface Skipped {
  record: SessionRecord;
  reason: string;
}
