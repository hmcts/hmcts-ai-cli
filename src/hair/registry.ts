import { join } from "node:path";
import type { Env } from "../system/env.js";
import type { Fs } from "../system/fs.js";

export const REGISTRY_FILE = "sessions.jsonl";
export const CLAIMS_DIR = "hair-claims";
export const REGISTRY_FILE_MODE = 0o600;

/**
 * Past this many lines the registry is rewritten to one line per session. It only grows
 * by two lines per conversation — a registration and a tombstone — so this is weeks of
 * work, and the rewrite is the one operation that can lose a concurrent append.
 */
export const COMPACTION_THRESHOLD = 500;

/**
 * The registry lives under `~/.claude`, not in hai's state directory. The hook that
 * writes it runs *inside* the container session while `hair` runs on the host, and
 * `~/.claude` is one of the few paths bind-mounted across that boundary — so the state
 * dir would give the two halves two different files. It also has to survive the container
 * rebuild a reboot forces, which the state dir does and a container's own disk does not.
 * `lockPath` in src/container/lock.ts keeps host-visible state under `~/.claude` for the
 * same reason.
 */
export function registryDir(env: Env): string | null {
  const home = env.HOME;
  return home === undefined || home === "" ? null : join(home, ".claude");
}

export function registryPath(env: Env): string | null {
  const dir = registryDir(env);
  return dir === null ? null : join(dir, REGISTRY_FILE);
}

/** One file per session id, because `O_EXCL` on it is the claim. */
export function claimPath(env: Env, sessionId: string): string | null {
  const dir = registryDir(env);
  return dir === null ? null : join(dir, CLAIMS_DIR, `${sessionId}.json`);
}

/**
 * JSONL rather than JSON so a registration is one `O_APPEND` write and ten sessions can
 * record themselves with no lock. Later lines win, which is what makes the hook
 * idempotent: `SessionStart` fires again on `clear` and `compact`, a prompt may be
 * submitted a hundred times, and a tombstone appended after a registration closes it.
 */
export function parseRegistry(text: string | null): SessionRecord[] {
  const byId = new Map<string, SessionRecord>();
  for (const line of (text ?? "").split("\n")) {
    const record = parseRecord(line);
    if (record !== null) {
      byId.set(record.sessionId, record);
    }
  }
  return [...byId.values()];
}

export function parseRecord(line: string): SessionRecord | null {
  if (line.trim() === "") {
    return null;
  }
  let parsed: Partial<SessionRecord>;
  try {
    parsed = JSON.parse(line) as Partial<SessionRecord>;
  } catch {
    return null;
  }
  const { sessionId, cwd, state } = parsed;
  if (typeof sessionId !== "string" || sessionId === "" || typeof cwd !== "string" || (state !== "open" && state !== "closed")) {
    return null;
  }
  return {
    sessionId,
    cwd,
    state,
    at: Number(parsed.at) || 0,
    pid: Number(parsed.pid) || 0,
    ...(typeof parsed.name === "string" && parsed.name !== "" ? { name: parsed.name } : {})
  };
}

export function recordLine(record: SessionRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export function openRecords(records: SessionRecord[]): SessionRecord[] {
  return records.filter((record) => record.state === "open");
}

export function lineCount(text: string | null): number {
  return text === null ? 0 : text.split("\n").filter((line) => line.trim() !== "").length;
}

/** Only the open records are worth keeping: a tombstone exists to cancel a registration. */
export function compacted(records: SessionRecord[]): string {
  return openRecords(records).map(recordLine).join("");
}

export async function readRegistry(deps: { fs: Fs; env: Env }): Promise<{ records: SessionRecord[]; lines: number }> {
  const path = registryPath(deps.env);
  const text = path === null ? null : await deps.fs.readText(path);
  return { records: parseRegistry(text), lines: lineCount(text) };
}

/** Append-only, so concurrent hooks in ten sessions never need to agree on anything. */
export async function appendRecord(deps: { fs: Fs; env: Env }, record: SessionRecord): Promise<void> {
  const path = registryPath(deps.env);
  if (path === null) {
    return;
  }
  await deps.fs.mkdirp(registryDir(deps.env)!);
  await deps.fs.appendText(path, recordLine(record), { mode: REGISTRY_FILE_MODE });
}

/**
 * Written to a temporary file and renamed, so a reader never sees a half-written
 * registry. An append that lands between the read and the rename is lost, which is why
 * this only runs once the file is long: losing one registration is a session the engineer
 * reopens by hand, and the alternative is a file that grows for ever.
 */
export async function compactRegistry(deps: { fs: Fs; env: Env }, records: SessionRecord[]): Promise<void> {
  const path = registryPath(deps.env);
  if (path === null) {
    return;
  }
  const temp = `${path}.tmp`;
  await deps.fs.writeText(temp, compacted(records), { mode: REGISTRY_FILE_MODE });
  await deps.fs.rename(temp, path);
}

export interface SessionRecord {
  /** Claude Code's own conversation id, which is what `claude -r` takes. */
  sessionId: string;
  /** The directory the conversation belongs to; `hair` moves there before resuming. */
  cwd: string;
  /** `-n/--name`, when the session was given one. No hook payload carries it. */
  name?: string;
  /**
   * `open` is a conversation a human was driving and nothing has since closed. A clean
   * exit appends `closed`; a reboot cannot, so "still open" *is* the crash signal.
   */
  state: "open" | "closed";
  at: number;
  /** The owning `claude` process, from the hook's `CLAUDE_PID`. Liveness is the reaper. */
  pid: number;
}
