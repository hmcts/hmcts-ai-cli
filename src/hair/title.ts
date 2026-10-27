import { basename, dirname, join } from "node:path";
import type { Env } from "../system/env.js";
import type { Fs } from "../system/fs.js";
import { registryDir } from "./registry.js";

/** `~/.claude/projects/<slug>/<session-id>.jsonl` is the transcript; `<slug>` is a project directory. */
export const PROJECTS_DIR = "projects";
export const TRANSCRIPT_SUFFIX = ".jsonl";

/**
 * The two record types a transcript carries a name in: `custom-title` is what `/rename`
 * writes, `ai-title` the name Claude Code generates for itself. A third, `agent-name`, is
 * deliberately not read — see the rule in CLAUDE.md before adding it.
 */
export const AI_TITLE_TYPE = "ai-title";
export const CUSTOM_TITLE_TYPE = "custom-title";

/**
 * The project directory Claude Code filed a conversation under, taken out of the
 * `transcript_path` the hook payload carries rather than derived: Claude Code fixes the slug
 * at startup while a session's `cwd` can move. Only the slug is kept, never the whole path,
 * because `~/.claude` is bind-mounted into a container session at a different absolute path.
 */
export function transcriptSlug(transcriptPath: unknown): string | undefined {
  // `unknown` because this is a boundary: `parsePayload` established only a non-array object,
  // and a `dirname` throw here costs `runHook` the whole registration, not just the slug.
  if (typeof transcriptPath !== "string" || transcriptPath === "") {
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

/**
 * Pure. One transcript line, or null for every line that is not a title record. The
 * `includes` is the cheap reject — `JSON.parse` per line is the whole cost of a scan — and
 * the `type` field is still what decides, so a line merely quoting one of these names
 * parses and is rejected.
 */
export function parseTitleRecord(line: string): TitleRecord | null {
  if (!line.includes(`"${CUSTOM_TITLE_TYPE}"`) && !line.includes(`"${AI_TITLE_TYPE}"`)) {
    return null;
  }
  try {
    // The reads are inside the `try` on purpose: a line of `null` or a number parses fine
    // and then throws on a property.
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
 * Pure, and the rule is custom-over-ai rather than whichever came last: Claude Code goes on
 * generating a name after a `/rename`, so a positional rule hands back a name the engineer
 * has already replaced. An empty last `custom-title` is a cleared name and lets the
 * `ai-title` through, which is what Claude Code itself would then show.
 */
export function pickTitle(found: TranscriptTitles): string | undefined {
  return named(found.custom) ?? named(found.ai);
}

/**
 * Which project directory holds this conversation, found rather than derived. A recorded
 * `slug` is the exact answer and one `stat`, so it is tried first; otherwise every project
 * directory is scanned for `<session-id>.jsonl`, which is exact because session ids are
 * unique.
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
 * One pass over the transcript, keeping the last record of each type. Nothing reads a window
 * off the tail, a `/rename` early in a long conversation being a title in the first megabyte
 * of a hundred, and `Fs.readLines` streams, so the pass holds two strings whatever the size.
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
 * What a conversation is called, or undefined for every way of not having a name. The
 * transcript is the only source. Every read goes through `Fs`, which answers "nothing" rather
 * than throwing for an absent or unreadable path, so this cannot break a hook or a resume.
 */
export async function readSessionTitle(deps: { fs: Fs; env: Env }, input: { slug?: string; sessionId?: string }): Promise<string | undefined> {
  const projectDir = await findProjectDir(deps, input);
  if (projectDir === null) {
    return undefined;
  }
  return pickTitle(await scanTranscriptTitles(deps, transcriptPath(projectDir, input.sessionId!)));
}

/**
 * A record with no title *field* is not a title record. An **empty** one is: `""` is how a
 * cleared title is written, and `pickTitle` reads it as "nobody has chosen a name".
 */
function titleRecord(kind: TitleKind, value: unknown): TitleRecord | null {
  return typeof value === "string" ? { kind, title: value } : null;
}

/** An empty title names nothing, whichever record it came off. */
function named(title: string | undefined): string | undefined {
  return title === undefined || title === "" ? undefined : title;
}

export type TitleKind = "custom" | "ai";

export interface TitleRecord {
  kind: TitleKind;
  title: string;
}

/**
 * The last record of each type the transcript carries, which is all a pass has to keep. A
 * value may be `""` — a title the person cleared, which `pickTitle` reads as a statement
 * rather than an absence.
 */
export interface TranscriptTitles {
  custom?: string;
  ai?: string;
}
