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
 * threshold exists to keep it rare, and it has to be sized against how fast the file
 * actually grows.
 *
 * It used to say "two lines per conversation — a registration and a tombstone", which was
 * true when a registration was stamped once and never moved. It is not any more: `at` is
 * refreshed as a conversation is driven (`ACTIVITY_REFRESH_MS` in hook.ts), so a session
 * worked in all day appends of the order of thirty lines rather than one. At 500 that
 * turned a rewrite every few weeks into one every day or two, which is the wrong direction
 * for the riskiest operation here, so the threshold moved with the growth rate.
 */
export const COMPACTION_THRESHOLD = 2000;

/**
 * How long after its last activity an open record is still worth offering. Past this it is
 * retired: dropped by the next compaction, and skipped (unprobed) by `hair` before then.
 *
 * Something has to retire open records, because nothing else does any more. Only a reason
 * in `CONVERSATION_OVER_REASONS` writes a tombstone, so every signal-killed session — the
 * set this whole mechanism exists to preserve — and every conversation stepped out of with
 * `/resume` is otherwise permanent. Two things degrade without a bound if they are:
 * `probeLiveness` spawns one sequential `ps` per open record on every `hair` and every
 * `hair --list`, and once the open set alone passes `COMPACTION_THRESHOLD` a compaction
 * can no longer shrink the file, so it would fire on every single hook.
 *
 * Seven days, because the longest ordinary gap between closing an editor and reopening it
 * is a bank-holiday weekend, and this has to cover that: being handed back what was open
 * is the entire feature. Past a week a conversation is stale enough that offering it is a
 * nuisance rather than a rescue. What retirement costs is only the *automatic* offer —
 * Claude Code still holds the transcript, so `claude -r` and its own `/resume` picker find
 * the conversation whatever this file says. That asymmetry is why a week is safe to pick
 * rather than a month: nothing is destroyed, only un-offered.
 */
export const RESTORE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Pure: an open record nobody has touched inside the window is not one to hand back. */
export function retired(record: SessionRecord, now: number): boolean {
  return now - record.at > RESTORE_WINDOW_MS;
}

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
 * The records still worth anything: open, and touched inside the window. A tombstone
 * exists to cancel a registration, and a retired record is one nobody is restoring. This
 * is the one definition of "worth keeping" — what a compaction writes, what `hair` probes
 * and what it offers all come from here, so a record cannot be dropped by one and offered
 * by another.
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
 * Pure: whether a rewrite is worth its risk. Long *and* at least halved by the rewrite.
 *
 * The length test alone was enough while every conversation ended in a tombstone, because
 * the rewrite could then always drop something. It is not now: an open set larger than the
 * threshold makes `lines >= COMPACTION_THRESHOLD` permanently true while the rewrite
 * removes nothing, so the one operation that can lose a concurrent append would run on
 * every register and every deregister instead of once in weeks. Requiring the rewrite to
 * halve the file bounds that for good — after one, the file has to double before another
 * can qualify — so the work between compactions is proportional to the file, whatever the
 * open set does.
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
 * Written to a temporary file and renamed, so a reader never sees a half-written
 * registry. An append that lands between the read and the rename is lost, which is why
 * this only runs once the file is long: losing one registration is a session the engineer
 * reopens by hand, and the alternative is a file that grows for ever.
 *
 * The temporary name carries the pid. One shared `.tmp` would let two sessions compacting
 * at once write different content to the same path before either renamed it, which is
 * exactly the half-written file the rename is there to rule out.
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
   * It is the title `/rename` persisted in Claude Code's own `custom-title.json`, falling
   * back to the `-n/--name` hai read off the argv. No hook payload carries either.
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
   * The hostname the pid lives on, which is what makes the pid comparable: a pid means
   * nothing outside its own PID namespace, and the hook that writes this often runs in a
   * different one from the `hair` that reads it.
   */
  host?: string;
  /**
   * The hai container the session ran in, when it ran in one. A pid cannot be asked about
   * across a namespace but a container can, so this is what lets a `hair` on the host tell
   * that a reboot took the session with its container — the same thing `lockDecision`
   * uses the field for.
   */
  container?: string;
  /**
   * The directory Claude Code filed this conversation's transcripts under, taken out of the
   * hook payload's own `transcript_path`. It is what `resolveNames` finds the stored title
   * through at restore time, and it is recorded rather than derived because Claude Code
   * fixes it when the session starts while `cwd` can move underneath it — a conversation
   * that registers at a workspace root and then `cd`s into a worktree rewrites its `cwd`
   * and a slug derived from that stops matching.
   *
   * The slug and not the whole path, because `~/.claude` is bind-mounted into a container
   * session at a different absolute path, so a path recorded inside does not resolve for a
   * `hair` on the host. The `~/.claude` root is recomposed by whoever reads it, the same way
   * `registryPath` and `claimPath` do.
   */
  slug?: string;
}
