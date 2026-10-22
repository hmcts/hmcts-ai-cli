import { join } from "node:path";
import type { Logger } from "../log/logger.js";
import type { Clock } from "../system/clock.js";
import type { Fs } from "../system/fs.js";
import type { Runner } from "../system/runner.js";
import { projectSlug } from "./session.js";

export const LOCK_FILE = ".hai.lock";

export const CONCURRENT_REFUSAL =
  "another session already holds this repo's Claude Code transcripts. The repo is mounted at its host path, so both would write the same conversation. " +
  "Either finish that session, or run with HAI_ALLOW_CONCURRENT=1 to share the history anyway.";

/**
 * Pure over the three things worth knowing about an existing lock: whose it is, whether
 * its container is still there and whether its process is. First match wins.
 */
export function lockDecision(input: {
  existing: LockFile | null;
  sessionName: string;
  allowConcurrent: boolean;
  containerRunning: boolean | null;
  pidAlive: boolean | null;
}): LockOutcome {
  if (input.allowConcurrent) {
    return { action: "skip", reason: "HAI_ALLOW_CONCURRENT=1, so no transcript lock is taken" };
  }
  if (input.existing === null) {
    return { action: "take", reason: "no other session holds this repo's transcripts" };
  }
  if (input.existing.container === input.sessionName) {
    return { action: "reclaim", reason: "the lock is this session's own, from a previous run" };
  }
  if (input.containerRunning === false) {
    return { action: "reclaim", reason: `the container that held the lock (${input.existing.container}) is gone` };
  }
  if (input.pidAlive === false) {
    return { action: "reclaim", reason: `the process that held the lock (pid ${input.existing.pid}) is gone` };
  }
  return { action: "refuse", reason: CONCURRENT_REFUSAL };
}

export function lockPath(input: { home: string; workdir: string }): string {
  return join(input.home, ".claude", "projects", projectSlug(input.workdir), LOCK_FILE);
}

export function parseLock(contents: string | null): LockFile | null {
  if (contents === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(contents) as Partial<LockFile>;
    const pid = Number(parsed.pid);
    if (!Number.isFinite(pid) || typeof parsed.container !== "string") {
      return null;
    }
    return { pid, container: parsed.container, at: Number(parsed.at) || 0 };
  } catch {
    return null;
  }
}

/** Throws on a refusal: there is nothing useful to carry on with. */
export async function takeLock(
  deps: { fs: Fs; clock: Clock; runner: Runner; logger: Logger },
  input: { path: string; sessionName: string; pid: number; allowConcurrent: boolean }
): Promise<Lock> {
  const existing = parseLock(await deps.fs.readText(input.path));
  const outcome = lockDecision({
    existing,
    sessionName: input.sessionName,
    allowConcurrent: input.allowConcurrent,
    containerRunning: existing === null ? null : await containerRunning(deps, existing.container),
    pidAlive: existing === null ? null : await pidAlive(deps, existing.pid)
  });
  deps.logger.verbose(`transcript lock: ${outcome.reason}`);
  if (outcome.action === "refuse") {
    throw new Error(outcome.reason);
  }
  if (outcome.action === "skip") {
    return { path: null };
  }
  await deps.fs.mkdirp(dirOf(input.path));
  await deps.fs.writeText(input.path, `${JSON.stringify({ pid: input.pid, container: input.sessionName, at: deps.clock.now() })}\n`);
  return { path: input.path };
}

export async function releaseLock(deps: { fs: Fs }, lock: Lock): Promise<void> {
  if (lock.path !== null) {
    await deps.fs.remove(lock.path);
  }
}

async function containerRunning(deps: { runner: Runner }, name: string): Promise<boolean | null> {
  const result = await deps.runner.run(["docker", "inspect", "-f", "{{.State.Running}}", name]);
  if (result.code === 0) {
    return result.stdout.trim() === "true";
  }
  // Docker says "No such object" with exit 1, which is a definite no. Anything else —
  // no docker, no daemon — leaves the question open, and an open question is not grounds
  // to take someone else's lock.
  return /no such object/i.test(result.stderr) ? false : null;
}

async function pidAlive(deps: { runner: Runner }, pid: number): Promise<boolean | null> {
  const result = await deps.runner.run(["ps", "-p", String(pid), "-o", "pid="]);
  if (result.code === 0) {
    return result.stdout.trim() !== "";
  }
  return result.code === 1 ? false : null;
}

function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

export interface LockFile {
  pid: number;
  container: string;
  at: number;
}

export interface LockOutcome {
  action: "take" | "reclaim" | "skip" | "refuse";
  reason: string;
}

export interface Lock {
  /** Null when no lock was taken, so releasing it is a no-op. */
  path: string | null;
}
