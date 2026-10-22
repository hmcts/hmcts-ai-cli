import { join } from "node:path";
import type { Fs } from "../system/fs.js";

export const CLAUDE_JSON = ".claude.json";
export const CLAUDE_JSON_MODE = 0o600;

/**
 * What a host that has never run Claude Code is missing, so a container session does not
 * open on onboarding and the folder-trust dialog. Deliberately not
 * `bypassPermissionsModeAccepted`: this file is the host's own, and hai no longer passes
 * `--dangerously-skip-permissions`, so seeding it would record an acceptance of risk the
 * user never gave for a prompt nothing here can raise.
 */
export const SEEDED_KEYS = ["hasCompletedOnboarding"] as const;
export const SEEDED_PROJECT_KEYS = ["hasTrustDialogAccepted", "hasClaudeMdExternalIncludesApproved", "hasClaudeMdExternalIncludesWarningShown"] as const;

/**
 * Merged, never overwritten: this file is the host's own Claude Code state, with every
 * project it has ever opened in it, and the container shares it rather than getting a copy.
 */
export function mergeClaudeJson(existing: string | null, workspacePath: string): string {
  const root = asObject(parse(existing));
  for (const key of SEEDED_KEYS) {
    root[key] = true;
  }
  const projects = asObject(root.projects);
  const project = asObject(projects[workspacePath]);
  for (const key of SEEDED_PROJECT_KEYS) {
    project[key] = true;
  }
  projects[workspacePath] = project;
  root.projects = projects;
  return `${JSON.stringify(root, null, 2)}\n`;
}

/**
 * Temp-then-rename, because the file is bind-mounted into the container: a half-written
 * one is a session that cannot start, and Claude Code rewrites it constantly.
 */
export async function seedClaudeJson(deps: { fs: Fs }, input: { home: string; workspacePath: string; pid: number }): Promise<void> {
  const path = join(input.home, CLAUDE_JSON);
  const existing = await deps.fs.readText(path);
  const merged = mergeClaudeJson(existing, input.workspacePath);
  if (existing === merged) {
    return;
  }
  const temp = `${path}.hai-${input.pid}.tmp`;
  await deps.fs.writeText(temp, merged, { mode: CLAUDE_JSON_MODE });
  await deps.fs.rename(temp, path);
}

function parse(contents: string | null): unknown {
  if (contents === null || contents.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(contents);
  } catch {
    return {};
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}
