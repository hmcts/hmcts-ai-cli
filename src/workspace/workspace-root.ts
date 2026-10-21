import { dirname, join } from "node:path";
import type { Fs } from "../system/fs.js";

export const MANIFEST_FILE = "workspace.yaml";
export const MARKETPLACE_FILE = join(".claude-plugin", "marketplace.json");

// A top-level `repos:` key is what distinguishes a cft-workspace manifest from any other
// workspace.yaml. Matching the key by line keeps this free of a YAML parser, which would
// be the package's only runtime dependency.
const REPOS_KEY = /^repos:/m;

export async function findWorkspaceRoot(deps: { fs: Fs; cwd: string }): Promise<string | null> {
  let dir = deps.cwd;
  for (;;) {
    const manifest = await deps.fs.readText(join(dir, MANIFEST_FILE));
    if (manifest !== null && REPOS_KEY.test(manifest)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}
