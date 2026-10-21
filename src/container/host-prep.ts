import type { Mount } from "./mounts.js";

/**
 * Everything bind-mounted from the host has to exist first. If ~/.claude.json is not
 * already a file, Docker creates a *directory* at it and Claude Code never starts — which
 * is why devcontainer.json's initializeCommand touches it, and why this does.
 */
export function hostPrepPaths(input: { home: string; mounts: Mount[] }): { dirs: string[]; files: string[] } {
  const dirs = new Set<string>();
  const files = new Set<string>();
  for (const mount of input.mounts) {
    if (mount.kind !== "bind" || !isUnder(mount.source, input.home)) {
      continue;
    }
    // A dotfile that a shell appends to is a file; everything else a tool expects is a
    // directory. Nothing else under $HOME is mounted.
    if (/_history$|\.json$/.test(mount.source)) {
      files.add(mount.source);
    } else {
      dirs.add(mount.source);
    }
  }
  return { dirs: [...dirs].sort(), files: [...files].sort() };
}

export function isUnder(path: string, home: string): boolean {
  return path === home || path.startsWith(`${home}/`);
}
