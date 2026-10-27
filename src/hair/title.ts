import { basename, dirname, join } from "node:path";
import type { Env } from "../system/env.js";
import type { Fs } from "../system/fs.js";
import { registryDir } from "./registry.js";

/** `~/.claude/projects/<slug>/<session-id>.jsonl` is the transcript; `<slug>` is a project directory. */
export const PROJECTS_DIR = "projects";
export const TRANSCRIPT_SUFFIX = ".jsonl";

/** Claude Code's own per-conversation title file, a sibling directory of the transcript. */
export const CUSTOM_TITLE_FILE = "custom-title.json";

/**
 * The two record types a transcript carries a name in. `custom-title` is what `/rename`
 * writes; `ai-title` is the name Claude Code generates for itself, and it is the one that
 * makes this worth reading at all — measured over 1171 conversations on one machine, 278
 * carry an `ai-title` record, 67 a `custom-title` record and 305 at least one, against 63
 * that have a `custom-title.json` file. Most conversations nobody ever renamed still have a
 * name.
 */
export const AI_TITLE_TYPE = "ai-title";
export const CUSTOM_TITLE_TYPE = "custom-title";

/**
 * The directory Claude Code filed a conversation under, taken out of the `transcript_path`
 * the hook payload carries — `<…>/projects/<slug>/<session-id>.jsonl` — rather than derived
 * from anything hai knows.
 *
 * Claude Code fixes the slug when the session starts, and it does not move afterwards. A
 * slug derived from `cwd` does: the hook re-registers a session whose directory changed, so
 * a conversation that registered at a workspace root and then `cd`-ed into a worktree
 * rewrites its record's `cwd` and stops matching where its transcripts actually live. The
 * payload hands us the answer, so there is no reason to compute one.
 *
 * Only the slug is kept, never the whole path. `~/.claude` is bind-mounted into a container
 * session at a *different* absolute path — `$HOME/.claude` on the host, `/home/hmcts/.claude`
 * inside, per `DEFAULT_HOME_BINDS` — so a path recorded by a hook running inside does not
 * resolve for the `hair` reading it on the host. The slug carries no namespace, and the
 * `~/.claude` root is recomposed by whoever is reading, exactly as `registryPath` and
 * `claimPath` already do. This is the path form of the rule that a pid is never read across
 * a PID namespace.
 */
export function transcriptSlug(transcriptPath: string | undefined): string | undefined {
  if (transcriptPath === undefined || transcriptPath === "") {
    return undefined;
  }
  const slug = basename(dirname(transcriptPath));
  // `dirname` answers "." for a bare filename and "/" for a root-level one, and neither is
  // a project directory.
  return slug === "" || slug === "." ? undefined : slug;
}

/** Pure. Where the transcripts live, under whichever `~/.claude` the reader is standing in. */
export function projectsDir(env: Env): string | null {
  const dir = registryDir(env);
  return dir === null ? null : join(dir, PROJECTS_DIR);
}

/** Pure. One conversation's transcript inside a project directory. */
export function transcriptPath(projectDir: string, sessionId: string): string {
  return join(projectDir, `${sessionId}${TRANSCRIPT_SUFFIX}`);
}

/** Pure. The title file `/rename` writes, a sibling of the transcript rather than of its project. */
export function customTitlePath(projectDir: string, sessionId: string): string {
  return join(projectDir, sessionId, CUSTOM_TITLE_FILE);
}

/**
 * Pure. One transcript line, or null for every line that is not a title record — which is
 * all but a handful of them.
 *
 * The `includes` is not decoration. A transcript runs to 80,000 lines and 198 MB on one
 * engineer's machine, so `JSON.parse` on every line is the whole cost of the scan, while a
 * substring test over a line that cannot be a title record is nothing. The `type` field is
 * still what decides: a line that merely quotes one of these names — a tool result holding
 * this very file, say — parses and is rejected on its type.
 */
