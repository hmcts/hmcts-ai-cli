import { join } from "node:path";
import type { Logger } from "../log/logger.js";
import type { Clock } from "../system/clock.js";
import type { Env } from "../system/env.js";
import type { Fs } from "../system/fs.js";
import type { Runner } from "../system/runner.js";
import { STATE_DIR_MODE, STATE_FILE_MODE, statePath } from "../system/state-dir.js";
import { pidAlive } from "./lock.js";

/**
 * Who is attached to a container: one marker file per hai process, named for its pid. The
 * pids are all the host's, so `ps` answers the same way on Linux and on Docker Desktop, where
 * a container's own process table says nothing about which `hai` is on the other end of it.
 */
export function attachedDir(env: Env, sessionName: string): string {
  return join(statePath(env, "sessions"), sessionName);
}

export function markerPath(env: Env, sessionName: string, pid: number): string {
  return join(attachedDir(env, sessionName), String(pid));
}

/** Pure over the liveness of every other marker. Unanswerable counts as attached: a container left behind is the safer mistake. */
export function othersDecision(liveness: Array<boolean | null>): { attached: boolean; reason: string } {
  const alive = liveness.filter((answer) => answer === true).length;
  if (alive > 0) {
    return { attached: true, reason: `${alive} other session(s) still attached` };
  }
  if (liveness.some((answer) => answer === null)) {
    return { attached: true, reason: "could not tell whether another session is still attached" };
  }
  return { attached: false, reason: "no other session is attached" };
}

export async function registerSession(deps: { fs: Fs; clock: Clock; env: Env }, input: { sessionName: string; pid: number }): Promise<void> {
  await deps.fs.mkdirp(attachedDir(deps.env, input.sessionName), { mode: STATE_DIR_MODE });
  await deps.fs.writeText(markerPath(deps.env, input.sessionName, input.pid), `${JSON.stringify({ pid: input.pid, at: deps.clock.now() })}\n`, {
    mode: STATE_FILE_MODE
  });
}

/** Removes this session's marker, then reports whether any other still stands for a live process. Markers of dead ones are cleared on the way. */
export async function leaveSession(deps: { fs: Fs; runner: Runner; env: Env; logger: Logger }, input: { sessionName: string; pid: number }): Promise<boolean> {
  await deps.fs.remove(markerPath(deps.env, input.sessionName, input.pid));
  const liveness: Array<boolean | null> = [];
  for (const entry of await deps.fs.listDir(attachedDir(deps.env, input.sessionName))) {
    const pid = Number(entry.name);
    if (!Number.isInteger(pid) || pid === input.pid) {
      continue;
    }
    const answer = await pidAlive(deps, pid);
    if (answer === false) {
      await deps.fs.remove(markerPath(deps.env, input.sessionName, pid));
    }
    liveness.push(answer);
  }
  const decision = othersDecision(liveness);
  deps.logger.verbose(`${input.sessionName}: ${decision.reason}`);
  return decision.attached;
}
