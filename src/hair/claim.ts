import { pidAlive } from "../container/lock.js";
import type { Logger } from "../log/logger.js";
import type { Clock } from "../system/clock.js";
import type { Env } from "../system/env.js";
import type { Fs } from "../system/fs.js";
import type { Runner } from "../system/runner.js";
import { claimPath, REGISTRY_FILE_MODE, registryDir, type SessionRecord } from "./registry.js";

export const CLAIM_DIR_MODE = 0o700;

/**
 * Pure over an existing claim: whose it is and whether its process is still there.
 * Same shape and same ordering as `lockDecision` in src/container/lock.ts, and for the
 * same reason — a stale holder is reclaimed, an unanswerable one is not.
 *
 * This is not the transcript lock widened. That lock keys on the project slug and asks
 * "may this session write these transcripts at all", answering refuse or reclaim for the
 * whole run; a claim keys on one session id and answers "is this conversation mine to
 * resume", where the right response to a no is to try the next conversation. Two keys,
 * two outcomes, two lifetimes.
 */
export function claimDecision(input: { existing: ClaimFile | null; host: string; alive: boolean | null }): ClaimOutcome {
  if (input.existing === null) {
    return { action: "take", reason: "nothing holds this conversation" };
  }
  if (input.existing.host !== input.host) {
    // A claimer's pid is in the claimer's PID namespace, same as a session's. Reclaiming
    // on a liveness answer from the wrong namespace is how two terminals both decide a
    // conversation is theirs, and `claude -r` forks rather than attaches.
    return { action: "taken", reason: `another terminal on ${input.existing.host ?? "an unnamed host"} claimed it` };
  }
  if (input.alive === false) {
    return { action: "reclaim", reason: `the terminal that claimed it (pid ${input.existing.pid}) is gone` };
  }
  return { action: "taken", reason: `another terminal (pid ${input.existing.pid}) claimed it` };
}

export function parseClaim(contents: string | null): ClaimFile | null {
  if (contents === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(contents) as Partial<ClaimFile>;
    const pid = Number(parsed.pid);
    if (!Number.isFinite(pid)) {
      return null;
    }
    return { pid, at: Number(parsed.at) || 0, ...(typeof parsed.host === "string" && parsed.host !== "" ? { host: parsed.host } : {}) };
  } catch {
    return null;
  }
}

export function claimContents(input: { pid: number; at: number; host: string }): string {
  return `${JSON.stringify({ pid: input.pid, at: input.at, host: input.host })}\n`;
}

/**
 * Walks the candidates in order and returns the first one this process won. The claim is
 * committed *before* the handover, because the resumed session's own hook re-registers it
 * as open within seconds: a claim taken afterwards would let the next terminal pick the
 * same id, and `claude -r` on a live session forks a copy rather than attaching, so the
 * engineer would get duplicates of one conversation instead of their ten distinct ones.
 *
 * There is no shell to run `flock` through, so the primitive is `O_EXCL` on a file named
 * after the session — exactly one creator wins. Reclaiming a stale claim goes through a
 * rename, which is the other atomic operation available: the loser of a rename race finds
 * the file already gone and moves on rather than both terminals deciding it was theirs.
 */
export async function claimFirst(
  deps: { fs: Fs; clock: Clock; runner: Runner; logger: Logger; env: Env; pid: number; hostname: string },
  candidates: SessionRecord[]
): Promise<SessionRecord | null> {
  const dir = registryDir(deps.env);
  if (dir === null) {
    return null;
  }
  for (const record of candidates) {
    if (await claimOne(deps, record)) {
      return record;
    }
  }
  return null;
}

async function claimOne(
  deps: { fs: Fs; clock: Clock; runner: Runner; logger: Logger; env: Env; pid: number; hostname: string },
  record: SessionRecord
): Promise<boolean> {
  const path = claimPath(deps.env, record.sessionId)!;
  const contents = claimContents({ pid: deps.pid, at: deps.clock.now(), host: deps.hostname });
  await deps.fs.mkdirp(dirOf(path), { mode: CLAIM_DIR_MODE });
  if (await deps.fs.createExclusive(path, contents, { mode: REGISTRY_FILE_MODE })) {
    deps.logger.verbose(`claimed ${record.sessionId}: nothing held it`);
    return true;
  }
  const existing = parseClaim(await deps.fs.readText(path));
  const outcome = claimDecision({ existing, host: deps.hostname, alive: existing === null ? null : await pidAlive(deps, existing.pid) });
  deps.logger.verbose(`${record.sessionId}: ${outcome.reason}`);
  if (outcome.action === "taken") {
    return false;
  }
  // Rename first: whoever moves the stale claim out of the way owns the right to replace
  // it, and the loser's rename fails because the file is already gone.
  try {
    await deps.fs.rename(path, `${path}.${deps.pid}.stale`);
  } catch {
    deps.logger.verbose(`${record.sessionId}: another terminal reclaimed it first`);
    return false;
  }
  await deps.fs.remove(`${path}.${deps.pid}.stale`);
  return await deps.fs.createExclusive(path, contents, { mode: REGISTRY_FILE_MODE });
}

/** A claim is released by the same hook that closes the registry entry. */
export async function releaseClaim(deps: { fs: Fs; env: Env }, sessionId: string): Promise<void> {
  const path = claimPath(deps.env, sessionId);
  if (path !== null) {
    await deps.fs.remove(path);
  }
}

function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

export interface ClaimFile {
  pid: number;
  /** The namespace the pid is meaningful in, so a claim is never reclaimed on a foreign one. */
  host?: string;
  at: number;
}

export interface ClaimOutcome {
  action: "take" | "reclaim" | "taken";
  reason: string;
}
