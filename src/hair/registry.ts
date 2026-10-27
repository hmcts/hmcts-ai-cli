import { join } from "node:path";
import type { Clock } from "../system/clock.js";
import type { Env } from "../system/env.js";
import type { Fs } from "../system/fs.js";

export const REGISTRY_FILE = "sessions.jsonl";
export const CLAIMS_DIR = "hair-claims";
export const REGISTRY_FILE_MODE = 0o600;

/**
 * Past this many lines the registry is a candidate for being rewritten to one line per
 * session. The rewrite is the one operation that can lose a concurrent append, so the
 * threshold is sized to keep it rare against how fast the file grows.
 */
export const COMPACTION_THRESHOLD = 2000;

/**
 * How long after its last activity an open record is still worth offering. Past this it is
 * retired: dropped by the next compaction, and skipped (unprobed) by `hair` before then.
 * Nothing else retires an open record, and retirement costs only the automatic offer —
 * Claude Code still holds the transcript, so `claude -r` finds the conversation regardless.
 */
export const RESTORE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Pure: an open record nobody has touched inside the window is not one to hand back. */
export function retired(record: SessionRecord, now: number): boolean {
  return now - record.at > RESTORE_WINDOW_MS;
}

/**
 * `~/.claude` rather than hai's state dir: it is one of the few paths bind-mounted across
 * the host/container boundary the hook and the `hair` reading it sit on opposite sides of.
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
 * record themselves with no lock. Later lines win, which is what makes the hook idempotent
 * and lets a tombstone appended after a registration close it.
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
    ...text("name", parsed.name),
    ...text("host", parsed.host),
    ...text("container", parsed.container),
    ...text("slug", parsed.slug)
  };
}

/** Absent rather than empty, so a record carries no field it could not fill. */
function text<K extends string>(key: K, value: unknown): Record<K, string> | Record<string, never> {
  return typeof value === "string" && value !== "" ? ({ [key]: value } as Record<K, string>) : {};
}

export function recordLine(record: SessionRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * The records still worth anything: open, and touched inside the window. The one definition
 * of "worth keeping", so a record cannot be dropped by the compaction and offered by the
 * restore.
 */
export function keptRecords(records: SessionRecord[], now: number): SessionRecord[] {
  return records.filter((record) => record.state === "open" && !retired(record, now));
}

export function lineCount(text: string | null): number {
  return text === null ? 0 : text.split("\n").filter((line) => line.trim() !== "").length;
}

export function compacted(records: SessionRecord[], now: number): string {
  return keptRecords(records, now).map(recordLine).join("");
}

/**
 * Pure: whether a rewrite is worth its risk. Long *and* at least halved by the rewrite —
 * without the second test, an open set larger than the threshold leaves the length test
 * permanently true while the rewrite removes nothing, so it would fire on every hook.
 */
export function shouldCompact(input: { lines: number; keeping: number }): boolean {
  return input.lines >= COMPACTION_THRESHOLD && input.keeping * 2 <= input.lines;
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
 * Written to a temporary file and renamed, so a reader never sees a half-written registry.
 * An append landing between the read and the rename is lost. The temporary name carries the
 * pid, so two sessions compacting at once cannot write to the same path.
 */
export async function compactRegistry(deps: { fs: Fs; env: Env; pid: number; clock: Clock }, records: SessionRecord[]): Promise<void> {
  const path = registryPath(deps.env);
  if (path === null) {
    return;
  }
  const temp = `${path}.${deps.pid}.tmp`;
  await deps.fs.writeText(temp, compacted(records, deps.clock.now()), { mode: REGISTRY_FILE_MODE });
  await deps.fs.rename(temp, path);
}

export interface SessionRecord {
  /** Claude Code's own conversation id, which is what `claude -r` takes. */
  sessionId: string;
  /** The directory the conversation belongs to; `hair` moves there before resuming. */
  cwd: string;
  /**
   * What the conversation is called, and what `hair` restores the terminal tab title from.
   * The `-n/--name` hai read off the argv; the transcript's own name wins at restore time.
   */
  name?: string;
  /**
   * `open` is a conversation a human was driving and nothing has since closed. A clean
   * exit appends `closed`; a reboot cannot, so "still open" *is* the crash signal.
   */
  state: "open" | "closed";
  at: number;
  /** The owning `claude` process, from the hook's `CLAUDE_PID`. Liveness is the reaper. */
  pid: number;
  /**
   * The PID namespace the pid is meaningful in; the hook that writes this often runs in a
   * different one from the `hair` that reads it.
   */
  host?: string;
  /**
   * The hai container the session ran in, when it ran in one. A pid cannot be asked about
   * across a namespace but a container can.
   */
  container?: string;
  /**
   * The project directory Claude Code filed this conversation's transcripts under, taken out
   * of the hook payload's own `transcript_path`. The slug and not the whole path, because
   * `~/.claude` is bind-mounted into a container session at a different absolute path.
   */
  slug?: string;
}
