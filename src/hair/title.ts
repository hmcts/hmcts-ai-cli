import { basename, dirname, join } from "node:path";
import { projectSlug } from "../container/session.js";
import type { Env } from "../system/env.js";
import type { Fs } from "../system/fs.js";
import { registryDir } from "./registry.js";

/** Claude Code's own per-conversation store, a sibling of the transcripts. */
export const PROJECTS_DIR = "projects";
export const CUSTOM_TITLE_FILE = "custom-title.json";

/**
 * The directory Claude Code filed a conversation under, taken out of the `transcript_path`
 * the hook payload carries — `<…>/projects/<slug>/<session-id>.jsonl` — rather than derived
 * from anything hai knows.
 *
 * Claude Code fixes the slug when the session starts, and it does not move afterwards. A
 * slug derived from `cwd` does: the hook re-registers a session whose directory changed, so
 * a conversation that registered at a workspace root and then `cd`-ed into a worktree
 * rewrites its record's `cwd` and stops matching where its transcripts actually live, and
 * every later lookup misses for good. The payload hands us the answer, so there is no reason
 * to compute one.
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

/**
 * Where Claude Code keeps the name `/rename` set: one file per conversation under the
 * project slug, `{"customTitle":"…"}`.
 *
 * The slug is preferred and `cwd` is the fallback, for the records written before one was
 * recorded — which is the whole of an engineer's existing registry, and those are killed
 * sessions that will never fire another hook to fill it in. The fallback is safe to keep
 * because the session id is the *leaf* of the path: a wrong slug names a directory that does
 * not exist, so the derivation can only ever miss, never answer with another conversation's
 * title. `projectSlug` is the same transform the transcript directory and the transcript
 * lock use, and it matches Claude Code's byte for byte — verified against the directory
 * names on this machine, including a path with a dot in it.
 *
 * Read-only. hai never creates or edits one of these: it is Claude Code's private store,
 * and writing into it would make a format change hai's bug to own.
 */
export function customTitlePath(env: Env, input: { slug?: string; cwd?: string; sessionId?: string }): string | null {
  const dir = registryDir(env);
  const slug = input.slug ?? (input.cwd === undefined ? undefined : projectSlug(input.cwd));
  if (dir === null || slug === undefined || input.sessionId === undefined) {
    return null;
  }
  return join(dir, PROJECTS_DIR, slug, input.sessionId, CUSTOM_TITLE_FILE);
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
 * The stored title for a conversation, or undefined for every way of not having one.
 * `Fs.readText` answers null rather than throwing for an absent or unreadable file, so
 * this is one read that cannot fail.
 */
export async function readCustomTitle(deps: { fs: Fs; env: Env }, input: { slug?: string; cwd?: string; sessionId?: string }): Promise<string | undefined> {
  const path = customTitlePath(deps.env, input);
  return path === null ? undefined : parseCustomTitle(await deps.fs.readText(path));
}
