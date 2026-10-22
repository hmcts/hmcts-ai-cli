import { createHash } from "node:crypto";
import { basename } from "node:path";

export const SESSION_PREFIX = "hai";
export const NETWORK_NAME = "hai";

/**
 * Claude Code keys a conversation on the workspace path with every non-alphanumeric
 * character replaced, so `~/.claude/projects/<slug>` is shared between a host session and
 * a container one whenever the repo is mounted at its host path. Container mode relies on
 * that for history, and the transcript lock exists because of it.
 */
export function projectSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Stable per repo, so a re-run finds the session it started last time. */
export function sessionName(input: { repoPath: string; requested?: string }): string {
  const requested = input.requested;
  if (requested !== undefined && requested !== "") {
    return requested;
  }
  const digest = createHash("sha1").update(input.repoPath).digest("hex").slice(0, 8);
  return `${SESSION_PREFIX}-${label(input.repoPath)}-${digest}`;
}

export function dockerVolumeName(sessionName: string): string {
  return `${sessionName}-docker`;
}

/** Docker names allow [a-zA-Z0-9][a-zA-Z0-9_.-]*, which a repo directory need not be. */
function label(repoPath: string): string {
  const name = basename(repoPath)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
  return name === "" ? "repo" : name;
}