export function parseTitleRecord(line: string): TitleRecord | null {
  if (!line.includes(`"${CUSTOM_TITLE_TYPE}"`) && !line.includes(`"${AI_TITLE_TYPE}"`)) {
    return null;
  }
  try {
    // The reads are inside the `try` on purpose: a line of `null` or a number parses fine
    // and then throws on a property, and a transcript holds whatever was appended to it.
    const parsed = JSON.parse(line) as { type?: unknown; customTitle?: unknown; aiTitle?: unknown };
    if (parsed.type === CUSTOM_TITLE_TYPE) {
      return titleRecord("custom", parsed.customTitle);
    }
    if (parsed.type === AI_TITLE_TYPE) {
      return titleRecord("ai", parsed.aiTitle);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Pure, and the rule is custom-over-ai rather than whichever came last.
 *
 * Measured in one transcript: the last `custom-title` record sits at byte 10,697,664 and the
 * last `ai-title` at 10,697,766, so the ai-title is *later* — yet the conversation's real
 * name is the custom one, `hai-resume`, which its `custom-title.json` independently confirms.
 * Claude Code keeps generating a name of its own after a `/rename`, so a positional
 * last-of-either rule hands back a name the engineer has already replaced. `/rename` is a
 * person saying what this conversation is; an `ai-title` is a guess, and it only wins where
 * nobody has said.
 */
export function pickTitle(found: TranscriptTitles): string | undefined {
  return found.custom ?? found.ai;
}

/**
 * Pure. A file that is absent, unparseable or carries no usable `customTitle` is a silent
 * no-name rather than an error: this is read from a hook, and a hook never breaks a
 * session.
 */
export function parseCustomTitle(text: string | null): string | undefined {
  if (text === null) {
    return undefined;
  }
  try {
    const { customTitle } = JSON.parse(text) as { customTitle?: unknown };
    return typeof customTitle === "string" && customTitle !== "" ? customTitle : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which project directory holds this conversation, found rather than derived.
 *
 * A recorded `slug` is the exact answer and is one `stat`, so it is tried first. Where there
 * is none — and no record written before the slug was recorded carries one, which is the
 * whole of an engineer's existing registry — every project directory is scanned for
 * `<session-id>.jsonl`. Session ids are unique, so that is exact too, where deriving a slug
 * from `cwd` was a guess: of the five open records in one live registry, the derived slug
 * named the directory the transcript is actually in for two. The other three had registered
 * in worktrees and sub-repos while Claude Code had filed them under the directory the
 * session was started from.
 *
 * The scan is 64 `stat` calls against the project directories on that machine, and it only
 * runs when the fast path missed.
 */
export async function findProjectDir(deps: { fs: Fs; env: Env }, input: { slug?: string; sessionId?: string }): Promise<string | null> {
  const projects = projectsDir(deps.env);
  if (projects === null || input.sessionId === undefined || input.sessionId === "") {
    return null;
  }
  if (input.slug !== undefined && input.slug !== "" && (await deps.fs.exists(transcriptPath(join(projects, input.slug), input.sessionId)))) {
    return join(projects, input.slug);
  }
  for (const entry of await deps.fs.listDir(projects)) {
    if (entry.isDirectory && (await deps.fs.exists(transcriptPath(join(projects, entry.name), input.sessionId)))) {
      return join(projects, entry.name);
    }
  }
  return null;
}

/**
 * One pass over the transcript, keeping the last record of each type.
 *
 * The title records are append-only and in practice land near the end, but that is an
 * observation and not a guarantee, so nothing here reads a window off the tail: a
 * `/rename` early in a long conversation that Claude Code never renamed again is a title
 * sitting in the first megabyte of a hundred. What the pass does guarantee is that it holds
 * two strings whatever the file's size — `Fs.readLines` streams, because `readText` on the
 * largest transcript measured here would be a 198 MB string.
 */
export async function scanTranscriptTitles(deps: { fs: Fs }, path: string): Promise<TranscriptTitles> {
  const found: TranscriptTitles = {};
  for await (const line of deps.fs.readLines(path)) {
    const record = parseTitleRecord(line);
    if (record !== null) {
      found[record.kind] = record.title;
    }
  }
  return found;
}

/**
 * What a conversation is called, or undefined for every way of not having a name.
 *
 * The transcript is the source: of the five open records in one live registry it answers for
 * all five, where `custom-title.json` answers for three. That file stays as the last
 * fallback because it is not quite a subset — one conversation of the 1171 on this machine
 * has the file and no `custom-title` record in its transcript — and because a title Claude
 * Code wrote and hai cannot read is worse than a second `readText`. It is read, never
 * written: it is Claude Code's private store, and writing into it would make a format change
 * hai's bug to own.
 *
 * Every read goes through `Fs`, which answers "nothing" rather than throwing for an absent
 * or unreadable path, so this cannot be what breaks a hook or a resume.
 */
export async function readSessionTitle(deps: { fs: Fs; env: Env }, input: { slug?: string; sessionId?: string }): Promise<string | undefined> {
  const projectDir = await findProjectDir(deps, input);
  if (projectDir === null) {
    return undefined;
  }
  const sessionId = input.sessionId!;
  const titled = pickTitle(await scanTranscriptTitles(deps, transcriptPath(projectDir, sessionId)));
  return titled ?? parseCustomTitle(await deps.fs.readText(customTitlePath(projectDir, sessionId)));
}

/** Absent or empty is no record at all, the same way `parseCustomTitle` reads an empty title. */
function titleRecord(kind: TitleKind, value: unknown): TitleRecord | null {
  return typeof value === "string" && value !== "" ? { kind, title: value } : null;
}

export type TitleKind = "custom" | "ai";

export interface TitleRecord {
  kind: TitleKind;
  title: string;
}

/** The last record of each type the transcript carries, which is all a pass has to keep. */
export interface TranscriptTitles {
  custom?: string;
  ai?: string;
}
